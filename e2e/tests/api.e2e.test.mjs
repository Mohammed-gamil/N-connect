import assert from "node:assert/strict";
import crypto from "node:crypto";
import { describe, it } from "node:test";

const BASE_URL = process.env.E2E_BASE_URL;
const UPSTREAM_URL = process.env.E2E_UPSTREAM_URL;

if (!BASE_URL || !UPSTREAM_URL) {
  throw new Error("E2E_BASE_URL and E2E_UPSTREAM_URL environment variables must be set.");
}

function hmacHex(secret, rawBody) {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

async function pollUntil(fn, { timeoutMs = 15000, intervalMs = 200, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const val = await fn();
      if (val) return val;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `Timed out waiting for ${label} after ${timeoutMs}ms${lastErr ? `: ${lastErr}` : ""}`,
  );
}

class Client {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.cookies = new Map();
  }

  captureCookies(resp) {
    const setCookies =
      typeof resp.headers.getSetCookie === "function"
        ? resp.headers.getSetCookie()
        : resp.headers.get("set-cookie")
          ? [resp.headers.get("set-cookie")]
          : [];
    for (const raw of setCookies) {
      if (!raw) continue;
      const firstPart = raw.split(";")[0];
      const eqIdx = firstPart.indexOf("=");
      if (eqIdx > 0) {
        const name = firstPart.slice(0, eqIdx).trim();
        const val = firstPart.slice(eqIdx + 1).trim();
        if (val === "") {
          this.cookies.delete(name);
        } else {
          this.cookies.set(name, val);
        }
      }
    }
  }

  cookieHeader() {
    if (this.cookies.size === 0) return undefined;
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }

  async request(path, { method = "GET", body, headers = {}, csrf = true, redirect = "manual" } = {}) {
    const hdrs = new Headers(headers);
    const ck = this.cookieHeader();
    if (ck && !hdrs.has("Cookie")) {
      hdrs.set("Cookie", ck);
    }
    if (method !== "GET" && method !== "HEAD" && csrf && !hdrs.has("X-Requested-With")) {
      hdrs.set("X-Requested-With", "hub");
    }
    let rawBody;
    if (body !== undefined) {
      if (typeof body === "string" || Buffer.isBuffer(body)) {
        rawBody = body;
      } else {
        rawBody = JSON.stringify(body);
        if (!hdrs.has("Content-Type")) {
          hdrs.set("Content-Type", "application/json");
        }
      }
    }
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: hdrs,
      body: rawBody,
      redirect,
    });
    this.captureCookies(resp);
    const text = await resp.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: resp.status, headers: resp.headers, text, json };
  }
}

async function upstreamAdmin(path, { method = "GET", body } = {}) {
  const resp = await fetch(`${UPSTREAM_URL}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await resp.json();
  assert.equal(resp.status, 200, `Upstream admin ${method} ${path} failed: ${JSON.stringify(json)}`);
  return json;
}

async function completeSlackOAuth(client, returnTo = "/connections") {
  const start = await client.request("/api/connections/slack/oauth/start", {
    method: "POST",
    body: { returnTo },
  });
  assert.equal(start.status, 200, `oauth/start failed: ${start.text}`);
  assert.ok(start.json?.redirectUrl, "expected redirectUrl");

  // Step 1: Fake Slack /oauth/v2/authorize -> 302 to /api/oauth/slack/callback?code=...&state=...
  const authResp = await fetch(start.json.redirectUrl, { redirect: "manual" });
  assert.equal(authResp.status, 302, "expected 302 from fake Slack authorize");
  const callbackUrl = authResp.headers.get("location");
  assert.ok(callbackUrl, "expected Location header from fake Slack authorize");

  // Step 2: Worker /api/oauth/slack/callback -> 302 to APP_ORIGIN + returnTo?connected=con_...
  const cbUrlObj = new URL(callbackUrl);
  const cbResp = await client.request(`${cbUrlObj.pathname}${cbUrlObj.search}`, {
    method: "GET",
    csrf: false,
    redirect: "manual",
  });
  assert.equal(cbResp.status, 302, `expected 302 from oauth callback, got ${cbResp.status}: ${cbResp.text}`);
  const finalLoc = cbResp.headers.get("location");
  assert.ok(finalLoc, "expected final redirect Location");
  const finalUrl = new URL(finalLoc);
  const connectedId = finalUrl.searchParams.get("connected");
  assert.ok(connectedId, `expected ?connected=<id>, got ${finalLoc}`);
  assert.equal(finalUrl.pathname, returnTo);
  return connectedId;
}

describe("Integration Hub — Full Worker + D1 + Queue + Assets E2E", () => {
  const clientA = new Client(BASE_URL);
  const clientB = new Client(BASE_URL);

  let clickupConnId;
  let slackConnId;
  let cuSlackAutId;
  let cuWebhookEndpoint;
  let firstExecId;
  let customWebhookAutId;

  it("1. Auth & CSRF protection (register, missing header -> 403, wrong Origin -> 403, /api/me, login roundtrip & rate-limit)", async () => {
    // 1a. Register User A
    const reg = await clientA.request("/api/auth/register", {
      method: "POST",
      body: {
        name: "Alice OrgA",
        email: "alice-e2e@example.com",
        password: "super-secure-password-123",
      },
    });
    assert.equal(reg.status, 201, `register failed: ${reg.text}`);
    assert.equal(reg.json.user.email, "alice-e2e@example.com");
    assert.ok(reg.json.organization.id.startsWith("org_"));

    // 1b. GET /api/me works with session cookie
    const me = await clientA.request("/api/me");
    assert.equal(me.status, 200);
    assert.equal(me.json.user.name, "Alice OrgA");

    // 1c. POST without X-Requested-With: hub -> 403
    const noCsrf = await clientA.request("/api/automations", {
      method: "POST",
      csrf: false,
      body: { name: "Blocked" },
    });
    assert.equal(noCsrf.status, 403);
    assert.equal(noCsrf.json?.error?.code, "forbidden");

    // 1d. POST with wrong Origin -> 403
    const badOrigin = await clientA.request("/api/automations", {
      method: "POST",
      headers: { Origin: "https://evil.example.com" },
      body: { name: "Blocked" },
    });
    assert.equal(badOrigin.status, 403);
    assert.equal(badOrigin.json?.error?.code, "forbidden");

    // 1e. Login roundtrip + bad password rate-limit on separate test email
    const badLogin = await clientA.request("/api/auth/login", {
      method: "POST",
      body: { email: "alice-e2e@example.com", password: "wrong-password" },
    });
    assert.equal(badLogin.status, 401);

    const goodLogin = await clientA.request("/api/auth/login", {
      method: "POST",
      body: { email: "alice-e2e@example.com", password: "super-secure-password-123" },
    });
    assert.equal(goodLogin.status, 200);
    assert.equal(goodLogin.json.user.email, "alice-e2e@example.com");

    for (let i = 0; i < 5; i++) {
      const r = await clientA.request("/api/auth/login", {
        method: "POST",
        body: { email: "ratelimit-check@example.com", password: "wrong-password" },
      });
      assert.equal(r.status, 401);
    }
    const limited = await clientA.request("/api/auth/login", {
      method: "POST",
      body: { email: "ratelimit-check@example.com", password: "wrong-password" },
    });
    assert.equal(limited.status, 429);
    assert.equal(limited.json?.error?.code, "rate_limited");

    // 1f. Rotating spoofable X-Forwarded-For headers must NOT bypass rate limiting
    for (let i = 0; i < 5; i++) {
      const r = await clientA.request("/api/auth/login", {
        method: "POST",
        headers: { "X-Forwarded-For": `198.51.100.${i + 1}` },
        body: { email: "xff-spoof-check@example.com", password: "wrong-password" },
      });
      assert.equal(r.status, 401);
    }
    const xffLimited = await clientA.request("/api/auth/login", {
      method: "POST",
      headers: { "X-Forwarded-For": "203.0.113.99" },
      body: { email: "xff-spoof-check@example.com", password: "wrong-password" },
    });
    assert.equal(xffLimited.status, 429);
    assert.equal(xffLimited.json?.error?.code, "rate_limited");
  });

  it("2. Connect ClickUp (personal token) & Slack (OAuth flow), verify no secrets leak in /api/connections", async () => {
    // Invalid ClickUp token rejected cleanly
    const badCu = await clientA.request("/api/connections", {
      method: "POST",
      body: {
        applicationId: "clickup",
        token: "bad_token",
        displayName: "Bad ClickUp",
      },
    });
    assert.equal(badCu.status, 422, `expected 422 for bad token, got ${badCu.status}: ${badCu.text}`);
    assert.ok(badCu.json?.error?.fields?.token);

    // Valid ClickUp personal token
    const goodCu = await clientA.request("/api/connections", {
      method: "POST",
      body: {
        applicationId: "clickup",
        token: "pk_e2e_valid_token",
        displayName: "Acme ClickUp",
      },
    });
    assert.equal(goodCu.status, 201, `expected 201, got ${goodCu.status}: ${goodCu.text}`);
    clickupConnId = goodCu.json.id;
    assert.equal(goodCu.json.applicationId, "clickup");
    assert.equal(goodCu.json.status, "connected");

    // Slack full OAuth flow via fake upstream
    slackConnId = await completeSlackOAuth(clientA, "/connections");
    assert.ok(slackConnId.startsWith("con_"));

    // Verify GET /api/connections never leaks tokens or secrets
    const listRes = await clientA.request("/api/connections");
    assert.equal(listRes.status, 200);
    assert.equal(listRes.json.connections.length, 2);
    assert.ok(!listRes.text.includes("pk_e2e_valid_token"));
    assert.ok(!listRes.text.includes("xoxb-"));
    assert.ok(!listRes.text.includes("ciphertext"));
    assert.ok(!listRes.text.includes("credential"));

    // Verify dynamic options endpoints work against fake upstreams
    const wsOpts = await clientA.request(`/api/connections/${clickupConnId}/options/workspaceId`);
    assert.equal(wsOpts.status, 200);
    assert.deepEqual(wsOpts.json.options, [{ value: "9012345", label: "Acme Workspace" }]);

    const listOpts = await clientA.request(
      `/api/connections/${clickupConnId}/options/listId?parent=9012345`,
    );
    assert.equal(listOpts.status, 200);
    assert.deepEqual(listOpts.json.options, [{ value: "list_1", label: "Product / Roadmap" }]);

    const chOpts = await clientA.request(`/api/connections/${slackConnId}/options/channel`);
    assert.equal(chOpts.status, 200);
    assert.deepEqual(chOpts.json.options, [
      { value: "C01GENERAL", label: "#general" },
      { value: "C02ENG", label: "#eng" },
    ]);
  });

  it("3. Create draft, validate activation rules, and activate ClickUp -> Slack automation", async () => {
    // Incomplete draft saves cleanly as draft
    const draftRes = await clientA.request("/api/automations", {
      method: "POST",
      body: {
        name: "ClickUp to Slack",
        definition: {
          version: 1,
          trigger: {
            application: "clickup",
            event: "",
            connectionId: clickupConnId,
            configuration: {},
          },
          filters: [],
          action: {
            application: "slack",
            event: "message.send",
            connectionId: slackConnId,
            configuration: {},
          },
        },
      },
    });
    assert.equal(draftRes.status, 201, `draft create failed: ${draftRes.text}`);
    assert.equal(draftRes.json.status, "draft");
    cuSlackAutId = draftRes.json.id;

    // Activating incomplete draft returns 422 with per-field validation errors
    const invalidAct = await clientA.request(`/api/automations/${cuSlackAutId}/activate`, {
      method: "POST",
    });
    assert.equal(invalidAct.status, 422);
    assert.ok(invalidAct.json?.error?.fields?.["trigger.event"]);
    assert.ok(invalidAct.json?.error?.fields?.["action.configuration.channel"]);
    assert.ok(invalidAct.json?.error?.fields?.["action.configuration.message"]);

    // With trigger.event selected but no workspaceId configured, workspaceId is required
    const partialPut = await clientA.request(`/api/automations/${cuSlackAutId}`, {
      method: "PUT",
      body: {
        name: "ClickUp to Slack",
        definition: {
          version: 1,
          trigger: {
            application: "clickup",
            event: "task.created",
            connectionId: clickupConnId,
            configuration: {},
          },
          filters: [],
          action: {
            application: "slack",
            event: "message.send",
            connectionId: slackConnId,
            configuration: {},
          },
        },
      },
    });
    assert.equal(partialPut.status, 200);
    const partialAct = await clientA.request(`/api/automations/${cuSlackAutId}/activate`, {
      method: "POST",
    });
    assert.equal(partialAct.status, 422);
    assert.ok(partialAct.json?.error?.fields?.["trigger.configuration.workspaceId"]);

    // Complete configuration via PUT
    const updateRes = await clientA.request(`/api/automations/${cuSlackAutId}`, {
      method: "PUT",
      body: {
        name: "ClickUp to Slack",
        definition: {
          version: 1,
          trigger: {
            application: "clickup",
            event: "task.created",
            connectionId: clickupConnId,
            configuration: {
              workspaceId: { value: "9012345", label: "Acme Workspace" },
              listId: { value: "list_1", label: "Roadmap" },
            },
          },
          filters: [],
          action: {
            application: "slack",
            event: "message.send",
            connectionId: slackConnId,
            configuration: {
              channel: { value: "C01GENERAL", label: "#general" },
              message: "New task: {{task.name}} ({{task.url}})",
            },
          },
        },
        layout: {
          nodes: {
            trigger: { x: 120, y: 200 },
            action: { x: 500, y: 200 },
          },
        },
      },
    });
    assert.equal(updateRes.status, 200, `update failed: ${updateRes.text}`);

    // Activate automation -> creates ClickUp webhook subscription in fake upstream
    const actRes = await clientA.request(`/api/automations/${cuSlackAutId}/activate`, {
      method: "POST",
    });
    assert.equal(actRes.status, 200, `activate failed: ${actRes.text}`);
    assert.equal(actRes.json.status, "active");

    const upState = await upstreamAdmin("/__admin/state");
    assert.equal(upState.clickup.webhooks.length, 1);
    assert.equal(upState.clickup.webhooks[0].teamId, "9012345");
    assert.deepEqual(upState.clickup.webhooks[0].events, ["taskCreated"]);
    cuWebhookEndpoint = upState.clickup.webhooks[0].endpoint;
    assert.ok(cuWebhookEndpoint.startsWith(`${BASE_URL}/hooks/`));
  });

  it("4. ClickUp Task Created -> Queue enriches task & delivers exactly 1 Slack message", async () => {
    await upstreamAdmin("/__admin/clickup/task", {
      method: "POST",
      body: {
        id: "task_e2e_1",
        name: "Ship E2E Verification",
        url: "https://app.clickup.com/t/task_e2e_1",
        status: { status: "to do", type: "open" },
        text_content: "Verify everything end-to-end",
        assignees: [{ username: "Alex Rivera" }],
        creator: { username: "Sam Lee" },
        list: { id: "list_1", name: "Roadmap" },
        due_date: "1795132800000",
        priority: { priority: "high" },
      },
    });

    const payload = JSON.stringify({
      webhook_id: "wh_cu_1",
      event: "taskCreated",
      task_id: "task_e2e_1",
      history_items: [{ id: "hist_e2e_1" }],
    });
    const sig = hmacHex("cu_wh_secret_123", payload);

    const hookResp = await fetch(cuWebhookEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Signature": sig,
      },
      body: payload,
    });
    assert.equal(hookResp.status, 200);
    const hookJson = await hookResp.json();
    assert.equal(hookJson.accepted, true);

    const exec = await pollUntil(async () => {
      const res = await clientA.request(`/api/executions?automationId=${cuSlackAutId}`);
      assert.equal(res.status, 200);
      const item = res.json.items.find((e) => e.status === "succeeded");
      return item || null;
    }, { label: "first ClickUp->Slack execution to succeed" });

    firstExecId = exec.id;
    assert.equal(exec.triggerSummary, 'Task "Ship E2E Verification" was created');
    assert.equal(exec.actionSummary, "Sent a message to #general");
    assert.equal(exec.errorMessage, null);
    assert.equal("errorDetail" in exec, false);

    const upState = await upstreamAdmin("/__admin/state");
    assert.equal(upState.slack.messages.length, 1);
    assert.equal(upState.slack.messages[0].channel, "C01GENERAL");
    assert.equal(
      upState.slack.messages[0].text,
      "New task: Ship E2E Verification (https://app.clickup.com/t/task_e2e_1)",
    );
  });

  it("5. Idempotency: replaying the exact same signed webhook 3 times delivers only 1 Slack message total", async () => {
    const payload = JSON.stringify({
      webhook_id: "wh_cu_1",
      event: "taskCreated",
      task_id: "task_e2e_1",
      history_items: [{ id: "hist_e2e_1" }],
    });
    const sig = hmacHex("cu_wh_secret_123", payload);

    for (let i = 0; i < 3; i++) {
      const r = await fetch(cuWebhookEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Signature": sig,
        },
        body: payload,
      });
      assert.equal(r.status, 200);
      const j = await r.json();
      assert.equal(j.accepted, true);
    }

    await new Promise((r) => setTimeout(r, 1500));

    const upState = await upstreamAdmin("/__admin/state");
    assert.equal(upState.slack.messages.length, 1);

    const execRes = await clientA.request(`/api/executions?automationId=${cuSlackAutId}`);
    assert.equal(execRes.status, 200);
    assert.equal(execRes.json.items.length, 1);
  });

  it("6. Bad webhook signature returns 400 (never 401/410) and creates zero executions", async () => {
    const payload = JSON.stringify({
      webhook_id: "wh_cu_1",
      event: "taskCreated",
      task_id: "task_bad_sig",
      history_items: [{ id: "hist_bad_sig" }],
    });

    const badSigResp = await fetch(cuWebhookEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Signature": "deadbeef0000",
      },
      body: payload,
    });
    assert.equal(badSigResp.status, 400);

    const missingSigResp = await fetch(cuWebhookEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });
    assert.equal(missingSigResp.status, 400);

    const execRes = await clientA.request(`/api/executions?automationId=${cuSlackAutId}`);
    assert.equal(execRes.json.items.length, 1);
  });

  it("7. Transient failure (Slack 429 Retry-After: 1) -> automatic Queue retry -> succeeds", async () => {
    await upstreamAdmin("/__admin/slack/fault", {
      method: "POST",
      body: { rateLimitRemaining: 1 },
    });
    await upstreamAdmin("/__admin/clickup/task", {
      method: "POST",
      body: {
        id: "task_e2e_2",
        name: "Retry Test Task",
        url: "https://app.clickup.com/t/task_e2e_2",
        status: { status: "to do", type: "open" },
        list: { id: "list_1", name: "Roadmap" },
      },
    });

    const payload = JSON.stringify({
      webhook_id: "wh_cu_1",
      event: "taskCreated",
      task_id: "task_e2e_2",
      history_items: [{ id: "hist_e2e_2" }],
    });
    const sig = hmacHex("cu_wh_secret_123", payload);

    const hookResp = await fetch(cuWebhookEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Signature": sig,
      },
      body: payload,
    });
    assert.equal(hookResp.status, 200);

    const exec = await pollUntil(
      async () => {
        const res = await clientA.request(`/api/executions?automationId=${cuSlackAutId}`);
        return res.json.items.find(
          (e) => e.triggerSummary === 'Task "Retry Test Task" was created' && e.status === "succeeded",
        );
      },
      { timeoutMs: 45000, intervalMs: 500, label: "429 retry execution to succeed" },
    );

    assert.ok(exec.attempt >= 2, `expected attempt >= 2 after 429 retry, got ${exec.attempt}`);
    const upState = await upstreamAdmin("/__admin/state");
    assert.equal(upState.slack.messages.length, 2);
    assert.ok(upState.slack.messages[1].text.includes("Retry Test Task"));
  });

  it("8. Revoked Slack token -> needs_attention + plain-language error -> reconnect OAuth -> manual retry succeeds", async () => {
    await upstreamAdmin("/__admin/slack/fault", {
      method: "POST",
      body: { mode: "token_revoked" },
    });
    await upstreamAdmin("/__admin/clickup/task", {
      method: "POST",
      body: {
        id: "task_e2e_3",
        name: "Revoked Token Task",
        url: "https://app.clickup.com/t/task_e2e_3",
        status: { status: "to do", type: "open" },
        list: { id: "list_1", name: "Roadmap" },
      },
    });

    const payload = JSON.stringify({
      webhook_id: "wh_cu_1",
      event: "taskCreated",
      task_id: "task_e2e_3",
      history_items: [{ id: "hist_e2e_3" }],
    });
    const sig = hmacHex("cu_wh_secret_123", payload);

    const hookResp = await fetch(cuWebhookEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Signature": sig,
      },
      body: payload,
    });
    assert.equal(hookResp.status, 200);

    const failedExec = await pollUntil(
      async () => {
        const res = await clientA.request(`/api/executions?automationId=${cuSlackAutId}`);
        return res.json.items.find(
          (e) => e.triggerSummary === 'Task "Revoked Token Task" was created' && e.status === "failed",
        );
      },
      { label: "revoked token execution to fail" },
    );

    assert.equal(
      failedExec.errorMessage,
      "Slack couldn't receive your message because the connection expired. Reconnect your Slack account.",
    );
    assert.equal(failedExec.recovery, "reconnect_then_retry");
    assert.equal(failedExec.connectionIdNeedingAttention, slackConnId);
    assert.ok(!failedExec.errorMessage.includes("stack") && !failedExec.errorMessage.includes("token_revoked"));

    // Slack connection should now be marked needs_attention
    const connsBefore = await clientA.request("/api/connections");
    const slackConnBefore = connsBefore.json.connections.find((c) => c.id === slackConnId);
    assert.equal(slackConnBefore.status, "needs_attention");

    // Reconnect Slack via OAuth flow
    const reconnectedId = await completeSlackOAuth(clientA, "/connections");
    assert.equal(reconnectedId, slackConnId);

    const connsAfter = await clientA.request("/api/connections");
    const slackConnAfter = connsAfter.json.connections.find((c) => c.id === slackConnId);
    assert.equal(slackConnAfter.status, "connected");

    // Manual retry
    const retryRes = await clientA.request(`/api/executions/${failedExec.id}/retry`, {
      method: "POST",
    });
    assert.equal(retryRes.status, 202, `retry failed: ${retryRes.text}`);
    assert.equal(retryRes.json.status, "queued");

    const retriedExec = await pollUntil(
      async () => {
        const res = await clientA.request(`/api/executions/${failedExec.id}`);
        return res.json.status === "succeeded" ? res.json : null;
      },
      { label: "manually retried execution to succeed" },
    );

    assert.equal(retriedExec.actionSummary, "Sent a message to #general");
    const upState = await upstreamAdmin("/__admin/state");
    assert.equal(upState.slack.messages.length, 3);
    assert.ok(upState.slack.messages[2].text.includes("Revoked Token Task"));
  });

  it("9. Custom Webhook + HTTP Request: rotate secret, HMAC-signed payload, SSRF guard blocks private/metadata IPs", async () => {
    const createRes = await clientA.request("/api/automations", {
      method: "POST",
      body: {
        name: "Custom Webhook SSRF Check",
        definition: {
          version: 1,
          trigger: {
            application: "webhook",
            event: "webhook.received",
            connectionId: null,
            configuration: { verification: "hmac_sha256" },
          },
          filters: [],
          action: {
            application: "http",
            event: "http.request",
            connectionId: null,
            configuration: {
              method: "POST",
              url: "http://169.254.169.254/latest/meta-data",
              headers: [{ key: "Content-Type", value: "application/json" }],
              authType: "none",
              body: '{"event":"{{body.event}}"}',
            },
          },
        },
      },
    });
    assert.equal(createRes.status, 201, `custom webhook create failed: ${createRes.text}`);
    customWebhookAutId = createRes.json.id;

    const actRes = await clientA.request(`/api/automations/${customWebhookAutId}/activate`, {
      method: "POST",
    });
    assert.equal(actRes.status, 200, `custom webhook activate failed: ${actRes.text}`);

    // Rotate secret -> shown once
    const rotRes = await clientA.request(`/api/automations/${customWebhookAutId}/webhook/rotate-secret`, {
      method: "POST",
    });
    assert.equal(rotRes.status, 200);
    assert.ok(rotRes.json.secret && rotRes.json.secret.startsWith("whsec_"));
    const webhookUrl = rotRes.json.url;
    const webhookSecret = rotRes.json.secret;

    // GET /webhook must NOT expose secret again
    const infoRes = await clientA.request(`/api/automations/${customWebhookAutId}/webhook`);
    assert.equal(infoRes.status, 200);
    assert.equal(infoRes.json.secret, undefined);
    assert.equal(infoRes.json.url, webhookUrl);

    // Send HMAC-signed custom webhook payload
    const cwBody = JSON.stringify({
      id: "cw_evt_1",
      event: "order.paid",
      data: { amount: 42 },
    });
    const cwSig = `sha256=${hmacHex(webhookSecret, cwBody)}`;
    const cwHookResp = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": cwSig,
      },
      body: cwBody,
    });
    assert.equal(cwHookResp.status, 200);

    // Execution must be blocked by SSRF guard cleanly
    const ssrfExec = await pollUntil(
      async () => {
        const res = await clientA.request(`/api/executions?automationId=${customWebhookAutId}`);
        return res.json.items.find((e) => e.status === "failed");
      },
      { label: "custom webhook HTTP SSRF execution to fail safely" },
    );
    assert.equal(ssrfExec.recovery, "edit_then_retry");
    assert.ok(
      ssrfExec.errorMessage.toLowerCase().includes("private network"),
      `unexpected SSRF errorMessage: ${ssrfExec.errorMessage}`,
    );

    // Webhook samples endpoint includes the payload
    const samplesRes = await clientA.request(`/api/automations/${customWebhookAutId}/webhook/samples`);
    assert.equal(samplesRes.status, 200);
    assert.equal(samplesRes.json.samples.length, 1);
    assert.equal(samplesRes.json.samples[0].payload.event, "order.paid");

    // POST /api/http/test SSRF checks
    for (const blockedUrl of [
      "http://127.0.0.1:80",
      "http://169.254.169.254/latest/meta-data",
      "http://localhost/admin",
    ]) {
      const testRes = await clientA.request("/api/http/test", {
        method: "POST",
        body: {
          method: "GET",
          url: blockedUrl,
          headers: [],
          auth: { type: "none" },
          body: null,
          sampleVariables: {},
        },
      });
      assert.equal(testRes.status, 200);
      assert.equal(testRes.json.ok, false);
      assert.equal(testRes.json.status, null);
      assert.ok(
        testRes.json.message.toLowerCase().includes("private"),
        `expected private network/host block message for ${blockedUrl}, got: ${testRes.json.message}`,
      );
    }
  });

  it("10. Strict tenant isolation: Org B gets 404 for all Org A resources and empty list responses", async () => {
    const regB = await clientB.request("/api/auth/register", {
      method: "POST",
      body: {
        name: "Bob OrgB",
        email: "bob-e2e@example.com",
        password: "super-secure-password-456",
      },
    });
    assert.equal(regB.status, 201, `register B failed: ${regB.text}`);

    const listAut = await clientB.request("/api/automations");
    assert.equal(listAut.status, 200);
    assert.deepEqual(listAut.json.automations, []);

    const listConn = await clientB.request("/api/connections");
    assert.equal(listConn.status, 200);
    assert.deepEqual(listConn.json.connections, []);

    const listExec = await clientB.request("/api/executions");
    assert.equal(listExec.status, 200);
    assert.deepEqual(listExec.json.items, []);

    const probes = [
      ["GET", `/api/automations/${cuSlackAutId}`],
      [
        "PUT",
        `/api/automations/${cuSlackAutId}`,
        {
          name: "Hijack",
          definition: {
            version: 1,
            trigger: { application: "webhook", event: "", connectionId: null, configuration: {} },
            filters: [],
            action: { application: "http", event: "", connectionId: null, configuration: {} },
          },
        },
      ],
      ["DELETE", `/api/automations/${cuSlackAutId}`],
      ["POST", `/api/automations/${cuSlackAutId}/activate`],
      ["POST", `/api/automations/${cuSlackAutId}/pause`],
      ["POST", `/api/automations/${cuSlackAutId}/test`],
      ["GET", `/api/automations/${customWebhookAutId}/webhook`],
      ["POST", `/api/automations/${customWebhookAutId}/webhook/rotate-secret`],
      ["GET", `/api/automations/${customWebhookAutId}/webhook/samples`],
      ["POST", `/api/connections/${clickupConnId}/test`],
      ["GET", `/api/connections/${clickupConnId}/options/workspaceId`],
      ["DELETE", `/api/connections/${clickupConnId}`],
      ["GET", `/api/executions/${firstExecId}`],
      ["POST", `/api/executions/${firstExecId}/retry`],
    ];

    for (const [method, path, body] of probes) {
      const res = await clientB.request(path, { method, body });
      assert.equal(
        res.status,
        404,
        `expected 404 for Org B ${method} ${path}, got ${res.status}: ${res.text}`,
      );
    }

    // Create an HTTP credential in Org A and verify Org B cannot reference any Org A connectionId
    const orgAHttpConn = await clientA.request("/api/connections", {
      method: "POST",
      body: {
        applicationId: "http",
        token: "orgA-secret-bearer-token",
        displayName: "Org A HTTP Bearer",
      },
    });
    assert.equal(orgAHttpConn.status, 201, `Org A HTTP conn failed: ${orgAHttpConn.text}`);
    const orgAHttpConnId = orgAHttpConn.json.id;

    const crossTenantCreateTrigger = await clientB.request("/api/automations", {
      method: "POST",
      body: {
        name: "Cross-tenant trigger bind",
        definition: {
          version: 1,
          trigger: {
            application: "clickup",
            event: "task.created",
            connectionId: clickupConnId,
            configuration: {},
          },
          filters: [],
          action: {
            application: "http",
            event: "http.request",
            connectionId: null,
            configuration: {},
          },
        },
      },
    });
    assert.equal(crossTenantCreateTrigger.status, 422);
    assert.ok(crossTenantCreateTrigger.json?.error?.fields?.["trigger.connectionId"]);

    const crossTenantCreateAction = await clientB.request("/api/automations", {
      method: "POST",
      body: {
        name: "Cross-tenant action bind",
        definition: {
          version: 1,
          trigger: {
            application: "webhook",
            event: "webhook.received",
            connectionId: null,
            configuration: { verification: "none" },
          },
          filters: [],
          action: {
            application: "slack",
            event: "message.send",
            connectionId: slackConnId,
            configuration: {},
          },
        },
      },
    });
    assert.equal(crossTenantCreateAction.status, 422);
    assert.ok(crossTenantCreateAction.json?.error?.fields?.["action.connectionId"]);

    const orgBDraft = await clientB.request("/api/automations", {
      method: "POST",
      body: {
        name: "Org B Clean Draft",
        definition: {
          version: 1,
          trigger: {
            application: "webhook",
            event: "webhook.received",
            connectionId: null,
            configuration: { verification: "none" },
          },
          filters: [],
          action: {
            application: "http",
            event: "http.request",
            connectionId: null,
            configuration: { method: "POST", url: "https://example.com/hook", authType: "none" },
          },
        },
      },
    });
    assert.equal(orgBDraft.status, 201);

    const crossTenantUpdate = await clientB.request(`/api/automations/${orgBDraft.json.id}`, {
      method: "PUT",
      body: {
        name: "Org B Hijack HTTP Cred",
        definition: {
          version: 1,
          trigger: {
            application: "webhook",
            event: "webhook.received",
            connectionId: null,
            configuration: { verification: "none" },
          },
          filters: [],
          action: {
            application: "http",
            event: "http.request",
            connectionId: orgAHttpConnId,
            configuration: { method: "POST", url: "https://example.com/hook", authType: "bearer" },
          },
        },
      },
    });
    assert.equal(crossTenantUpdate.status, 422);
    assert.ok(crossTenantUpdate.json?.error?.fields?.["action.connectionId"]);

    const crossTenantHttpTest = await clientB.request("/api/http/test", {
      method: "POST",
      body: {
        method: "GET",
        url: "https://example.com/hook",
        headers: [],
        auth: { type: "bearer", credentialConnectionId: orgAHttpConnId },
        body: null,
        sampleVariables: {},
      },
    });
    assert.equal(crossTenantHttpTest.status, 404);
    assert.equal(crossTenantHttpTest.json?.error?.code, "not_found");
  });

  it("11. Security hardening: OAuth returnTo rejects open redirects and webhook enforces 256 KB cap on chunked bodies", async () => {
    const badReturnTos = [
      "https://evil.com",
      "//evil.com",
      "/\\evil.com",
      "/\t/evil.com",
      "/..//evil.com",
      "/a/../..//evil.com",
    ];
    for (const returnTo of badReturnTos) {
      const res = await clientA.request("/api/connections/slack/oauth/start", {
        method: "POST",
        body: { returnTo },
      });
      assert.equal(
        res.status,
        422,
        `expected 422 for open-redirect returnTo=${JSON.stringify(returnTo)}, got ${res.status}: ${res.text}`,
      );
      assert.ok(res.json?.error?.fields?.returnTo);
    }

    // Stream > 256 KB in chunks without Content-Length to verify streaming body limit
    const chunk = new Uint8Array(64 * 1024).fill(0x61); // 'a'
    let chunksSent = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (chunksSent < 5) {
          chunksSent += 1; // 5 * 64 KB = 320 KB > 256 KB
          controller.enqueue(chunk);
        } else {
          controller.close();
        }
      },
    });
    const oversizedResp = await fetch(cuWebhookEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: stream,
      duplex: "half",
    });
    assert.equal(
      oversizedResp.status,
      413,
      `expected 413 for chunked >256KB webhook body, got ${oversizedResp.status}`,
    );
  });

  it("12. Client self-serve config: per-org OAuth app credentials (tenant-isolated, no secrets leaked) & Slack bot token connect", async () => {
    // List OAuth apps for Org A (server defaults configured in test harness)
    const listBefore = await clientA.request("/api/oauth-apps");
    assert.equal(listBefore.status, 200);
    assert.equal(listBefore.json.apps.length, 2);
    const slackBefore = listBefore.json.apps.find((a) => a.applicationId === "slack");
    assert.ok(slackBefore);
    assert.equal(slackBefore.configured, true);
    assert.equal(slackBefore.source, "server");
    assert.equal(slackBefore.clientId, null);
    assert.ok(slackBefore.redirectUrl.endsWith("/api/oauth/slack/callback"));
    assert.ok(slackBefore.requiredScopes.includes("chat:write"));

    // Org A configures a custom Slack OAuth app in the UI/API
    const saved = await clientA.request("/api/oauth-apps/slack", {
      method: "PUT",
      body: {
        clientId: "orgA_custom_slack_client_id",
        clientSecret: "orgA_super_secret_do_not_leak",
      },
    });
    assert.equal(saved.status, 200, `PUT /api/oauth-apps/slack failed: ${saved.text}`);
    assert.equal(saved.json.source, "organization");
    assert.equal(saved.json.clientId, "orgA_custom_slack_client_id");
    assert.ok(!saved.text.includes("orgA_super_secret_do_not_leak"), "clientSecret must never be returned");

    // Org B must NOT see Org A's custom clientId
    const orgBList = await clientB.request("/api/oauth-apps");
    assert.equal(orgBList.status, 200);
    const orgBSlack = orgBList.json.apps.find((a) => a.applicationId === "slack");
    assert.equal(orgBSlack.source, "server");
    assert.equal(orgBSlack.clientId, null);

    // Org A OAuth start URL uses Org A's custom clientId
    const customStart = await clientA.request("/api/connections/slack/oauth/start", {
      method: "POST",
      body: { returnTo: "/connections" },
    });
    assert.equal(customStart.status, 200);
    const parsedRedirect = new URL(customStart.json.redirectUrl);
    assert.equal(parsedRedirect.searchParams.get("client_id"), "orgA_custom_slack_client_id");

    // Org A removes its custom OAuth override -> reverts to server default
    const delRes = await clientA.request("/api/oauth-apps/slack", {
      method: "DELETE",
    });
    assert.equal(delRes.status, 204);

    // Direct Slack Bot Token connection (xoxb-...) without OAuth dance
    const slTokenConn = await clientA.request("/api/connections", {
      method: "POST",
      body: {
        applicationId: "slack",
        token: "xoxb-client-direct-bot-token",
        displayName: "Client Direct Slack Bot",
      },
    });
    assert.equal(slTokenConn.status, 201, `Slack token conn failed: ${slTokenConn.text}`);
    assert.equal(slTokenConn.json.applicationId, "slack");
    assert.equal(slTokenConn.json.displayName, "Client Direct Slack Bot");
    assert.equal(slTokenConn.json.status, "connected");
    assert.ok(!slTokenConn.text.includes("xoxb-client-direct-bot-token"));

    // Test the newly created Slack bot-token connection live
    const testSl = await clientA.request(`/api/connections/${slTokenConn.json.id}/test`, {
      method: "POST",
    });
    assert.equal(testSl.status, 200);
    assert.equal(testSl.json.ok, true);
  });
});
