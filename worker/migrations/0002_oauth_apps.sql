-- Per-organization OAuth app credentials (Client ID + AES-256-GCM encrypted Client Secret)
-- Allows each client organization to configure their own ClickUp / Slack OAuth app from the UI.
CREATE TABLE org_oauth_apps (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  application_id TEXT NOT NULL REFERENCES applications(id),
  client_id TEXT NOT NULL,
  ciphertext BLOB NOT NULL,               -- AES-256-GCM(client_secret||tag)
  nonce BLOB NOT NULL,                    -- 12 bytes, random per encryption
  key_version INTEGER NOT NULL,
  updated_by TEXT NOT NULL REFERENCES users(id),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, application_id)
);                                        -- AAD = org_id || ':oauth_app:' || application_id
