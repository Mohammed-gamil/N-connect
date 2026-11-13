import { defineConfig } from "@playwright/test";

const PORT = 4179;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  retries: 0,
  timeout: 30_000,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    headless: true,
    launchOptions: {
      executablePath: "/usr/bin/chromium",
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    },
    viewport: { width: 1280, height: 820 },
  },
  webServer: {
    command: `pnpm exec vite --host 127.0.0.1 --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
