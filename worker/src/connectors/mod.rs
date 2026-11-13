pub mod clickup;
pub mod http;
pub mod slack;
pub mod webhook;

use std::collections::BTreeMap;

use serde_json::Value;
use thiserror::Error;
use worker::{Env, Headers};

use crate::api_types::{
    ActionDefinition, AppDefinition, AppId, AuthKind, ConfigValue, FieldDefinition, FieldOption,
    FieldType, RecoveryAction, TokenAuthSpec, TriggerDefinition, VariableDefinition,
};
use crate::crypto::Secret;

/// Connector execution context passed into connector methods.
pub struct Cx<'a> {
    pub env: &'a Env,
    pub org_id: &'a str,
    pub request_id: &'a str,
}

#[derive(Debug, Clone)]
pub enum AuthSpec {
    OAuth2 {
        authorize_url: &'static str,
        token_url: &'static str,
        scopes: &'static [&'static str],
    },
    ApiToken,
    None,
}

#[derive(Debug, Clone)]
pub struct NewConnection {
    pub display_name: String,
    pub external_account_id: Option<String>,
    pub credential: Secret,
}

#[derive(Debug, Clone)]
pub struct TriggerConfig {
    pub event: String,
    pub configuration: BTreeMap<String, ConfigValue>,
}

#[derive(Debug, Clone)]
pub struct ActionConfig {
    pub event: String,
    pub configuration: BTreeMap<String, ConfigValue>,
}

#[derive(Debug, Clone)]
pub struct ExternalSubscription {
    pub external_webhook_id: Option<String>,
    pub signing_secret: Option<Secret>,
    pub verification: String,
}

#[derive(Debug, Clone)]
pub struct NormalizedEvent {
    pub trigger_summary: String,
    pub variables: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone)]
pub struct RenderedInputs {
    pub values: BTreeMap<String, ConfigValue>,
}

#[derive(Debug, Clone)]
pub struct ActionOutput {
    pub action_summary: String,
    pub external_ref: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorClass {
    Retryable { retry_after_secs: Option<u64> },
    NeedsReconnect,
    UserFixable,
    UnknownOutcome,
    Permanent,
}

impl ErrorClass {
    pub fn as_str(&self) -> &'static str {
        match self {
            ErrorClass::Retryable { .. } => "retryable",
            ErrorClass::NeedsReconnect => "needs_reconnect",
            ErrorClass::UserFixable => "user_fixable",
            ErrorClass::UnknownOutcome => "unknown_outcome",
            ErrorClass::Permanent => "permanent",
        }
    }

    pub fn recovery(&self) -> Option<RecoveryAction> {
        match self {
            ErrorClass::Retryable { .. } => Some(RecoveryAction::Retry),
            ErrorClass::NeedsReconnect => Some(RecoveryAction::ReconnectThenRetry),
            ErrorClass::UserFixable => Some(RecoveryAction::EditThenRetry),
            ErrorClass::UnknownOutcome => Some(RecoveryAction::Retry),
            ErrorClass::Permanent => None,
        }
    }
}

#[derive(Debug, Error)]
#[error("{user_message}")]
pub struct ConnectorError {
    pub class: ErrorClass,
    pub user_message: String,
    pub internal_detail: String,
}

impl ConnectorError {
    pub fn permanent(user_message: impl Into<String>, internal_detail: impl Into<String>) -> Self {
        Self {
            class: ErrorClass::Permanent,
            user_message: user_message.into(),
            internal_detail: internal_detail.into(),
        }
    }

    pub fn user_fixable(
        user_message: impl Into<String>,
        internal_detail: impl Into<String>,
    ) -> Self {
        Self {
            class: ErrorClass::UserFixable,
            user_message: user_message.into(),
            internal_detail: internal_detail.into(),
        }
    }

    pub fn needs_reconnect(
        user_message: impl Into<String>,
        internal_detail: impl Into<String>,
    ) -> Self {
        Self {
            class: ErrorClass::NeedsReconnect,
            user_message: user_message.into(),
            internal_detail: internal_detail.into(),
        }
    }

    pub fn retryable(
        retry_after_secs: Option<u64>,
        user_message: impl Into<String>,
        internal_detail: impl Into<String>,
    ) -> Self {
        Self {
            class: ErrorClass::Retryable { retry_after_secs },
            user_message: user_message.into(),
            internal_detail: internal_detail.into(),
        }
    }
}

#[derive(Debug, Error)]
pub enum VerifyError {
    #[error("missing signature header")]
    MissingSignature,
    #[error("invalid signature")]
    InvalidSignature,
    #[error("malformed request")]
    MalformedRequest,
}

#[async_trait::async_trait(?Send)]
pub trait Connector {
    fn id(&self) -> AppId;
    fn name(&self) -> &'static str;
    fn auth(&self) -> AuthSpec;
    fn triggers(&self) -> Vec<TriggerDefinition>;
    fn actions(&self) -> Vec<ActionDefinition>;

    async fn complete_oauth(&self, cx: &Cx<'_>, code: &str)
        -> Result<NewConnection, ConnectorError>;

    async fn field_options(
        &self,
        cx: &Cx<'_>,
        creds: &Secret,
        field: &str,
        parent: Option<&str>,
    ) -> Result<Vec<FieldOption>, ConnectorError>;

    async fn subscribe(
        &self,
        cx: &Cx<'_>,
        creds: &Secret,
        trigger: &TriggerConfig,
        callback_url: &str,
    ) -> Result<ExternalSubscription, ConnectorError>;

    async fn unsubscribe(
        &self,
        cx: &Cx<'_>,
        creds: &Secret,
        sub: &ExternalSubscription,
    ) -> Result<(), ConnectorError>;

    fn verify(
        &self,
        headers: &Headers,
        raw_body: &[u8],
        secret: &[u8],
    ) -> Result<(), VerifyError>;

    fn dedup_key(&self, raw: &Value, raw_body: &[u8]) -> String;

    async fn normalize(
        &self,
        cx: &Cx<'_>,
        creds: &Secret,
        trigger: &TriggerConfig,
        raw: &Value,
    ) -> Result<Option<NormalizedEvent>, ConnectorError>;

    async fn execute(
        &self,
        cx: &Cx<'_>,
        creds: &Secret,
        action: &ActionConfig,
        inputs: &RenderedInputs,
    ) -> Result<ActionOutput, ConnectorError>;
}

pub fn get_connector(app_id: AppId) -> Box<dyn Connector> {
    match app_id {
        AppId::Clickup => Box::new(clickup::ClickUpConnector),
        AppId::Slack => Box::new(slack::SlackConnector),
        AppId::Webhook => Box::new(webhook::WebhookConnector),
        AppId::Http => Box::new(http::HttpConnector),
    }
}

pub async fn test_connection(
    app_id: AppId,
    cx: &Cx<'_>,
    creds: &Secret,
) -> Result<String, ConnectorError> {
    match app_id {
        AppId::Clickup => clickup::ClickUpConnector.test_connection(cx, creds).await,
        AppId::Slack => slack::SlackConnector.test_connection(cx, creds).await,
        AppId::Http => {
            let s = creds
                .expose_str()
                .map_err(|_| ConnectorError::needs_reconnect("Saved HTTP credential is corrupted.", "invalid utf8"))?;
            if s.trim().is_empty() {
                Err(ConnectorError::needs_reconnect(
                    "HTTP credential is empty. Please recreate this connection.",
                    "empty http credential",
                ))
            } else {
                Ok("HTTP credential is stored and ready.".to_string())
            }
        }
        AppId::Webhook => Ok("Custom Webhook does not require external credentials.".to_string()),
    }
}

/// Static MVP catalog of supported applications, triggers, actions, and variable schemas.
#[derive(Debug, Clone)]
pub struct Catalog {
    apps: Vec<AppDefinition>,
}

impl Default for Catalog {
    fn default() -> Self {
        Self::mvp()
    }
}

impl Catalog {
    pub fn mvp() -> Self {
        Self {
            apps: vec![
                clickup_app_definition(),
                slack_app_definition(),
                webhook_app_definition(),
                http_app_definition(),
            ],
        }
    }

    pub fn apps(&self) -> &[AppDefinition] {
        &self.apps
    }

    pub fn get_app(&self, id: AppId) -> Option<&AppDefinition> {
        self.apps.iter().find(|a| a.id == id)
    }

    pub fn get_trigger(&self, app_id: AppId, trigger_id: &str) -> Option<&TriggerDefinition> {
        self.get_app(app_id)?
            .triggers
            .iter()
            .find(|t| t.id == trigger_id)
    }

    pub fn get_action(&self, app_id: AppId, action_id: &str) -> Option<&ActionDefinition> {
        self.get_app(app_id)?
            .actions
            .iter()
            .find(|a| a.id == action_id)
    }
}

pub fn clickup_variables() -> Vec<VariableDefinition> {
    vec![
        VariableDefinition {
            path: "task.id".to_string(),
            label: "Task ID".to_string(),
            example: "8688abc12".to_string(),
        },
        VariableDefinition {
            path: "task.name".to_string(),
            label: "Task name".to_string(),
            example: "Ship the new onboarding".to_string(),
        },
        VariableDefinition {
            path: "task.url".to_string(),
            label: "Task URL".to_string(),
            example: "https://app.clickup.com/t/8688abc12".to_string(),
        },
        VariableDefinition {
            path: "task.status".to_string(),
            label: "Status".to_string(),
            example: "in progress".to_string(),
        },
        VariableDefinition {
            path: "task.description".to_string(),
            label: "Description".to_string(),
            example: "Update the welcome checklist".to_string(),
        },
        VariableDefinition {
            path: "task.assignees".to_string(),
            label: "Assignees".to_string(),
            example: "Alex Rivera".to_string(),
        },
        VariableDefinition {
            path: "task.creator".to_string(),
            label: "Creator".to_string(),
            example: "Sam Lee".to_string(),
        },
        VariableDefinition {
            path: "task.list".to_string(),
            label: "List".to_string(),
            example: "Product Roadmap".to_string(),
        },
        VariableDefinition {
            path: "task.due_date".to_string(),
            label: "Due date".to_string(),
            example: "2026-11-20".to_string(),
        },
        VariableDefinition {
            path: "task.priority".to_string(),
            label: "Priority".to_string(),
            example: "high".to_string(),
        },
        VariableDefinition {
            path: "event.type".to_string(),
            label: "Event type".to_string(),
            example: "taskCreated".to_string(),
        },
    ]
}

fn clickup_trigger_fields() -> Vec<FieldDefinition> {
    vec![
        FieldDefinition {
            key: "workspaceId".to_string(),
            label: "Which ClickUp workspace should we watch?".to_string(),
            field_type: FieldType::DynamicSelect,
            required: true,
            placeholder: Some("Select a workspace".to_string()),
            help: None,
            options: None,
            depends_on: None,
            advanced: None,
        },
        FieldDefinition {
            key: "listId".to_string(),
            label: "Limit to a specific list (optional)".to_string(),
            field_type: FieldType::DynamicSelect,
            required: false,
            placeholder: Some("All lists in workspace".to_string()),
            help: Some("Leave empty to trigger for every list in the workspace.".to_string()),
            options: None,
            depends_on: Some("workspaceId".to_string()),
            advanced: None,
        },
    ]
}

fn clickup_app_definition() -> AppDefinition {
    let fields = clickup_trigger_fields();
    let vars = clickup_variables();
    AppDefinition {
        id: AppId::Clickup,
        name: "ClickUp".to_string(),
        description: "Trigger automations when tasks are created, updated, completed, or assigned."
            .to_string(),
        icon_url: "/icons/clickup.svg".to_string(),
        auth_kind: AuthKind::Oauth2,
        token_auth: Some(TokenAuthSpec {
            label: "Personal API token".to_string(),
            help: "Paste a ClickUp personal API token (pk_...) for instant setup without configuring an OAuth app."
                .to_string(),
            advanced: false,
        }),
        triggers: vec![
            TriggerDefinition {
                id: "task.created".to_string(),
                label: "When a task is created".to_string(),
                description: "Runs whenever a new task is added.".to_string(),
                fields: fields.clone(),
                variables: vars.clone(),
            },
            TriggerDefinition {
                id: "task.updated".to_string(),
                label: "When a task is updated".to_string(),
                description: "Runs whenever a task is edited.".to_string(),
                fields: fields.clone(),
                variables: vars.clone(),
            },
            TriggerDefinition {
                id: "task.completed".to_string(),
                label: "When a task is completed".to_string(),
                description: "Runs when a task moves into a closed/done status.".to_string(),
                fields: fields.clone(),
                variables: vars.clone(),
            },
            TriggerDefinition {
                id: "task.assigned".to_string(),
                label: "When a task is assigned".to_string(),
                description: "Runs when someone is assigned to a task.".to_string(),
                fields,
                variables: vars,
            },
        ],
        actions: vec![],
        advanced: None,
    }
}

fn slack_app_definition() -> AppDefinition {
    AppDefinition {
        id: AppId::Slack,
        name: "Slack".to_string(),
        description: "Post formatted messages to Slack channels.".to_string(),
        icon_url: "/icons/slack.svg".to_string(),
        auth_kind: AuthKind::Oauth2,
        token_auth: Some(TokenAuthSpec {
            label: "Bot User OAuth token".to_string(),
            help: "Paste a Slack Bot Token (xoxb-...) from OAuth & Permissions for instant setup without configuring OAuth redirect URLs."
                .to_string(),
            advanced: false,
        }),
        triggers: vec![],
        actions: vec![ActionDefinition {
            id: "message.send".to_string(),
            label: "Send a message".to_string(),
            description: "Post a message to a public or private Slack channel.".to_string(),
            fields: vec![
                FieldDefinition {
                    key: "channel".to_string(),
                    label: "Where should we send the message?".to_string(),
                    field_type: FieldType::DynamicSelect,
                    required: true,
                    placeholder: Some("Choose a channel".to_string()),
                    help: None,
                    options: None,
                    depends_on: None,
                    advanced: None,
                },
                FieldDefinition {
                    key: "message".to_string(),
                    label: "What should the message say?".to_string(),
                    field_type: FieldType::Template,
                    required: true,
                    placeholder: Some("New task: {{task.name}} ({{task.url}})".to_string()),
                    help: Some("Use {{variable}} placeholders from your trigger.".to_string()),
                    options: None,
                    depends_on: None,
                    advanced: None,
                },
            ],
            advanced: None,
        }],
        advanced: None,
    }
}

fn webhook_app_definition() -> AppDefinition {
    AppDefinition {
        id: AppId::Webhook,
        name: "Custom Webhook".to_string(),
        description: "Start an automation when any external service sends an HTTP POST."
            .to_string(),
        icon_url: "/icons/webhook.svg".to_string(),
        auth_kind: AuthKind::None,
        token_auth: None,
        triggers: vec![TriggerDefinition {
            id: "webhook.received".to_string(),
            label: "When a webhook is received".to_string(),
            description: "Generates a unique URL you can call with JSON payloads.".to_string(),
            fields: vec![FieldDefinition {
                key: "verification".to_string(),
                label: "How should incoming requests be verified?".to_string(),
                field_type: FieldType::Select,
                required: true,
                placeholder: None,
                help: None,
                options: Some(vec![
                    FieldOption {
                        value: "hmac_sha256".to_string(),
                        label: "HMAC-SHA256 signature".to_string(),
                    },
                    FieldOption {
                        value: "shared_token".to_string(),
                        label: "Shared bearer/header token".to_string(),
                    },
                    FieldOption {
                        value: "none".to_string(),
                        label: "No signature check".to_string(),
                    },
                ]),
                depends_on: None,
                advanced: Some(true),
            }],
            variables: vec![
                VariableDefinition {
                    path: "body.event".to_string(),
                    label: "Event name".to_string(),
                    example: "order.paid".to_string(),
                },
                VariableDefinition {
                    path: "body.id".to_string(),
                    label: "Payload ID".to_string(),
                    example: "evt_123".to_string(),
                },
                VariableDefinition {
                    path: "body.data".to_string(),
                    label: "Payload data".to_string(),
                    example: "{\"amount\":42}".to_string(),
                },
            ],
        }],
        actions: vec![],
        advanced: Some(true),
    }
}

fn http_app_definition() -> AppDefinition {
    AppDefinition {
        id: AppId::Http,
        name: "HTTP Request".to_string(),
        description: "Call any external HTTPS API endpoint with SSRF protection.".to_string(),
        icon_url: "/icons/http.svg".to_string(),
        auth_kind: AuthKind::ApiToken,
        token_auth: Some(TokenAuthSpec {
            label: "API credential".to_string(),
            help: "Store an encrypted token or credential for HTTP requests.".to_string(),
            advanced: true,
        }),
        triggers: vec![],
        actions: vec![ActionDefinition {
            id: "http.request".to_string(),
            label: "Send an HTTP request".to_string(),
            description: "Make an outbound HTTP call with templated URL, headers, and body."
                .to_string(),
            fields: vec![
                FieldDefinition {
                    key: "method".to_string(),
                    label: "HTTP method".to_string(),
                    field_type: FieldType::Select,
                    required: true,
                    placeholder: None,
                    help: None,
                    options: Some(vec![
                        FieldOption {
                            value: "POST".to_string(),
                            label: "POST".to_string(),
                        },
                        FieldOption {
                            value: "GET".to_string(),
                            label: "GET".to_string(),
                        },
                        FieldOption {
                            value: "PUT".to_string(),
                            label: "PUT".to_string(),
                        },
                        FieldOption {
                            value: "PATCH".to_string(),
                            label: "PATCH".to_string(),
                        },
                        FieldOption {
                            value: "DELETE".to_string(),
                            label: "DELETE".to_string(),
                        },
                    ]),
                    depends_on: None,
                    advanced: Some(true),
                },
                FieldDefinition {
                    key: "url".to_string(),
                    label: "Destination URL".to_string(),
                    field_type: FieldType::Template,
                    required: true,
                    placeholder: Some("https://api.example.com/webhooks".to_string()),
                    help: None,
                    options: None,
                    depends_on: None,
                    advanced: Some(true),
                },
                FieldDefinition {
                    key: "headers".to_string(),
                    label: "Headers".to_string(),
                    field_type: FieldType::KeyValue,
                    required: false,
                    placeholder: None,
                    help: None,
                    options: None,
                    depends_on: None,
                    advanced: Some(true),
                },
                FieldDefinition {
                    key: "authType".to_string(),
                    label: "Authentication".to_string(),
                    field_type: FieldType::Select,
                    required: false,
                    placeholder: None,
                    help: None,
                    options: Some(vec![
                        FieldOption {
                            value: "none".to_string(),
                            label: "None".to_string(),
                        },
                        FieldOption {
                            value: "bearer".to_string(),
                            label: "Bearer token".to_string(),
                        },
                        FieldOption {
                            value: "api_key".to_string(),
                            label: "API key header".to_string(),
                        },
                        FieldOption {
                            value: "basic".to_string(),
                            label: "Basic auth".to_string(),
                        },
                    ]),
                    depends_on: None,
                    advanced: Some(true),
                },
                FieldDefinition {
                    key: "body".to_string(),
                    label: "Request body".to_string(),
                    field_type: FieldType::Template,
                    required: false,
                    placeholder: Some("{\"task\":\"{{task.name}}\"}".to_string()),
                    help: None,
                    options: None,
                    depends_on: None,
                    advanced: Some(true),
                },
            ],
            advanced: Some(true),
        }],
        advanced: Some(true),
    }
}
