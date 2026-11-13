use std::collections::BTreeMap;
use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub type Id = String;
pub type UnixMs = i64;

// ───────────────────────── Common ─────────────────────────

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    Unauthenticated,
    Forbidden,
    NotFound,
    ValidationFailed,
    Conflict,
    RateLimited,
    UpstreamError,
    Internal,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ApiErrorBody {
    pub code: ErrorCode,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fields: Option<BTreeMap<String, String>>,
    pub request_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ApiError {
    pub error: ApiErrorBody,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Page<T> {
    pub items: Vec<T>,
    pub next_cursor: Option<String>,
}

// ───────────────────────── Auth ─────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RegisterRequest {
    pub name: String,
    pub email: String,
    pub password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MeUser {
    pub id: Id,
    pub name: String,
    pub email: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MeOrganization {
    pub id: Id,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Me {
    pub user: MeUser,
    pub organization: MeOrganization,
}

// ───────────────────────── Catalog ─────────────────────────

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum AppId {
    Clickup,
    Slack,
    Webhook,
    Http,
}

impl AppId {
    pub fn as_str(self) -> &'static str {
        match self {
            AppId::Clickup => "clickup",
            AppId::Slack => "slack",
            AppId::Webhook => "webhook",
            AppId::Http => "http",
        }
    }
}

impl fmt::Display for AppId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for AppId {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "clickup" => Ok(AppId::Clickup),
            "slack" => Ok(AppId::Slack),
            "webhook" => Ok(AppId::Webhook),
            "http" => Ok(AppId::Http),
            other => Err(format!("unknown application id: {other}")),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuthKind {
    Oauth2,
    ApiToken,
    None,
}

impl AuthKind {
    pub fn as_str(self) -> &'static str {
        match self {
            AuthKind::Oauth2 => "oauth2",
            AuthKind::ApiToken => "api_token",
            AuthKind::None => "none",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FieldType {
    Text,
    Template,
    Select,
    DynamicSelect,
    KeyValue,
    Secret,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FieldOption {
    pub value: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FieldDefinition {
    pub key: String,
    pub label: String,
    #[serde(rename = "type")]
    pub field_type: FieldType,
    pub required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub help: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<FieldOption>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub depends_on: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub advanced: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VariableDefinition {
    pub path: String,
    pub label: String,
    pub example: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TriggerDefinition {
    pub id: String,
    pub label: String,
    pub description: String,
    pub fields: Vec<FieldDefinition>,
    pub variables: Vec<VariableDefinition>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActionDefinition {
    pub id: String,
    pub label: String,
    pub description: String,
    pub fields: Vec<FieldDefinition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub advanced: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TokenAuthSpec {
    pub label: String,
    pub help: String,
    pub advanced: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppDefinition {
    pub id: AppId,
    pub name: String,
    pub description: String,
    pub icon_url: String,
    pub auth_kind: AuthKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_auth: Option<TokenAuthSpec>,
    pub triggers: Vec<TriggerDefinition>,
    pub actions: Vec<ActionDefinition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub advanced: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppsResponse {
    pub apps: Vec<AppDefinition>,
}

// ───────────────────────── Connections ─────────────────────────

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionStatus {
    Connected,
    NeedsAttention,
    Revoked,
}

impl ConnectionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            ConnectionStatus::Connected => "connected",
            ConnectionStatus::NeedsAttention => "needs_attention",
            ConnectionStatus::Revoked => "revoked",
        }
    }
}

impl FromStr for ConnectionStatus {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "connected" => Ok(ConnectionStatus::Connected),
            "needs_attention" => Ok(ConnectionStatus::NeedsAttention),
            "revoked" => Ok(ConnectionStatus::Revoked),
            other => Err(format!("unknown connection status: {other}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub id: Id,
    pub application_id: AppId,
    pub display_name: String,
    pub status: ConnectionStatus,
    pub created_at: UnixMs,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionsResponse {
    pub connections: Vec<Connection>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CreateTokenConnectionRequest {
    pub application_id: AppId,
    pub token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OAuthStartRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub return_to: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OAuthStartResponse {
    pub redirect_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TestConnectionResponse {
    pub ok: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OptionsResponse {
    pub options: Vec<FieldOption>,
}

// ───────────────────────── Workflow definition ─────────────────────────

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FilterOp {
    Equals,
    NotEquals,
    Contains,
    NotContains,
    IsEmpty,
    IsNotEmpty,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Filter {
    pub path: String,
    pub op: FilterOp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SelectConfigValue {
    pub value: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KeyValuePair {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum ConfigValue {
    String(String),
    Select(SelectConfigValue),
    KeyValueList(Vec<KeyValuePair>),
    Null,
}

impl ConfigValue {
    pub fn as_str(&self) -> Option<&str> {
        match self {
            ConfigValue::String(s) => Some(s.as_str()),
            ConfigValue::Select(sv) => Some(sv.value.as_str()),
            ConfigValue::KeyValueList(_) | ConfigValue::Null => None,
        }
    }

    pub fn display_label(&self) -> Option<&str> {
        match self {
            ConfigValue::String(s) => Some(s.as_str()),
            ConfigValue::Select(sv) => Some(sv.label.as_str()),
            ConfigValue::KeyValueList(_) | ConfigValue::Null => None,
        }
    }

    pub fn is_empty_value(&self) -> bool {
        match self {
            ConfigValue::String(s) => s.trim().is_empty(),
            ConfigValue::Select(sv) => sv.value.trim().is_empty(),
            ConfigValue::KeyValueList(items) => items.is_empty(),
            ConfigValue::Null => true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowStep {
    pub application: AppId,
    pub event: String,
    pub connection_id: Option<Id>,
    #[serde(default)]
    pub configuration: BTreeMap<String, ConfigValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowDefinitionV1 {
    pub version: u8,
    pub trigger: WorkflowStep,
    #[serde(default)]
    pub filters: Vec<Filter>,
    pub action: WorkflowStep,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NodePosition {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AutomationLayout {
    pub nodes: BTreeMap<String, NodePosition>,
}

// ───────────────────────── Automations ─────────────────────────

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AutomationStatus {
    Draft,
    Active,
    Paused,
    Error,
}

impl AutomationStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            AutomationStatus::Draft => "draft",
            AutomationStatus::Active => "active",
            AutomationStatus::Paused => "paused",
            AutomationStatus::Error => "error",
        }
    }
}

impl FromStr for AutomationStatus {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "draft" => Ok(AutomationStatus::Draft),
            "active" => Ok(AutomationStatus::Active),
            "paused" => Ok(AutomationStatus::Paused),
            "error" => Ok(AutomationStatus::Error),
            other => Err(format!("unknown automation status: {other}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Automation {
    pub id: Id,
    pub name: String,
    pub status: AutomationStatus,
    pub definition: WorkflowDefinitionV1,
    pub layout: Option<AutomationLayout>,
    pub summary: String,
    pub last_execution_at: Option<UnixMs>,
    pub last_execution_status: Option<ExecutionStatus>,
    pub created_at: UnixMs,
    pub updated_at: UnixMs,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AutomationsResponse {
    pub automations: Vec<Automation>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SaveAutomationRequest {
    pub name: String,
    pub definition: WorkflowDefinitionV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout: Option<AutomationLayout>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TestRunResult {
    pub ok: bool,
    pub message: String,
    pub used_sample_data: bool,
}

// ───────────────────────── Custom webhook (Advanced) ─────────────────────────

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WebhookVerification {
    SharedToken,
    HmacSha256,
    None,
}

impl WebhookVerification {
    pub fn as_str(self) -> &'static str {
        match self {
            WebhookVerification::SharedToken => "shared_token",
            WebhookVerification::HmacSha256 => "hmac_sha256",
            WebhookVerification::None => "none",
        }
    }
}

impl FromStr for WebhookVerification {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "shared_token" => Ok(WebhookVerification::SharedToken),
            "hmac_sha256" => Ok(WebhookVerification::HmacSha256),
            "none" => Ok(WebhookVerification::None),
            other => Err(format!("unknown webhook verification mode: {other}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WebhookInfo {
    pub url: String,
    pub verification: WebhookVerification,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret: Option<String>,
    pub last_received_at: Option<UnixMs>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WebhookSample {
    pub event_id: Id,
    pub received_at: UnixMs,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WebhookSamplesResponse {
    pub samples: Vec<WebhookSample>,
}

// ───────────────────────── HTTP test (Advanced) ─────────────────────────

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub enum HttpMethod {
    Get,
    Post,
    Put,
    Patch,
    Delete,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HttpAuthConfig {
    None,
    Bearer {
        #[serde(rename = "credentialConnectionId")]
        credential_connection_id: Id,
    },
    ApiKey {
        #[serde(rename = "credentialConnectionId")]
        credential_connection_id: Id,
        #[serde(rename = "headerName")]
        header_name: String,
    },
    Basic {
        #[serde(rename = "credentialConnectionId")]
        credential_connection_id: Id,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HttpTestRequest {
    pub method: HttpMethod,
    pub url: String,
    pub headers: Vec<KeyValuePair>,
    pub auth: HttpAuthConfig,
    pub body: Option<String>,
    pub sample_variables: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HttpTestResult {
    pub ok: bool,
    pub status: Option<u16>,
    pub duration_ms: u64,
    pub response_preview: String,
    pub message: String,
}

// ───────────────────────── Executions ─────────────────────────

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionStatus {
    Queued,
    Running,
    Sending,
    Succeeded,
    Failed,
    Filtered,
    NeedsReview,
}

impl ExecutionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            ExecutionStatus::Queued => "queued",
            ExecutionStatus::Running => "running",
            ExecutionStatus::Sending => "sending",
            ExecutionStatus::Succeeded => "succeeded",
            ExecutionStatus::Failed => "failed",
            ExecutionStatus::Filtered => "filtered",
            ExecutionStatus::NeedsReview => "needs_review",
        }
    }
}

impl FromStr for ExecutionStatus {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "queued" => Ok(ExecutionStatus::Queued),
            "running" => Ok(ExecutionStatus::Running),
            "sending" => Ok(ExecutionStatus::Sending),
            "succeeded" => Ok(ExecutionStatus::Succeeded),
            "failed" => Ok(ExecutionStatus::Failed),
            "filtered" => Ok(ExecutionStatus::Filtered),
            "needs_review" => Ok(ExecutionStatus::NeedsReview),
            other => Err(format!("unknown execution status: {other}")),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryAction {
    Retry,
    ReconnectThenRetry,
    EditThenRetry,
}

impl RecoveryAction {
    pub fn as_str(self) -> &'static str {
        match self {
            RecoveryAction::Retry => "retry",
            RecoveryAction::ReconnectThenRetry => "reconnect_then_retry",
            RecoveryAction::EditThenRetry => "edit_then_retry",
        }
    }
}

impl FromStr for RecoveryAction {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "retry" => Ok(RecoveryAction::Retry),
            "reconnect_then_retry" => Ok(RecoveryAction::ReconnectThenRetry),
            "edit_then_retry" => Ok(RecoveryAction::EditThenRetry),
            other => Err(format!("unknown recovery action: {other}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Execution {
    pub id: Id,
    pub automation_id: Id,
    pub automation_name: String,
    pub status: ExecutionStatus,
    pub attempt: u32,
    pub trigger_summary: Option<String>,
    pub action_summary: Option<String>,
    pub error_message: Option<String>,
    pub recovery: Option<RecoveryAction>,
    pub connection_id_needing_attention: Option<Id>,
    pub started_at: Option<UnixMs>,
    pub finished_at: Option<UnixMs>,
    pub duration_ms: Option<u64>,
}

// ───────────────────────── Dashboard ─────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DashboardStats {
    pub active_automations: u64,
    pub successful_executions: u64,
    pub failed_executions: u64,
    pub connected_apps: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn api_error_camel_case_roundtrip() {
        let mut fields = BTreeMap::new();
        fields.insert(
            "trigger.configuration.listId".to_string(),
            "Required".to_string(),
        );
        let err = ApiError {
            error: ApiErrorBody {
                code: ErrorCode::ValidationFailed,
                message: "Validation failed".to_string(),
                fields: Some(fields),
                request_id: "req_123".to_string(),
            },
        };
        let v = serde_json::to_value(&err).unwrap();
        assert_eq!(
            v,
            json!({
                "error": {
                    "code": "validation_failed",
                    "message": "Validation failed",
                    "fields": { "trigger.configuration.listId": "Required" },
                    "requestId": "req_123"
                }
            })
        );
        let back: ApiError = serde_json::from_value(v).unwrap();
        assert_eq!(back, err);
    }

    #[test]
    fn workflow_definition_and_config_values_roundtrip() {
        let json_val = json!({
            "version": 1,
            "trigger": {
                "application": "clickup",
                "event": "task.created",
                "connectionId": "con_123",
                "configuration": {
                    "workspaceId": { "value": "ws_1", "label": "Acme" },
                    "listId": null
                }
            },
            "filters": [
                { "path": "task.status", "op": "is_not_empty" },
                { "path": "task.name", "op": "contains", "value": "urgent" }
            ],
            "action": {
                "application": "slack",
                "event": "message.send",
                "connectionId": "con_456",
                "configuration": {
                    "channel": { "value": "C01", "label": "#general" },
                    "message": "New task: {{task.name}}",
                    "headers": [{ "key": "X-Foo", "value": "bar" }]
                }
            }
        });

        let def: WorkflowDefinitionV1 = serde_json::from_value(json_val.clone()).unwrap();
        assert_eq!(def.version, 1);
        assert_eq!(
            def.trigger.configuration.get("listId"),
            Some(&ConfigValue::Null)
        );
        let back = serde_json::to_value(&def).unwrap();
        assert_eq!(back, json_val);
    }

    #[test]
    fn http_test_request_and_auth_roundtrip() {
        let req_json = json!({
            "method": "POST",
            "url": "https://example.com/hook",
            "headers": [{ "key": "Content-Type", "value": "application/json" }],
            "auth": {
                "type": "api_key",
                "credentialConnectionId": "con_http_1",
                "headerName": "X-Api-Key"
            },
            "body": "{\"name\":\"{{task.name}}\"}",
            "sampleVariables": { "task.name": "Ship v2" }
        });
        let req: HttpTestRequest = serde_json::from_value(req_json.clone()).unwrap();
        let back = serde_json::to_value(&req).unwrap();
        assert_eq!(back, req_json);
    }

    #[test]
    fn execution_and_dashboard_and_page_roundtrip() {
        let page = Page {
            items: vec![Execution {
                id: "exe_1".to_string(),
                automation_id: "aut_1".to_string(),
                automation_name: "ClickUp to Slack".to_string(),
                status: ExecutionStatus::NeedsReview,
                attempt: 1,
                trigger_summary: Some("Task created".to_string()),
                action_summary: None,
                error_message: Some("Timed out while sending".to_string()),
                recovery: Some(RecoveryAction::ReconnectThenRetry),
                connection_id_needing_attention: Some("con_slack".to_string()),
                started_at: Some(1700000000000),
                finished_at: Some(1700000001200),
                duration_ms: Some(1200),
            }],
            next_cursor: None,
        };
        let v = serde_json::to_value(&page).unwrap();
        assert_eq!(v["nextCursor"], Value::Null);
        assert_eq!(v["items"][0]["status"], "needs_review");
        assert_eq!(v["items"][0]["recovery"], "reconnect_then_retry");
        assert_eq!(
            v["items"][0]["connectionIdNeedingAttention"],
            "con_slack"
        );
        let back: Page<Execution> = serde_json::from_value(v).unwrap();
        assert_eq!(back, page);

        let stats = DashboardStats {
            active_automations: 3,
            successful_executions: 42,
            failed_executions: 1,
            connected_apps: 2,
        };
        let sv = serde_json::to_value(&stats).unwrap();
        assert_eq!(
            sv,
            json!({
                "activeAutomations": 3,
                "successfulExecutions": 42,
                "failedExecutions": 1,
                "connectedApps": 2
            })
        );
    }
}
