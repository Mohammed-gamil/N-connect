# API Contract

The authoritative type definitions live in [`web/src/contracts.ts`](../web/src/contracts.ts) (routes are documented inline next to each type).
The Rust Worker mirrors them in `worker/src/api_types.rs` using `#[serde(rename_all = "camelCase")]`.

## Cross-cutting rules

- **Base:** JSON over the same origin as the SPA. `/api/*` and `/hooks/*` are handled by the Worker; everything else is the SPA.
- **Auth:** session cookie `__Host-session` (`HttpOnly; Secure; SameSite=Lax; Path=/`). When `ENVIRONMENT=development` and the origin is `http://localhost`, the cookie name is `session` and `Secure` is omitted, because `__Host-` requires HTTPS. Public routes: `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/apps`, `GET /api/oauth/:appId/callback`, `POST /hooks/:publicId`.
- **CSRF:** every non-GET `/api/*` request must send `X-Requested-With: hub`, and its `Origin` header (if present) must equal `APP_ORIGIN`. Otherwise the response is `403 forbidden`.
- **Tenant isolation:** `org_id` comes only from the session. A resource belonging to another org returns `404 not_found`, never `403`, so the API doesn't reveal that the resource exists.
- **Errors:** always the `ApiError` shape with a `requestId` (also sent as an `X-Request-Id` response header). Internal details go only to structured logs.
- **Secrets:** no response ever includes tokens, client secrets, webhook secrets, or `error_detail`. The one exception is `rotate-secret`, which returns the custom-webhook secret exactly once.
- **Limits:** request bodies on `/api/*` are capped at 64 KB, and on `/hooks/*` at 256 KB.
- **Rate limits:** login allows 5 failed attempts per 15 minutes per (email, IP) and returns `429 rate_limited` after that. Registration allows 10 per hour per IP.

## Draft rules (SaveAutomationRequest)

Drafts may be incomplete. In a draft, `trigger.event` / `action.event` may be `""`, `connectionId` may be `null`, and `configuration` may be missing keys. Even so, every field that *is* present is validated: known app ids, ownership of connections, and allowed filter ops.
`POST /activate` runs full validation:
- All required fields are present.
- Each connection exists in this org, belongs to the matching app, and has status `connected`.
- Every `{{variable}}` used in templates exists in the trigger's variable list.
- Filter paths are valid.

If validation fails, the response is `422 validation_failed` with per-field messages in `fields`, keyed as `trigger.configuration.listId`, `action.configuration.message`, and so on.

## Template syntax

Only `{{dotted.path}}` lookups are supported, with no logic, loops or helpers. Unknown variables are rejected at activation. At run time, a missing value renders as an empty string. For Slack, values are escaped (`&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`). For HTTP JSON bodies, values are JSON-string-escaped when they appear inside a JSON string.

## Catalog ids (MVP)

| App | Triggers | Actions |
|---|---|---|
| `clickup` | `task.created`, `task.updated`, `task.completed`, `task.assigned` (fields: `workspaceId` dynamic_select, `listId` dynamic_select optional dependsOn `workspaceId`) | — |
| `slack` | — | `message.send` (fields: `channel` dynamic_select, `message` template) |
| `webhook` | `webhook.received` (fields: `verification` select; variables derived from the latest sample payload as `body.*`) | — |
| `http` | — | `http.request` (fields: `method`, `url` template, `headers` key_value, `authType`, `body` template) |

ClickUp variables: `task.id`, `task.name`, `task.url`, `task.status`, `task.description`, `task.assignees`, `task.creator`, `task.list`, `task.due_date`, `task.priority`, `event.type`.

## Self-serve app credentials & token connections

- `GET /api/oauth-apps`: lists per-app (`clickup`, `slack`) OAuth readiness (`configured`, `source`: `"organization" | "server" | "none"`, non-secret `clientId`, pre-filled `redirectUrl`, `requiredScopes`, `docsHint`). Never returns `clientSecret`.
- `PUT /api/oauth-apps/:appId`: saves or updates per-organization `clientId` and AES-256-GCM encrypted `clientSecret` (`SaveOAuthAppConfigRequest`). If `clientSecret` is omitted/empty when an organization config already exists, the stored encrypted secret is preserved.
- `DELETE /api/oauth-apps/:appId`: removes the organization's custom OAuth app credentials (falling back to server secrets if configured).
- `POST /api/connections`: accepts token-based connections for `clickup` (Personal API token verified via ClickUp `/user`), `slack` (Bot User OAuth token verified via Slack `auth.test`), and `http`.

