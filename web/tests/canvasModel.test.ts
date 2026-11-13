import { describe, expect, it } from "vitest";
import { DEFAULT_APPS } from "../src/canvas/appMeta";
import {
  addNodeToSlot,
  buildWorkflowSentence,
  cancelClickToConnect,
  CANVAS_MAX_X,
  CANVAS_MAX_Y,
  CANVAS_MIN_X,
  CANVAS_MIN_Y,
  clampNodePosition,
  completeClickToConnect,
  fromWorkflowAndLayout,
  GRID_SIZE,
  INITIAL_CANVAS_STATE,
  nudgeNode,
  placeGuidedStepNode,
  serializeCanvasToWorkflow,
  setCanvasFilters,
  snapNodeToGrid,
  snapToGrid,
  startClickToConnect,
  updateNodeConfig,
  updateNodeConnection,
  updateNodeEvent,
} from "../src/canvas/canvasModel";
import {
  canRedo,
  canUndo,
  createHistory,
  pushHistory,
  redoHistory,
  undoHistory,
} from "../src/canvas/history";
import type { Automation } from "../src/contracts";

describe("grid snapping and node positioning", () => {
  it("keeps canvas clamp maxima exact multiples of GRID_SIZE (20)", () => {
    expect(CANVAS_MAX_X % GRID_SIZE).toBe(0);
    expect(CANVAS_MAX_Y % GRID_SIZE).toBe(0);
  });

  it("snaps numbers to the 20px grid and clamps within canvas bounds", () => {
    expect(snapToGrid(0)).toBe(0);
    expect(snapToGrid(9)).toBe(0);
    expect(snapToGrid(11)).toBe(20);
    expect(snapToGrid(149)).toBe(140);
    expect(snapToGrid(151)).toBe(160);

    expect(clampNodePosition(-50, 10)).toEqual({
      x: CANVAS_MIN_X,
      y: CANVAS_MIN_Y,
    });
    expect(clampNodePosition(5000, 5000)).toEqual({
      x: CANVAS_MAX_X,
      y: CANVAS_MAX_Y,
    });
    expect(clampNodePosition(253, 214)).toEqual({
      x: 260,
      y: 220,
    });
  });

  it("snapNodeToGrid and nudgeNode keep positions grid-aligned", () => {
    let state = addNodeToSlot(INITIAL_CANVAS_STATE, "clickup", { x: 133, y: 209 });
    const nodeId = Object.keys(state.nodes)[0];
    expect(state.nodes[nodeId].x % GRID_SIZE).toBe(0);
    expect(state.nodes[nodeId].y % GRID_SIZE).toBe(0);

    state = {
      ...state,
      nodes: {
        ...state.nodes,
        [nodeId]: { ...state.nodes[nodeId], x: 171, y: 249 },
      },
    };
    const snapped = snapNodeToGrid(state, nodeId);
    expect(snapped.nodes[nodeId].x).toBe(180);
    expect(snapped.nodes[nodeId].y).toBe(240);

    const nudged = nudgeNode(snapped, nodeId, 2, -1);
    expect(nudged.nodes[nodeId].x).toBe(220);
    expect(nudged.nodes[nodeId].y).toBe(220);
  });
});

describe("click-to-connect and guided placement", () => {
  it("connects a trigger node to an action node and supports cancel", () => {
    let state = addNodeToSlot(INITIAL_CANVAS_STATE, "clickup");
    const triggerId = Object.keys(state.nodes)[0];
    state = addNodeToSlot(state, "slack");
    const actionId = Object.keys(state.nodes).find((id) => id !== triggerId)!;

    expect(startClickToConnect(state, actionId).connectFromNodeId).toBeNull();

    state = startClickToConnect(state, triggerId);
    expect(state.connectFromNodeId).toBe(triggerId);
    expect(cancelClickToConnect(state).connectFromNodeId).toBeNull();

    state = completeClickToConnect(state, actionId);
    expect(state.connectFromNodeId).toBeNull();
    const conns = Object.values(state.connections);
    expect(conns).toHaveLength(1);
    expect(conns[0].sourceNodeId).toBe(triggerId);
    expect(conns[0].targetNodeId).toBe(actionId);
  });

  it("placeGuidedStepNode auto-connects trigger and action for click-only creation", () => {
    let state = placeGuidedStepNode(
      INITIAL_CANVAS_STATE,
      "clickup",
      DEFAULT_APPS,
      "con_cu_1",
    );
    state = placeGuidedStepNode(state, "slack", DEFAULT_APPS, "con_sl_1");

    expect(Object.keys(state.nodes)).toHaveLength(2);
    expect(Object.values(state.connections)).toHaveLength(1);
    const serialized = serializeCanvasToWorkflow(state);
    expect(serialized).not.toBeNull();
    expect(serialized!.definition.trigger.application).toBe("clickup");
    expect(serialized!.definition.trigger.connectionId).toBe("con_cu_1");
    expect(serialized!.definition.action.application).toBe("slack");
    expect(serialized!.definition.action.connectionId).toBe("con_sl_1");
  });
});

describe("undo/redo history", () => {
  it("tracks past/present/future and clears future on new push", () => {
    const s0 = INITIAL_CANVAS_STATE;
    const s1 = addNodeToSlot(s0, "clickup");
    const s2 = addNodeToSlot(s1, "slack");

    let hist = createHistory(s0);
    expect(canUndo(hist)).toBe(false);
    expect(canRedo(hist)).toBe(false);

    hist = pushHistory(hist, s1);
    hist = pushHistory(hist, s2);
    expect(canUndo(hist)).toBe(true);
    expect(hist.present).toBe(s2);

    // Identical state is a no-op
    expect(pushHistory(hist, structuredClone(s2))).toBe(hist);

    hist = undoHistory(hist);
    expect(hist.present).toBe(s1);
    expect(canRedo(hist)).toBe(true);

    hist = redoHistory(hist);
    expect(hist.present).toBe(s2);
    expect(canRedo(hist)).toBe(false);

    hist = undoHistory(hist);
    const s3 = addNodeToSlot(s1, "http");
    hist = pushHistory(hist, s3);
    expect(canRedo(hist)).toBe(false);
    expect(hist.present).toBe(s3);
  });
});

describe("WorkflowDefinitionV1 <-> CanvasState round-trip", () => {
  it("returns null when trigger and action are disconnected", () => {
    let state = addNodeToSlot(INITIAL_CANVAS_STATE, "clickup");
    state = addNodeToSlot(state, "slack");
    expect(serializeCanvasToWorkflow(state)).toBeNull();
  });

  it("round-trips an existing Automation into CanvasState and back without data loss", () => {
    const automation: Pick<Automation, "definition" | "layout"> = {
      definition: {
        version: 1,
        trigger: {
          application: "clickup",
          event: "task.assigned",
          connectionId: "con_cu_1",
          configuration: {
            workspaceId: { value: "ws_1", label: "Product" },
            listId: { value: "list_2", label: "Sprint" },
          },
        },
        filters: [{ path: "task.priority", op: "equals", value: "high" }],
        action: {
          application: "slack",
          event: "message.send",
          connectionId: "con_sl_1",
          configuration: {
            channel: { value: "C99", label: "#alerts" },
            message: "Assigned: {{task.name}}",
          },
        },
      },
      layout: {
        nodes: {
          trigger: { x: 140, y: 220 },
          action: { x: 520, y: 240 },
        },
      },
    };

    const loaded = fromWorkflowAndLayout(automation, DEFAULT_APPS);
    expect(Object.keys(loaded.nodes)).toHaveLength(2);
    expect(Object.values(loaded.connections)).toHaveLength(1);
    expect(loaded.filters).toEqual(automation.definition.filters);

    const roundTripped = serializeCanvasToWorkflow(loaded);
    expect(roundTripped).toEqual({
      definition: automation.definition,
      layout: automation.layout,
    });

    expect(buildWorkflowSentence(loaded, DEFAULT_APPS)).toBe(
      "When a task is assigned in ClickUp (Product) (if 1 filter matches), send a message to #alerts in Slack.",
    );
  });

  it("serializes edits made to event, connectionId, config, and filters", () => {
    let state = placeGuidedStepNode(INITIAL_CANVAS_STATE, "webhook", DEFAULT_APPS);
    const triggerId = Object.keys(state.nodes)[0];
    state = placeGuidedStepNode(state, "http", DEFAULT_APPS, "con_http_1");
    const actionId = Object.keys(state.nodes).find((id) => id !== triggerId)!;

    state = updateNodeEvent(state, triggerId, "webhook.received");
    state = updateNodeConfig(state, triggerId, "verification", "shared_token");
    state = updateNodeConnection(state, actionId, "con_http_2");
    state = updateNodeConfig(state, actionId, "method", "PUT");
    state = updateNodeConfig(
      state,
      actionId,
      "url",
      "https://example.com/{{body.id}}",
    );
    state = setCanvasFilters(state, [
      { path: "body.event", op: "equals", value: "order.paid" },
    ]);

    const serialized = serializeCanvasToWorkflow(state);
    expect(serialized).not.toBeNull();
    expect(serialized!.definition.trigger.connectionId).toBeNull();
    expect(serialized!.definition.trigger.configuration.verification).toBe(
      "shared_token",
    );
    expect(serialized!.definition.filters).toEqual([
      { path: "body.event", op: "equals", value: "order.paid" },
    ]);
    expect(serialized!.definition.action.connectionId).toBe("con_http_2");
    expect(serialized!.definition.action.configuration.method).toBe("PUT");
  });
});
