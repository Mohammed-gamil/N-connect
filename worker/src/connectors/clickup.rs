use serde_json::{json, Map, Value};
use worker::{Env, Headers};

use crate::api_types::{ActionDefinition, AppId, FieldOption, TriggerDefinition};
use crate::crypto::{sha256_hex, verify_hmac_sha256_hex, Secret};

use super::{
    ActionConfig, ActionOutput, AuthSpec, Catalog, Connector, ConnectorError, Cx,
    ExternalSubscription, NewConnection, NormalizedEvent, RenderedInputs, TriggerConfig,
    VerifyError,
};

const DEFAULT_CLICKUP_API_BASE: &str = "https://api.clickup.com/api/v2";
const MAX_SPACES_TO_FETCH: usize = 10;
const MAX_EXTRA_FOLDER_FETCHES: usize = 10;

pub struct ClickUpConnector;

pub fn api_base(env: &Env) -> String {
    #[cfg(feature = "e2e")]
    if let Ok(v) = env.var("CLICKUP_API_BASE") {
        let s = v.to_string();
        if !s.trim().is_empty() {
            return s.trim_end_matches('/').to_string();
        }
    }
    let _ = env;
    DEFAULT_CLICKUP_API_BASE.to_string()
}

pub fn oauth_authorize_url(env: &Env) -> String {
    #[cfg(feature = "e2e")]
    if let Ok(v) = env.var("CLICKUP_OAUTH_BASE") {
        let s = v.to_string();
        if !s.trim().is_empty() {
            return format!("{}/oauth/authorize", s.trim_end_matches('/'));
        }
    }
    let _ = env;
    "https://app.clickup.com/api".to_string()
}

pub(crate) fn get_env_secret_or_var(env: &Env, name: &str) -> Option<String> {
    if let Ok(s) = env.secret(name) {
        let val = s.to_string();
        if !val.trim().is_empty() {
            return Some(val);
        }
    }
    if let Ok(v) = env.var(name) {
        let val = v.to_string();
        if !val.trim().is_empty() {
            return Some(val);
        }
    }
    None
}

pub fn map_trigger_to_clickup_event(trigger_event: &str) -> Result<&'static str, ConnectorError> {
    match trigger_event {
        "task.created" => Ok("taskCreated"),
        "task.updated" => Ok("taskUpdated"),
        "task.completed" => Ok("taskStatusUpdated"),
        "task.assigned" => Ok("taskAssigneeUpdated"),
        other => Err(ConnectorError::user_fixable(
            format!("Unsupported ClickUp trigger '{other}'."),
            format!("unsupported clickup trigger event: {other}"),
        )),
    }
}

pub fn verify_clickup_signature(
    signature_header: Option<&str>,
    raw_body: &[u8],
    secret: &[u8],
) -> Result<(), VerifyError> {
    let Some(sig) = signature_header.map(str::trim).filter(|s| !s.is_empty()) else {
        return Err(VerifyError::MissingSignature);
    };
    if verify_hmac_sha256_hex(secret, raw_body, sig) {
        Ok(())
    } else {
        Err(VerifyError::InvalidSignature)
    }
}

fn value_as_id_str(v: &Value) -> Option<String> {
    if let Some(s) = v.as_str() {
        let t = s.trim();
        if !t.is_empty() {
            return Some(t.to_string());
        }
    } else if let Some(n) = v.as_i64() {
        return Some(n.to_string());
    } else if let Some(n) = v.as_u64() {
        return Some(n.to_string());
    }
    None
}

pub fn clickup_dedup_key(raw: &Value, raw_body: &[u8]) -> String {
    let webhook_id = value_as_id_str(&raw["webhook_id"]).unwrap_or_else(|| "unknown".to_string());
    let event = raw["event"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("unknown");
    let task_id = value_as_id_str(&raw["task_id"]).unwrap_or_else(|| "unknown".to_string());

    let history_id = raw["history_items"]
        .as_array()
        .and_then(|arr| arr.first())
        .and_then(|item| value_as_id_str(&item["id"]));

    match history_id {
        Some(hid) => format!("{webhook_id}:{event}:{task_id}:{hid}"),
        None => format!("{webhook_id}:{event}:{task_id}:{}", sha256_hex(raw_body)),
    }
}

/// Converts a ClickUp epoch-millisecond timestamp (e.g. `"1795046400000"`) into `YYYY-MM-DD` UTC.
fn format_clickup_due_date(val: &Value) -> String {
    let ms = if let Some(n) = val.as_i64() {
        Some(n)
    } else if let Some(s) = val.as_str() {
        let trimmed = s.trim();
        if trimmed.is_empty() {
            return String::new();
        }
        if let Ok(parsed) = trimmed.parse::<i64>() {
            Some(parsed)
        } else {
            return trimmed.to_string();
        }
    } else {
        None
    };

    let Some(ms) = ms else {
        return String::new();
    };
    let days = ms.div_euclid(86_400_000);
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}")
}

/// Howard Hinnant's civil-from-days algorithm (days since 1970-01-01).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = y + if m <= 2 { 1 } else { 0 };
    (y, m as u32, d as u32)
}

fn history_indicates_non_closed(raw: &Value) -> bool {
    let Some(items) = raw["history_items"].as_array() else {
        return false;
    };
    let mut saw_after_type = false;
    for item in items {
        if let Some(after_type) = item["after"]["type"].as_str() {
            saw_after_type = true;
            if after_type.eq_ignore_ascii_case("closed") {
                return false;
            }
        }
    }
    saw_after_type
}

pub fn normalize_clickup_payload(
    trigger_event: &str,
    configured_list_id: Option<&str>,
    raw_event: &Value,
    task: &Value,
) -> Option<NormalizedEvent> {
    let expected_event = map_trigger_to_clickup_event(trigger_event).ok()?;
    let actual_event = raw_event["event"].as_str().unwrap_or("");
    if actual_event != expected_event {
        return None;
    }

    if let Some(target_list_id) = configured_list_id.map(str::trim).filter(|s| !s.is_empty()) {
        let task_list_id = value_as_id_str(&task["list"]["id"]);
        if task_list_id.as_deref() != Some(target_list_id) {
            return None;
        }
    }

    if trigger_event == "task.completed" {
        let history_closed = raw_event["history_items"]
            .as_array()
            .map(|items| {
                items.iter().any(|item| {
                    item["after"]["type"]
                        .as_str()
                        .map(|t| t.eq_ignore_ascii_case("closed"))
                        .unwrap_or(false)
                })
            })
            .unwrap_or(false);
        let task_closed = task["status"]["type"]
            .as_str()
            .map(|t| t.eq_ignore_ascii_case("closed"))
            .unwrap_or(false);
        if !history_closed && !task_closed {
            return None;
        }
    }

    let task_id = value_as_id_str(&task["id"])
        .or_else(|| value_as_id_str(&raw_event["task_id"]))
        .unwrap_or_default();
    let task_name = task["name"].as_str().unwrap_or("Untitled task").to_string();
    let task_url = task["url"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("https://app.clickup.com/t/{task_id}"));
    let task_status = task["status"]["status"]
        .as_str()
        .unwrap_or("")
        .to_string();
    let task_description = task["text_content"]
        .as_str()
        .or_else(|| task["description"].as_str())
        .unwrap_or("")
        .to_string();
    let task_assignees = task["assignees"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|u| {
                    u["username"]
                        .as_str()
                        .or_else(|| u["email"].as_str())
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(str::to_string)
                })
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();
    let task_creator = task["creator"]["username"]
        .as_str()
        .or_else(|| task["creator"]["email"].as_str())
        .unwrap_or("")
        .to_string();
    let task_list = task["list"]["name"].as_str().unwrap_or("").to_string();
    let task_due_date = format_clickup_due_date(&task["due_date"]);
    let task_priority = task["priority"]["priority"]
        .as_str()
        .unwrap_or("")
        .to_string();

    let mut vars = Map::new();
    vars.insert("task.id".to_string(), Value::String(task_id));
    vars.insert("task.name".to_string(), Value::String(task_name.clone()));
    vars.insert("task.url".to_string(), Value::String(task_url));
    vars.insert("task.status".to_string(), Value::String(task_status));
    vars.insert(
        "task.description".to_string(),
        Value::String(task_description),
    );
    vars.insert("task.assignees".to_string(), Value::String(task_assignees));
    vars.insert("task.creator".to_string(), Value::String(task_creator));
    vars.insert("task.list".to_string(), Value::String(task_list));
    vars.insert("task.due_date".to_string(), Value::String(task_due_date));
    vars.insert("task.priority".to_string(), Value::String(task_priority));
    vars.insert(
        "event.type".to_string(),
        Value::String(actual_event.to_string()),
    );

    let verb = match trigger_event {
        "task.created" => "was created",
        "task.updated" => "was updated",
        "task.completed" => "was completed",
        "task.assigned" => "was assigned",
        _ => "triggered",
    };
    let trigger_summary = format!("Task \"{task_name}\" {verb}");

    Some(NormalizedEvent {
        trigger_summary,
        variables: vars,
    })
}

fn classify_clickup_http_error(status: u16, retry_after: Option<&str>, body: &str) -> ConnectorError {
    let retry_after_secs = retry_after.and_then(|s| s.trim().parse::<u64>().ok());
    if status == 401 || status == 403 {
        return ConnectorError::needs_reconnect(
            "ClickUp rejected the saved credentials. Please reconnect your ClickUp account.",
            format!("clickup http {status}: {body}"),
        );
    }
    if status == 429 {
        return ConnectorError::retryable(
            retry_after_secs,
            "ClickUp rate limit reached. We'll retry automatically.",
            format!("clickup http 429: {body}"),
        );
    }
    if status >= 500 {
        return ConnectorError::retryable(
            None,
            "ClickUp is temporarily unavailable. We'll retry automatically.",
            format!("clickup http {status}: {body}"),
        );
    }
    ConnectorError::user_fixable(
        "ClickUp couldn't complete that request. Check your ClickUp workspace/list settings and try again.",
        format!("clickup http {status}: {body}"),
    )
}

#[cfg(target_arch = "wasm32")]
async fn clickup_request(
    method: worker::Method,
    url: &str,
    token: Option<&str>,
    json_body: Option<&Value>,
) -> Result<(u16, Option<String>, String), ConnectorError> {
    use worker::wasm_bindgen::JsValue;

    let headers = Headers::new();
    if let Some(tok) = token {
        headers
            .set("Authorization", tok.trim())
            .map_err(|e| ConnectorError::permanent("Invalid token header.", e.to_string()))?;
    }
    if json_body.is_some() {
        headers
            .set("Content-Type", "application/json")
            .map_err(|e| ConnectorError::permanent("Failed to set header.", e.to_string()))?;
    }
    headers
        .set("Accept", "application/json")
        .map_err(|e| ConnectorError::permanent("Failed to set header.", e.to_string()))?;

    let mut init = worker::RequestInit::new();
    init.with_method(method);
    init.with_headers(headers);
    if let Some(body) = json_body {
        let s = serde_json::to_string(body)
            .map_err(|e| ConnectorError::permanent("Failed to encode JSON.", e.to_string()))?;
        init.with_body(Some(JsValue::from_str(&s)));
    }

    let req = worker::Request::new_with_init(url, &init)
        .map_err(|e| ConnectorError::permanent("Invalid ClickUp URL.", e.to_string()))?;
    let mut resp = worker::Fetch::Request(req).send().await.map_err(|e| {
        ConnectorError::retryable(
            None,
            "Could not reach ClickUp. We'll retry automatically.",
            format!("clickup fetch error: {e}"),
        )
    })?;

    let status = resp.status_code();
    let retry_after = resp.headers().get("Retry-After").ok().flatten();
    let text = resp.text().await.unwrap_or_default();
    Ok((status, retry_after, text))
}

#[cfg(not(target_arch = "wasm32"))]
async fn clickup_request(
    _method: worker::Method,
    _url: &str,
    _token: Option<&str>,
    _json_body: Option<&Value>,
) -> Result<(u16, Option<String>, String), ConnectorError> {
    Err(ConnectorError::permanent(
        "Outbound ClickUp requests require the Cloudflare Worker runtime.",
        "non-wasm32 clickup_request stub",
    ))
}

async fn clickup_get_json(
    url: &str,
    token: &str,
) -> Result<Value, ConnectorError> {
    let (status, retry_after, body) =
        clickup_request(worker::Method::Get, url, Some(token), None).await?;
    if !(200..300).contains(&status) {
        return Err(classify_clickup_http_error(status, retry_after.as_deref(), &body));
    }
    serde_json::from_str(&body).map_err(|e| {
        ConnectorError::retryable(
            None,
            "ClickUp returned an unexpected response.",
            format!("clickup invalid json: {e}"),
        )
    })
}

/// Verifies a ClickUp token (OAuth or personal API token) via `GET /user`.
/// Returns `(display_name, external_account_id)`.
pub async fn verify_clickup_token(
    env: &Env,
    token: &str,
) -> Result<(String, Option<String>), ConnectorError> {
    let base = api_base(env);
    let url = format!("{base}/user");
    let v = clickup_get_json(&url, token).await?;

    let user = &v["user"];
    let ext_id = value_as_id_str(&user["id"]);
    let username = user["username"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let email = user["email"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let label = username
        .or(email)
        .map(|s| format!("{s} (ClickUp)"))
        .unwrap_or_else(|| "ClickUp Account".to_string());

    Ok((label, ext_id))
}

impl ClickUpConnector {
    pub async fn test_connection(
        &self,
        cx: &Cx<'_>,
        creds: &Secret,
    ) -> Result<String, ConnectorError> {
        let token = creds
            .expose_str()
            .map_err(|_| ConnectorError::needs_reconnect("Saved token is corrupted.", "invalid utf8"))?;
        let (label, _) = verify_clickup_token(cx.env, token).await?;
        Ok(format!("Connected as {label}."))
    }
}

#[async_trait::async_trait(?Send)]
impl Connector for ClickUpConnector {
    fn id(&self) -> AppId {
        AppId::Clickup
    }

    fn name(&self) -> &'static str {
        "ClickUp"
    }

    fn auth(&self) -> AuthSpec {
        AuthSpec::OAuth2 {
            authorize_url: "https://app.clickup.com/api",
            token_url: "https://api.clickup.com/api/v2/oauth/token",
            scopes: &[],
        }
    }

    fn triggers(&self) -> Vec<TriggerDefinition> {
        Catalog::mvp()
            .get_app(AppId::Clickup)
            .map(|a| a.triggers.clone())
            .unwrap_or_default()
    }

    fn actions(&self) -> Vec<ActionDefinition> {
        vec![]
    }

    async fn complete_oauth(
        &self,
        cx: &Cx<'_>,
        code: &str,
    ) -> Result<NewConnection, ConnectorError> {
        let client_id = get_env_secret_or_var(cx.env, "CLICKUP_CLIENT_ID").ok_or_else(|| {
            ConnectorError::permanent(
                "ClickUp OAuth is not configured on this server.",
                "missing CLICKUP_CLIENT_ID",
            )
        })?;
        let client_secret =
            get_env_secret_or_var(cx.env, "CLICKUP_CLIENT_SECRET").ok_or_else(|| {
                ConnectorError::permanent(
                    "ClickUp OAuth is not configured on this server.",
                    "missing CLICKUP_CLIENT_SECRET",
                )
            })?;

        let base = api_base(cx.env);
        let token_url = format!("{base}/oauth/token");
        let payload = json!({
            "client_id": client_id,
            "client_secret": client_secret,
            "code": code,
        });

        let (status, retry_after, body) =
            clickup_request(worker::Method::Post, &token_url, None, Some(&payload)).await?;
        if !(200..300).contains(&status) {
            return Err(classify_clickup_http_error(
                status,
                retry_after.as_deref(),
                &body,
            ));
        }

        let parsed: Value = serde_json::from_str(&body).map_err(|e| {
            ConnectorError::permanent("Invalid token response from ClickUp.", e.to_string())
        })?;
        let access_token = parsed["access_token"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                ConnectorError::permanent(
                    "ClickUp did not return an access token.",
                    format!("missing access_token in clickup response: {body}"),
                )
            })?
            .to_string();

        let (display_name, external_account_id) =
            verify_clickup_token(cx.env, &access_token).await?;

        Ok(NewConnection {
            display_name,
            external_account_id,
            credential: Secret::from_string(access_token),
        })
    }

    async fn field_options(
        &self,
        cx: &Cx<'_>,
        creds: &Secret,
        field: &str,
        parent: Option<&str>,
    ) -> Result<Vec<FieldOption>, ConnectorError> {
        let token = creds
            .expose_str()
            .map_err(|_| ConnectorError::needs_reconnect("Saved token is corrupted.", "invalid utf8"))?;
        let base = api_base(cx.env);

        match field {
            "workspaceId" => {
                let v = clickup_get_json(&format!("{base}/team"), token).await?;
                let teams = v["teams"].as_array().cloned().unwrap_or_default();
                let mut opts = Vec::with_capacity(teams.len());
                for team in teams {
                    if let (Some(id), Some(name)) =
                        (value_as_id_str(&team["id"]), team["name"].as_str())
                    {
                        opts.push(FieldOption {
                            value: id,
                            label: name.to_string(),
                        });
                    }
                }
                Ok(opts)
            }
            "listId" => {
                let workspace_id = parent
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| {
                        ConnectorError::user_fixable(
                            "Please select a ClickUp workspace first.",
                            "missing parent workspaceId",
                        )
                    })?;

                let spaces_val = clickup_get_json(
                    &format!("{base}/team/{workspace_id}/space?archived=false"),
                    token,
                )
                .await?;
                let spaces = spaces_val["spaces"].as_array().cloned().unwrap_or_default();

                let mut options = Vec::new();
                let mut extra_folder_fetches = 0usize;

                for space in spaces.into_iter().take(MAX_SPACES_TO_FETCH) {
                    let Some(space_id) = value_as_id_str(&space["id"]) else {
                        continue;
                    };
                    let space_name = space["name"].as_str().unwrap_or("Space");

                    // Folderless lists
                    let lists_val = clickup_get_json(
                        &format!("{base}/space/{space_id}/list?archived=false"),
                        token,
                    )
                    .await?;
                    if let Some(lists) = lists_val["lists"].as_array() {
                        for list in lists {
                            if let (Some(lid), Some(lname)) =
                                (value_as_id_str(&list["id"]), list["name"].as_str())
                            {
                                options.push(FieldOption {
                                    value: lid,
                                    label: format!("{space_name} / {lname}"),
                                });
                            }
                        }
                    }

                    // Folders (ClickUp returns inline `lists` on each folder)
                    let folders_val = clickup_get_json(
                        &format!("{base}/space/{space_id}/folder?archived=false"),
                        token,
                    )
                    .await?;
                    if let Some(folders) = folders_val["folders"].as_array() {
                        for folder in folders {
                            let folder_name = folder["name"].as_str().unwrap_or("Folder");
                            if let Some(inline_lists) = folder["lists"].as_array() {
                                for list in inline_lists {
                                    if let (Some(lid), Some(lname)) =
                                        (value_as_id_str(&list["id"]), list["name"].as_str())
                                    {
                                        options.push(FieldOption {
                                            value: lid,
                                            label: format!("{space_name} / {folder_name} / {lname}"),
                                        });
                                    }
                                }
                            } else if extra_folder_fetches < MAX_EXTRA_FOLDER_FETCHES {
                                if let Some(fid) = value_as_id_str(&folder["id"]) {
                                    extra_folder_fetches += 1;
                                    let fl_val = clickup_get_json(
                                        &format!("{base}/folder/{fid}/list?archived=false"),
                                        token,
                                    )
                                    .await?;
                                    if let Some(lists) = fl_val["lists"].as_array() {
                                        for list in lists {
                                            if let (Some(lid), Some(lname)) = (
                                                value_as_id_str(&list["id"]),
                                                list["name"].as_str(),
                                            ) {
                                                options.push(FieldOption {
                                                    value: lid,
                                                    label: format!(
                                                        "{space_name} / {folder_name} / {lname}"
                                                    ),
                                                });
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                Ok(options)
            }
            other => Err(ConnectorError::user_fixable(
                format!("Unknown ClickUp option field '{other}'."),
                format!("unsupported clickup field_options: {other}"),
            )),
        }
    }

    async fn subscribe(
        &self,
        cx: &Cx<'_>,
        creds: &Secret,
        trigger: &TriggerConfig,
        callback_url: &str,
    ) -> Result<ExternalSubscription, ConnectorError> {
        let token = creds
            .expose_str()
            .map_err(|_| ConnectorError::needs_reconnect("Saved token is corrupted.", "invalid utf8"))?;
        let workspace_id = trigger
            .configuration
            .get("workspaceId")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                ConnectorError::user_fixable(
                    "Please choose a ClickUp workspace before activating.",
                    "missing trigger.configuration.workspaceId",
                )
            })?;

        let clickup_event = map_trigger_to_clickup_event(&trigger.event)?;
        let mut payload = json!({
            "endpoint": callback_url,
            "events": [clickup_event],
        });

        if let Some(list_id) = trigger
            .configuration
            .get("listId")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            if let Ok(num) = list_id.parse::<u64>() {
                payload["list_id"] = json!(num);
            } else {
                payload["list_id"] = json!(list_id);
            }
        }

        let base = api_base(cx.env);
        let url = format!("{base}/team/{workspace_id}/webhook");
        let (status, retry_after, body) =
            clickup_request(worker::Method::Post, &url, Some(token), Some(&payload)).await?;
        if !(200..300).contains(&status) {
            return Err(classify_clickup_http_error(
                status,
                retry_after.as_deref(),
                &body,
            ));
        }

        let parsed: Value = serde_json::from_str(&body).map_err(|e| {
            ConnectorError::retryable(
                None,
                "ClickUp returned an unexpected webhook response.",
                e.to_string(),
            )
        })?;

        let webhook_id = value_as_id_str(&parsed["webhook"]["id"])
            .or_else(|| value_as_id_str(&parsed["id"]))
            .ok_or_else(|| {
                ConnectorError::permanent(
                    "ClickUp did not return a webhook ID.",
                    format!("missing webhook id in response: {body}"),
                )
            })?;

        let secret_str = parsed["webhook"]["secret"]
            .as_str()
            .or_else(|| parsed["secret"].as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(Secret::from_str_slice);

        Ok(ExternalSubscription {
            external_webhook_id: Some(webhook_id),
            signing_secret: secret_str,
            verification: "clickup_hmac".to_string(),
        })
    }

    async fn unsubscribe(
        &self,
        cx: &Cx<'_>,
        creds: &Secret,
        sub: &ExternalSubscription,
    ) -> Result<(), ConnectorError> {
        let Some(ref webhook_id) = sub.external_webhook_id else {
            return Ok(());
        };
        let token = creds
            .expose_str()
            .map_err(|_| ConnectorError::needs_reconnect("Saved token is corrupted.", "invalid utf8"))?;
        let base = api_base(cx.env);
        let url = format!("{base}/webhook/{webhook_id}");
        let (status, retry_after, body) =
            clickup_request(worker::Method::Delete, &url, Some(token), None).await?;
        if status == 404 || (200..300).contains(&status) {
            return Ok(());
        }
        Err(classify_clickup_http_error(
            status,
            retry_after.as_deref(),
            &body,
        ))
    }

    fn verify(
        &self,
        headers: &Headers,
        raw_body: &[u8],
        secret: &[u8],
    ) -> Result<(), VerifyError> {
        let sig = headers.get("X-Signature").ok().flatten();
        verify_clickup_signature(sig.as_deref(), raw_body, secret)
    }

    fn dedup_key(&self, raw: &Value, raw_body: &[u8]) -> String {
        clickup_dedup_key(raw, raw_body)
    }

    async fn normalize(
        &self,
        cx: &Cx<'_>,
        creds: &Secret,
        trigger: &TriggerConfig,
        raw: &Value,
    ) -> Result<Option<NormalizedEvent>, ConnectorError> {
        let expected_event = map_trigger_to_clickup_event(&trigger.event)?;
        let actual_event = raw["event"].as_str().unwrap_or("");
        if actual_event != expected_event {
            return Ok(None);
        }

        if trigger.event == "task.completed" && history_indicates_non_closed(raw) {
            return Ok(None);
        }

        let Some(task_id) = value_as_id_str(&raw["task_id"]) else {
            return Ok(None);
        };

        let token = creds
            .expose_str()
            .map_err(|_| ConnectorError::needs_reconnect("Saved token is corrupted.", "invalid utf8"))?;
        let base = api_base(cx.env);
        let url = format!("{base}/task/{task_id}");

        let (status, retry_after, body) =
            clickup_request(worker::Method::Get, &url, Some(token), None).await?;
        if status == 404 {
            return Ok(None);
        }
        if !(200..300).contains(&status) {
            return Err(classify_clickup_http_error(
                status,
                retry_after.as_deref(),
                &body,
            ));
        }

        let task: Value = serde_json::from_str(&body).map_err(|e| {
            ConnectorError::retryable(
                None,
                "ClickUp returned an unexpected task payload.",
                e.to_string(),
            )
        })?;

        let configured_list_id = trigger
            .configuration
            .get("listId")
            .and_then(|v| v.as_str());

        Ok(normalize_clickup_payload(
            &trigger.event,
            configured_list_id,
            raw,
            &task,
        ))
    }

    async fn execute(
        &self,
        _cx: &Cx<'_>,
        _creds: &Secret,
        _action: &ActionConfig,
        _inputs: &RenderedInputs,
    ) -> Result<ActionOutput, ConnectorError> {
        Err(ConnectorError::permanent(
            "ClickUp does not support outbound actions.",
            "clickup execute called",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connectors::clickup_variables;
    use crate::crypto::hmac_sha256_hex;

    #[test]
    fn verifies_clickup_hmac_signature() {
        let secret = b"CU_WEBHOOK_SECRET_987";
        let raw_body = br#"{"event":"taskCreated","task_id":"8688abc12","webhook_id":"wh_1"}"#;
        let valid_sig = hmac_sha256_hex(secret, raw_body);

        assert!(verify_clickup_signature(Some(&valid_sig), raw_body, secret).is_ok());
        assert!(verify_clickup_signature(Some(&valid_sig.to_uppercase()), raw_body, secret).is_ok());
        assert!(matches!(
            verify_clickup_signature(None, raw_body, secret),
            Err(VerifyError::MissingSignature)
        ));
        assert!(matches!(
            verify_clickup_signature(Some("   "), raw_body, secret),
            Err(VerifyError::MissingSignature)
        ));
        assert!(matches!(
            verify_clickup_signature(Some("0000"), raw_body, secret),
            Err(VerifyError::InvalidSignature)
        ));
        assert!(matches!(
            verify_clickup_signature(Some(&valid_sig), b"tampered", secret),
            Err(VerifyError::InvalidSignature)
        ));
    }

    #[test]
    fn builds_clickup_dedup_key_with_and_without_history_id() {
        let raw_with_history = json!({
            "webhook_id": "wh_42",
            "event": "taskCreated",
            "task_id": "8688abc12",
            "history_items": [{ "id": "hist_999" }]
        });
        assert_eq!(
            clickup_dedup_key(&raw_with_history, b"{}"),
            "wh_42:taskCreated:8688abc12:hist_999"
        );

        let raw_without_history = json!({
            "webhook_id": "wh_42",
            "event": "taskUpdated",
            "task_id": "8688abc12"
        });
        let body = br#"{"webhook_id":"wh_42","event":"taskUpdated","task_id":"8688abc12"}"#;
        assert_eq!(
            clickup_dedup_key(&raw_without_history, body),
            format!("wh_42:taskUpdated:8688abc12:{}", sha256_hex(body))
        );
    }

    #[test]
    fn normalizes_clickup_task_and_populates_all_variables() {
        let raw_event = json!({
            "event": "taskCreated",
            "task_id": "8688abc12",
            "webhook_id": "wh_1"
        });
        let task = json!({
            "id": "8688abc12",
            "name": "Ship v2",
            "url": "https://app.clickup.com/t/8688abc12",
            "status": { "status": "in progress", "type": "custom" },
            "text_content": "Update the welcome checklist",
            "assignees": [
                { "username": "Alex Rivera", "email": "alex@example.com" },
                { "username": "Sam Lee" }
            ],
            "creator": { "username": "Sam Lee" },
            "list": { "id": "list_99", "name": "Product Roadmap" },
            "due_date": "1795132800000",
            "priority": { "priority": "high" }
        });

        let norm = normalize_clickup_payload("task.created", Some("list_99"), &raw_event, &task)
            .expect("should normalize");
        assert_eq!(norm.trigger_summary, "Task \"Ship v2\" was created");
        assert_eq!(norm.variables["task.id"], "8688abc12");
        assert_eq!(norm.variables["task.name"], "Ship v2");
        assert_eq!(
            norm.variables["task.url"],
            "https://app.clickup.com/t/8688abc12"
        );
        assert_eq!(norm.variables["task.status"], "in progress");
        assert_eq!(
            norm.variables["task.description"],
            "Update the welcome checklist"
        );
        assert_eq!(norm.variables["task.assignees"], "Alex Rivera, Sam Lee");
        assert_eq!(norm.variables["task.creator"], "Sam Lee");
        assert_eq!(norm.variables["task.list"], "Product Roadmap");
        assert_eq!(norm.variables["task.due_date"], "2026-11-20");
        assert_eq!(norm.variables["task.priority"], "high");
        assert_eq!(norm.variables["event.type"], "taskCreated");

        // Ensure all 11 catalog variables are present
        for var in clickup_variables() {
            assert!(
                norm.variables.contains_key(&var.path),
                "missing variable {}",
                var.path
            );
        }

        // List mismatch filters out event
        assert!(
            normalize_clickup_payload("task.created", Some("other_list"), &raw_event, &task)
                .is_none()
        );

        // task.completed requires closed status
        let status_raw = json!({
            "event": "taskStatusUpdated",
            "task_id": "8688abc12",
            "history_items": [{ "after": { "status": "in progress", "type": "custom" } }]
        });
        assert!(
            normalize_clickup_payload("task.completed", None, &status_raw, &task).is_none()
        );

        let closed_raw = json!({
            "event": "taskStatusUpdated",
            "task_id": "8688abc12",
            "history_items": [{ "after": { "status": "complete", "type": "closed" } }]
        });
        let closed_norm = normalize_clickup_payload("task.completed", None, &closed_raw, &task)
            .expect("closed status should trigger task.completed");
        assert_eq!(closed_norm.trigger_summary, "Task \"Ship v2\" was completed");
    }
}
