use serde_json::{json, Value};
use url::form_urlencoded;
use worker::{Env, Headers};

use crate::api_types::{ActionDefinition, AppId, FieldOption, TriggerDefinition};
use crate::crypto::{sha256_hex, Secret};

use super::clickup::get_env_secret_or_var;
use super::{
    ActionConfig, ActionOutput, AuthSpec, Catalog, Connector, ConnectorError, Cx,
    ExternalSubscription, NewConnection, NormalizedEvent, RenderedInputs, TriggerConfig,
    VerifyError,
};

const DEFAULT_SLACK_API_BASE: &str = "https://slack.com/api";

pub struct SlackConnector;

pub fn api_base(env: &Env) -> String {
    #[cfg(feature = "e2e")]
    if let Ok(v) = env.var("SLACK_API_BASE") {
        let s = v.to_string();
        if !s.trim().is_empty() {
            return s.trim_end_matches('/').to_string();
        }
    }
    let _ = env;
    DEFAULT_SLACK_API_BASE.to_string()
}

pub fn classify_slack_error(
    status: u16,
    retry_after_header: Option<&str>,
    body_json: Option<&Value>,
    raw_body: &str,
) -> ConnectorError {
    let retry_after_secs = retry_after_header.and_then(|s| s.trim().parse::<u64>().ok());

    if status == 429 {
        return ConnectorError::retryable(
            retry_after_secs,
            "Slack is rate limiting requests right now. We'll retry automatically.",
            format!("slack http 429: {raw_body}"),
        );
    }

    if status >= 500 {
        return ConnectorError::retryable(
            None,
            "Slack is temporarily unavailable. We'll retry automatically.",
            format!("slack http {status}: {raw_body}"),
        );
    }

    if status == 401 || status == 403 {
        return ConnectorError::needs_reconnect(
            "Slack couldn't receive your message because the connection expired. Reconnect your Slack account.",
            format!("slack http {status}: {raw_body}"),
        );
    }

    if let Some(err_code) = body_json
        .and_then(|v| v["error"].as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return match err_code {
            "invalid_auth" | "token_revoked" | "account_inactive" | "not_authed"
            | "token_expired" => ConnectorError::needs_reconnect(
                "Slack couldn't receive your message because the connection expired. Reconnect your Slack account.",
                format!("slack error={err_code}"),
            ),
            "ratelimited" => ConnectorError::retryable(
                retry_after_secs,
                "Slack is rate limiting requests right now. We'll retry automatically.",
                format!("slack error=ratelimited"),
            ),
            "channel_not_found" => ConnectorError::user_fixable(
                "The selected Slack channel couldn't be found. Pick a different channel in your automation and try again.",
                "slack error=channel_not_found",
            ),
            "not_in_channel" => ConnectorError::user_fixable(
                "The Slack app isn't a member of that private channel yet. Invite the app to the channel in Slack, or choose a public channel.",
                "slack error=not_in_channel",
            ),
            "is_archived" => ConnectorError::user_fixable(
                "That Slack channel is archived. Pick an active channel in your automation and try again.",
                "slack error=is_archived",
            ),
            "msg_too_long" => ConnectorError::user_fixable(
                "The Slack message is too long. Shorten your message template and try again.",
                "slack error=msg_too_long",
            ),
            "no_text" => ConnectorError::user_fixable(
                "The Slack message was empty. Add text to your message template and try again.",
                "slack error=no_text",
            ),
            other => ConnectorError::user_fixable(
                format!("Slack couldn't accept the request ({other}). Check your channel and message settings."),
                format!("slack error={other}"),
            ),
        };
    }

    ConnectorError::user_fixable(
        "Slack couldn't accept the request. Check your channel and message settings.",
        format!("slack http {status}: {raw_body}"),
    )
}

#[cfg(target_arch = "wasm32")]
async fn slack_request(
    method: worker::Method,
    url: &str,
    bearer_token: Option<&str>,
    content_type: Option<&str>,
    body_str: Option<&str>,
) -> Result<(u16, Option<String>, String), ConnectorError> {
    use worker::wasm_bindgen::JsValue;

    let headers = Headers::new();
    if let Some(tok) = bearer_token {
        headers
            .set("Authorization", &format!("Bearer {}", tok.trim()))
            .map_err(|e| ConnectorError::permanent("Invalid token header.", e.to_string()))?;
    }
    if let Some(ct) = content_type {
        headers
            .set("Content-Type", ct)
            .map_err(|e| ConnectorError::permanent("Failed to set header.", e.to_string()))?;
    }
    headers
        .set("Accept", "application/json")
        .map_err(|e| ConnectorError::permanent("Failed to set header.", e.to_string()))?;

    let mut init = worker::RequestInit::new();
    init.with_method(method);
    init.with_headers(headers);
    if let Some(b) = body_str {
        init.with_body(Some(JsValue::from_str(b)));
    }

    let req = worker::Request::new_with_init(url, &init)
        .map_err(|e| ConnectorError::permanent("Invalid Slack URL.", e.to_string()))?;
    let mut resp = worker::Fetch::Request(req).send().await.map_err(|e| {
        ConnectorError::retryable(
            None,
            "Could not reach Slack. We'll retry automatically.",
            format!("slack fetch error: {e}"),
        )
    })?;

    let status = resp.status_code();
    let retry_after = resp.headers().get("Retry-After").ok().flatten();
    let text = resp.text().await.unwrap_or_default();
    Ok((status, retry_after, text))
}

#[cfg(not(target_arch = "wasm32"))]
async fn slack_request(
    _method: worker::Method,
    _url: &str,
    _bearer_token: Option<&str>,
    _content_type: Option<&str>,
    _body_str: Option<&str>,
) -> Result<(u16, Option<String>, String), ConnectorError> {
    Err(ConnectorError::permanent(
        "Outbound Slack requests require the Cloudflare Worker runtime.",
        "non-wasm32 slack_request stub",
    ))
}

async fn slack_call_json(
    method: worker::Method,
    url: &str,
    bearer_token: Option<&str>,
    content_type: Option<&str>,
    body_str: Option<&str>,
) -> Result<Value, ConnectorError> {
    let (status, retry_after, body) =
        slack_request(method, url, bearer_token, content_type, body_str).await?;
    let parsed: Option<Value> = serde_json::from_str(&body).ok();

    if !(200..300).contains(&status) {
        return Err(classify_slack_error(
            status,
            retry_after.as_deref(),
            parsed.as_ref(),
            &body,
        ));
    }

    let val = parsed.ok_or_else(|| {
        ConnectorError::retryable(
            None,
            "Slack returned an unexpected response.",
            format!("slack invalid json: {body}"),
        )
    })?;

    if !val["ok"].as_bool().unwrap_or(false) {
        return Err(classify_slack_error(
            status,
            retry_after.as_deref(),
            Some(&val),
            &body,
        ));
    }

    Ok(val)
}

impl SlackConnector {
    pub async fn test_connection(
        &self,
        cx: &Cx<'_>,
        creds: &Secret,
    ) -> Result<String, ConnectorError> {
        let token = creds
            .expose_str()
            .map_err(|_| ConnectorError::needs_reconnect("Saved Slack token is corrupted.", "invalid utf8"))?;
        let base = api_base(cx.env);
        let url = format!("{base}/auth.test");
        let val = slack_call_json(
            worker::Method::Post,
            &url,
            Some(token),
            Some("application/x-www-form-urlencoded"),
            None,
        )
        .await?;
        let team = val["team"].as_str().unwrap_or("Slack workspace");
        Ok(format!("Connected to {team}."))
    }
}

#[async_trait::async_trait(?Send)]
impl Connector for SlackConnector {
    fn id(&self) -> AppId {
        AppId::Slack
    }

    fn name(&self) -> &'static str {
        "Slack"
    }

    fn auth(&self) -> AuthSpec {
        AuthSpec::OAuth2 {
            authorize_url: "https://slack.com/oauth/v2/authorize",
            token_url: "https://slack.com/api/oauth.v2.access",
            scopes: &["chat:write", "chat:write.public", "channels:read", "groups:read"],
        }
    }

    fn triggers(&self) -> Vec<TriggerDefinition> {
        vec![]
    }

    fn actions(&self) -> Vec<ActionDefinition> {
        Catalog::mvp()
            .get_app(AppId::Slack)
            .map(|a| a.actions.clone())
            .unwrap_or_default()
    }

    async fn complete_oauth(
        &self,
        cx: &Cx<'_>,
        code: &str,
    ) -> Result<NewConnection, ConnectorError> {
        let client_id = get_env_secret_or_var(cx.env, "SLACK_CLIENT_ID").ok_or_else(|| {
            ConnectorError::permanent(
                "Slack OAuth is not configured on this server.",
                "missing SLACK_CLIENT_ID",
            )
        })?;
        let client_secret =
            get_env_secret_or_var(cx.env, "SLACK_CLIENT_SECRET").ok_or_else(|| {
                ConnectorError::permanent(
                    "Slack OAuth is not configured on this server.",
                    "missing SLACK_CLIENT_SECRET",
                )
            })?;
        let app_origin = get_env_secret_or_var(cx.env, "APP_ORIGIN")
            .unwrap_or_else(|| "http://localhost:8787".to_string());
        let redirect_uri = format!("{}/api/oauth/slack/callback", app_origin.trim_end_matches('/'));

        let form_body = form_urlencoded::Serializer::new(String::new())
            .append_pair("client_id", &client_id)
            .append_pair("client_secret", &client_secret)
            .append_pair("code", code)
            .append_pair("redirect_uri", &redirect_uri)
            .finish();

        let base = api_base(cx.env);
        let url = format!("{base}/oauth.v2.access");
        let val = slack_call_json(
            worker::Method::Post,
            &url,
            None,
            Some("application/x-www-form-urlencoded"),
            Some(&form_body),
        )
        .await?;

        let access_token = val["access_token"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                ConnectorError::permanent(
                    "Slack did not return an access token.",
                    "missing access_token in oauth.v2.access response",
                )
            })?
            .to_string();

        let team_id = val["team"]["id"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let team_name = val["team"]["name"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("Slack Workspace");

        Ok(NewConnection {
            display_name: format!("{team_name} (Slack)"),
            external_account_id: team_id,
            credential: Secret::from_string(access_token),
        })
    }

    async fn field_options(
        &self,
        cx: &Cx<'_>,
        creds: &Secret,
        field: &str,
        _parent: Option<&str>,
    ) -> Result<Vec<FieldOption>, ConnectorError> {
        if field != "channel" {
            return Err(ConnectorError::user_fixable(
                format!("Unknown Slack option field '{field}'."),
                format!("unsupported slack field_options: {field}"),
            ));
        }

        let token = creds
            .expose_str()
            .map_err(|_| ConnectorError::needs_reconnect("Saved Slack token is corrupted.", "invalid utf8"))?;
        let base = api_base(cx.env);
        let url = format!(
            "{base}/conversations.list?types=public_channel,private_channel&exclude_archived=true&limit=200"
        );
        let val = slack_call_json(worker::Method::Get, &url, Some(token), None, None).await?;

        let channels = val["channels"].as_array().cloned().unwrap_or_default();
        let mut options = Vec::with_capacity(channels.len());
        for ch in channels {
            if let (Some(id), Some(name)) = (ch["id"].as_str(), ch["name"].as_str()) {
                options.push(FieldOption {
                    value: id.to_string(),
                    label: format!("#{name}"),
                });
            }
        }
        Ok(options)
    }

    async fn subscribe(
        &self,
        _cx: &Cx<'_>,
        _creds: &Secret,
        _trigger: &TriggerConfig,
        _callback_url: &str,
    ) -> Result<ExternalSubscription, ConnectorError> {
        Err(ConnectorError::permanent(
            "Slack does not support webhook triggers in this version.",
            "slack subscribe called",
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
        if action.event != "message.send" {
            return Err(ConnectorError::user_fixable(
                format!("Unsupported Slack action '{}'.", action.event),
                format!("unsupported slack action: {}", action.event),
            ));
        }

        let token = creds
            .expose_str()
            .map_err(|_| ConnectorError::needs_reconnect("Saved Slack token is corrupted.", "invalid utf8"))?;

        let channel_val = inputs
            .values
            .get("channel")
            .or_else(|| action.configuration.get("channel"));
        let channel = channel_val
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                ConnectorError::user_fixable(
                    "Please select a Slack channel.",
                    "missing slack channel",
                )
            })?;
        let channel_label = channel_val
            .and_then(|v| v.display_label())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(channel);

        let message = inputs
            .values
            .get("message")
            .or_else(|| action.configuration.get("message"))
            .and_then(|v| v.as_str())
            .unwrap_or("");

        if message.trim().is_empty() {
            return Err(ConnectorError::user_fixable(
                "The Slack message was empty. Add text to your message template and try again.",
                "empty slack message text",
            ));
        }

        let base = api_base(cx.env);
        let url = format!("{base}/chat.postMessage");
        let payload = json!({
            "channel": channel,
            "text": message,
        })
        .to_string();

        let val = slack_call_json(
            worker::Method::Post,
            &url,
            Some(token),
            Some("application/json; charset=utf-8"),
            Some(&payload),
        )
        .await?;

        let ts = val["ts"].as_str().map(str::to_string);
        Ok(ActionOutput {
            action_summary: format!("Sent a message to {channel_label}"),
            external_ref: ts,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connectors::ErrorClass;

    #[test]
    fn classifies_slack_token_revoked_as_needs_reconnect() {
        let body = json!({ "ok": false, "error": "token_revoked" });
        let err = classify_slack_error(200, None, Some(&body), &body.to_string());
        assert_eq!(err.class, ErrorClass::NeedsReconnect);
        assert_eq!(
            err.user_message,
            "Slack couldn't receive your message because the connection expired. Reconnect your Slack account."
        );

        for code in ["invalid_auth", "account_inactive", "not_authed"] {
            let b = json!({ "ok": false, "error": code });
            let e = classify_slack_error(200, None, Some(&b), &b.to_string());
            assert_eq!(e.class, ErrorClass::NeedsReconnect);
        }
    }

    #[test]
    fn classifies_slack_channel_errors_as_user_fixable() {
        let body = json!({ "ok": false, "error": "channel_not_found" });
        let err = classify_slack_error(200, None, Some(&body), &body.to_string());
        assert_eq!(err.class, ErrorClass::UserFixable);
        assert!(err.user_message.contains("channel"));

        for code in ["not_in_channel", "is_archived", "msg_too_long", "no_text"] {
            let b = json!({ "ok": false, "error": code });
            let e = classify_slack_error(200, None, Some(&b), &b.to_string());
            assert_eq!(e.class, ErrorClass::UserFixable);
        }
    }

    #[test]
    fn classifies_slack_429_with_retry_after_and_5xx_as_retryable() {
        let err = classify_slack_error(429, Some("15"), None, "rate limited");
        assert_eq!(
            err.class,
            ErrorClass::Retryable {
                retry_after_secs: Some(15)
            }
        );

        let err500 = classify_slack_error(503, None, None, "service unavailable");
        assert_eq!(
            err500.class,
            ErrorClass::Retryable {
                retry_after_secs: None
            }
        );
    }
}
