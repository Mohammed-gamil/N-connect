import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../src/components/ui";
import type { Connection, Execution } from "../src/contracts";
import { ActivityPage } from "../src/features/activity/ActivityPage";
import { ConnectionsPage } from "../src/features/connections/ConnectionsPage";
import { api, ApiClientError } from "../src/lib/api";

const MOCK_CONNECTIONS: Connection[] = [
  {
    id: "con_cu_1",
    applicationId: "clickup",
    displayName: "Acme ClickUp",
    status: "connected",
    createdAt: Date.now() - 86_400_000,
  },
  {
    id: "con_sl_1",
    applicationId: "slack",
    displayName: "Acme Slack",
    status: "needs_attention",
    createdAt: Date.now() - 172_800_000,
  },
];

const MOCK_EXECUTIONS: Execution[] = [
  {
    id: "exe_1",
    automationId: "aut_1",
    automationName: "Notify #general",
    status: "failed",
    attempt: 2,
    triggerSummary: "Task “Ship v2” was created",
    actionSummary: null,
    errorMessage: "Slack authorization expired. Reconnect Slack and try again.",
    recovery: "reconnect_then_retry",
    connectionIdNeedingAttention: "con_sl_1",
    startedAt: Date.now() - 60_000,
    finishedAt: Date.now() - 59_000,
    durationMs: 420,
  },
  {
    id: "exe_2",
    automationId: "aut_1",
    automationName: "Notify #general",
    status: "succeeded",
    attempt: 1,
    triggerSummary: "Task “Fix login” was created",
    actionSummary: "Sent a message to #general",
    errorMessage: null,
    recovery: null,
    connectionIdNeedingAttention: null,
    startedAt: Date.now() - 120_000,
    finishedAt: Date.now() - 119_500,
    durationMs: 310,
  },
];

describe("ConnectionsPage", () => {
  it("lists connections, tests health, and disconnects after confirmation", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "listConnections").mockResolvedValue({
      connections: MOCK_CONNECTIONS,
    });
    const testSpy = vi
      .spyOn(api, "testConnection")
      .mockResolvedValue({ ok: true, message: "Workspace reachable." });
    const deleteSpy = vi
      .spyOn(api, "deleteConnection")
      .mockResolvedValue(undefined);

    render(
      <MemoryRouter initialEntries={["/connections"]}>
        <ToastProvider>
          <Routes>
            <Route path="/connections" element={<ConnectionsPage />} />
          </Routes>
        </ToastProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText("Acme ClickUp")).toBeInTheDocument();
    expect(screen.getByText("Acme Slack")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("Needs attention")).toBeInTheDocument();

    const testButtons = screen.getAllByRole("button", { name: "Test" });
    await user.click(testButtons[0]);

    await waitFor(() => {
      expect(testSpy).toHaveBeenCalledWith("con_cu_1");
    });
    const clickupCard = screen.getByTestId("connection-card-con_cu_1");
    expect(
      await within(clickupCard).findByText("Workspace reachable."),
    ).toBeInTheDocument();

    // Disconnect Acme ClickUp via confirm dialog
    await user.click(
      screen.getByRole("button", { name: "Disconnect Acme ClickUp" }),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Disconnect" }));

    await waitFor(() => {
      expect(deleteSpy).toHaveBeenCalledWith("con_cu_1");
    });
    await waitFor(() => {
      expect(screen.queryByText("Acme ClickUp")).not.toBeInTheDocument();
    });
  });

  it("shows toast feedback for ?connected=... redirect param", async () => {
    vi.spyOn(api, "listConnections").mockResolvedValue({
      connections: MOCK_CONNECTIONS,
    });

    render(
      <MemoryRouter initialEntries={["/connections?connected=con_cu_1"]}>
        <ToastProvider>
          <Routes>
            <Route path="/connections" element={<ConnectionsPage />} />
          </Routes>
        </ToastProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText("App connected")).toBeInTheDocument();
  });
});

describe("ActivityPage", () => {
  it("renders executions, shows Reconnect CTA, optimistically retries, and rolls back on error", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "listAutomations").mockResolvedValue({ automations: [] });
    vi.spyOn(api, "listExecutions").mockResolvedValue({
      items: MOCK_EXECUTIONS,
      nextCursor: null,
    });

    let rejectRetry!: (err: unknown) => void;
    const retrySpy = vi.spyOn(api, "retryExecution").mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectRetry = reject;
        }),
    );

    render(
      <MemoryRouter initialEntries={["/activity"]}>
        <ToastProvider>
          <Routes>
            <Route path="/activity" element={<ActivityPage />} />
            <Route path="/connections" element={<div>Connections</div>} />
          </Routes>
        </ToastProvider>
      </MemoryRouter>,
    );

    expect(
      await screen.findByText(
        "Slack authorization expired. Reconnect Slack and try again.",
      ),
    ).toBeInTheDocument();

    const reconnectBtn = screen.getByRole("button", { name: "Reconnect" });
    expect(reconnectBtn.closest("a")).toHaveAttribute("href", "/connections");

    const retryBtn = screen.getByRole("button", { name: "Try again" });
    await user.click(retryBtn);

    expect(retrySpy).toHaveBeenCalledWith("exe_1");
    // Optimistically shows Queued badge
    const row1 = screen.getByTestId("execution-row-exe_1");
    expect(await within(row1).findByText("Queued")).toBeInTheDocument();

    // Server error -> rolls back to Failed + shows toast
    rejectRetry(
      new ApiClientError(
        "upstream_error",
        "Retry queue temporarily unavailable.",
        undefined,
        "req_1",
        503,
      ),
    );

    expect(
      await screen.findByText("Retry queue temporarily unavailable."),
    ).toBeInTheDocument();
    expect(within(row1).getByText("Failed")).toBeInTheDocument();
  });

  it("loads next page when Load more is clicked", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "listAutomations").mockResolvedValue({ automations: [] });
    const listSpy = vi
      .spyOn(api, "listExecutions")
      .mockResolvedValueOnce({
        items: [MOCK_EXECUTIONS[0]],
        nextCursor: "cur_2",
      })
      .mockResolvedValueOnce({
        items: [MOCK_EXECUTIONS[1]],
        nextCursor: null,
      });

    render(
      <MemoryRouter initialEntries={["/activity"]}>
        <ToastProvider>
          <Routes>
            <Route path="/activity" element={<ActivityPage />} />
          </Routes>
        </ToastProvider>
      </MemoryRouter>,
    );

    const loadMoreBtn = await screen.findByRole("button", {
      name: "Load more",
    });
    await user.click(loadMoreBtn);

    await waitFor(() => {
      expect(listSpy).toHaveBeenCalledTimes(2);
    });
    expect(
      await screen.findByText("Sent a message to #general"),
    ).toBeInTheDocument();
  });
});
