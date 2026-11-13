use std::collections::BTreeMap;
use std::str::FromStr;

use serde_json::json;
use worker::{Request, Response, RouteContext};

use crate::api_types::{
    AppId, Connection, ConnectionStatus, ConnectionsResponse, CreateTokenConnectionRequest,
    OptionsResponse, TestConnectionResponse,
};
use crate::connectors::clickup::verify_clickup_token;
use crate::connectors::slack::verify_slack_token;
use crate::connectors::{get_connector, test_connection as run_connector_test, Cx, ErrorClass};
use crate::crypto::{
    encrypt_secret, load_master_key, make_credential_aad, new_id, decrypt_secret, Secret,
    PREFIX_CONNECTION, PREFIX_CREDENTIAL,
};
use crate::db::{audit, connections, credentials, d1};
use crate::http::{
    authenticate, empty_response, json_response, log_structured, now_ms, read_json_limited,
    AppError, MAX_API_BODY_BYTES,
};

const CURRENT_KEY_VERSION: i32 = 1;
const MAX_TOKEN_BYTES: usize = 8192;

pub async fn list_connections(
    req: Request,
    ctx: RouteContext<String>,
) -> Result<Response, AppError> {
    let request_id = &ctx.data;
    let now = now_ms();
    let auth = authenticate(&req, &ctx.env, now).await?;
    let db = d1(&ctx.env)?;

    let rows = connections::list_connections(&db, &auth.org_id).await?;
    let items = rows
        .into_iter()
        .map(Connection::try_from)
        .collect::<Result<Vec<_>, _>>()?;

    Ok(json_response(
        200,
        &ConnectionsResponse { connections: items },
        request_id,
        auth.refreshed_cookie.as_deref(),
    )?)
}

pub async fn create_connection(
    mut req: Request,
    ctx: RouteContext<String>,
) -> Result<Response, AppError> {
    let request_id = &ctx.data;
    let now = now_ms();
    let auth = authenticate(&req, &ctx.env, now).await?;
    let body: CreateTokenConnectionRequest =
        read_json_limited(&mut req, MAX_API_BODY_BYTES).await?;

    let token = body.token.trim();
    let mut fields = BTreeMap::new();
    if token.is_empty() {
        fields.insert("token".to_string(), "Please enter a token or credential.".to_string());
    } else if token.len() > MAX_TOKEN_BYTES {
        fields.insert(
            "token".to_string(),
            "Token exceeds maximum allowed length.".to_string(),
        );
    }

    let kind = match body.application_id {
        AppId::Clickup | AppId::Slack => "api_token",
        AppId::Http => "http_auth",
        AppId::Webhook => {
            fields.insert(
                "applicationId".to_string(),
                "This application does not support token connections.".to_string(),
            );
            return Err(AppError::Validation {
                message: "Validation failed.".to_string(),
                fields: Some(fields),
            });
        }
    };

    if let Some(ref dn) = body.display_name {
        if dn.trim().chars().count() > 120 {
            fields.insert(
                "displayName".to_string(),
                "Display name must be 120 characters or fewer.".to_string(),
            );
        }
    }

    if !fields.is_empty() {
        return Err(AppError::Validation {
            message: "Please check your connection details.".to_string(),
            fields: Some(fields),
        });
    }

    let (default_label, external_account_id) = match body.application_id {
        AppId::Clickup => match verify_clickup_token(&ctx.env, token).await {
            Ok((label, ext_id)) => (label, ext_id),
            Err(e) => {
                log_structured(
                    "warn",
                    "clickup_token_verify_failed",
                    request_id,
                    Some(&auth.org_id),
                    None,
                    Some(&e.internal_detail),
                );
                let mut f = BTreeMap::new();
                f.insert("token".to_string(), e.user_message);
                return Err(AppError::Validation {
                    message: "Could not verify the ClickUp token.".to_string(),
                    fields: Some(f),
                });
            }
        },
        AppId::Slack => match verify_slack_token(&ctx.env, token).await {
            Ok((label, ext_id)) => (label, ext_id),
            Err(e) => {
                log_structured(
                    "warn",
                    "slack_token_verify_failed",
                    request_id,
                    Some(&auth.org_id),
                    None,
                    Some(&e.internal_detail),
                );
                let mut f = BTreeMap::new();
                f.insert("token".to_string(), e.user_message);
                return Err(AppError::Validation {
                    message: "Could not verify the Slack bot token.".to_string(),
                    fields: Some(f),
                });
            }
        },
        AppId::Http => ("HTTP Credential".to_string(), None),
        AppId::Webhook => unreachable!(),
    };

    let display_name = body
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or(default_label);

    let master_key = load_master_key(&ctx.env, CURRENT_KEY_VERSION)?;
    let cred_id = new_id(PREFIX_CREDENTIAL)?;
    let con_id = new_id(PREFIX_CONNECTION)?;
    let aad = make_credential_aad(&auth.org_id, &cred_id, kind);
    let secret = Secret::from_str_slice(token);
    let blob = encrypt_secret(&master_key, CURRENT_KEY_VERSION, &secret, &aad)?;

    let db = d1(&ctx.env)?;
    credentials::insert_credential(
        &db,
        &cred_id,
        &auth.org_id,
        kind,
        &blob.ciphertext,
        &blob.nonce,
        blob.key_version,
        now,
    )
    .await?;

    if let Err(e) = connections::create_connection(
        &db,
        &auth.org_id,
        &con_id,
        body.application_id,
        &display_name,
        external_account_id.as_deref(),
        &cred_id,
        ConnectionStatus::Connected,
        &auth.user_id,
        now,
    )
    .await
    {
        let _ = credentials::delete_credential(&db, &auth.org_id, &cred_id).await;
        return Err(e.into());
    }

    let meta_json = json!({ "applicationId": body.application_id.as_str(), "kind": kind }).to_string();
    let _ = audit::insert_audit_log(
        &db,
        &auth.org_id,
        Some(&auth.user_id),
        "connection.created",
        Some("connection"),
        Some(&con_id),
        Some(&meta_json),
        now,
    )
    .await;

    let dto = Connection {
        id: con_id,
        application_id: body.application_id,
        display_name,
        status: ConnectionStatus::Connected,
        created_at: now,
    };

    Ok(json_response(
        201,
        &dto,
        request_id,
        auth.refreshed_cookie.as_deref(),
    )?)
}

pub async fn test_connection(
    req: Request,
    ctx: RouteContext<String>,
) -> Result<Response, AppError> {
    let request_id = &ctx.data;
    let now = now_ms();
    let auth = authenticate(&req, &ctx.env, now).await?;
    let id = ctx
        .param("id")
        .ok_or_else(|| AppError::NotFound("Connection not found.".to_string()))?
        .to_string();

    let db = d1(&ctx.env)?;
    let conn = connections::get_connection(&db, &auth.org_id, &id)
        .await?
        .ok_or_else(|| AppError::NotFound("Connection not found.".to_string()))?;

    let app_id = AppId::from_str(&conn.application_id)
        .map_err(|e| AppError::Internal(format!("Invalid stored app id: {e}")))?;

    let cred = credentials::get_credential(&db, &auth.org_id, &conn.credential_id)
        .await?
        .ok_or_else(|| AppError::Internal("Missing credential record.".to_string()))?;

    let master_key = load_master_key(&ctx.env, cred.key_version)?;
    let aad = make_credential_aad(&auth.org_id, &cred.id, &cred.kind);
    let secret = decrypt_secret(&master_key, &cred.ciphertext, &cred.nonce, &aad)?;

    let cx = Cx {
        env: &ctx.env,
        org_id: &auth.org_id,
        request_id,
    };

    let result = match run_connector_test(app_id, &cx, &secret).await {
        Ok(message) => {
            connections::update_connection_status(
                &db,
                &auth.org_id,
                &id,
                ConnectionStatus::Connected,
                now,
            )
            .await?;
            TestConnectionResponse { ok: true, message }
        }
        Err(err) => {
            log_structured(
                "warn",
                "connection_test_failed",
                request_id,
                Some(&auth.org_id),
                None,
                Some(&err.internal_detail),
            );
            if matches!(err.class, ErrorClass::NeedsReconnect) {
                connections::update_connection_status(
                    &db,
                    &auth.org_id,
                    &id,
                    ConnectionStatus::NeedsAttention,
                    now,
                )
                .await?;
            }
            TestConnectionResponse {
                ok: false,
                message: err.user_message,
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

pub async fn field_options(
    req: Request,
    ctx: RouteContext<String>,
) -> Result<Response, AppError> {
    let request_id = &ctx.data;
    let now = now_ms();
    let auth = authenticate(&req, &ctx.env, now).await?;
    let id = ctx
        .param("id")
        .ok_or_else(|| AppError::NotFound("Connection not found.".to_string()))?
        .to_string();
    let field_key = ctx
        .param("fieldKey")
        .ok_or_else(|| AppError::BadRequest("Missing field key.".to_string()))?
        .to_string();

    let parent = req.url().ok().and_then(|u| {
        u.query_pairs()
            .find(|(k, _)| k == "parent")
            .map(|(_, v)| v.into_owned())
            .filter(|s| !s.trim().is_empty())
    });

    let db = d1(&ctx.env)?;
    let conn = connections::get_connection(&db, &auth.org_id, &id)
        .await?
        .ok_or_else(|| AppError::NotFound("Connection not found.".to_string()))?;

    let app_id = AppId::from_str(&conn.application_id)
        .map_err(|e| AppError::Internal(format!("Invalid stored app id: {e}")))?;

    let cred = credentials::get_credential(&db, &auth.org_id, &conn.credential_id)
        .await?
        .ok_or_else(|| AppError::Internal("Missing credential record.".to_string()))?;

    let master_key = load_master_key(&ctx.env, cred.key_version)?;
    let aad = make_credential_aad(&auth.org_id, &cred.id, &cred.kind);
    let secret = decrypt_secret(&master_key, &cred.ciphertext, &cred.nonce, &aad)?;

    let cx = Cx {
        env: &ctx.env,
        org_id: &auth.org_id,
        request_id,
    };

    let connector = get_connector(app_id);
    match connector
        .field_options(&cx, &secret, &field_key, parent.as_deref())
        .await
    {
        Ok(options) => Ok(json_response(
            200,
            &OptionsResponse { options },
            request_id,
            auth.refreshed_cookie.as_deref(),
        )?),
        Err(err) => {
            log_structured(
                "warn",
                "field_options_failed",
                request_id,
                Some(&auth.org_id),
                None,
                Some(&err.internal_detail),
            );
            if matches!(err.class, ErrorClass::NeedsReconnect) {
                let _ = connections::update_connection_status(
                    &db,
                    &auth.org_id,
                    &id,
                    ConnectionStatus::NeedsAttention,
                    now,
                )
                .await;
            }
            Err(AppError::BadRequest(err.user_message))
        }
    }
}

pub async fn delete_connection(
    req: Request,
    ctx: RouteContext<String>,
) -> Result<Response, AppError> {
    let request_id = &ctx.data;
    let now = now_ms();
    let auth = authenticate(&req, &ctx.env, now).await?;
    let id = ctx
        .param("id")
        .ok_or_else(|| AppError::NotFound("Connection not found.".to_string()))?;

    let db = d1(&ctx.env)?;
    let deleted = connections::delete_connection(&db, &auth.org_id, id).await?;
    if !deleted {
        return Err(AppError::NotFound("Connection not found.".to_string()));
    }

    let _ = audit::insert_audit_log(
        &db,
        &auth.org_id,
        Some(&auth.user_id),
        "connection.deleted",
        Some("connection"),
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
