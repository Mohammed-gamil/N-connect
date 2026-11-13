-- Integration Hub — initial schema (D1 / SQLite)
-- Every tenant-owned table carries org_id; every query MUST be scoped by org_id from the session.
-- Timestamps are unix epoch milliseconds.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,            -- "pbkdf2-sha256$100000$<salt_b64>$<hash_b64>"
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE memberships (
  org_id TEXT NOT NULL REFERENCES organizations(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('owner','member')),
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,            -- hex sha256(raw cookie token); raw token never stored
  user_id TEXT NOT NULL REFERENCES users(id),
  org_id TEXT NOT NULL REFERENCES organizations(id),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE rate_limits (                -- fixed-window counters (login attempts, etc.)
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);

CREATE TABLE applications (               -- catalog ids; full definitions live in Rust code
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  auth_kind TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);
INSERT INTO applications (id, name, auth_kind) VALUES
  ('clickup', 'ClickUp', 'oauth2'),
  ('slack',   'Slack',   'oauth2'),
  ('webhook', 'Custom Webhook', 'none'),
  ('http',    'HTTP Request',   'api_token');

CREATE TABLE credentials (                -- "CredentialReferences": encrypted blobs only
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  kind TEXT NOT NULL CHECK (kind IN ('oauth_token','api_token','webhook_secret','http_auth')),
  ciphertext BLOB NOT NULL,               -- AES-256-GCM(ciphertext||tag)
  nonce BLOB NOT NULL,                    -- 12 bytes, random per encryption
  key_version INTEGER NOT NULL,           -- which CREDENTIALS_KEY_V<n> encrypted it
  created_at INTEGER NOT NULL,
  rotated_at INTEGER
);                                        -- AAD = org_id || ':' || id || ':' || kind
CREATE INDEX idx_credentials_org ON credentials(org_id);

CREATE TABLE connections (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  application_id TEXT NOT NULL REFERENCES applications(id),
  display_name TEXT NOT NULL,
  external_account_id TEXT,               -- Slack team_id / ClickUp user id
  credential_id TEXT NOT NULL REFERENCES credentials(id),
  status TEXT NOT NULL CHECK (status IN ('connected','needs_attention','revoked')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_connections_org ON connections(org_id);

CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY,            -- hex sha256(state); single use, 10 min TTL
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  return_to TEXT,                         -- must be a same-origin relative path
  expires_at INTEGER NOT NULL
);

CREATE TABLE automations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','active','paused','error')),
  definition_version INTEGER NOT NULL,
  definition_json TEXT NOT NULL,          -- validated WorkflowDefinition
  layout_json TEXT,                       -- visual-only
  last_execution_at INTEGER,
  last_execution_status TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_automations_org ON automations(org_id, status);

CREATE TABLE automation_steps (           -- "Triggers" / "Actions", denormalized for querying + FK integrity
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('trigger','action')),
  application_id TEXT NOT NULL REFERENCES applications(id),
  event TEXT NOT NULL,
  connection_id TEXT REFERENCES connections(id),
  PRIMARY KEY (automation_id, kind)
);
CREATE INDEX idx_steps_connection ON automation_steps(connection_id);

CREATE TABLE webhook_subscriptions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  public_id TEXT NOT NULL UNIQUE,         -- 128-bit random, base64url; used in /hooks/:publicId
  provider TEXT NOT NULL CHECK (provider IN ('clickup','custom')),
  external_webhook_id TEXT,               -- e.g. ClickUp webhook id
  secret_credential_id TEXT REFERENCES credentials(id),
  verification TEXT NOT NULL CHECK (verification IN ('clickup_hmac','hmac_sha256','shared_token','none')),
  status TEXT NOT NULL CHECK (status IN ('active','paused','failing','deleted')),
  last_received_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_webhooks_automation ON webhook_subscriptions(automation_id);

CREATE TABLE events (                     -- inbound events, deduplicated
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
  dedup_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,             -- truncated to 64 KB
  received_at INTEGER NOT NULL,
  UNIQUE (subscription_id, dedup_key)
);
CREATE INDEX idx_events_sub_time ON events(subscription_id, received_at DESC);

CREATE TABLE execution_logs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','sending','succeeded','failed','filtered','needs_review')),
  attempt INTEGER NOT NULL DEFAULT 0,
  trigger_summary TEXT,
  action_summary TEXT,
  error_class TEXT,                       -- retryable | needs_reconnect | user_fixable | unknown_outcome | permanent
  error_user_message TEXT,                -- safe to show
  error_detail TEXT,                      -- internal only; NEVER returned by the API
  recovery TEXT,                          -- retry | reconnect_then_retry | edit_then_retry
  connection_id_needing_attention TEXT,
  external_ref TEXT,                      -- e.g. Slack message ts
  next_retry_at INTEGER,
  started_at INTEGER,
  finished_at INTEGER,
  duration_ms INTEGER,
  UNIQUE (automation_id, event_id)        -- execution idempotency
);
CREATE INDEX idx_exec_org_time ON execution_logs(org_id, started_at DESC);
CREATE INDEX idx_exec_status ON execution_logs(status, next_retry_at);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT,
  action TEXT NOT NULL,                   -- e.g. connection.created, automation.activated
  target_type TEXT,
  target_id TEXT,
  metadata_json TEXT,                     -- never contains secrets
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_audit_org_time ON audit_logs(org_id, created_at DESC);
