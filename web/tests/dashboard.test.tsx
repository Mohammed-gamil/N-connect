import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { Automation, DashboardStats, Me } from "../src/contracts";
import { ToastProvider } from "../src/components/ui";
import { AuthProvider } from "../src/features/auth/AuthContext";
import { DashboardPage } from "../src/features/dashboard/DashboardPage";
import { api, ApiClientError } from "../src/lib/api";

const MOCK_ME: Me = {
  user: { id: "usr_1", name: "Sam", email: "sam@example.com" },
  organization: { id: "org_1", name: "Acme" },
};

const MOCK_AUTOMATION: Automation = {
  id: "aut_1",
  name: "Notify #general on new tasks",
  status: "active",
  definition: {
    version: 1,
    trigger: {
      application: "clickup",
      event: "task.created",
      connectionId: "con_1",
      configuration: { workspaceId: "ws_1" },
    },
    filters: [],
    action: {
      application: "slack",
      event: "message.send",
      connectionId: "con_2",
      configuration: { channel: { value: "C123", label: "#general" }, message: "Hi {{task.name}}" },
    },
  },
  layout: null,
  summary: "When a task is created in ClickUp, send a message to #general in Slack.",
  lastExecutionAt: Date.now() - 120_000,
  lastExecutionStatus: "succeeded",
  createdAt: Date.now() - 86_400_000,
  updatedAt: Date.now() - 3_600_000,
};

function renderDashboard(stats: DashboardStats, automations: Automation[]) {
  vi.spyOn(api, "me").mockResolvedValue(MOCK_ME);
  vi.spyOn(api, "getDashboard").mockResolvedValue(stats);
  vi.spyOn(api, "listAutomations").mockResolvedValue({ automations });

  return render(
    <MemoryRouter initialEntries={["/"]}>
      <ToastProvider>
        <AuthProvider>
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/automations/new" element={<div>New Automation Builder</div>} />
            <Route path="/automations/:id" element={<div>Edit Automation Builder</div>} />
          </Routes>
        </AuthProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe("DashboardPage", () => {
  it("renders welcome header, 4 quiet stats, and empty state CTA when no automations exist", async () => {
    renderDashboard(
      {
        activeAutomations: 0,
        successfulExecutions: 0,
        failedExecutions: 0,
        connectedApps: 1,
      },
      [],
    );

    expect(await screen.findByText("Welcome, Sam")).toBeInTheDocument();
    expect(screen.getByText("Active automations")).toBeInTheDocument();
    expect(screen.getByText("Successful runs (30d)")).toBeInTheDocument();
    expect(screen.getByText("Failed runs")).toBeInTheDocument();
    expect(screen.getByText("Connected apps")).toBeInTheDocument();

    const cta = await screen.findByRole("button", {
      name: "Create your first automation",
    });
    expect(cta).toBeInTheDocument();
    expect(cta.closest("a")).toHaveAttribute("href", "/automations/new");
  });

  it("optimistically toggles automation status and rolls back with toast on error", async () => {
    const user = userEvent.setup();
    renderDashboard(
      {
        activeAutomations: 1,
        successfulExecutions: 12,
        failedExecutions: 0,
        connectedApps: 2,
      },
      [MOCK_AUTOMATION],
    );

    expect(
      await screen.findByText("Notify #general on new tasks"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("When a task is created in ClickUp, send a message to #general in Slack."),
    ).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("Last run succeeded")).toBeInTheDocument();

    let rejectPause!: (err: unknown) => void;
    vi.spyOn(api, "pauseAutomation").mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectPause = reject;
        }),
    );

    const toggle = screen.getByRole("switch", {
      name: "Toggle Notify #general on new tasks",
    });
    expect(toggle).toHaveAttribute("aria-checked", "true");

    await user.click(toggle);

    // Optimistic state immediately flips to Paused
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("Paused")).toBeInTheDocument();

    // Server rejects -> rollback to Active + toast shown
    rejectPause(
      new ApiClientError(
        "upstream_error",
        "Could not pause webhook subscription.",
        undefined,
        "req_err",
        502,
      ),
    );

    await waitFor(() => {
      expect(toggle).toHaveAttribute("aria-checked", "true");
    });
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not pause webhook subscription.",
    );
  });

  it("deletes an automation after confirmation dialog", async () => {
    const user = userEvent.setup();
    const deleteSpy = vi.spyOn(api, "deleteAutomation").mockResolvedValue(undefined);

    renderDashboard(
      {
        activeAutomations: 1,
        successfulExecutions: 3,
        failedExecutions: 0,
        connectedApps: 2,
      },
      [MOCK_AUTOMATION],
    );

    await screen.findByText("Notify #general on new tasks");

    await user.click(
      screen.getByRole("button", { name: "Delete Notify #general on new tasks" }),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete automation" }));

    await waitFor(() => {
      expect(deleteSpy).toHaveBeenCalledWith("aut_1");
    });
    expect(
      await screen.findByRole("button", { name: "Create your first automation" }),
    ).toBeInTheDocument();
  });
});
