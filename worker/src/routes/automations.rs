use std::collections::{BTreeMap, HashMap};
use std::str::FromStr;

use serde_json::{Map, Value};
use worker::{Env, Request, Response, RouteContext};

use crate::api_types::{
    AppId, AutomationStatus, AutomationsResponse, ConfigValue, ConnectionStatus, FieldType,
    SaveAutomationRequest, TestRunResult, WebhookInfo, WebhookSample, WebhookSamplesResponse,
    WebhookVerification, WorkflowDefinitionV1,
};
use crate::connectors::clickup::{get_env_secret_or_var, ClickUpConnector};
use crate::connectors::{
    get_connector, ActionConfig, Catalog, Connector, Cx, ErrorClass, ExternalSubscription,
    TriggerConfig,
};
use crate::crypto::{
    decrypt_secret, encrypt_secret, load_master_key, make_credential_aad, new_id, new_public_id,
    random_token_b64url, Secret, PREFIX_AUTOMATION, PREFIX_CREDENTIAL, PREFIX_WEBHOOK,
};
use crate::db::{audit, automations, connections, credentials, d1, events, webhooks};
use crate::engine::processor::{render_action_inputs, synthesize_sample_variables};
use crate::http::{
    authenticate, empty_response, json_response, log_structured, now_ms, read_json_limited,
    AppError, MAX_API_BODY_BYTES,
};
use crate::workflow::template::extract_template_vars;
use crate::workflow::validation::{validate_active, validate_draft, ConnectionMeta};

const CURRENT_KEY_VERSION: i32 = 1;

fn app_origin_from_env(env: &Env) -> String {
    get_env_secret_or_var(env, "APP_ORIGIN")
        .unwrap_or_else(|| "http://localhost:8787".to_string())
        .trim_end_matches('/')
        .to_string()
}

fn webhook_url_for_public_id(env: &Env, public_id: &str) -> String {
    format!("{}/hooks/{}", app_origin_from_env(env), public_id)
}

fn custom_verification_from_def(def: &WorkflowDefinitionV1) -> WebhookVerification {
    def.trigger
        .configuration
        .get("verification")
        .and_then(|v| v.as_str())
        .and_then(|s| WebhookVerification::from_str(s.trim()).ok())
        .unwrap_or(WebhookVerification::HmacSha256)
}

async fn load_and_decrypt_connection_secret(
    env: &Env,
    db: &worker::D1Database,
    org_id: &str,
    connection_id: &str,
) -> Result<Secret, AppError> {
    let conn = connections::get_connection(db, org_id, connection_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Connection not found.".to_string()))?;
    let cred = credentials::get_credential(db, org_id, &conn.credential_id)
        .await?
        .ok_or_else(|| AppError::Internal("Connection credential record missing.".to_string()))?;
    let master_key = load_master_key(env, cred.key_version)?;
    let aad = make_credential_aad(org_id, &cred.id, &cred.kind);
    Ok(decrypt_secret(
        &master_key,
        &cred.ciphertext,
        &cred.nonce,
        &aad,
    )?)
}

async fn store_webhook_secret(
    env: &Env,
    db: &worker::D1Database,
    org_id: &str,
    secret: &Secret,
    now: i64,
) -> Result<String, AppError> {
    let cred_id = new_id(PREFIX_CREDENTIAL)?;
    let master_key = load_master_key(env, CURRENT_KEY_VERSION)?;
    let aad = make_credential_aad(org_id, &cred_id, "webhook_secret");
    let blob = encrypt_secret(&master_key, CURRENT_KEY_VERSION, secret, &aad)?;
    credentials::insert_credential(
        db,
        &cred_id,
        org_id,
        "webhook_secret",
        &blob.ciphertext,
        &blob.nonce,
        blob.key_version,
        now,
    )
    .await?;
    Ok(cred_id)
}

async fn unsubscribe_clickup_subs_best_effort(
    env: &Env,
    db: &worker::D1Database,
    org_id: &str,
    def: &WorkflowDefinitionV1,
    subs: &[webhooks::WebhookSubscriptionRow],
    request_id: &str,
    mark_deleted: bool,
) {
    let Some(ref conn_id) = def.trigger.connection_id else {
        if mark_deleted {
            for sub in subs {
                if sub.provider == "clickup" {
                    let _ = webhooks::update_subscription_status(db, org_id, &sub.id, "deleted")
                        .await;
                }
            }
        }
        return;
    };

    let creds_res = load_and_decrypt_connection_secret(env, db, org_id, conn_id).await;
    let cx = Cx {
        env,
        org_id,
        request_id,
    };

    for sub in subs {
        if sub.provider != "clickup" {
            continue;
        }
        if let (Some(ref ext_id), Ok(ref creds)) = (&sub.external_webhook_id, &creds_res) {
            let ext_sub = ExternalSubscription {
                external_webhook_id: Some(ext_id.clone()),
                signing_secret: None,
                verification: sub.verification.clone(),
            };
            if let Err(e) = ClickUpConnector.unsubscribe(&cx, creds, &ext_sub).await {
                log_structured(
                    "warn",
                    "clickup_unsubscribe_failed",
                    request_id,
                    Some(org_id),
                    None,
                    Some(&e.internal_detail),
                );
            }
        }
        if mark_deleted {
            let _ = webhooks::update_subscription_status(db, org_id, &sub.id, "deleted").await;
        }
    }
}

async fn ensure_custom_webhook_subscription(
    env: &Env,
    db: &worker::D1Database,
    org_id: &str,
    automation_id: &str,
    def: &WorkflowDefinitionV1,
    initial_status: &str,
    now: i64,
) -> Result<webhooks::WebhookSubscriptionRow, AppError> {
    if let Some(existing) = webhooks::get_by_automation(db, org_id, automation_id).await? {
        return Ok(existing);
    }

    let verification = custom_verification_from_def(def);
    let secret_cred_id = if verification == WebhookVerification::None {
        None
    } else {
        let raw_secret = format!("whsec_{}", random_token_b64url(32)?);
        let cred_id = store_webhook_secret(
            env,
            db,
            org_id,
            &Secret::from_string(raw_secret),
            now,
        )
        .await?;
        Some(cred_id)
    };

    let sub_id = new_id(PREFIX_WEBHOOK)?;
    let public_id = new_public_id()?;
    webhooks::insert_subscription(
        db,
        org_id,
        &sub_id,
        automation_id,
        &public_id,
        "custom",
        None,
        secret_cred_id.as_deref(),
        verification.as_str(),
        initial_status,
        now,
    )
    .await?;

    webhooks::get_by_automation(db, org_id, automation_id)
        .await?
        .ok_or_else(|| AppError::Internal("Created webhook subscription missing.".to_string()))
}

pub async fn list_automations(
    req: Request,
    ctx: RouteContext<String>,
) -> Result<Response, AppError> {
    let request_id = &ctx.data;
    let now = now_ms();
    let auth = authenticate(&req, &ctx.env, now).await?;
    let db = d1(&ctx.env)?;
    let catalog = Catalog::mvp();

    let rows = automations::list_automations(&db, &auth.org_id).await?;
    let items = rows
        .into_iter()
        .map(|r| r.into_dto(&catalog))
        .collect::<Result<Vec<_>, _>>()?;

    Ok(json_response(
        200,
        &AutomationsResponse { automations: items },
        request_id,
        auth.refreshed_cookie.as_deref(),
    )?)
}

pub async fn create_automation(
    mut req: Request,
    ctx: RouteContext<String>,
) -> Result<Response, AppError> {
    let request_id = &ctx.data;
    let now = now_ms();
    let auth = authenticate(&req, &ctx.env, now).await?;
    let body: SaveAutomationRequest = read_json_limited(&mut req, MAX_API_BODY_BYTES).await?;

    let name = body.name.trim();
    if name.is_empty() || name.chars().count() > 120 {
        let mut fields = BTreeMap::new();
        fields.insert(
            "name".to_string(),
            "Automation name must be between 1 and 120 characters.".to_string(),
        );
        return Err(AppError::Validation {
            message: "Validation failed.".to_string(),
            fields: Some(fields),
        });
    }

    let db = d1(&ctx.env)?;
    let catalog = Catalog::mvp();
    let owned_connections = connections::list_connection_meta_map(&db, &auth.org_id).await?;
    if let Err(fields) = validate_draft(&body.definition, &catalog, &owned_connections) {
        return Err(AppError::Validation {
            message: "Please fix the highlighted workflow fields.".to_string(),
            fields: Some(fields),
        });
    }

    let id = new_id(PREFIX_AUTOMATION)?;
    automations::insert_automation_with_steps(
        &db,
        &auth.org_id,
        &id,
        name,
        AutomationStatus::Draft,
        &body.definition,
        body.layout.as_ref(),
        &auth.user_id,
        now,
    )
    .await?;

    let _ = audit::insert_audit_log(
        &db,
        &auth.org_id,
        Some(&auth.user_id),
        "automation.created",
        Some("automation"),
        Some(&id),
        None,
        now,
    )
    .await;

    let row = automations::get_automation(&db, &auth.org_id, &id)
        .await?
        .ok_or_else(|| AppError::Internal("Created automation could not be loaded.".to_string()))?;
    let dto = row.into_dto(&catalog)?;

    Ok(json_response(
        201,
        &dto,
        request_id,
        auth.refreshed_cookie.as_deref(),
    )?)
}

pub async fn get_automation(
    req: Request,
    ctx: RouteContext<String>,
) -> Result<Response, AppError> {
    let request_id = &ctx.data;
    let now = now_ms();
    let auth = authenticate(&req, &ctx.env, now).await?;
    let id = ctx
        .param("id")
        .ok_or_else(|| AppError::NotFound("Automation not found.".to_string()))?;

    let db = d1(&ctx.env)?;
    let row = automations::get_automation(&db, &auth.org_id, id)
        .await?
        .ok_or_else(|| AppError::NotFound("Automation not found.".to_string()))?;

    let catalog = Catalog::mvp();
    let dto = row.into_dto(&catalog)?;
    Ok(json_response(
        200,
        &dto,
        request_id,
        auth.refreshed_cookie.as_deref(),
    )?)
}

pub async fn update_automation(
    mut req: Request,
    ctx: RouteContext<String>,
) -> Result<Response, AppError> {
    let request_id = &ctx.data;
    let now = now_ms();
    let auth = authenticate(&req, &ctx.env, now).await?;
    let id = ctx
        .param("id")
        .ok_or_else(|| AppError::NotFound("Automation not found.".to_string()))?
        .to_string();

    let body: SaveAutomationRequest = read_json_limited(&mut req, MAX_API_BODY_BYTES).await?;
    let name = body.name.trim();
    if name.is_empty() || name.chars().count() > 120 {
        let mut fields = BTreeMap::new();
        fields.insert(
            "name".to_string(),
            "Automation name must be between 1 and 120 characters.".to_string(),
        );
        return Err(AppError::Validation {
            message: "Validation failed.".to_string(),
            fields: Some(fields),
        });
    }

    let db = d1(&ctx.env)?;
    if automations::get_automation(&db, &auth.org_id, &id)
        .await?
        .is_none()
    {
        return Err(AppError::NotFound("Automation not found.".to_string()));
    }

    let catalog = Catalog::mvp();
    let owned_connections = connections::list_connection_meta_map(&db, &auth.org_id).await?;
    if let Err(fields) = validate_draft(&body.definition, &catalog, &owned_connections) {
        return Err(AppError::Validation {
            message: "Please fix the highlighted workflow fields.".to_string(),
            fields: Some(fields),
        });
    }

    automations::update_automation_with_steps(
        &db,
        &auth.org_id,
        &id,
        name,
        &body.definition,
        body.layout.as_ref(),
        now,
    )
    .await?;

    let row = automations::get_automation(&db, &auth.org_id, &id)
        .await?
        .ok_or_else(|| AppError::NotFound("Automation not found.".to_string()))?;
    let dto = row.into_dto(&catalog)?;

    Ok(json_response(
        200,
        &dto,
        request_id,
        auth.refreshed_cookie.as_deref(),
    )?)
}

pub async fn delete_automation(
    req: Request,
    ctx: RouteContext<String>,
) -> Result<Response, AppError> {
    let request_id = &ctx.data;
    let now = now_ms();
    let auth = authenticate(&req, &ctx.env, now).await?;
    let id = ctx
        .param("id")
        .ok_or_else(|| AppError::NotFound("Automation not found.".to_string()))?;

    let db = d1(&ctx.env)?;
    let Some(row) = automations::get_automation(&db, &auth.org_id, id).await? else {
        return Err(AppError::NotFound("Automation not found.".to_string()));
    };

    let subs = webhooks::list_active_by_automation(&db, &auth.org_id, id).await?;
    if !subs.is_empty() {
        if let Ok(def) = serde_json::from_str::<WorkflowDefinitionV1>(&row.definition_json) {
            unsubscribe_clickup_subs_best_effort(
                &ctx.env,
                &db,
                &auth.org_id,
                &def,
                &subs,
                request_id,
                false,
            )
            .await;
        }
    }

    let deleted = automations::delete_automation(&db, &auth.org_id, id).await?;
    if !deleted {
        return Err(AppError::NotFound("Automation not found.".to_string()));
    }

    for sub in &subs {
        if let Some(ref cred_id) = sub.secret_credential_id {
            let _ = credentials::delete_credential(&db, &auth.org_id, cred_id).await;
        }
    }

    let _ = audit::insert_audit_log(
        &db,
        &auth.org_id,
        Some(&auth.user_id),
        "automation.deleted",
        Some("automation"),
        Some(id),
        None,
        now,
    )
    .await;

    Ok(empty_response(
        204,
        request_id,
        auth.refreshed_cookie.as_deref(),
    )?)
}

pub async fn activate_automation(
    req: Request,
    ctx: RouteContext<String>,
) -> Result<Response, AppError> {
    let request_id = &ctx.data;
    let now = now_ms();
    let auth = authenticate(&req, &ctx.env, now).await?;
    let id = ctx
        .param("id")
        .ok_or_else(|| AppError::NotFound("Automation not found.".to_string()))?
        .to_string();

    let db = d1(&ctx.env)?;
    let row = automations::get_automation(&db, &auth.org_id, &id)
        .await?
        .ok_or_else(|| AppError::NotFound("Automation not found.".to_string()))?;

    let def: WorkflowDefinitionV1 = serde_json::from_str(&row.definition_json)
        .map_err(|e| AppError::Internal(format!("Invalid automation definition: {e}")))?;

    let catalog = Catalog::mvp();
    let owned_connections = connections::list_connection_meta_map(&db, &auth.org_id).await?;
    if let Err(fields) = validate_active(&def, &catalog, &owned_connections) {
        return Err(AppError::Validation {
            message: "Please fix the highlighted workflow fields before activating.".to_string(),
            fields: Some(fields),
        });
    }

    match def.trigger.application {
        AppId::Clickup => {
            let existing = webhooks::get_by_automation(&db, &auth.org_id, &id).await?;
            let already_active = existing
                .as_ref()
                .map(|s| {
                    s.provider == "clickup"
                        && s.status == "active"
                        && s.external_webhook_id.is_some()
                })
                .unwrap_or(false);

            if !already_active {
                let conn_id = def
                    .trigger
                    .connection_id
                    .as_deref()
                    .ok_or_else(|| AppError::BadRequest("Missing ClickUp connection.".to_string()))?;
                let creds =
                    load_and_decrypt_connection_secret(&ctx.env, &db, &auth.org_id, conn_id)
                        .await?;

                let public_id = new_public_id()?;
                let callback_url = webhook_url_for_public_id(&ctx.env, &public_id);
                let cx = Cx {
                    env: &ctx.env,
                    org_id: &auth.org_id,
                    request_id,
                };
                let trigger_cfg = TriggerConfig {
                    event: def.trigger.event.clone(),
                    configuration: def.trigger.configuration.clone(),
                };

                let ext_sub = match ClickUpConnector
                    .subscribe(&cx, &creds, &trigger_cfg, &callback_url)
                    .await
                {
                    Ok(s) => s,
                    Err(err) => {
                        log_structured(
                            "warn",
                            "clickup_subscribe_failed",
                            request_id,
                            Some(&auth.org_id),
                            None,
                            Some(&err.internal_detail),
                        );
                        if err.class == ErrorClass::NeedsReconnect {
                            let _ = connections::update_connection_status(
                                &db,
                                &auth.org_id,
                                conn_id,
                                ConnectionStatus::NeedsAttention,
                                now,
                            )
                            .await;
                        }
                        return Err(AppError::BadRequest(err.user_message));
                    }
                };

                let secret_cred_id = match ext_sub.signing_secret {
                    Some(ref sec) => {
                        Some(store_webhook_secret(&ctx.env, &db, &auth.org_id, sec, now).await?)
                    }
                    None => None,
                };

                let sub_id = new_id(PREFIX_WEBHOOK)?;
                webhooks::insert_subscription(
                    &db,
                    &auth.org_id,
                    &sub_id,
                    &id,
                    &public_id,
                    "clickup",
                    ext_sub.external_webhook_id.as_deref(),
                    secret_cred_id.as_deref(),
                    &ext_sub.verification,
                    "active",
                    now,
                )
                .await?;
            }
        }
        AppId::Webhook => {
            let verification = custom_verification_from_def(&def);
            if let Some(existing) = webhooks::get_by_automation(&db, &auth.org_id, &id).await? {
                let mut secret_cred_id = existing.secret_credential_id.clone();
                if verification != WebhookVerification::None && secret_cred_id.is_none() {
                    let raw_secret = format!("whsec_{}", random_token_b64url(32)?);
                    secret_cred_id = Some(
                        store_webhook_secret(
                            &ctx.env,
                            &db,
                            &auth.org_id,
                            &Secret::from_string(raw_secret),
                            now,
                        )
                        .await?,
                    );
                }
                webhooks::update_subscription_config(
                    &db,
                    &auth.org_id,
                    &existing.id,
                    verification.as_str(),
                    secret_cred_id.as_deref(),
                    "active",
                )
                .await?;
            } else {
                ensure_custom_webhook_subscription(
                    &ctx.env,
                    &db,
                    &auth.org_id,
                    &id,
                    &def,
                    "active",
                    now,
                )
                .await?;
            }
        }
        other => {
            return Err(AppError::BadRequest(format!(
                "Application '{other}' cannot be used as a trigger."
            )));
        }
    }

    automations::update_automation_status(&db, &auth.org_id, &id, AutomationStatus::Active, now)
        .await?;

    let _ = audit::insert_audit_log(
        &db,
        &auth.org_id,
        Some(&auth.user_id),
        "automation.activated",
        Some("automation"),
        Some(&id),
        None,
        now,
    )
    .await;

    let updated = automations::get_automation(&db, &auth.org_id, &id)
        .await?
        .ok_or_else(|| AppError::NotFound("Automation not found.".to_string()))?;
    let dto = updated.into_dto(&catalog)?;

    Ok(json_response(
        200,
        &dto,
        request_id,
        auth.refreshed_cookie.as_deref(),
    )?)
}

pub async fn pause_automation(
    req: Request,
    ctx: RouteContext<String>,
) -> Result<Response, AppError> {
    let request_id = &ctx.data;
    let now = now_ms();
    let auth = authenticate(&req, &ctx.env, now).await?;
    let id = ctx
        .param("id")
        .ok_or_else(|| AppError::NotFound("Automation not found.".to_string()))?
        .to_string();

    let db = d1(&ctx.env)?;
    let row = automations::get_automation(&db, &auth.org_id, &id)
        .await?
        .ok_or_else(|| AppError::NotFound("Automation not found.".to_string()))?;

    let subs = webhooks::list_active_by_automation(&db, &auth.org_id, &id).await?;
    if !subs.is_empty() {
        if let Ok(def) = serde_json::from_str::<WorkflowDefinitionV1>(&row.definition_json) {
            unsubscribe_clickup_subs_best_effort(
                &ctx.env,
                &db,
                &auth.org_id,
                &def,
                &subs,
                request_id,
                true,
            )
            .await;
        }
        for sub in &subs {
            if sub.provider != "clickup" {
                webhooks::update_subscription_status(&db, &auth.org_id, &sub.id, "paused")
                    .await?;
            }
        }
    }

    automations::update_automation_status(&db, &auth.org_id, &id, AutomationStatus::Paused, now)
        .await?;

    let _ = audit::insert_audit_log(
        &db,
        &auth.org_id,
        Some(&auth.user_id),
        "automation.paused",
        Some("automation"),
        Some(&id),
        None,
        now,
    )
    .await;

    let catalog = Catalog::mvp();
    let updated = automations::get_automation(&db, &auth.org_id, &id)
        .await?
        .ok_or_else(|| AppError::NotFound("Automation not found.".to_string()))?;
    let dto = updated.into_dto(&catalog)?;

    Ok(json_response(
        200,
        &dto,
        request_id,
        auth.refreshed_cookie.as_deref(),
    )?)
}

fn validate_action_for_test(
    def: &WorkflowDefinitionV1,
    catalog: &Catalog,
    owned_connections: &HashMap<String, ConnectionMeta>,
) -> Result<(), BTreeMap<String, String>> {
    let mut errors = BTreeMap::new();

    if def.action.event.trim().is_empty() {
        errors.insert(
            "action.event".to_string(),
            "Please select an action event.".to_string(),
        );
    } else if catalog
        .get_action(def.action.application, &def.action.event)
        .is_none()
    {
        errors.insert(
            "action.event".to_string(),
            format!(
                "Unknown action '{}' for {}.",
                def.action.event, def.action.application
            ),
        );
    }

    let requires_connection = match def.action.application {
        AppId::Slack => true,
        AppId::Http => {
            let auth_type = def
                .action
                .configuration
                .get("authType")
                .and_then(|v| v.as_str())
                .unwrap_or("none");
            !auth_type.is_empty() && auth_type != "none"
        }
        _ => false,
    };

    if requires_connection || def.action.connection_id.is_some() {
        match def
            .action
            .connection_id
            .as_deref()
            .filter(|s| !s.trim().is_empty())
        {
            None => {
                errors.insert(
                    "action.connectionId".to_string(),
                    "Please connect an account for this action.".to_string(),
                );
            }
            Some(cid) => match owned_connections.get(cid) {
                None => {
                    errors.insert(
                        "action.connectionId".to_string(),
                        "Selected connection was not found.".to_string(),
                    );
                }
                Some(meta) if meta.application_id != def.action.application => {
                    errors.insert(
                        "action.connectionId".to_string(),
                        "Selected connection does not match this action app.".to_string(),
                    );
                }
                Some(meta) if meta.status != ConnectionStatus::Connected => {
                    errors.insert(
                        "action.connectionId".to_string(),
                        "This connection needs to be reconnected before testing.".to_string(),
                    );
                }
                Some(_) => {}
            },
        }
    }

    if let Some(ad) = catalog.get_action(def.action.application, &def.action.event) {
        for field in &ad.fields {
            let err_key = format!("action.configuration.{}", field.key);
            let value = def.action.configuration.get(&field.key);
            if field.required && value.map(|v| v.is_empty_value()).unwrap_or(true) {
                errors.insert(err_key.clone(), format!("{} is required.", field.label));
                continue;
            }
            if let Some(val) = value {
                match (field.field_type, val) {
                    (FieldType::Template, ConfigValue::String(s)) => {
                        if let Err(e) = extract_template_vars(s) {
                            errors.insert(err_key, e.to_string());
                        }
                    }
                    (FieldType::KeyValue, ConfigValue::KeyValueList(pairs)) => {
                        for pair in pairs {
                            if let Err(e) = extract_template_vars(&pair.value) {
                                errors.insert(err_key.clone(), e.to_string());
                                break;
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

pub async fn test_automation(
    req: Request,
    ctx: RouteContext<String>,
) -> Result<Response, AppError> {
    let request_id = &ctx.data;
    let now = now_ms();
    let auth = authenticate(&req, &ctx.env, now).await?;
    let id = ctx
        .param("id")
        .ok_or_else(|| AppError::NotFound("Automation not found.".to_string()))?
        .to_string();

    let db = d1(&ctx.env)?;
    let row = automations::get_automation(&db, &auth.org_id, &id)
        .await?
        .ok_or_else(|| AppError::NotFound("Automation not found.".to_string()))?;

    let def: WorkflowDefinitionV1 = serde_json::from_str(&row.definition_json)
        .map_err(|e| AppError::Internal(format!("Invalid automation definition: {e}")))?;

    let catalog = Catalog::mvp();
    let owned_connections = connections::list_connection_meta_map(&db, &auth.org_id).await?;
    if let Err(fields) = validate_action_for_test(&def, &catalog, &owned_connections) {
        return Err(AppError::Validation {
            message: "Please finish configuring the action step before testing.".to_string(),
            fields: Some(fields),
        });
    }

    let cx = Cx {
        env: &ctx.env,
        org_id: &auth.org_id,
        request_id,
    };

    // Prefer latest real event payload if available; otherwise synthesize from catalog examples.
    let mut vars: Option<Map<String, Value>> = None;
    let mut used_sample_data = true;

    if let Some(latest_event) =
        events::get_latest_event_for_automation(&db, &auth.org_id, &id).await?
    {
        if let Ok(raw_json) = serde_json::from_str::<Value>(&latest_event.payload_json) {
            if raw_json.get("_truncated").and_then(|v| v.as_bool()) != Some(true) {
                let trigger_creds = if let Some(ref conn_id) = def.trigger.connection_id {
                    load_and_decrypt_connection_secret(&ctx.env, &db, &auth.org_id, conn_id)
                        .await
                        .ok()
                } else {
                    Some(Secret::from_bytes(Vec::new()))
                };

                if let Some(creds) = trigger_creds {
                    let trigger_connector = get_connector(def.trigger.application);
                    let trigger_cfg = TriggerConfig {
                        event: def.trigger.event.clone(),
                        configuration: def.trigger.configuration.clone(),
                    };
                    if let Ok(Some(norm)) = trigger_connector
                        .normalize(&cx, &creds, &trigger_cfg, &raw_json)
                        .await
                    {
                        vars = Some(norm.variables);
                        used_sample_data = false;
                    }
                }
            }
        }
    }

    let final_vars = vars.unwrap_or_else(|| synthesize_sample_variables(&def, &catalog));
    let rendered_inputs = render_action_inputs(&def, &final_vars);

    let action_creds = if let Some(ref conn_id) = def.action.connection_id {
        load_and_decrypt_connection_secret(&ctx.env, &db, &auth.org_id, conn_id).await?
    } else {
        Secret::from_bytes(Vec::new())
    };

    let action_connector = get_connector(def.action.application);
    let action_cfg = ActionConfig {
        event: def.action.event.clone(),
        configuration: def.action.configuration.clone(),
    };

    let result = match action_connector
        .execute(&cx, &action_creds, &action_cfg, &rendered_inputs)
        .await
    {
        Ok(output) => TestRunResult {
            ok: true,
            message: output.action_summary,
            used_sample_data,
        },
        Err(err) => {
            log_structured(
                "warn",
                "automation_test_failed",
                request_id,
                Some(&auth.org_id),
                None,
                Some(&err.internal_detail),
            );
            if err.class == ErrorClass::NeedsReconnect {
                if let Some(ref cid) = def.action.connection_id {
                    let _ = connections::update_connection_status(
                        &db,
                        &auth.org_id,
                        cid,
                        ConnectionStatus::NeedsAttention,
                        now,
                    )
                    .await;
                }
            }
            TestRunResult {
                ok: false,
                message: err.user_message,
                used_sample_data,
            }
        }
    };

    Ok(json_response(
        200,
        &result,
        request_id,
        auth.refreshed_cookie.as_deref(),
    )?)
}

pub async fn get_webhook_info(
    req: Request,
    ctx: RouteContext<String>,
) -> Result<Response, AppError> {
    let request_id = &ctx.data;
    let now = now_ms();
    let auth = authenticate(&req, &ctx.env, now).await?;
    let id = ctx
        .param("id")
        .ok_or_else(|| AppError::NotFound("Automation not found.".to_string()))?
        .to_string();

    let db = d1(&ctx.env)?;
    let row = automations::get_automation(&db, &auth.org_id, &id)
        .await?
        .ok_or_else(|| AppError::NotFound("Automation not found.".to_string()))?;

    let def: WorkflowDefinitionV1 = serde_json::from_str(&row.definition_json)
        .map_err(|e| AppError::Internal(format!("Invalid automation definition: {e}")))?;
    if def.trigger.application != AppId::Webhook {
        return Err(AppError::BadRequest(
            "This automation does not use a Custom Webhook trigger.".to_string(),
        ));
    }

    let sub = ensure_custom_webhook_subscription(
        &ctx.env,
        &db,
        &auth.org_id,
        &id,
        &def,
        "paused",
        now,
    )
    .await?;

    let verification = WebhookVerification::from_str(&sub.verification)
        .unwrap_or_else(|_| custom_verification_from_def(&def));

    let info = WebhookInfo {
        url: webhook_url_for_public_id(&ctx.env, &sub.public_id),
        verification,
        secret: None,
        last_received_at: sub.last_received_at,
    };

    Ok(json_response(
        200,
        &info,
        request_id,
        auth.refreshed_cookie.as_deref(),
    )?)
}

pub async fn rotate_webhook_secret(
    req: Request,
    ctx: RouteContext<String>,
) -> Result<Response, AppError> {
    let request_id = &ctx.data;
    let now = now_ms();
    let auth = authenticate(&req, &ctx.env, now).await?;
    let id = ctx
        .param("id")
        .ok_or_else(|| AppError::NotFound("Automation not found.".to_string()))?
        .to_string();

    let db = d1(&ctx.env)?;
    let row = automations::get_automation(&db, &auth.org_id, &id)
        .await?
        .ok_or_else(|| AppError::NotFound("Automation not found.".to_string()))?;

    let def: WorkflowDefinitionV1 = serde_json::from_str(&row.definition_json)
        .map_err(|e| AppError::Internal(format!("Invalid automation definition: {e}")))?;
    if def.trigger.application != AppId::Webhook {
        return Err(AppError::BadRequest(
            "This automation does not use a Custom Webhook trigger.".to_string(),
        ));
    }

    let sub = ensure_custom_webhook_subscription(
        &ctx.env,
        &db,
        &auth.org_id,
        &id,
        &def,
        "paused",
        now,
    )
    .await?;

    let raw_secret = format!("whsec_{}", random_token_b64url(32)?);
    let new_cred_id = store_webhook_secret(
        &ctx.env,
        &db,
        &auth.org_id,
        &Secret::from_str_slice(&raw_secret),
        now,
    )
    .await?;

    webhooks::update_secret_credential_id(&db, &auth.org_id, &sub.id, Some(&new_cred_id)).await?;

    if let Some(ref old_cred_id) = sub.secret_credential_id {
        if old_cred_id != &new_cred_id {
            let _ = credentials::delete_credential(&db, &auth.org_id, old_cred_id).await;
        }
    }

    let _ = audit::insert_audit_log(
        &db,
        &auth.org_id,
        Some(&auth.user_id),
        "webhook.secret_rotated",
        Some("automation"),
        Some(&id),
        None,
        now,
    )
    .await;

    let verification = WebhookVerification::from_str(&sub.verification)
        .unwrap_or_else(|_| custom_verification_from_def(&def));

    let info = WebhookInfo {
        url: webhook_url_for_public_id(&ctx.env, &sub.public_id),
        verification,
        secret: Some(raw_secret),
        last_received_at: sub.last_received_at,
    };

    Ok(json_response(
        200,
        &info,
        request_id,
        auth.refreshed_cookie.as_deref(),
    )?)
}

pub async fn list_webhook_samples(
    req: Request,
    ctx: RouteContext<String>,
) -> Result<Response, AppError> {
    let request_id = &ctx.data;
    let now = now_ms();
    let auth = authenticate(&req, &ctx.env, now).await?;
    let id = ctx
        .param("id")
        .ok_or_else(|| AppError::NotFound("Automation not found.".to_string()))?
        .to_string();

    let db = d1(&ctx.env)?;
    let _row = automations::get_automation(&db, &auth.org_id, &id)
        .await?
        .ok_or_else(|| AppError::NotFound("Automation not found.".to_string()))?;

    let samples = if let Some(sub) = webhooks::get_by_automation(&db, &auth.org_id, &id).await? {
        let rows = events::list_recent_samples(&db, &auth.org_id, &sub.id, 10).await?;
        rows.into_iter()
            .map(|r| WebhookSample {
                event_id: r.id,
                received_at: r.received_at,
                payload: serde_json::from_str(&r.payload_json).unwrap_or(Value::Null),
            })
            .collect()
    } else {
        Vec::new()
    };

    Ok(json_response(
        200,
        &WebhookSamplesResponse { samples },
        request_id,
        auth.refreshed_cookie.as_deref(),
    )?)
}
