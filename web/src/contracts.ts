/**
 * FROZEN API CONTRACT — Integration Hub (version 1)
 *
 * Single source of truth shared by the Rust Worker (serde, camelCase) and the React app.
 * Changing anything here requires updating docs/API.md, the Rust DTOs in worker/src/api_types.rs,
 * and the e2e contract tests.
 */

// ───────────────────────── Common ─────────────────────────

export type Id = string; // opaque, prefixed: usr_, org_, con_, aut_, exe_, evt_, whk_
export type UnixMs = number;

/** Every non-2xx JSON response from /api/* has this shape. Never contains stack traces or secrets. */
export interface ApiError {
  error: {
    code: ErrorCode;
    message: string; // human-friendly, safe to show to end users
    fields?: Record<string, string>; // per-field validation messages
    requestId: string;
  };
}
export type ErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "validation_failed"
  | "conflict"
  | "rate_limited"
  | "upstream_error"
  | "internal";

/** Cursor pagination */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

// ───────────────────────── Auth ─────────────────────────

export interface RegisterRequest {
  name: string; // 1..80
  email: string;
  password: string; // >= 10 chars
}
export interface LoginRequest {
  email: string;
  password: string;
}
export interface Me {
  user: { id: Id; name: string; email: string };
  organization: { id: Id; name: string };
}
// POST /api/auth/register -> 201 Me (sets __Host-session cookie; in local dev over http: "session")
// POST /api/auth/login    -> 200 Me
// POST /api/auth/logout   -> 204
// GET  /api/me            -> 200 Me | 401

// ───────────────────────── Catalog ─────────────────────────

export type AppId = "clickup" | "slack" | "webhook" | "http";

export type AuthKind = "oauth2" | "api_token" | "none";

export type FieldType =
  | "text" // single line
  | "template" // multi-line text that may contain {{variables}}
  | "select" // static options
  | "dynamic_select" // options loaded from GET /api/connections/:id/options/:fieldKey
  | "key_value" // list of {key,value} (headers); values may be templates
  | "secret"; // write-only; stored encrypted, never returned

export interface FieldDefinition {
  key: string;
  label: string; // natural language, e.g. "Where should we send the message?"
  type: FieldType;
  required: boolean;
  placeholder?: string;
  help?: string;
  options?: { value: string; label: string }[]; // for "select"
  dependsOn?: string; // for "dynamic_select": parent field key (passed as ?parent=)
  advanced?: boolean; // hidden unless Advanced mode
}

export interface VariableDefinition {
  path: string; // "task.name"
  label: string; // "Task name"
  example: string; // "Ship the new onboarding"
}

export interface TriggerDefinition {
  id: string; // "task.created"
  label: string; // "When a task is created"
  description: string;
  fields: FieldDefinition[];
  variables: VariableDefinition[];
}

export interface ActionDefinition {
  id: string; // "message.send"
  label: string; // "Send a message"
  description: string;
  fields: FieldDefinition[];
  advanced?: boolean; // e.g. HTTP request
}

export interface AppDefinition {
  id: AppId;
  name: string;
  description: string;
  iconUrl: string; // served from /icons/{id}.svg (static asset)
  authKind: AuthKind;
  /** For apps that support an alternative token-based connection (e.g. ClickUp personal token) */
  tokenAuth?: { label: string; help: string; advanced: boolean };
  triggers: TriggerDefinition[];
  actions: ActionDefinition[];
  advanced?: boolean; // webhook/http are listed only in Advanced mode
}
// GET /api/apps -> 200 { apps: AppDefinition[] }   (public catalog; no auth required)

// ───────────────────────── Connections ─────────────────────────

export type ConnectionStatus = "connected" | "needs_attention" | "revoked";

export interface Connection {
  id: Id;
  applicationId: AppId;
  displayName: string; // "Acme (Slack)"
  status: ConnectionStatus;
  createdAt: UnixMs;
  // NOTE: no credential fields, ever.
}
// GET    /api/connections                           -> 200 { connections: Connection[] }
// POST   /api/connections/:appId/oauth/start         body { returnTo?: string } -> 200 { redirectUrl: string }
// GET    /api/oauth/:appId/callback?code&state       -> 302 to `${returnTo || "/connections"}?connected=<conId>` or `?connectError=<code>`
// POST   /api/connections                            body CreateTokenConnectionRequest -> 201 Connection
// POST   /api/connections/:id/test                   -> 200 { ok: boolean; message: string }
// DELETE /api/connections/:id                        -> 204
// GET    /api/connections/:id/options/:fieldKey?parent=<value> -> 200 { options: FieldOption[] }
export interface CreateTokenConnectionRequest {
  applicationId: AppId;
  token: string; // write-only
  displayName?: string;
}
export interface FieldOption {
  value: string;
  label: string;
}

export type OAuthAppConfigSource = "organization" | "server" | "none";

export interface OAuthAppConfigStatus {
  applicationId: "clickup" | "slack";
  name: string;
  configured: boolean;
  source: OAuthAppConfigSource;
  clientId: string | null;
  redirectUrl: string;
  requiredScopes: string[];
  docsHint: string;
  updatedAt: UnixMs | null;
}

export interface SaveOAuthAppConfigRequest {
  clientId: string;
  clientSecret?: string;
}
// GET    /api/oauth-apps          -> 200 { apps: OAuthAppConfigStatus[] }
// PUT    /api/oauth-apps/:appId   body SaveOAuthAppConfigRequest -> 200 OAuthAppConfigStatus
// DELETE /api/oauth-apps/:appId   -> 204

// ───────────────────────── Workflow definition (persisted, executed) ─────────────────────────

export type FilterOp = "equals" | "not_equals" | "contains" | "not_contains" | "is_empty" | "is_not_empty";

export interface Filter {
  path: string; // variable path from the trigger's variables, e.g. "task.status"
  op: FilterOp;
  value?: string; // omitted for is_empty/is_not_empty
}

/** A configuration value. For dynamic selects we keep the label for human summaries. */
export type ConfigValue = string | { value: string; label: string } | { key: string; value: string }[] | null;

export interface WorkflowStep {
  application: AppId;
  event: string; // trigger id or action id
  connectionId: Id | null; // null only for apps with authKind "none"
  configuration: Record<string, ConfigValue>;
}

export interface WorkflowDefinitionV1 {
  version: 1;
  trigger: WorkflowStep;
  filters: Filter[];
  action: WorkflowStep;
}

/** Visual-only; never affects execution. */
export interface AutomationLayout {
  nodes: Record<string, { x: number; y: number }>; // keyed "trigger" | "action"
}

// ───────────────────────── Automations ─────────────────────────

export type AutomationStatus = "draft" | "active" | "paused" | "error";

export interface Automation {
  id: Id;
  name: string;
  status: AutomationStatus;
  definition: WorkflowDefinitionV1;
  layout: AutomationLayout | null;
  summary: string; // "When a task is created in ClickUp, send a message to #general in Slack."
  lastExecutionAt: UnixMs | null;
  lastExecutionStatus: ExecutionStatus | null;
  createdAt: UnixMs;
  updatedAt: UnixMs;
}
export interface SaveAutomationRequest {
  name: string;
  definition: WorkflowDefinitionV1; // drafts may have incomplete steps: see "draft rules" in docs/API.md
  layout?: AutomationLayout | null;
}
// GET    /api/automations              -> 200 { automations: Automation[] }
// POST   /api/automations              body SaveAutomationRequest -> 201 Automation (status "draft")
// GET    /api/automations/:id          -> 200 Automation
// PUT    /api/automations/:id          body SaveAutomationRequest -> 200 Automation
// DELETE /api/automations/:id          -> 204 (unsubscribes webhooks)
// POST   /api/automations/:id/activate -> 200 Automation (full validation; creates webhook subscription)
// POST   /api/automations/:id/pause    -> 200 Automation
// POST   /api/automations/:id/test     -> 200 TestRunResult (runs the action once using the latest event or sample data)
export interface TestRunResult {
  ok: boolean;
  message: string; // human-readable
  usedSampleData: boolean;
}

// ───────────────────────── Custom webhook (Advanced) ─────────────────────────

export interface WebhookInfo {
  url: string; // https://<host>/hooks/<publicId>
  verification: "shared_token" | "hmac_sha256" | "none";
  /** Only present in the response of rotate-secret (shown once). */
  secret?: string;
  lastReceivedAt: UnixMs | null;
}
export interface WebhookSample {
  eventId: Id;
  receivedAt: UnixMs;
  payload: unknown; // truncated JSON body
}
// GET  /api/automations/:id/webhook                 -> 200 WebhookInfo
// POST /api/automations/:id/webhook/rotate-secret   -> 200 WebhookInfo (with secret)
// GET  /api/automations/:id/webhook/samples         -> 200 { samples: WebhookSample[] }  (last 10)

// ───────────────────────── HTTP test (Advanced) ─────────────────────────

export interface HttpTestRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers: { key: string; value: string }[];
  auth:
    | { type: "none" }
    | { type: "bearer"; credentialConnectionId: Id }
    | { type: "api_key"; credentialConnectionId: Id; headerName: string }
    | { type: "basic"; credentialConnectionId: Id };
  body: string | null; // may contain {{variables}}; rendered with sampleVariables
  sampleVariables: Record<string, string>;
}
export interface HttpTestResult {
  ok: boolean;
  status: number | null;
  durationMs: number;
  responsePreview: string; // first 4 KB
  message: string; // human-readable, e.g. "That address points to a private network, which isn't allowed."
}
// POST /api/http/test body HttpTestRequest -> 200 HttpTestResult

// ───────────────────────── Executions ─────────────────────────

export type ExecutionStatus =
  | "queued"
  | "running"
  | "sending"
  | "succeeded"
  | "failed"
  | "filtered"
  | "needs_review";

export interface Execution {
  id: Id;
  automationId: Id;
  automationName: string;
  status: ExecutionStatus;
  attempt: number;
  triggerSummary: string | null; // "Task “Ship v2” was created"
  actionSummary: string | null; // "Sent a message to #general"
  errorMessage: string | null; // human-readable; never a stack trace
  recovery: "retry" | "reconnect_then_retry" | "edit_then_retry" | null;
  connectionIdNeedingAttention: Id | null;
  startedAt: UnixMs | null;
  finishedAt: UnixMs | null;
  durationMs: number | null;
}
// GET  /api/executions?automationId=&status=&cursor=&limit= -> 200 Page<Execution>
// GET  /api/executions/:id                                  -> 200 Execution
// POST /api/executions/:id/retry                            -> 202 Execution (status "queued")

// ───────────────────────── Dashboard ─────────────────────────

export interface DashboardStats {
  activeAutomations: number;
  successfulExecutions: number; // last 30 days
  failedExecutions: number; // last 30 days
  connectedApps: number;
}
// GET /api/dashboard -> 200 DashboardStats

// ───────────────────────── Public webhook receiver ─────────────────────────
// POST /hooks/:publicId
//   200 accepted / ignored (unknown or paused automations also return 200 to avoid provider suspension)
//   400 bad signature or malformed body (NEVER 401/410: ClickUp suspends webhooks on those)
//   413 body > 256 KB
