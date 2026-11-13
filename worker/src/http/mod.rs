use std::collections::BTreeMap;

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::json;
use worker::{console_error, console_log, Date, Env, Headers, Request, Response};

use crate::api_types::{ApiError, ApiErrorBody, ErrorCode};
use crate::auth::password::PasswordError;
use crate::auth::session::{
    extract_cookie_token, CookieConfig, SESSION_REFRESH_THRESHOLD_MS, SESSION_TTL_MS,
    SESSION_TTL_SECS,
};
use crate::crypto::{new_id, sha256_hex, CryptoError, PREFIX_REQUEST};
use crate::db::{d1, sessions, DbError};

pub const MAX_API_BODY_BYTES: usize = 64 * 1024;
pub const MAX_HOOK_BODY_BYTES: usize = 256 * 1024;

pub fn now_ms() -> i64 {
    Date::now().as_millis() as i64
}

pub fn new_request_id() -> String {
    new_id(PREFIX_REQUEST).unwrap_or_else(|_| "req_fallback".to_string())
}

pub fn log_structured(
    level: &str,
    event: &str,
    request_id: &str,
    org_id: Option<&str>,
    status: Option<u16>,
    detail: Option<&str>,
) {
    let payload = json!({
        "level": level,
        "event": event,
        "requestId": request_id,
        "orgId": org_id,
        "status": status,
        "detail": detail,
    });
    if level == "error" {
        console_error!("{}", payload);
    } else {
        console_log!("{}", payload);
    }
}

#[derive(Debug)]
pub enum AppError {
    Unauthenticated(String),
    Forbidden(String),
    NotFound(String),
    BadRequest(String),
    PayloadTooLarge(String),
    Validation {
        message: String,
        fields: Option<BTreeMap<String, String>>,
    },
    Conflict(String),
    RateLimited(String),
    NotImplemented(String),
    Internal(String),
}

impl AppError {
    pub fn status_and_code(&self) -> (u16, ErrorCode) {
        match self {
            AppError::Unauthenticated(_) => (401, ErrorCode::Unauthenticated),
            AppError::Forbidden(_) => (403, ErrorCode::Forbidden),
            AppError::NotFound(_) => (404, ErrorCode::NotFound),
            AppError::BadRequest(_) => (400, ErrorCode::ValidationFailed),
            AppError::PayloadTooLarge(_) => (413, ErrorCode::ValidationFailed),
            AppError::Validation { .. } => (422, ErrorCode::ValidationFailed),
            AppError::Conflict(_) => (409, ErrorCode::Conflict),
            AppError::RateLimited(_) => (429, ErrorCode::RateLimited),
            AppError::NotImplemented(_) => (501, ErrorCode::Internal),
            AppError::Internal(_) => (500, ErrorCode::Internal),
        }
    }

    pub fn into_response(self, request_id: &str) -> worker::Result<Response> {
        let (status, code) = self.status_and_code();
        let (message, fields) = match self {
            AppError::Unauthenticated(m)
            | AppError::Forbidden(m)
            | AppError::NotFound(m)
            | AppError::BadRequest(m)
            | AppError::PayloadTooLarge(m)
            | AppError::Conflict(m)
            | AppError::RateLimited(m)
            | AppError::NotImplemented(m) => (m, None),
            AppError::Validation { message, fields } => (message, fields),
            AppError::Internal(internal_msg) => {
                log_structured(
                    "error",
                    "internal_error",
                    request_id,
                    None,
                    Some(500),
                    Some(&internal_msg),
                );
                (
                    "An internal error occurred. Please try again.".to_string(),
                    None,
                )
            }
        };

        let body = ApiError {
            error: ApiErrorBody {
                code,
                message,
                fields,
                request_id: request_id.to_string(),
            },
        };
        json_response(status, &body, request_id, None)
    }
}

impl From<DbError> for AppError {
    fn from(e: DbError) -> Self {
        AppError::Internal(e.to_string())
    }
}

impl From<CryptoError> for AppError {
    fn from(e: CryptoError) -> Self {
        AppError::Internal(e.to_string())
    }
}

impl From<PasswordError> for AppError {
    fn from(e: PasswordError) -> Self {
        AppError::Internal(e.to_string())
    }
}

impl From<worker::Error> for AppError {
    fn from(e: worker::Error) -> Self {
        AppError::Internal(e.to_string())
    }
}

#[derive(Debug, Clone)]
pub struct AuthSession {
    pub user_id: String,
    pub org_id: String,
    pub token_hash: String,
    pub refreshed_cookie: Option<String>,
}

pub async fn authenticate(
    req: &Request,
    env: &Env,
    now: i64,
) -> Result<AuthSession, AppError> {
    let cookie_cfg = CookieConfig::from_env(env);
    let raw_token = extract_cookie_token(req, cookie_cfg.name)
        .ok_or_else(|| AppError::Unauthenticated("Authentication required.".to_string()))?;

    let token_hash = sha256_hex(raw_token.as_bytes());
    let db = d1(env)?;
    let session = sessions::find_valid_session(&db, &token_hash, now)
        .await?
        .ok_or_else(|| AppError::Unauthenticated("Session expired or invalid.".to_string()))?;

    let refreshed_cookie = if session.expires_at - now < SESSION_REFRESH_THRESHOLD_MS {
        let new_expires_at = now + SESSION_TTL_MS;
        sessions::touch_session_expiry(&db, &token_hash, &session.org_id, new_expires_at).await?;
        Some(cookie_cfg.format_set_cookie(&raw_token, SESSION_TTL_SECS))
    } else {
        None
    };

    Ok(AuthSession {
        user_id: session.user_id,
        org_id: session.org_id,
        token_hash,
        refreshed_cookie,
    })
}

pub async fn read_body_limited(req: &mut Request, max_bytes: usize) -> Result<Vec<u8>, AppError> {
    if let Ok(Some(cl)) = req.headers().get("Content-Length") {
        if let Ok(len) = cl.trim().parse::<usize>() {
            if len > max_bytes {
                return Err(AppError::PayloadTooLarge(format!(
                    "Request body exceeds {max_bytes} byte limit."
                )));
            }
        }
    }

    let bytes = req
        .bytes()
        .await
        .map_err(|_| AppError::BadRequest("Unable to read request body.".to_string()))?;

    if bytes.len() > max_bytes {
        return Err(AppError::PayloadTooLarge(format!(
            "Request body exceeds {max_bytes} byte limit."
        )));
    }
    Ok(bytes)
}

pub async fn read_json_limited<T: DeserializeOwned>(
    req: &mut Request,
    max_bytes: usize,
) -> Result<T, AppError> {
    let bytes = read_body_limited(req, max_bytes).await?;
    serde_json::from_slice(&bytes)
        .map_err(|_| AppError::BadRequest("Invalid JSON request body.".to_string()))
}

pub fn json_response<T: Serialize>(
    status: u16,
    body: &T,
    request_id: &str,
    set_cookie: Option<&str>,
) -> worker::Result<Response> {
    let mut resp = Response::from_json(body)?.with_status(status);
    let headers = Headers::new();
    headers.set("Content-Type", "application/json; charset=utf-8")?;
    headers.set("Cache-Control", "no-store")?;
    headers.set("X-Request-Id", request_id)?;
    if let Some(cookie) = set_cookie {
        headers.set("Set-Cookie", cookie)?;
    }
    resp = resp.with_headers(headers);
    Ok(resp)
}

pub fn empty_response(
    status: u16,
    request_id: &str,
    set_cookie: Option<&str>,
) -> worker::Result<Response> {
    let mut resp = Response::empty()?.with_status(status);
    let headers = Headers::new();
    headers.set("Cache-Control", "no-store")?;
    headers.set("X-Request-Id", request_id)?;
    if let Some(cookie) = set_cookie {
        headers.set("Set-Cookie", cookie)?;
    }
    resp = resp.with_headers(headers);
    Ok(resp)
}
