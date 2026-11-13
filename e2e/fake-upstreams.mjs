import http from "node:http";
import { pathToFileURL } from "node:url";

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function createInitialState() {
  return {
    clickup: {
      webhooks: [],
      deletedWebhooks: [],
      tasks: {},
      oauthTokensIssued: 0,
      requests: [],
    },
    slack: {
      mode: "normal", // "normal" | "token_revoked"
      rateLimitRemaining: 0,
      revokedTokens: new Set(),
      issuedTokens: [],
      oauthTokensIssued: 0,
      messages: [],
      requests: [],
    },
  };
}

export async function startFakeUpstreams({ host = "127.0.0.1", port = 0 } = {}) {
  let state = createInitialState();

  function resetState() {
    state = createInitialState();
  }

  function extractClickUpToken(req) {
    const auth = req.headers["authorization"];
    if (!auth || typeof auth !== "string") return null;
    return auth.trim();
  }

  function extractSlackToken(req) {
    const auth = req.headers["authorization"];
    if (!auth || typeof auth !== "string") return null;
    const m = auth.trim().match(/^Bearer\s+(.+)$/i);
    return m ? m[1].trim() : null;
  }

  function isSlackTokenRevoked(token) {
    if (!token) return true;
    return state.slack.mode === "token_revoked" || state.slack.revokedTokens.has(token);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || `${host}:${port}`}`);
    const pathname = url.pathname;
    const method = (req.method || "GET").toUpperCase();

    try {
      // ─────────────── Control / Admin API for tests ───────────────
      if (pathname === "/__admin/health" && method === "GET") {
        return sendJson(res, 200, { ok: true });
      }

      if (pathname === "/__admin/reset" && method === "POST") {
        resetState();
        return sendJson(res, 200, { ok: true });
      }

      if (pathname === "/__admin/state" && method === "GET") {
        return sendJson(res, 200, {
          clickup: {
            webhooks: state.clickup.webhooks,
            deletedWebhooks: state.clickup.deletedWebhooks,
            tasks: state.clickup.tasks,
            requests: state.clickup.requests,
          },
          slack: {
            mode: state.slack.mode,
            rateLimitRemaining: state.slack.rateLimitRemaining,
            revokedTokens: Array.from(state.slack.revokedTokens),
            issuedTokens: state.slack.issuedTokens,
            messages: state.slack.messages,
            requests: state.slack.requests,
          },
        });
      }

      if (pathname === "/__admin/slack/fault" && method === "POST") {
        const raw = await readBody(req);
        const body = raw ? JSON.parse(raw) : {};
        if (typeof body.mode === "string") {
          state.slack.mode = body.mode;
        }
        if (typeof body.rateLimitRemaining === "number") {
          state.slack.rateLimitRemaining = body.rateLimitRemaining;
        }
        if (typeof body.revokeToken === "string") {
          state.slack.revokedTokens.add(body.revokeToken);
        }
        if (body.clearRevokedTokens) {
          state.slack.revokedTokens.clear();
        }
        return sendJson(res, 200, {
          ok: true,
          mode: state.slack.mode,
          rateLimitRemaining: state.slack.rateLimitRemaining,
          revokedTokens: Array.from(state.slack.revokedTokens),
        });
      }

      if (pathname === "/__admin/clickup/task" && method === "POST") {
        const raw = await readBody(req);
        const body = raw ? JSON.parse(raw) : {};
        if (!body.id) {
          return sendJson(res, 400, { error: "task id required" });
        }
        state.clickup.tasks[String(body.id)] = body;
        return sendJson(res, 200, { ok: true, task: body });
      }

      // ─────────────── ClickUp OAuth & API v2 ───────────────
      if (pathname === "/oauth/authorize" && method === "GET") {
        const redirectUri = url.searchParams.get("redirect_uri");
        const oauthState = url.searchParams.get("state") || "";
        if (!redirectUri) {
          return sendJson(res, 400, { error: "missing redirect_uri" });
        }
        const target = new URL(redirectUri);
        target.searchParams.set("code", "cu_code_1");
        target.searchParams.set("state", oauthState);
        res.writeHead(302, { Location: target.toString() });
        res.end();
        return;
      }

      if (pathname === "/api/v2/oauth/token" && method === "POST") {
        await readBody(req);
        state.clickup.oauthTokensIssued += 1;
        const token = `cu_oauth_tok_${state.clickup.oauthTokensIssued}`;
        return sendJson(res, 200, { access_token: token });
      }

      if (pathname.startsWith("/api/v2/")) {
        const raw = await readBody(req);
        const tok = extractClickUpToken(req);
        state.clickup.requests.push({ method, pathname, hasToken: Boolean(tok) });

        if (!tok || tok === "bad_token" || tok === "invalid") {
          return sendJson(res, 401, { err: "Token invalid", ECODE: "OAUTH_019" });
        }

        if (pathname === "/api/v2/user" && method === "GET") {
          return sendJson(res, 200, {
            user: {
              id: 1001,
              username: "Alex ClickUp",
              email: "alex@acme.test",
            },
          });
        }

        if (pathname === "/api/v2/team" && method === "GET") {
          return sendJson(res, 200, {
            teams: [{ id: "9012345", name: "Acme Workspace" }],
          });
        }

        const spaceMatch = pathname.match(/^\/api\/v2\/team\/([^/]+)\/space$/);
        if (spaceMatch && method === "GET") {
          return sendJson(res, 200, {
            spaces: [{ id: "space_1", name: "Product" }],
          });
        }

        const spaceListMatch = pathname.match(/^\/api\/v2\/space\/([^/]+)\/list$/);
        if (spaceListMatch && method === "GET") {
          return sendJson(res, 200, {
            lists: [{ id: "list_1", name: "Roadmap" }],
          });
        }

        const spaceFolderMatch = pathname.match(/^\/api\/v2\/space\/([^/]+)\/folder$/);
        if (spaceFolderMatch && method === "GET") {
          return sendJson(res, 200, {
            folders: [],
          });
        }

        const createWhMatch = pathname.match(/^\/api\/v2\/team\/([^/]+)\/webhook$/);
        if (createWhMatch && method === "POST") {
          const parsed = raw ? JSON.parse(raw) : {};
          const idx = state.clickup.webhooks.length + 1;
          const whId = idx === 1 ? "wh_cu_1" : `wh_cu_${idx}`;
          const record = {
            id: whId,
            teamId: createWhMatch[1],
            endpoint: parsed.endpoint,
            events: parsed.events || [],
            list_id: parsed.list_id ?? null,
            secret: "cu_wh_secret_123",
          };
          state.clickup.webhooks.push(record);
          return sendJson(res, 200, {
            id: whId,
            webhook: {
              id: whId,
              secret: "cu_wh_secret_123",
            },
          });
        }

        const delWhMatch = pathname.match(/^\/api\/v2\/webhook\/([^/]+)$/);
        if (delWhMatch && method === "DELETE") {
          const whId = delWhMatch[1];
          state.clickup.deletedWebhooks.push(whId);
          state.clickup.webhooks = state.clickup.webhooks.filter((w) => w.id !== whId);
          return sendJson(res, 200, {});
        }

        const taskMatch = pathname.match(/^\/api\/v2\/task\/([^/]+)$/);
        if (taskMatch && method === "GET") {
          const taskId = taskMatch[1];
          const stored = state.clickup.tasks[taskId];
          if (stored) {
            return sendJson(res, 200, stored);
          }
          return sendJson(res, 200, {
            id: taskId,
            name: `Task ${taskId}`,
            url: `https://app.clickup.com/t/${taskId}`,
            status: { status: "to do", type: "open" },
            text_content: "Default ClickUp task description",
            description: "Default ClickUp task description",
            assignees: [{ username: "Alex Rivera", email: "alex@acme.test" }],
            creator: { username: "Sam Lee", email: "sam@acme.test" },
            list: { id: "list_1", name: "Roadmap" },
            due_date: "1795132800000",
            priority: { priority: "high" },
          });
        }

        return sendJson(res, 404, { err: "Not found" });
      }

      // ─────────────── Slack OAuth & Web API ───────────────
      if (pathname === "/oauth/v2/authorize" && method === "GET") {
        const redirectUri = url.searchParams.get("redirect_uri");
        const oauthState = url.searchParams.get("state") || "";
        if (!redirectUri) {
          return sendJson(res, 400, { ok: false, error: "missing_redirect_uri" });
        }
        const target = new URL(redirectUri);
        target.searchParams.set("code", "sl_code_1");
        target.searchParams.set("state", oauthState);
        res.writeHead(302, { Location: target.toString() });
        res.end();
        return;
      }

      if (pathname === "/api/oauth.v2.access" && method === "POST") {
        await readBody(req);
        state.slack.oauthTokensIssued += 1;
        const token =
          state.slack.oauthTokensIssued === 1
            ? "xoxb-e2e-valid"
            : `xoxb-e2e-valid-${state.slack.oauthTokensIssued}`;
        state.slack.issuedTokens.push(token);
        // Reconnecting restores normal mode for the newly issued token
        state.slack.mode = "normal";
        state.slack.requests.push({ method, pathname });
        return sendJson(res, 200, {
          ok: true,
          access_token: token,
          team: { id: "T1", name: "Acme Test" },
        });
      }

      if (pathname === "/api/auth.test" && method === "POST") {
        await readBody(req);
        const tok = extractSlackToken(req);
        state.slack.requests.push({ method, pathname, token: tok });
        if (isSlackTokenRevoked(tok)) {
          return sendJson(res, 200, { ok: false, error: "token_revoked" });
        }
        return sendJson(res, 200, {
          ok: true,
          team: "Acme Test",
          team_id: "T1",
          user_id: "U_BOT",
        });
      }

      if (pathname === "/api/conversations.list" && method === "GET") {
        const tok = extractSlackToken(req);
        state.slack.requests.push({ method, pathname, token: tok });
        if (isSlackTokenRevoked(tok)) {
          return sendJson(res, 200, { ok: false, error: "token_revoked" });
        }
        return sendJson(res, 200, {
          ok: true,
          channels: [
            { id: "C01GENERAL", name: "general" },
            { id: "C02ENG", name: "eng" },
          ],
        });
      }

      if (pathname === "/api/chat.postMessage" && method === "POST") {
        const raw = await readBody(req);
        const tok = extractSlackToken(req);
        const body = raw ? JSON.parse(raw) : {};
        state.slack.requests.push({
          method,
          pathname,
          token: tok,
          channel: body.channel,
          text: body.text,
        });

        if (isSlackTokenRevoked(tok)) {
          if (tok) state.slack.revokedTokens.add(tok);
          return sendJson(res, 200, { ok: false, error: "token_revoked" });
        }

        if (state.slack.rateLimitRemaining > 0) {
          state.slack.rateLimitRemaining -= 1;
          return sendJson(
            res,
            429,
            { ok: false, error: "ratelimited" },
            { "Retry-After": "1" },
          );
        }

        const ts = `1700000000.${String(state.slack.messages.length + 1).padStart(6, "0")}`;
        state.slack.messages.push({
          channel: body.channel,
          text: body.text,
          token: tok,
          ts,
          receivedAt: Date.now(),
        });
        return sendJson(res, 200, { ok: true, ts, channel: body.channel });
      }

      sendJson(res, 404, { error: `Unhandled fake upstream route: ${method} ${pathname}` });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  const baseUrl = `http://${host}:${actualPort}`;

  return {
    server,
    host,
    port: actualPort,
    url: baseUrl,
    reset: resetState,
    getState: () => state,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.FAKE_UPSTREAM_PORT || "0");
  const upstream = await startFakeUpstreams({ port });
  console.log(`Fake upstreams listening on ${upstream.url}`);
  const shutdown = async () => {
    await upstream.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
