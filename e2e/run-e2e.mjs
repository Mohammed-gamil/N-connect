import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeUpstreams } from "./fake-upstreams.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

const args = new Set(process.argv.slice(2));
const skipBuild = args.has("--skip-build");
const apiOnly = args.has("--api-only");
const browserOnly = args.has("--browser-only");

function cleanChildEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "http_proxy",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy",
    "NODE_USE_ENV_PROXY",
  ]) {
    delete env[key];
  }
  return {
    ...env,
    NO_PROXY: "127.0.0.1,localhost",
    ...extra,
  };
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function runProcess(cmd, cmdArgs, { cwd = __dirname, env = cleanChildEnv(), label = cmd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, {
      cwd,
      env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${label} exited with code ${code ?? `signal ${signal}`}`));
      }
    });
  });
}

async function waitForHttpReady(url, { timeoutMs = 30_000, child } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      throw new Error(`wrangler dev exited prematurely with code ${child.exitCode}`);
    }
    try {
      const resp = await fetch(url);
      if (resp.ok) {
        return;
      }
      lastErr = new Error(`HTTP ${resp.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastErr}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 4000)),
  ]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
  }
}

async function main() {
  if (!skipBuild) {
    console.log("==> Building web SPA...");
    await runProcess("pnpm", ["--dir", path.join(ROOT_DIR, "web"), "build"], {
      cwd: ROOT_DIR,
      env: process.env,
      label: "web build",
    });

    console.log("==> Building Rust Worker with --features e2e...");
    await runProcess(
      "bash",
      [
        "-lc",
        `source "${path.join(ROOT_DIR, "scripts/env.sh")}" && cd "${path.join(ROOT_DIR, "worker")}" && worker-build --release -- --features e2e`,
      ],
      {
        cwd: ROOT_DIR,
        env: process.env,
        label: "worker-build --features e2e",
      },
    );
  }

  console.log("==> Starting fake ClickUp & Slack upstream server...");
  const upstream = await startFakeUpstreams({ host: "127.0.0.1", port: 0 });
  console.log(`    Fake upstreams listening at ${upstream.url}`);

  const workerPort = await getFreePort();
  const baseUrl = `http://127.0.0.1:${workerPort}`;

  const tmpDir = await fs.mkdtemp(path.join(__dirname, ".tmp-e2e-"));
  const persistDir = path.join(tmpDir, "wrangler-state");
  const tmpWranglerToml = path.join(tmpDir, "wrangler.e2e.toml");
  const wranglerBin = path.join(ROOT_DIR, "node_modules/.bin/wrangler");

  let wranglerProc = null;

  try {
    const tomlContent = `name = "integration-hub-e2e"
main = ${JSON.stringify(path.join(ROOT_DIR, "worker/build/index.js"))}
compatibility_date = "2026-11-01"

[assets]
directory = ${JSON.stringify(path.join(ROOT_DIR, "web/dist"))}
binding = "ASSETS"
not_found_handling = "single-page-application"
run_worker_first = ["/api/*", "/hooks/*"]

[[d1_databases]]
binding = "DB"
database_name = "integration-hub"
database_id = "00000000-0000-0000-0000-000000000000"
migrations_dir = ${JSON.stringify(path.join(ROOT_DIR, "worker/migrations"))}

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
APP_ORIGIN = ${JSON.stringify(baseUrl)}
CREDENTIALS_KEY_V1 = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="
CLICKUP_CLIENT_ID = "cu_e2e_client_id"
CLICKUP_CLIENT_SECRET = "cu_e2e_client_secret"
SLACK_CLIENT_ID = "sl_e2e_client_id"
SLACK_CLIENT_SECRET = "sl_e2e_client_secret"
CLICKUP_API_BASE = ${JSON.stringify(`${upstream.url}/api/v2`)}
CLICKUP_OAUTH_BASE = ${JSON.stringify(upstream.url)}
SLACK_API_BASE = ${JSON.stringify(`${upstream.url}/api`)}
SLACK_OAUTH_BASE = ${JSON.stringify(upstream.url)}
`;

    await fs.writeFile(tmpWranglerToml, tomlContent, "utf8");

    console.log("==> Applying D1 migrations to local state...");
    await runProcess(
      wranglerBin,
      [
        "d1",
        "migrations",
        "apply",
        "integration-hub",
        "--local",
        "--config",
        tmpWranglerToml,
        "--persist-to",
        persistDir,
      ],
      {
        cwd: ROOT_DIR,
        env: cleanChildEnv(),
        label: "wrangler d1 migrations apply",
      },
    );

    console.log(`==> Starting wrangler dev at ${baseUrl}...`);
    wranglerProc = spawn(
      wranglerBin,
      [
        "dev",
        "--local",
        "--config",
        tmpWranglerToml,
        "--persist-to",
        persistDir,
        "--ip",
        "127.0.0.1",
        "--port",
        String(workerPort),
        "--show-interactive-dev-session",
        "false",
      ],
      {
        cwd: ROOT_DIR,
        env: cleanChildEnv({ CI: "1" }),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let wranglerLogs = "";
    const appendLog = (chunk) => {
      wranglerLogs = (wranglerLogs + chunk.toString("utf8")).slice(-8000);
    };
    wranglerProc.stdout.on("data", appendLog);
    wranglerProc.stderr.on("data", appendLog);

    try {
      await waitForHttpReady(`${baseUrl}/api/apps`, {
        timeoutMs: 30_000,
        child: wranglerProc,
      });
    } catch (err) {
      console.error("wrangler dev failed to start. Recent logs:\n", wranglerLogs);
      throw err;
    }

    const testEnv = cleanChildEnv({
      E2E_BASE_URL: baseUrl,
      E2E_UPSTREAM_URL: upstream.url,
    });

    if (!browserOnly) {
      console.log("==> Running API + Queue + D1 Worker E2E tests...");
      await runProcess(
        "node",
        ["--test", path.join(__dirname, "tests/api.e2e.test.mjs")],
        {
          cwd: __dirname,
          env: testEnv,
          label: "api.e2e.test.mjs",
        },
      );
    }

    if (!apiOnly) {
      upstream.reset();
      console.log("==> Running Playwright Browser E2E tests...");
      const pwBin = path.join(__dirname, "node_modules/.bin/playwright");
      await runProcess(
        pwBin,
        ["test", "--config", path.join(__dirname, "playwright.config.ts")],
        {
          cwd: __dirname,
          env: testEnv,
          label: "playwright browser e2e",
        },
      );
    }

    console.log("==> All E2E suites passed!");
  } finally {
    await stopChild(wranglerProc);
    await upstream.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
