use base64::engine::general_purpose::STANDARD as B64_STD;
use base64::Engine as _;
use serde_json::{Map, Value};
use url::Url;
use worker::{Env, Headers};

use crate::api_types::{
    ActionDefinition, AppId, ConfigValue, FieldOption, HttpAuthConfig, HttpMethod,
    HttpTestRequest, HttpTestResult, TriggerDefinition,
};
use crate::crypto::{decrypt_secret, load_master_key, make_credential_aad, sha256_hex, Secret};
use crate::db::{connections, credentials, d1};
use crate::http::{now_ms, AppError};
use crate::ssrf::{self, SsrfError};
use crate::workflow::template::{render_template, EscapeMode};

use super::{
    ActionConfig, ActionOutput, AuthSpec, Catalog, Connector, ConnectorError, Cx,
    ExternalSubscription, NewConnection, NormalizedEvent, RenderedInputs, TriggerConfig,
    VerifyError,
};

const MAX_RESPONSE_PREVIEW_BYTES: usize = 4096;

pub struct HttpConnector;

fn to_worker_method(m: HttpMethod) -> worker::Method {
    match m {
        HttpMethod::Get => worker::Method::Get,
        HttpMethod::Post => worker::Method::Post,
        HttpMethod::Put => worker::Method::Put,
        HttpMethod::Patch => worker::Method::Patch,
        HttpMethod::Delete => worker::Method::Delete,
    }
}

fn parse_method_str(s: &str) -> Result<worker::Method, ConnectorError> {
    match s.trim().to_ascii_uppercase().as_str() {
        "GET" => Ok(worker::Method::Get),
        "POST" => Ok(worker::Method::Post),
        "PUT" => Ok(worker::Method::Put),
        "PATCH" => Ok(worker::Method::Patch),
        "DELETE" => Ok(worker::Method::Delete),
        other => Err(ConnectorError::user_fixable(
            format!("Unsupported HTTP method '{other}'."),
            format!("unsupported http method: {other}"),
        )),
    }
}

fn is_safe_header_token(s: &str) -> bool {
    !s.contains('\r') && !s.contains('\n') && !s.contains('\0')
}

fn format_basic_auth_value(raw: &str) -> String {
    if let Ok(v) = serde_json::from_str::<Value>(raw) {
        if let (Some(u), Some(p)) = (v["username"].as_str(), v["password"].as_str()) {
            let combined = format!("{u}:{p}");
            return format!("Basic {}", B64_STD.encode(combined.as_bytes()));
        }
        if let Some(tok) = v["token"].as_str() {
            return format!("Basic {}", B64_STD.encode(tok.as_bytes()));
        }
    }
    format!("Basic {}", B64_STD.encode(raw.as_bytes()))
}

fn extract_token_and_optional_header(raw: &str) -> (String, Option<String>) {
    if let Ok(v) = serde_json::from_str::<Value>(raw) {
        if let Some(obj) = v.as_object() {
            let tok = obj
                .get("token")
                .or_else(|| obj.get("apiKey"))
                .or_else(|| obj.get("value"))
                .and_then(|x| x.as_str())
                .unwrap_or(raw)
                .trim()
                .to_string();
            let hdr = obj
                .get("headerName")
                .and_then(|x| x.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            return (tok, hdr);
        }
    }
    (raw.trim().to_string(), None)
}

fn apply_auth_header_from_secret(
    auth_type: &str,
    header_override: Option<&str>,
    creds: &Secret,
    headers: &mut Vec<(String, String)>,
) -> Result<(), ConnectorError> {
    if auth_type == "none" || auth_type.is_empty() {
        return Ok(());
    }

    let raw = creds.expose_str().map_err(|_| {
        ConnectorError::needs_reconnect(
            "Saved HTTP credential is corrupted.",
            "invalid utf8 in http credential",
        )
    })?;
    if raw.trim().is_empty() {
        return Err(ConnectorError::needs_reconnect(
            "Please select or reconnect an HTTP credential for authentication.",
            "empty http credential for non-none authType",
        ));
    }

    match auth_type {
        "bearer" => {
            let (tok, _) = extract_token_and_optional_header(raw);
            let val = format!("Bearer {tok}");
            if !is_safe_header_token(&val) {
                return Err(ConnectorError::user_fixable(
                    "Stored bearer token contains invalid characters.",
                    "newline in bearer token",
                ));
            }
            headers.retain(|(k, _)| !k.eq_ignore_ascii_case("Authorization"));
            headers.push(("Authorization".to_string(), val));
        }
        "api_key" => {
            let (tok, cred_hdr) = extract_token_and_optional_header(raw);
            let header_name = header_override
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .or(cred_hdr)
                .unwrap_or_else(|| "X-Api-Key".to_string());
            if !is_safe_header_token(&header_name) || !is_safe_header_token(&tok) {
                return Err(ConnectorError::user_fixable(
                    "API key header or value contains invalid characters.",
                    "invalid characters in api_key header",
                ));
            }
            headers.retain(|(k, _)| !k.eq_ignore_ascii_case(&header_name));
            headers.push((header_name, tok));
        }
        "basic" => {
            let val = format_basic_auth_value(raw.trim());
            if !is_safe_header_token(&val) {
                return Err(ConnectorError::user_fixable(
                    "Stored basic credential contains invalid characters.",
                    "invalid characters in basic auth",
                ));
            }
            headers.retain(|(k, _)| !k.eq_ignore_ascii_case("Authorization"));
            headers.push(("Authorization".to_string(), val));
        }
        other => {
            return Err(ConnectorError::user_fixable(
                format!("Unsupported authentication type '{other}'."),
                format!("unsupported http authType: {other}"),
            ));
        }
    }
    Ok(())
}

pub fn classify_http_status(
    status: u16,
    auth_used: bool,
    headers: &[(String, String)],
    body: &[u8],
) -> Result<(), ConnectorError> {
    if (200..300).contains(&status) {
        return Ok(());
    }
    let preview = String::from_utf8_lossy(&body[..body.len().min(512)]);
    let retry_after_secs = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("Retry-After"))
        .and_then(|(_, v)| v.trim().parse::<u64>().ok());

    if status == 429 {
        return Err(ConnectorError::retryable(
            retry_after_secs,
            "The destination endpoint rate-limited the request (HTTP 429). We'll retry automatically.",
            format!("http 429: {preview}"),
        ));
    }
    if status >= 500 {
        return Err(ConnectorError::retryable(
            None,
            format!("The destination endpoint returned a server error (HTTP {status}). We'll retry automatically."),
            format!("http {status}: {preview}"),
        ));
    }
    if (300..400).contains(&status) {
        return Err(ConnectorError::user_fixable(
            format!("The destination URL returned a redirect (HTTP {status}), which is blocked for security."),
            format!("http redirect {status}: {preview}"),
        ));
    }
    if status == 401 || status == 403 {
        if auth_used {
            return Err(ConnectorError::needs_reconnect(
                format!("The destination rejected the saved credentials (HTTP {status}). Update or reconnect your HTTP credential."),
                format!("http {status}: {preview}"),
            ));
        }
        return Err(ConnectorError::user_fixable(
            format!("The destination endpoint refused the request (HTTP {status}). Add or check authentication settings."),
            format!("http {status}: {preview}"),
        ));
    }

    Err(ConnectorError::user_fixable(
        format!("The destination endpoint returned HTTP {status}. Check the URL, headers, and body."),
        format!("http {status}: {preview}"),
    ))
}

fn map_ssrf_to_connector_error(err: SsrfError) -> ConnectorError {
    match err {
        SsrfError::Timeout => ConnectorError::retryable(
            None,
            err.to_string(),
            "outbound http request timed out after 10s",
        ),
        SsrfError::FetchFailed(detail) => ConnectorError::retryable(
            None,
            "Could not reach the destination URL. We'll retry automatically.",
            detail,
        ),
        other => ConnectorError::user_fixable(other.to_string(), format!("ssrf blocked: {other}")),
    }
}

fn preview_from_bytes(bytes: &[u8]) -> String {
    let slice = &bytes[..bytes.len().min(MAX_RESPONSE_PREVIEW_BYTES)];
    String::from_utf8_lossy(slice).into_owned()
}

fn looks_like_json_request(headers: &[(String, String)], body: &str) -> bool {
    let ct_is_json = headers.iter().any(|(k, v)| {
        k.eq_ignore_ascii_case("Content-Type") && v.to_ascii_lowercase().contains("json")
    });
    if ct_is_json {
        return true;
    }
    let trimmed = body.trim_start();
    trimmed.starts_with('{') || trimmed.starts_with('[')
}

/// Executes `POST /api/http/test` with SSRF protection, template rendering, and credential lookup.
pub async fn test_http_request(
    env: &Env,
    org_id: &str,
    req: HttpTestRequest,
) -> Result<HttpTestResult, AppError> {
    let mut vars_map = Map::new();
    for (k, v) in &req.sample_variables {
        vars_map.insert(k.clone(), Value::String(v.clone()));
    }

    let rendered_url = render_template(&req.url, &vars_map, EscapeMode::None);
    let mut headers = Vec::with_capacity(req.headers.len() + 1);
    for pair in &req.headers {
        let key = pair.key.trim();
        if key.is_empty() {
            continue;
        }
        let val = render_template(&pair.value, &vars_map, EscapeMode::None);
        if !is_safe_header_token(key) || !is_safe_header_token(&val) {
            return Err(AppError::Validation {
                message: "Headers contain invalid newline characters.".to_string(),
                fields: None,
            });
        }
        headers.push((key.to_string(), val));
    }

    let rendered_body = req.body.as_ref().map(|b| {
        let mode = if looks_like_json_request(&headers, b) {
            EscapeMode::JsonString
        } else {
            EscapeMode::None
        };
        render_template(b, &vars_map, mode)
    });

    match &req.auth {
        HttpAuthConfig::None => {}
        HttpAuthConfig::Bearer {
            credential_connection_id,
        }
        | HttpAuthConfig::Basic {
            credential_connection_id,
        }
        | HttpAuthConfig::ApiKey {
            credential_connection_id,
            ..
        } => {
            let db = d1(env)?;
            let conn = connections::get_connection(&db, org_id, credential_connection_id)
                .await?
                .ok_or_else(|| {
                    AppError::NotFound("Credential connection not found.".to_string())
                })?;
            if conn.application_id != AppId::Http.as_str() {
                return Err(AppError::BadRequest(
                    "Selected connection is not an HTTP Request credential.".to_string(),
                ));
            }
            let cred = credentials::get_credential(&db, org_id, &conn.credential_id)
                .await?
                .ok_or_else(|| {
                    AppError::Internal("Connection credential record missing.".to_string())
                })?;
            let master_key = load_master_key(env, cred.key_version)?;
            let aad = make_credential_aad(org_id, &cred.id, &cred.kind);
            let secret = decrypt_secret(&master_key, &cred.ciphertext, &cred.nonce, &aad)?;

            let (auth_type, header_override) = match &req.auth {
                HttpAuthConfig::Bearer { .. } => ("bearer", None),
                HttpAuthConfig::Basic { .. } => ("basic", None),
                HttpAuthConfig::ApiKey { header_name, .. } => {
                    ("api_key", Some(header_name.as_str()))
                }
                HttpAuthConfig::None => ("none", None),
            };
            apply_auth_header_from_secret(auth_type, header_override, &secret, &mut headers)
                .map_err(|e| AppError::BadRequest(e.user_message))?;
        }
    }

    let app_origin = env
        .var("APP_ORIGIN")
        .map(|v| v.to_string())
        .unwrap_or_default();

    let started = now_ms();
    let method = to_worker_method(req.method);
    let body_opt = match req.method {
        HttpMethod::Get | HttpMethod::Delete => None,
        _ => rendered_body.as_deref(),
    };

    let res = ssrf::safe_fetch(method, &rendered_url, &headers, body_opt, &app_origin).await;
    let duration_ms = (now_ms() - started).max(0) as u64;

    match res {
        Ok(resp) => {
            let ok = (200..300).contains(&resp.status);
            let message = if ok {
                format!("HTTP {} OK in {} ms.", resp.status, duration_ms)
            } else if (300..400).contains(&resp.status) {
                format!(
                    "Destination returned redirect HTTP {} (redirects are not followed).",
                    resp.status
                )
            } else {
                format!("Destination returned HTTP {}.", resp.status)
            };
            Ok(HttpTestResult {
                ok,
                status: Some(resp.status),
                duration_ms,
                response_preview: preview_from_bytes(&resp.body),
                message,
            })
        }
        Err(ssrf_err) => Ok(HttpTestResult {
            ok: false,
            status: None,
            duration_ms,
            response_preview: String::new(),
            message: ssrf_err.to_string(),
        }),
    }
}

#[async_trait::async_trait(?Send)]
impl Connector for HttpConnector {
    fn id(&self) -> AppId {
        AppId::Http
    }

    fn name(&self) -> &'static str {
        "HTTP Request"
    }

    fn auth(&self) -> AuthSpec {
        AuthSpec::ApiToken
    }

    fn triggers(&self) -> Vec<TriggerDefinition> {
        vec![]
    }

    fn actions(&self) -> Vec<ActionDefinition> {
        Catalog::mvp()
            .get_app(AppId::Http)
            .map(|a| a.actions.clone())
            .unwrap_or_default()
    }

    async fn complete_oauth(
        &self,
        _cx: &Cx<'_>,
        _code: &str,
    ) -> Result<NewConnection, ConnectorError> {
        Err(ConnectorError::permanent(
            "HTTP Request does not use OAuth.",
            "http complete_oauth called",
        ))
    }

    async fn field_options(
        &self,
        _cx: &Cx<'_>,
        _creds: &Secret,
        _field: &str,
        _parent: Option<&str>,
    ) -> Result<Vec<FieldOption>, ConnectorError> {
        Ok(vec![])
    }

    async fn subscribe(
        &self,
        _cx: &Cx<'_>,
        _creds: &Secret,
        _trigger: &TriggerConfig,
        _callback_url: &str,
    ) -> Result<ExternalSubscription, ConnectorError> {
        Err(ConnectorError::permanent(
            "HTTP Request does not support triggers.",
            "http subscribe called",
        ))
    }

    async fn unsubscribe(
        &self,
        _cx: &Cx<'_>,
        _creds: &Secret,
        _sub: &ExternalSubscription,
    ) -> Result<(), ConnectorError> {
        Ok(())
    }

    fn verify(
        &self,
        _headers: &Headers,
        _raw_body: &[u8],
        _secret: &[u8],
    ) -> Result<(), VerifyError> {
        Err(VerifyError::MalformedRequest)
    }

    fn dedup_key(&self, _raw: &Value, raw_body: &[u8]) -> String {
        sha256_hex(raw_body)
    }

    async fn normalize(
        &self,
        _cx: &Cx<'_>,
        _creds: &Secret,
        _trigger: &TriggerConfig,
        _raw: &Value,
    ) -> Result<Option<NormalizedEvent>, ConnectorError> {
        Ok(None)
    }

    async fn execute(
        &self,
        cx: &Cx<'_>,
        creds: &Secret,
        action: &ActionConfig,
        inputs: &RenderedInputs,
    ) -> Result<ActionOutput, ConnectorError> {
        if action.event != "http.request" {
            return Err(ConnectorError::user_fixable(
                format!("Unsupported HTTP action '{}'.", action.event),
                format!("unsupported http action: {}", action.event),
            ));
        }

        let method_str = inputs
            .values
            .get("method")
            .or_else(|| action.configuration.get("method"))
            .and_then(|v| v.as_str())
            .unwrap_or("POST");
        let method = parse_method_str(method_str)?;
        let method_upper = method_str.trim().to_ascii_uppercase();

        let url = inputs
            .values
            .get("url")
            .or_else(|| action.configuration.get("url"))
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                ConnectorError::user_fixable(
                    "Destination URL is required.",
                    "missing http.request url",
                )
            })?;

        let mut headers: Vec<(String, String)> = Vec::new();
        if let Some(ConfigValue::KeyValueList(pairs)) = inputs
            .values
            .get("headers")
            .or_else(|| action.configuration.get("headers"))
        {
            for pair in pairs {
                let k = pair.key.trim();
                if k.is_empty() {
                    continue;
                }
                if !is_safe_header_token(k) || !is_safe_header_token(&pair.value) {
                    return Err(ConnectorError::user_fixable(
                        "HTTP headers cannot contain newline characters.",
                        "invalid header character",
                    ));
                }
                headers.push((k.to_string(), pair.value.clone()));
            }
        }

        let auth_type = inputs
            .values
            .get("authType")
            .or_else(|| action.configuration.get("authType"))
            .and_then(|v| v.as_str())
            .unwrap_or("none");
        let auth_used = !auth_type.is_empty() && auth_type != "none";
        apply_auth_header_from_secret(auth_type, None, creds, &mut headers)?;

        let body_opt = match method {
            worker::Method::Get | worker::Method::Delete => None,
            _ => inputs
                .values
                .get("body")
                .or_else(|| action.configuration.get("body"))
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty()),
        };

        let app_origin = cx
            .env
            .var("APP_ORIGIN")
            .map(|v| v.to_string())
            .unwrap_or_default();

        let resp = ssrf::safe_fetch(method, url, &headers, body_opt, &app_origin)
            .await
            .map_err(map_ssrf_to_connector_error)?;

        classify_http_status(resp.status, auth_used, &resp.headers, &resp.body)?;

        let host_label = Url::parse(url)
            .ok()
            .and_then(|u| u.host_str().map(str::to_string))
            .unwrap_or_else(|| url.to_string());

        Ok(ActionOutput {
            action_summary: format!("{method_upper} {host_label} (HTTP {})", resp.status),
            external_ref: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connectors::ErrorClass;

    #[test]
    fn classifies_http_statuses_cleanly() {
        assert!(classify_http_status(200, false, &[], b"ok").is_ok());
        assert!(classify_http_status(204, true, &[], b"").is_ok());

        let r429 = classify_http_status(
            429,
            false,
            &[("Retry-After".to_string(), "30".to_string())],
            b"slow down",
        )
        .unwrap_err();
        assert_eq!(
            r429.class,
            ErrorClass::Retryable {
                retry_after_secs: Some(30)
            }
        );

        let r503 = classify_http_status(503, false, &[], b"down").unwrap_err();
        assert_eq!(
            r503.class,
            ErrorClass::Retryable {
                retry_after_secs: None
            }
        );

        let r401_auth = classify_http_status(401, true, &[], b"unauthorized").unwrap_err();
        assert_eq!(r401_auth.class, ErrorClass::NeedsReconnect);

        let r401_no_auth = classify_http_status(401, false, &[], b"unauthorized").unwrap_err();
        assert_eq!(r401_no_auth.class, ErrorClass::UserFixable);

        let r400 = classify_http_status(400, false, &[], b"bad").unwrap_err();
        assert_eq!(r400.class, ErrorClass::UserFixable);
    }

    #[test]
    fn applies_bearer_api_key_and_basic_auth_headers() {
        let mut h = Vec::new();
        apply_auth_header_from_secret("bearer", None, &Secret::from_str_slice("tok_123"), &mut h)
            .unwrap();
        assert_eq!(h, vec![("Authorization".to_string(), "Bearer tok_123".to_string())]);

        let mut h2 = Vec::new();
        apply_auth_header_from_secret(
            "api_key",
            Some("X-Custom-Key"),
            &Secret::from_str_slice("key_abc"),
            &mut h2,
        )
        .unwrap();
        assert_eq!(h2, vec![("X-Custom-Key".to_string(), "key_abc".to_string())]);

        let mut h3 = Vec::new();
        apply_auth_header_from_secret("basic", None, &Secret::from_str_slice("alice:secret"), &mut h3)
            .unwrap();
        assert_eq!(
            h3,
            vec![(
                "Authorization".to_string(),
                format!("Basic {}", B64_STD.encode("alice:secret"))
            )]
        );
    }
}
