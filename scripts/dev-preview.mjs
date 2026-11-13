import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeUpstreams } from "../e2e/fake-upstreams.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const STATE_DIR = path.join(ROOT, ".tmp-preview");
const UPSTREAM_PORT = 4100;
const WRANGLER_PORT = 8788;
const PUBLIC_PORT = Number(process.env.PORT || 8787);

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "http_proxy",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy",
    "NODE_USE_ENV_PROXY",
  ]) {
    delete env[k];
  }
  return { ...env, NO_PROXY: "127.0.0.1,localhost", ...extra };
}

function runCommand(cmd, args, cwd, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exited with ${code}`));
    });
  });
}

async function main() {
  console.log("==> Building web SPA...");
  await runCommand("pnpm", ["--dir", path.join(ROOT, "web"), "build"], ROOT);

  console.log("==> Building Rust Worker (e2e preview mode, --no-opt)...");
  await runCommand(
    "node",
    [path.join(ROOT, "scripts/build-worker.mjs"), "--no-opt", "--", "--features", "e2e"],
    path.join(ROOT, "worker"),
  );

  await fs.rm(STATE_DIR, { recursive: true, force: true });
  await fs.mkdir(STATE_DIR, { recursive: true });
  const persistDir = path.join(STATE_DIR, "wrangler-state");
  const tomlPath = path.join(STATE_DIR, "wrangler.preview.toml");

  const upstream = await startFakeUpstreams({ host: "127.0.0.1", port: UPSTREAM_PORT });
  console.log(`==> Simulated ClickUp/Slack upstreams listening at ${upstream.url}`);

  const tomlContent = `name = "integration-hub-preview"
main = ${JSON.stringify(path.join(ROOT, "worker/build/index.js"))}
compatibility_date = "2026-11-01"

[assets]
directory = ${JSON.stringify(path.join(ROOT, "web/dist"))}
binding = "ASSETS"
not_found_handling = "single-page-application"
run_worker_first = ["/api/*", "/hooks/*"]

[[d1_databases]]
binding = "DB"
database_name = "integration-hub"
database_id = "00000000-0000-0000-0000-000000000000"
migrations_dir = ${JSON.stringify(path.join(ROOT, "worker/migrations"))}

[[queues.producers]]
binding = "EXECUTIONS"
queue = "hub-executions"

[[queues.consumers]]
queue = "hub-executions"
max_batch_size = 5
max_batch_timeout = 1
max_retries = 5
dead_letter_queue = "hub-executions-dlq"

[[queues.consumers]]
queue = "hub-executions-dlq"
max_batch_size = 10

[vars]
ENVIRONMENT = "development"
APP_ORIGIN = "http://localhost:${PUBLIC_PORT}"
CREDENTIALS_KEY_V1 = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="
CLICKUP_CLIENT_ID = "cu_preview_client_id"
CLICKUP_CLIENT_SECRET = "cu_preview_client_secret"
SLACK_CLIENT_ID = "sl_preview_client_id"
SLACK_CLIENT_SECRET = "sl_preview_client_secret"
CLICKUP_API_BASE = "http://127.0.0.1:${UPSTREAM_PORT}/api/v2"
CLICKUP_OAUTH_BASE = "http://localhost:${PUBLIC_PORT}/__preview_upstream"
SLACK_API_BASE = "http://127.0.0.1:${UPSTREAM_PORT}/api"
SLACK_OAUTH_BASE = "http://localhost:${PUBLIC_PORT}/__preview_upstream"
`;
  await fs.writeFile(tomlPath, tomlContent, "utf8");

  const wranglerBin = path.join(
    ROOT,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "wrangler.cmd" : "wrangler",
  );

  console.log("==> Applying D1 migrations locally...");
  await runCommand(
    wranglerBin,
    ["d1", "migrations", "apply", "integration-hub", "--local", "--config", tomlPath, "--persist-to", persistDir],
    ROOT,
    cleanEnv(),
  );

  const wranglerProc = spawn(
    wranglerBin,
    [
      "dev",
      "--local",
      "--config",
      tomlPath,
      "--persist-to",
      persistDir,
      "--ip",
      "127.0.0.1",
      "--port",
      String(WRANGLER_PORT),
      "--show-interactive-dev-session",
      "false",
    ],
    {
      cwd: ROOT,
      env: cleanEnv({ CI: "1" }),
      stdio: "inherit",
      shell: process.platform === "win32",
    },
  );

  const proxy = http.createServer((clientReq, clientRes) => {
    const reqUrl = clientReq.url || "/";
    const isUpstream = reqUrl.startsWith("/__preview_upstream");
    const targetPort = isUpstream ? UPSTREAM_PORT : WRANGLER_PORT;
    const targetPath = isUpstream ? reqUrl.replace(/^\/__preview_upstream/, "") || "/" : reqUrl;

    const proxyReq = http.request(
      {
        hostname: "127.0.0.1",
        port: targetPort,
        path: targetPath,
        method: clientReq.method,
        headers: {
          ...clientReq.headers,
          host: isUpstream ? `127.0.0.1:${UPSTREAM_PORT}` : `localhost:${PUBLIC_PORT}`,
        },
      },
      (proxyRes) => {
        clientRes.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
        proxyRes.pipe(clientRes, { end: true });
      },
    );
    proxyReq.on("error", (err) => {
      clientRes.writeHead(502, { "Content-Type": "text/plain" });
      clientRes.end(`Preview proxy error: ${err.message}`);
    });
    clientReq.pipe(proxyReq, { end: true });
  });

  await new Promise((resolve) => {
    proxy.listen(PUBLIC_PORT, "127.0.0.1", resolve);
  });

  // Wait until wrangler dev is actually accepting connections before printing the URL.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${WRANGLER_PORT}/api/apps`);
      if (r.ok) break;
    } catch {
      // still booting
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  console.log(`\n✅ Integration Hub preview ready at http://localhost:${PUBLIC_PORT}`);
  console.log("   (Uses local D1, Queues, and simulated ClickUp/Slack OAuth + APIs.)\n");

  const shutdown = async () => {
    proxy.close();
    wranglerProc.kill("SIGTERM");
    await upstream.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  wranglerProc.on("exit", (code) => {
    process.exit(code ?? 1);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
