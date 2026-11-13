use std::collections::BTreeMap;
use std::str::FromStr;

use serde::Deserialize;
use serde_json::json;
use url::Url;
use worker::{Request, Response, RouteContext};

use crate::api_types::{AppId, ConnectionStatus, OAuthStartRequest, OAuthStartResponse};
use crate::connectors::clickup::get_env_secret_or_var;
use crate::connectors::{get_connector, AuthSpec, Cx};
use crate::crypto::{
    encrypt_secret, load_master_key, make_credential_aad, new_id, random_token_b64url,
    sha256_hex, PREFIX_CONNECTION, PREFIX_CREDENTIAL,
};
use crate::db::{audit, connections, credentials, d1, d1_i64, d1_opt_str};
use crate::http::{
    authenticate, json_response, log_structured, now_ms, read_body_limited, AppError,
    MAX_API_BODY_BYTES,
};

const OAUTH_STATE_TTL_MS: i64 = 10 * 60 * 1000; // 10 minutes
const CURRENT_KEY_VERSION: i32 = 1;

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

pub fn sanitize_return_to(raw: Option<&str>) -> Result<String, AppError> {
    let Some(val) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok("/connections".to_string());
    };
    if val.len() > 512
        || !val.starts_with('/')
        || val.starts_with("//")
        || val.starts_with("/\\")
        || val.contains('\r')
        || val.contains('\n')
        || val.contains('\0')
        || val.contains('\\')
    {
        let mut fields = BTreeMap::new();
        fields.insert(
            "returnTo".to_string(),
            "Return path must be a relative path starting with '/'.".to_string(),
        );
        return Err(AppError::Validation {
            message: "Invalid return path.".to_string(),
            fields: Some(fields),
        });
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
    let (authorize_url, scopes) = match connector.auth() {
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

    let raw_body = read_body_limited(&mut req, MAX_API_BODY_BYTES).await?;
    let body: OAuthStartRequest = if raw_body.is_empty() {
        OAuthStartRequest { return_to: None }
    } else {
        serde_json::from_slice(&raw_body)
            .map_err(|_| AppError::BadRequest("Invalid JSON request body.".to_string()))?
    };

    let return_to = sanitize_return_to(body.return_to.as_deref())?;

    let client_id_env = match app_id {
        AppId::Clickup => "CLICKUP_CLIENT_ID",
        AppId::Slack => "SLACK_CLIENT_ID",
        _ => unreachable!(),
    };
    let client_id = get_env_secret_or_var(&ctx.env, client_id_env).ok_or_else(|| {
        AppError::BadRequest(format!(
            "{} OAuth is not configured on this server yet.",
            connector.name()
        ))
    })?;

    let app_origin = get_env_secret_or_var(&ctx.env, "APP_ORIGIN")
        .unwrap_or_else(|| "http://localhost:8787".to_string());
    let callback_uri = format!(
        "{}/api/oauth/{}/callback",
        app_origin.trim_end_matches('/'),
        app_id.as_str()
    );

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

    let mut auth_url = Url::parse(authorize_url)
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
        assert!(sanitize_return_to(Some("/connections\r\nSet-Cookie: a=b")).is_err());
    }
}
