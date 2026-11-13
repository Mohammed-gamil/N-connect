use std::collections::BTreeMap;
use std::str::FromStr;

use serde::Deserialize;
use serde_json::json;
use url::Url;
use worker::{Env, Request, Response, RouteContext};

use crate::api_types::{
    AppId, ConnectionStatus, OAuthAppConfigSource, OAuthAppConfigStatus, OAuthAppsResponse,
    OAuthStartRequest, OAuthStartResponse, SaveOAuthAppConfigRequest,
};
use crate::connectors::clickup::get_env_secret_or_var;
use crate::connectors::{get_connector, AuthSpec, Cx};
use crate::crypto::{
    decrypt_secret, encrypt_secret, load_master_key, make_credential_aad, make_oauth_app_aad,
    new_id, random_token_b64url, sha256_hex, Secret, PREFIX_CONNECTION, PREFIX_CREDENTIAL,
};
use crate::db::{audit, connections, credentials, d1, d1_i64, d1_opt_str, oauth_apps};
use crate::http::{
    authenticate, empty_response, json_response, log_structured, now_ms, read_body_limited,
    read_json_limited, AppError, MAX_API_BODY_BYTES,
};

const OAUTH_STATE_TTL_MS: i64 = 10 * 60 * 1000; // 10 minutes
const CURRENT_KEY_VERSION: i32 = 1;
const MAX_CLIENT_ID_LEN: usize = 256;
const MAX_CLIENT_SECRET_LEN: usize = 2048;

#[derive(Debug, Deserialize)]
struct OAuthStateRow {
    #[allow(dead_code)]
    state_hash: String,
    org_id: String,
    user_id: String,
    #[allow(dead_code)]
    application_id: String,
    return_to: Option<String>,
    expires_at: i64,
}

#[derive(Debug, Deserialize)]
struct ExistingConnRow {
    id: String,
    credential_id: String,
}

fn oauth_env_keys(app_id: AppId) -> Option<(&'static str, &'static str)> {
    match app_id {
        AppId::Clickup => Some(("CLICKUP_CLIENT_ID", "CLICKUP_CLIENT_SECRET")),
        AppId::Slack => Some(("SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET")),
        AppId::Webhook | AppId::Http => None,
    }
}

fn app_origin_str(env: &Env) -> String {
    get_env_secret_or_var(env, "APP_ORIGIN")
        .unwrap_or_else(|| "http://localhost:8787".to_string())
        .trim_end_matches('/')
        .to_string()
}

fn oauth_callback_uri(env: &Env, app_id: AppId) -> String {
    format!("{}/api/oauth/{}/callback", app_origin_str(env), app_id.as_str())
}

fn oauth_docs_hint(app_id: AppId) -> (&'static str, Vec<String>, &'static str) {
    match app_id {
        AppId::Clickup => (
            "ClickUp",
            vec![],
            "In ClickUp → Settings → ClickUp API (or Integrations) → Create an App, paste the Redirect URL above, then copy your Client ID and Client Secret.",
        ),
        AppId::Slack => (
            "Slack",
            vec![
                "chat:write".to_string(),
                "chat:write.public".to_string(),
                "channels:read".to_string(),
                "groups:read".to_string(),
            ],
            "In api.slack.com/apps → Create New App → OAuth & Permissions, add the Redirect URL and Bot Token Scopes above, then copy Client ID and Client Secret from Basic Information.",
        ),
        AppId::Webhook | AppId::Http => ("App", vec![], ""),
    }
}

fn has_server_oauth_env(env: &Env, app_id: AppId) -> bool {
    let Some((id_key, sec_key)) = oauth_env_keys(app_id) else {
        return false;
    };
    get_env_secret_or_var(env, id_key).is_some()
        && get_env_secret_or_var(env, sec_key).is_some()
}

/// Resolves `(client_id, client_secret, source)` for an OAuth app:
/// 1. Organization-configured encrypted OAuth app in D1 (`org_oauth_apps`)
/// 2. Server-level env vars/secrets (`CLICKUP_CLIENT_ID`/`SECRET` or `SLACK_CLIENT_ID`/`SECRET`)
pub async fn resolve_oauth_credentials(
    env: &Env,
    org_id: &str,
    app_id: AppId,
) -> Result<Option<(String, Secret, OAuthAppConfigSource)>, AppError> {
    let Some((id_key, sec_key)) = oauth_env_keys(app_id) else {
        return Ok(None);
    };

    let db = d1(env)?;
    if let Some(row) = oauth_apps::get_org_oauth_app(&db, org_id, app_id.as_str()).await? {
        let master_key = load_master_key(env, row.key_version)?;
        let aad = make_oauth_app_aad(org_id, app_id.as_str());
        let client_secret = decrypt_secret(&master_key, &row.ciphertext, &row.nonce, &aad)?;
        return Ok(Some((
            row.client_id,
            client_secret,
            OAuthAppConfigSource::Organization,
        )));
    }

    if let (Some(cid), Some(csec)) = (
        get_env_secret_or_var(env, id_key),
        get_env_secret_or_var(env, sec_key),
    ) {
        return Ok(Some((
            cid,
            Secret::from_string(csec),
            OAuthAppConfigSource::Server,
        )));
    }

    Ok(None)
}

fn build_oauth_status(
    env: &Env,
    app_id: AppId,
    org_row: Option<&oauth_apps::OrgOAuthAppRow>,
) -> OAuthAppConfigStatus {
    let (name, required_scopes, docs_hint) = oauth_docs_hint(app_id);
    let redirect_url = oauth_callback_uri(env, app_id);
    if let Some(row) = org_row {
        OAuthAppConfigStatus {
            application_id: app_id,
            name: name.to_string(),
            configured: true,
            source: OAuthAppConfigSource::Organization,
            client_id: Some(row.client_id.clone()),
            redirect_url,
            required_scopes,
            docs_hint: docs_hint.to_string(),
            updated_at: Some(row.updated_at),
        }
    } else if has_server_oauth_env(env, app_id) {
        OAuthAppConfigStatus {
            application_id: app_id,
            name: name.to_string(),
            configured: true,
            source: OAuthAppConfigSource::Server,
            client_id: None,
            redirect_url,
            required_scopes,
            docs_hint: docs_hint.to_string(),
            updated_at: None,
        }
    } else {
        OAuthAppConfigStatus {
            application_id: app_id,
            name: name.to_string(),
            configured: false,
            source: OAuthAppConfigSource::None,
            client_id: None,
            redirect_url,
            required_scopes,
            docs_hint: docs_hint.to_string(),
            updated_at: None,
        }
    }
}

pub async fn list_oauth_apps(
    req: Request,
    ctx: RouteContext<String>,
) -> Result<Response, AppError> {
    let request_id = &ctx.data;
    let now = now_ms();
    let auth = authenticate(&req, &ctx.env, now).await?;
    let db = d1(&ctx.env)?;

    let rows = oauth_apps::list_org_oauth_apps(&db, &auth.org_id).await?;
    let apps = [AppId::Clickup, AppId::Slack]
        .into_iter()
        .map(|app_id| {
            let row = rows.iter().find(|r| r.application_id == app_id.as_str());
            build_oauth_status(&ctx.env, app_id, row)
        })
        .collect();

    Ok(json_response(
        200,
        &OAuthAppsResponse { apps },
        request_id,
        auth.refreshed_cookie.as_deref(),
    )?)
}

pub async fn upsert_oauth_app(
    mut req: Request,
    ctx: RouteContext<String>,
) -> Result<Response, AppError> {
    let request_id = &ctx.data;
    let now = now_ms();
    let auth = authenticate(&req, &ctx.env, now).await?;

    let app_str = ctx
        .param("appId")
        .ok_or_else(|| AppError::NotFound("Application not found.".to_string()))?;
    let app_id = AppId::from_str(app_str)
        .map_err(|_| AppError::NotFound("Application not found.".to_string()))?;
    if !matches!(app_id, AppId::Clickup | AppId::Slack) {
        return Err(AppError::NotFound("Application not found.".to_string()));
    }

    let body: SaveOAuthAppConfigRequest = read_json_limited(&mut req, MAX_API_BODY_BYTES).await?;
    let client_id = body.client_id.trim();
    let client_secret_opt = body
        .client_secret
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let db = d1(&ctx.env)?;
    let existing = oauth_apps::get_org_oauth_app(&db, &auth.org_id, app_id.as_str()).await?;

    let mut fields = BTreeMap::new();
    if client_id.is_empty() {
        fields.insert("clientId".to_string(), "Please enter the OAuth Client ID.".to_string());
    } else if client_id.len() > MAX_CLIENT_ID_LEN || client_id.chars().any(|c| c.is_control()) {
        fields.insert(
            "clientId".to_string(),
            "Client ID is invalid or exceeds 256 characters.".to_string(),
        );
    }

    if let Some(sec) = client_secret_opt {
        if sec.len() > MAX_CLIENT_SECRET_LEN || sec.chars().any(|c| c.is_control()) {
            fields.insert(
                "clientSecret".to_string(),
                "Client Secret is invalid or too long.".to_string(),
            );
        }
    } else if existing.is_none() {
        fields.insert(
            "clientSecret".to_string(),
            "Please enter the OAuth Client Secret.".to_string(),
        );
    }

    if !fields.is_empty() {
        return Err(AppError::Validation {
            message: "Please check your OAuth app credentials.".to_string(),
            fields: Some(fields),
        });
    }

    let master_key = load_master_key(&ctx.env, CURRENT_KEY_VERSION)?;
    let aad = make_oauth_app_aad(&auth.org_id, app_id.as_str());

    let (ciphertext, nonce, key_version) = if let Some(sec) = client_secret_opt {
        let secret = Secret::from_str_slice(sec);
        let blob = encrypt_secret(&master_key, CURRENT_KEY_VERSION, &secret, &aad)?;
        (blob.ciphertext, blob.nonce.to_vec(), blob.key_version)
    } else {
        let prev = existing.expect("checked above");
        (prev.ciphertext, prev.nonce, prev.key_version)
    };

    oauth_apps::upsert_org_oauth_app(
        &db,
        &auth.org_id,
        app_id.as_str(),
        client_id,
        &ciphertext,
        &nonce,
        key_version,
        &auth.user_id,
        now,
    )
    .await?;

    let meta_json = json!({ "applicationId": app_id.as_str() }).to_string();
    let _ = audit::insert_audit_log(
        &db,
        &auth.org_id,
        Some(&auth.user_id),
        "oauth_app.configured",
        Some("oauth_app"),
        Some(app_id.as_str()),
        Some(&meta_json),
        now,
    )
    .await;

    let saved = oauth_apps::get_org_oauth_app(&db, &auth.org_id, app_id.as_str()).await?;
    let status = build_oauth_status(&ctx.env, app_id, saved.as_ref());

    Ok(json_response(
        200,
        &status,
        request_id,
        auth.refreshed_cookie.as_deref(),
    )?)
}

pub async fn delete_oauth_app(
    req: Request,
    ctx: RouteContext<String>,
) -> Result<Response, AppError> {
    let request_id = &ctx.data;
    let now = now_ms();
    let auth = authenticate(&req, &ctx.env, now).await?;

    let app_str = ctx
        .param("appId")
        .ok_or_else(|| AppError::NotFound("Application not found.".to_string()))?;
    let app_id = AppId::from_str(app_str)
        .map_err(|_| AppError::NotFound("Application not found.".to_string()))?;
    if !matches!(app_id, AppId::Clickup | AppId::Slack) {
        return Err(AppError::NotFound("Application not found.".to_string()));
    }

    let db = d1(&ctx.env)?;
    let removed = oauth_apps::delete_org_oauth_app(&db, &auth.org_id, app_id.as_str()).await?;
    if removed {
        let meta_json = json!({ "applicationId": app_id.as_str() }).to_string();
        let _ = audit::insert_audit_log(
            &db,
            &auth.org_id,
            Some(&auth.user_id),
            "oauth_app.removed",
            Some("oauth_app"),
            Some(app_id.as_str()),
            Some(&meta_json),
            now,
        )
        .await;
    }

    Ok(empty_response(
        204,
        request_id,
        auth.refreshed_cookie.as_deref(),
    )?)
}

fn invalid_return_to_error() -> AppError {
    let mut fields = BTreeMap::new();
    fields.insert(
        "returnTo".to_string(),
        "Return path must be a relative path starting with '/'.".to_string(),
    );
    AppError::Validation {
        message: "Invalid return path.".to_string(),
        fields: Some(fields),
    }
}

pub fn sanitize_return_to(raw: Option<&str>) -> Result<String, AppError> {
    let Some(val) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok("/connections".to_string());
    };
    if val.len() > 512
        || !val.starts_with('/')
        || val.starts_with("//")
        || val.starts_with("/\\")
        || val.chars().any(|c| c.is_control())
        || val.contains('\\')
    {
        return Err(invalid_return_to_error());
    }
    let probe = Url::parse(&format!("https://origin.invalid{val}"))
        .map_err(|_| invalid_return_to_error())?;
    if probe.scheme() != "https"
        || probe.host_str() != Some("origin.invalid")
        || !probe.username().is_empty()
        || probe.password().is_some()
        || probe.path().starts_with("//")
        || !probe.path().starts_with('/')
    {
        return Err(invalid_return_to_error());
    }
    Ok(val.to_string())
}

fn build_redirect_url(app_origin: &str, return_to: &str, key: &str, value: &str) -> Result<Url, AppError> {
    let base = format!(
        "{}{}",
        app_origin.trim_end_matches('/'),
        return_to
    );
    let mut u = Url::parse(&base).map_err(|e| AppError::Internal(format!("Invalid redirect URL: {e}")))?;
    u.query_pairs_mut().append_pair(key, value);
    Ok(u)
}

fn redirect_302(url: Url) -> Result<Response, AppError> {
    Response::redirect(url).map_err(AppError::from)
}

fn sanitize_error_code(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .take(40)
        .collect();
    if cleaned.is_empty() {
        "oauth_failed".to_string()
    } else {
        cleaned
    }
}

pub async fn oauth_start(
    mut req: Request,
    ctx: RouteContext<String>,
) -> Result<Response, AppError> {
    let request_id = &ctx.data;
    let now = now_ms();
    let auth = authenticate(&req, &ctx.env, now).await?;

    let app_str = ctx
        .param("appId")
        .ok_or_else(|| AppError::NotFound("Application not found.".to_string()))?;
    let app_id = AppId::from_str(app_str)
        .map_err(|_| AppError::NotFound("Application not found.".to_string()))?;

    let connector = get_connector(app_id);
    let (default_authorize_url, scopes) = match connector.auth() {
        AuthSpec::OAuth2 {
            authorize_url,
            scopes,
            ..
        } => (authorize_url, scopes),
        _ => {
            return Err(AppError::BadRequest(
                "This application does not use OAuth2.".to_string(),
            ));
        }
    };
    let authorize_url = match app_id {
        AppId::Clickup => crate::connectors::clickup::oauth_authorize_url(&ctx.env),
        AppId::Slack => crate::connectors::slack::oauth_authorize_url(&ctx.env),
        _ => default_authorize_url.to_string(),
    };

    let raw_body = read_body_limited(&mut req, MAX_API_BODY_BYTES).await?;
    let body: OAuthStartRequest = if raw_body.is_empty() {
        OAuthStartRequest { return_to: None }
    } else {
        serde_json::from_slice(&raw_body)
            .map_err(|_| AppError::BadRequest("Invalid JSON request body.".to_string()))?
    };

    let return_to = sanitize_return_to(body.return_to.as_deref())?;

    let (client_id, _client_secret, _source) =
        resolve_oauth_credentials(&ctx.env, &auth.org_id, app_id)
            .await?
            .ok_or_else(|| {
                AppError::BadRequest(format!(
                    "{} OAuth is not configured yet. Configure your OAuth Client ID & Secret or connect with a token.",
                    connector.name()
                ))
            })?;

    let callback_uri = oauth_callback_uri(&ctx.env, app_id);

    let raw_state = random_token_b64url(32)?;
    let state_hash = sha256_hex(raw_state.as_bytes());
    let expires_at = now + OAUTH_STATE_TTL_MS;

    let db = d1(&ctx.env)?;
    db.prepare(
        "INSERT INTO oauth_states (state_hash, org_id, user_id, application_id, return_to, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )
    .bind(&[
        state_hash.into(),
        auth.org_id.clone().into(),
        auth.user_id.clone().into(),
        app_id.as_str().into(),
        d1_opt_str(Some(&return_to)),
        d1_i64(expires_at),
    ])?
    .run()
    .await
    .map_err(crate::db::DbError::from)?;

    let mut auth_url = Url::parse(&authorize_url)
        .map_err(|e| AppError::Internal(format!("Invalid authorize URL: {e}")))?;
    {
        let mut qp = auth_url.query_pairs_mut();
        qp.append_pair("client_id", &client_id);
        if !scopes.is_empty() {
            qp.append_pair("scope", &scopes.join(","));
        }
        qp.append_pair("redirect_uri", &callback_uri);
        qp.append_pair("state", &raw_state);
    }

    Ok(json_response(
        200,
        &OAuthStartResponse {
            redirect_url: auth_url.to_string(),
        },
        request_id,
        auth.refreshed_cookie.as_deref(),
    )?)
}

pub async fn oauth_callback(
    req: Request,
    ctx: RouteContext<String>,
) -> Result<Response, AppError> {
    let request_id = &ctx.data;
    let now = now_ms();
    let app_origin = get_env_secret_or_var(&ctx.env, "APP_ORIGIN")
        .unwrap_or_else(|| "http://localhost:8787".to_string());

    let Some(app_str) = ctx.param("appId") else {
        let u = build_redirect_url(&app_origin, "/connections", "connectError", "invalid_app")?;
        return redirect_302(u);
    };
    let Ok(app_id) = AppId::from_str(app_str) else {
        let u = build_redirect_url(&app_origin, "/connections", "connectError", "invalid_app")?;
        return redirect_302(u);
    };
    let connector = get_connector(app_id);
    if !matches!(connector.auth(), AuthSpec::OAuth2 { .. }) {
        let u = build_redirect_url(&app_origin, "/connections", "connectError", "invalid_app")?;
        return redirect_302(u);
    }

    let req_url = req
        .url()
        .map_err(|_| AppError::BadRequest("Invalid callback URL.".to_string()))?;

    let mut code: Option<String> = None;
    let mut state: Option<String> = None;
    let mut oauth_error: Option<String> = None;

    for (k, v) in req_url.query_pairs() {
        match k.as_ref() {
            "code" => code = Some(v.into_owned()),
            "state" => state = Some(v.into_owned()),
            "error" => oauth_error = Some(v.into_owned()),
            _ => {}
        }
    }

    let Some(raw_state) = state.filter(|s| !s.trim().is_empty()) else {
        let u = build_redirect_url(&app_origin, "/connections", "connectError", "invalid_state")?;
        return redirect_302(u);
    };

    let state_hash = sha256_hex(raw_state.as_bytes());
    let db = d1(&ctx.env)?;

    let maybe_state: Option<OAuthStateRow> = db
        .prepare(
            "SELECT state_hash, org_id, user_id, application_id, return_to, expires_at
             FROM oauth_states
             WHERE state_hash = ?1 AND application_id = ?2",
        )
        .bind(&[state_hash.clone().into(), app_id.as_str().into()])?
        .first(None)
        .await
        .map_err(crate::db::DbError::from)?;

    let del_res = db
        .prepare("DELETE FROM oauth_states WHERE state_hash = ?1 AND application_id = ?2")
        .bind(&[state_hash.into(), app_id.as_str().into()])?
        .run()
        .await
        .map_err(crate::db::DbError::from)?;

    let deleted_rows = del_res
        .meta()
        .ok()
        .flatten()
        .and_then(|m| m.changes)
        .unwrap_or(0);

    let Some(state_row) = maybe_state.filter(|_| deleted_rows == 1) else {
        let u = build_redirect_url(&app_origin, "/connections", "connectError", "invalid_state")?;
        return redirect_302(u);
    };

    let return_to = sanitize_return_to(state_row.return_to.as_deref())
        .unwrap_or_else(|_| "/connections".to_string());

    if state_row.expires_at <= now {
        let u = build_redirect_url(&app_origin, &return_to, "connectError", "state_expired")?;
        return redirect_302(u);
    }

    if let Some(err_str) = oauth_error.filter(|s| !s.trim().is_empty()) {
        let code_param = sanitize_error_code(&err_str);
        let u = build_redirect_url(&app_origin, &return_to, "connectError", &code_param)?;
        return redirect_302(u);
    }

    let Some(auth_code) = code.filter(|s| !s.trim().is_empty()) else {
        let u = build_redirect_url(&app_origin, &return_to, "connectError", "missing_code")?;
        return redirect_302(u);
    };

    let cx = Cx {
        env: &ctx.env,
        org_id: &state_row.org_id,
        request_id,
    };

    let new_conn = match connector.complete_oauth(&cx, &auth_code).await {
        Ok(c) => c,
        Err(e) => {
            log_structured(
                "warn",
                "oauth_exchange_failed",
                request_id,
                Some(&state_row.org_id),
                None,
                Some(&e.internal_detail),
            );
            let u = build_redirect_url(&app_origin, &return_to, "connectError", "oauth_failed")?;
            return redirect_302(u);
        }
    };

    let master_key = load_master_key(&ctx.env, CURRENT_KEY_VERSION)?;

    // If a connection already exists for the same external account in this org, update & reconnect it.
    let existing: Option<ExistingConnRow> = if let Some(ref ext_id) = new_conn.external_account_id {
        db.prepare(
            "SELECT id, credential_id
             FROM connections
             WHERE org_id = ?1 AND application_id = ?2 AND external_account_id = ?3
             LIMIT 1",
        )
        .bind(&[
            state_row.org_id.clone().into(),
            app_id.as_str().into(),
            ext_id.clone().into(),
        ])?
        .first(None)
        .await
        .map_err(crate::db::DbError::from)?
    } else {
        None
    };

    let con_id = if let Some(existing) = existing {
        let aad = make_credential_aad(&state_row.org_id, &existing.credential_id, "oauth_token");
        let blob = encrypt_secret(&master_key, CURRENT_KEY_VERSION, &new_conn.credential, &aad)?;
        credentials::rotate_credential(
            &db,
            &state_row.org_id,
            &existing.credential_id,
            &blob.ciphertext,
            &blob.nonce,
            blob.key_version,
            now,
        )
        .await?;

        db.prepare(
            "UPDATE connections
             SET display_name = ?1, status = 'connected', updated_at = ?2
             WHERE id = ?3 AND org_id = ?4",
        )
        .bind(&[
            new_conn.display_name.into(),
            d1_i64(now),
            existing.id.clone().into(),
            state_row.org_id.clone().into(),
        ])?
        .run()
        .await
        .map_err(crate::db::DbError::from)?;

        let meta_json = json!({ "applicationId": app_id.as_str(), "reconnected": true }).to_string();
        let _ = audit::insert_audit_log(
            &db,
            &state_row.org_id,
            Some(&state_row.user_id),
            "connection.reconnected",
            Some("connection"),
            Some(&existing.id),
            Some(&meta_json),
            now,
        )
        .await;

        existing.id
    } else {
        let cred_id = new_id(PREFIX_CREDENTIAL)?;
        let con_id = new_id(PREFIX_CONNECTION)?;
        let aad = make_credential_aad(&state_row.org_id, &cred_id, "oauth_token");
        let blob = encrypt_secret(&master_key, CURRENT_KEY_VERSION, &new_conn.credential, &aad)?;

        credentials::insert_credential(
            &db,
            &cred_id,
            &state_row.org_id,
            "oauth_token",
            &blob.ciphertext,
            &blob.nonce,
            blob.key_version,
            now,
        )
        .await?;

        if let Err(e) = connections::create_connection(
            &db,
            &state_row.org_id,
            &con_id,
            app_id,
            &new_conn.display_name,
            new_conn.external_account_id.as_deref(),
            &cred_id,
            ConnectionStatus::Connected,
            &state_row.user_id,
            now,
        )
        .await
        {
            let _ = credentials::delete_credential(&db, &state_row.org_id, &cred_id).await;
            return Err(e.into());
        }

        let meta_json = json!({ "applicationId": app_id.as_str(), "kind": "oauth_token" }).to_string();
        let _ = audit::insert_audit_log(
            &db,
            &state_row.org_id,
            Some(&state_row.user_id),
            "connection.created",
            Some("connection"),
            Some(&con_id),
            Some(&meta_json),
            now,
        )
        .await;

        con_id
    };

    let redirect_url = build_redirect_url(&app_origin, &return_to, "connected", &con_id)?;
    redirect_302(redirect_url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_return_to_prevents_open_redirects() {
        assert_eq!(sanitize_return_to(None).unwrap(), "/connections");
        assert_eq!(sanitize_return_to(Some("   ")).unwrap(), "/connections");
        assert_eq!(
            sanitize_return_to(Some("/automations/new")).unwrap(),
            "/automations/new"
        );
        assert!(sanitize_return_to(Some("https://evil.com")).is_err());
        assert!(sanitize_return_to(Some("//evil.com")).is_err());
        assert!(sanitize_return_to(Some("/\\evil.com")).is_err());
        assert!(sanitize_return_to(Some("/\t/evil.com")).is_err());
        assert!(sanitize_return_to(Some("/..//evil.com")).is_err());
        assert!(sanitize_return_to(Some("/a/../..//evil.com")).is_err());
        assert!(sanitize_return_to(Some("/connections\r\nSet-Cookie: a=b")).is_err());
    }
}
