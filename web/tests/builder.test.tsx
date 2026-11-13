import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_APPS } from "../src/canvas/appMeta";
import { ToastProvider } from "../src/components/ui";
import type { Automation, Connection } from "../src/contracts";
import { BuilderPage } from "../src/features/builder/BuilderPage";
import { api } from "../src/lib/api";

const MOCK_CONNECTIONS: Connection[] = [
  {
    id: "con_cu_1",
    applicationId: "clickup",
    displayName: "Acme ClickUp",
    status: "connected",
    createdAt: Date.now() - 10_000,
  },
  {
    id: "con_sl_1",
    applicationId: "slack",
    displayName: "Acme Slack",
    status: "connected",
    createdAt: Date.now() - 10_000,
  },
];

function renderBuilder(initialPath = "/automations/new") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <ToastProvider>
        <Routes>
          <Route path="/automations/new" element={<BuilderPage />} />
          <Route path="/automations/:id" element={<BuilderPage />} />
          <Route path="/" element={<div>Dashboard</div>} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe("BuilderPage", () => {
  it("hides Advanced mode features by default and reveals webhook/http/filters when toggled on", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "listApps").mockResolvedValue({ apps: DEFAULT_APPS });
    vi.spyOn(api, "listConnections").mockResolvedValue({
      connections: MOCK_CONNECTIONS,
    });

    renderBuilder("/automations/new");

    expect(
      await screen.findByText("What should start this automation?"),
    ).toBeInTheDocument();

    const advancedSwitch = screen.getByRole("switch", { name: "Advanced mode" });
    expect(advancedSwitch).toHaveAttribute("aria-checked", "false");

    // Basic mode only shows ClickUp trigger card, not Custom Webhook
    expect(screen.getByTestId("guided-app-card-clickup")).toBeInTheDocument();
    expect(
      screen.queryByTestId("guided-app-card-webhook"),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("palette-chip-webhook")).not.toBeInTheDocument();
    expect(screen.queryByTestId("palette-chip-http")).not.toBeInTheDocument();
    expect(screen.queryByTestId("filter-editor")).not.toBeInTheDocument();

    // Toggle Advanced mode ON
    await user.click(advancedSwitch);
    expect(advancedSwitch).toHaveAttribute("aria-checked", "true");

    expect(screen.getByTestId("guided-app-card-webhook")).toBeInTheDocument();
    expect(screen.getByTestId("palette-chip-webhook")).toBeInTheDocument();
    expect(screen.getByTestId("palette-chip-http")).toBeInTheDocument();

    // Pick ClickUp -> Step 3 shows FilterEditor in Advanced mode
    await user.click(screen.getByTestId("guided-app-card-clickup"));
    expect(await screen.findByTestId("filter-editor")).toBeInTheDocument();
  });

  it("supports full click-only guided creation, dynamic options, variable chip insertion, and activation", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "listApps").mockResolvedValue({ apps: DEFAULT_APPS });
    vi.spyOn(api, "listConnections").mockResolvedValue({
      connections: MOCK_CONNECTIONS,
    });
    vi.spyOn(api, "getFieldOptions").mockImplementation(
      async (_connId, fieldKey) => {
        if (fieldKey === "workspaceId") {
          return {
            options: [{ value: "ws_1", label: "Acme Product" }],
          };
        }
        if (fieldKey === "listId") {
          return {
            options: [{ value: "list_1", label: "Sprint Backlog" }],
          };
        }
        if (fieldKey === "channel") {
          return {
            options: [{ value: "C0123", label: "#general" }],
          };
        }
        return { options: [] };
      },
    );

    const createdAutomation: Automation = {
      id: "aut_new_1",
      name: "Task Alerts",
      status: "draft",
      definition: {
        version: 1,
        trigger: {
          application: "clickup",
          event: "task.created",
          connectionId: "con_cu_1",
          configuration: {
            workspaceId: { value: "ws_1", label: "Acme Product" },
          },
        },
        filters: [],
        action: {
          application: "slack",
          event: "message.send",
          connectionId: "con_sl_1",
          configuration: {
            channel: { value: "C0123", label: "#general" },
            message: "New task: {{task.name}}",
          },
        },
      },
      layout: {
        nodes: {
          trigger: { x: 120, y: 200 },
          action: { x: 500, y: 200 },
        },
      },
      summary: "When a task is created in ClickUp, send a message to #general in Slack.",
      lastExecutionAt: null,
      lastExecutionStatus: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const createSpy = vi
      .spyOn(api, "createAutomation")
      .mockResolvedValue(createdAutomation);
    const updateSpy = vi
      .spyOn(api, "updateAutomation")
      .mockResolvedValue(createdAutomation);
    const activateSpy = vi
      .spyOn(api, "activateAutomation")
      .mockResolvedValue({ ...createdAutomation, status: "active" });

    renderBuilder("/automations/new");

    await screen.findByText("What should start this automation?");

    // Edit automation name
    const nameInput = screen.getByTestId("automation-name-input");
    await user.clear(nameInput);
    await user.type(nameInput, "Task Alerts");

    // Step 1: Click ClickUp card (auto-selects con_cu_1 and advances to Step 3)
    await user.click(screen.getByTestId("guided-app-card-clickup"));
    expect(
      await screen.findByText("What event should trigger this?"),
    ).toBeInTheDocument();

    // Select ClickUp workspace
    const workspaceSelect = await screen.findByTestId("field-workspaceId");
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "Acme Product" })).toBeInTheDocument();
    });
    await user.selectOptions(workspaceSelect, "ws_1");

    // Continue to Step 4: Action
    await user.click(screen.getByRole("button", { name: /Continue to action/i }));
    expect(
      await screen.findByText("What should happen next?"),
    ).toBeInTheDocument();

    // Step 4: Click Slack card (auto-connects ClickUp -> Slack and advances to Step 6)
    await user.click(screen.getByTestId("guided-app-card-slack"));
    expect(await screen.findByText("Configure your action")).toBeInTheDocument();

    // Select Slack channel
    const channelSelect = await screen.findByTestId("field-channel");
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "#general" })).toBeInTheDocument();
    });
    await user.selectOptions(channelSelect, "C0123");

    // Type message prefix and click variable chip {{task.name}}
    const messageTextarea = screen.getByTestId(
      "field-message",
    ) as HTMLTextAreaElement;
    await user.type(messageTextarea, "New task: ");
    await user.click(screen.getByTestId("var-chip-task.name"));

    expect(messageTextarea.value).toBe("New task: {{task.name}}");

    // Continue to Step 7: Review & Activate
    await user.click(screen.getByRole("button", { name: /Review & Activate/i }));
    expect(await screen.findByTestId("review-summary-sentence")).toHaveTextContent(
      "When a task is created in ClickUp (Acme Product), send a message to #general in Slack.",
    );

    // Click Activate automation
    const activateButtons = screen.getAllByRole("button", {
      name: "Activate automation",
    });
    await user.click(activateButtons[0]);

    await waitFor(() => {
      expect(activateSpy).toHaveBeenCalledWith("aut_new_1");
    });
    expect(createSpy.mock.calls.length + updateSpy.mock.calls.length).toBeGreaterThan(0);
    expect(await screen.findByText("Active")).toBeInTheDocument();
  });

  it("loads an existing automation, supports Undo/Redo, and runs a Test run", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "listApps").mockResolvedValue({ apps: DEFAULT_APPS });
    vi.spyOn(api, "listConnections").mockResolvedValue({
      connections: MOCK_CONNECTIONS,
    });
    vi.spyOn(api, "getFieldOptions").mockResolvedValue({
      options: [{ value: "ws_1", label: "Acme Product" }],
    });

    const existingAutomation: Automation = {
      id: "aut_existing_1",
      name: "Existing Alerts",
      status: "draft",
      definition: {
        version: 1,
        trigger: {
          application: "clickup",
          event: "task.created",
          connectionId: "con_cu_1",
          configuration: {
            workspaceId: { value: "ws_1", label: "Acme Product" },
          },
        },
        filters: [],
        action: {
          application: "slack",
          event: "message.send",
          connectionId: "con_sl_1",
          configuration: {
            channel: { value: "C0123", label: "#general" },
            message: "Hello {{task.name}}",
          },
        },
      },
      layout: {
        nodes: {
          trigger: { x: 120, y: 200 },
          action: { x: 500, y: 200 },
        },
      },
      summary: "When a task is created in ClickUp, send a message to #general in Slack.",
      lastExecutionAt: null,
      lastExecutionStatus: null,
      createdAt: Date.now() - 60_000,
      updatedAt: Date.now() - 30_000,
    };

    const getSpy = vi
      .spyOn(api, "getAutomation")
      .mockResolvedValue(existingAutomation);
    const updateSpy = vi
      .spyOn(api, "updateAutomation")
      .mockResolvedValue(existingAutomation);
    const testSpy = vi.spyOn(api, "testAutomation").mockResolvedValue({
      ok: true,
      message: "Sent sample Slack message to #general.",
      usedSampleData: true,
    });

    renderBuilder("/automations/aut_existing_1");

    await waitFor(() => {
      expect(getSpy).toHaveBeenCalledWith("aut_existing_1", expect.anything());
    });
    expect(screen.getByTestId("automation-name-input")).toHaveValue(
      "Existing Alerts",
    );

    // Change trigger event -> pushes to history -> Undo & Redo
    const completedRadio = await screen.findByLabelText(
      /When a task is completed/i,
    );
    await user.click(completedRadio);
    expect(completedRadio).toBeChecked();

    const undoBtn = screen.getByTestId("undo-btn");
    const redoBtn = screen.getByTestId("redo-btn");
    expect(undoBtn).toBeEnabled();

    await user.click(undoBtn);
    expect(screen.getByLabelText(/When a task is created/i)).toBeChecked();
    expect(redoBtn).toBeEnabled();

    await user.click(redoBtn);
    expect(screen.getByLabelText(/When a task is completed/i)).toBeChecked();

    // Run Test run
    await user.click(screen.getByRole("button", { name: /Test run/i }));
    await waitFor(() => {
      expect(testSpy).toHaveBeenCalledWith("aut_existing_1");
    });
    expect(updateSpy).toHaveBeenCalled();
    expect(
      await screen.findByText(/Sent sample Slack message to #general\./i),
    ).toBeInTheDocument();
  });
});
