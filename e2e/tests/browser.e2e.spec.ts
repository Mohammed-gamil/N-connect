import crypto from "node:crypto";
import { expect, test } from "@playwright/test";

const UPSTREAM_URL = process.env.E2E_UPSTREAM_URL;
if (!UPSTREAM_URL) {
  throw new Error("E2E_UPSTREAM_URL environment variable must be set.");
}

function hmacHex(secret: string, rawBody: string): string {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

async function upstreamJson(path: string, init?: RequestInit) {
  const resp = await fetch(`${UPSTREAM_URL}${path}`, init);
  if (!resp.ok) {
    throw new Error(`Upstream ${path} failed with ${resp.status}: ${await resp.text()}`);
  }
  return resp.json();
}

test.describe.serial("Integration Hub Browser E2E", () => {
  const email = "browser-e2e@example.com";
  const password = "browser-secure-pw-123";

  test("registers, builds ClickUp -> Slack automation via guided flow & OAuth, receives webhook, verifies Dashboard & Activity", async ({
    page,
  }) => {
    // 1. Register a new user via UI
    await page.goto("/register");
    await page.fill("#register-name", "Browser Tester");
    await page.fill("#register-email", email);
    await page.fill("#register-password", password);
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByText("Welcome, Browser Tester")).toBeVisible();

    // 2. Navigate to /automations/new via Dashboard empty-state CTA
    await page.getByRole("link", { name: /Create your first automation/i }).click();
    await expect(page).toHaveURL(/\/automations\/new$/);

    // Name the automation
    const nameInput = page.getByTestId("automation-name-input");
    await expect(nameInput).toBeVisible();
    await nameInput.fill("Browser ClickUp Slack Flow");

    // 3. Step 1: Select ClickUp trigger app
    await page.getByTestId("guided-app-card-clickup").click();

    // 4. Step 2: Connect ClickUp via personal API token
    await page.getByRole("button", { name: /Or paste a personal API token/i }).click();
    await page.getByPlaceholder("Account label (optional)").fill("Browser ClickUp");
    await page.getByPlaceholder("Paste personal API token...").fill("pk_browser_valid");
    await page.getByRole("button", { name: "Save token" }).click();

    // 5. Step 3: Select Task Created and workspace + list
    const taskCreatedRadio = page.locator('input[name="trigger-event"][value="task.created"]');
    await expect(taskCreatedRadio).toBeVisible();
    await taskCreatedRadio.check();

    const workspaceSelect = page.getByTestId("field-workspaceId");
    await expect(workspaceSelect.locator('option[value="9012345"]')).toBeAttached();
    await workspaceSelect.selectOption("9012345");

    const listSelect = page.getByTestId("field-listId");
    await expect(listSelect.locator('option[value="list_1"]')).toBeAttached();
    await listSelect.selectOption("list_1");

    await page.getByRole("button", { name: /Continue to action/i }).click();

    // 6. Step 4: Select Slack action app
    await page.getByTestId("guided-app-card-slack").click();

    // 7. Step 5: Connect Slack via OAuth redirect through fake upstream
    await page.getByRole("button", { name: /^Connect Slack$/i }).click();

    // Browser goes to fake Slack /oauth/v2/authorize -> Worker callback -> /automations/:id
    await page.waitForURL(/\/automations\/aut_/);

    // 8. Step 6: Configure Slack channel & message with {{task.name}} variable chip
    const channelSelect = page.getByTestId("field-channel");
    await expect(channelSelect).toBeVisible();
    await expect(channelSelect.locator('option[value="C01GENERAL"]')).toBeAttached();
    await channelSelect.selectOption("C01GENERAL");

    const messageTextarea = page.getByTestId("field-message");
    await messageTextarea.click();
    await messageTextarea.fill("Browser alert: ");
    await page.getByTestId("var-chip-task.name").click();
    await expect(messageTextarea).toHaveValue("Browser alert: {{task.name}}");

    await page.getByRole("button", { name: /Review & Activate/i }).click();

    // 9. Step 7: Activate automation
    const guidedPanel = page.getByTestId("guided-panel");
    await guidedPanel.getByRole("button", { name: "Activate automation" }).click();
    await expect(page.getByText("Active", { exact: true }).first()).toBeVisible();

    // 10. Trigger signed ClickUp webhook against real Worker
    const upStateBefore = await upstreamJson("/__admin/state");
    expect(upStateBefore.clickup.webhooks.length).toBe(1);
    const cuWebhook = upStateBefore.clickup.webhooks[0];

    await upstreamJson("/__admin/clickup/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "task_browser_1",
        name: "Playwright Verified Task",
        url: "https://app.clickup.com/t/task_browser_1",
        status: { status: "to do", type: "open" },
        list: { id: "list_1", name: "Roadmap" },
      }),
    });

    const webhookPayload = JSON.stringify({
      webhook_id: cuWebhook.id,
      event: "taskCreated",
      task_id: "task_browser_1",
      history_items: [{ id: "hist_browser_1" }],
    });
    const sig = hmacHex(cuWebhook.secret, webhookPayload);
    const hookResp = await fetch(cuWebhook.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Signature": sig,
      },
      body: webhookPayload,
    });
    expect(hookResp.status).toBe(200);

    // Wait for Queue consumer to deliver Slack message
    await expect
      .poll(
        async () => {
          const st = await upstreamJson("/__admin/state");
          return st.slack.messages.length;
        },
        { timeout: 15_000, intervals: [200, 400, 800] },
      )
      .toBe(1);

    const upStateAfter = await upstreamJson("/__admin/state");
    expect(upStateAfter.slack.messages[0].channel).toBe("C01GENERAL");
    expect(upStateAfter.slack.messages[0].text).toBe(
      "Browser alert: Playwright Verified Task",
    );

    // 11. Check Dashboard stats and automation card
    await page.getByRole("link", { name: "Dashboard", exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByText("Browser ClickUp Slack Flow")).toBeVisible();

    const statsSection = page.getByRole("region", { name: "Workspace summary" });
    await expect(statsSection).toContainText("Active automations");
    await expect(statsSection).toContainText("Successful runs (30d)");
    await expect(statsSection.locator("p.text-2xl").nth(0)).toHaveText("1");
    await expect(statsSection.locator("p.text-2xl").nth(1)).toHaveText("1");
    await expect(statsSection.locator("p.text-2xl").nth(3)).toHaveText("2");

    // 12. Check Activity page shows succeeded run
    await page.getByRole("link", { name: "Activity" }).click();
    await expect(page).toHaveURL(/\/activity$/);
    await expect(page.getByText("Succeeded", { exact: true })).toBeVisible();
    await expect(page.getByText('Task "Playwright Verified Task" was created')).toBeVisible();
    await expect(page.getByText("Sent a message to #general")).toBeVisible();
  });

  test("renders cleanly at mobile viewport (390x844) with accessible mobile navigation", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });

    // Sign in with user created in previous test
    await page.goto("/login");
    await page.fill("#login-email", email);
    await page.fill("#login-password", password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByText("Browser ClickUp Slack Flow")).toBeVisible();

    // Verify no horizontal overflow on Dashboard
    const dashboardOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(dashboardOverflow).toBeLessThanOrEqual(2);

    // Open mobile navigation menu and navigate to Activity
    const menuBtn = page.getByRole("button", { name: /Open navigation menu/i });
    await expect(menuBtn).toBeVisible();
    await menuBtn.click();
    await page
      .getByRole("navigation", { name: "Mobile navigation" })
      .getByRole("link", { name: "Activity" })
      .click();
    await expect(page).toHaveURL(/\/activity$/);
    await expect(page.getByText('Task "Playwright Verified Task" was created')).toBeVisible();

    const activityOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(activityOverflow).toBeLessThanOrEqual(2);

    // Check builder on mobile viewport
    await page.goto("/automations/new");
    await expect(page.getByTestId("guided-panel")).toBeVisible();
    const builderOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(builderOverflow).toBeLessThanOrEqual(2);
  });
});
