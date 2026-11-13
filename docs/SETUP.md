# Integration Hub — Deployment & Real-API Setup Guide

This guide walks you through deploying **Integration Hub** to Cloudflare Workers, creating your ClickUp and Slack apps, configuring secrets, and running the real end-to-end acceptance checklist.

> **Plan note:** We recommend the **Cloudflare Workers Paid** plan (\$5/mo), which provides higher CPU limits (ideal for Rust WASM + WebCrypto) and Cloudflare Queues.

---

## 1. Prerequisites

- Node.js 20+ and `pnpm` (`corepack enable`)
- Rust toolchain with `wasm32-unknown-unknown` target (`rustup target add wasm32-unknown-unknown`) and `worker-build` (`cargo install worker-build --locked`)
- Wrangler authenticated with your Cloudflare account:
  ```bash
  npx wrangler login
  ```

---

## 2. Provision Cloudflare Resources

Run these from the repository root:

### A. Create the D1 Database
```bash
npx wrangler d1 create integration-hub
```
Copy the `database_id` printed by Wrangler into `wrangler.toml` under `[[d1_databases]]`:
```toml
database_id = "<your-d1-database-id>"
```

Apply the schema migration to the remote database:
```bash
npx wrangler d1 migrations apply integration-hub --remote
```

### B. Create the Queues (Main + Dead-Letter Queue)
```bash
npx wrangler queues create hub-executions
npx wrangler queues create hub-executions-dlq
```

### C. Generate and Set the Credential Encryption Key
Generate a 32-byte random base64 key for AES-256-GCM credential encryption:
```bash
openssl rand -base64 32 | npx wrangler secret put CREDENTIALS_KEY_V1
```

---

## 3. Configure `wrangler.toml` for Production

Before deploying, update `[vars]` in `wrangler.toml` to match your deployed Worker URL (for example `https://integration-hub.<your-subdomain>.workers.dev` or your custom domain):

```toml
[vars]
APP_ORIGIN = "https://integration-hub.<your-subdomain>.workers.dev"
ENVIRONMENT = "production"
```

> Setting `ENVIRONMENT = "production"` enables the `__Host-session` `Secure` cookie flag. Make sure `APP_ORIGIN` matches the exact `https://` origin users open in their browser (required by CSRF validation).

---

## 4. Deploy First (to Know Your Exact Redirect URLs)

```bash
pnpm install
pnpm --dir web install
pnpm --dir web build
npx wrangler deploy
```

Note your live Worker URL: `https://integration-hub.<your-subdomain>.workers.dev`.

---

## 5. Client App Connections (UI Self-Serve — Recommended)

Once deployed, clients **do not need CLI access or Wrangler** to connect ClickUp or Slack. Inside the web UI (**Connections** or directly inside the **Automation Builder**), clients have two options:

1. **Instant Token Setup (No Redirect URLs or OAuth App Credentials Needed):**
   - **ClickUp:** Paste a Personal API Token (`pk_...` from ClickUp → Settings → Apps).
   - **Slack:** Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps), add Bot Token Scopes (`chat:write`, `chat:write.public`, `channels:read`, `groups:read`), click **Install to Workspace**, and paste the **Bot User OAuth Token (`xoxb-...`)**.
2. **Per-Workspace 1-Click OAuth App Setup (From the UI):**
   - On `/connections` (or inside Step 2 / Step 5 of the Builder), click **Configure 1-click OAuth app**.
   - Copy the pre-filled **Redirect URL** and **Required Scopes** shown in the dialog into Slack or ClickUp, then paste your **Client ID** and **Client Secret**.
   - Credentials are stored encrypted per organization in D1 (`AES-256-GCM`).

---

## 6. Optional: Global Server-Level OAuth Secrets

If you want every organization on your deployment to share one default Slack/ClickUp OAuth app without each client entering their own Client ID & Secret, you can still set server-level secrets with Wrangler:

- **Slack Redirect URL:** `https://integration-hub.<your-subdomain>.workers.dev/api/oauth/slack/callback` (scopes: `chat:write`, `chat:write.public`, `channels:read`, `groups:read`)
  ```bash
  npx wrangler secret put SLACK_CLIENT_ID
  npx wrangler secret put SLACK_CLIENT_SECRET
  ```
- **ClickUp Redirect URL:** `https://integration-hub.<your-subdomain>.workers.dev/api/oauth/clickup/callback`
  ```bash
  npx wrangler secret put CLICKUP_CLIENT_ID
  npx wrangler secret put CLICKUP_CLIENT_SECRET
  ```

> Note: ClickUp webhooks require a public `https://` callback URL (`localhost` cannot receive real ClickUp webhooks unless exposed via `cloudflared tunnel`).

---

## 7. Local Development (`.dev.vars`)

For local testing against `pnpm run dev` (`wrangler dev`):
1. Create `.dev.vars` at the repo root (already in `.gitignore`):
   ```ini
   CREDENTIALS_KEY_V1=<base64 32-byte key>
   CLICKUP_CLIENT_ID=...
   CLICKUP_CLIENT_SECRET=...
   SLACK_CLIENT_ID=...
   SLACK_CLIENT_SECRET=...
   ```
2. Apply local D1 migrations:
   ```bash
   pnpm run db:migrate:local
   ```
3. Build the frontend and run Wrangler locally:
   ```bash
   pnpm run dev
   ```
   If you want to receive real ClickUp webhooks locally, run `cloudflared tunnel --url http://localhost:8787` and temporarily set `APP_ORIGIN` to the tunnel `https://` URL.

---

## 8. Real-API Acceptance Checklist

Once deployed and configured with real ClickUp + Slack credentials, verify:

1. **Register** a new user at `https://<your-worker>/register`.
2. Click **Create your first automation** (or **New automation**).
3. Select **ClickUp** → connect your ClickUp account (OAuth or personal token) → select **When a task is created** → pick your Workspace (and optionally a List).
4. Select **Slack** → connect your Slack workspace via OAuth → select **Send a message** → choose `#general` (or another channel) → click the `{{task.name}}` variable chip to compose `"New task: {{task.name}} ({{task.url}})"`.
5. Review the plain-English summary and click **Activate automation**.
6. In ClickUp, create a real task in that Workspace/List.
7. Confirm the formatted message arrives in your Slack channel and **Activity** (`/activity`) shows **Succeeded** with duration.
8. Verify **Failure & Recovery**:
   - Temporarily remove/revoke the Slack app from the Slack workspace (or test against an archived channel), create another task in ClickUp, and confirm **Activity** shows a plain-language message (no stack traces) with **Reconnect** and **Try again**.
   - Reconnect Slack and click **Try again**; confirm the queued retry delivers the Slack message.
9. Test the builder on a mobile viewport and using keyboard navigation (`Tab`, `Arrow` keys to nudge nodes, `Enter`, click-to-connect).
