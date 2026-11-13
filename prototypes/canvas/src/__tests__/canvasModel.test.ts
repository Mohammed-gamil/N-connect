import { describe, expect, it } from "vitest";
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
  GRID_SIZE,
  INITIAL_CANVAS_STATE,
  nudgeNode,
  serializeCanvasToWorkflow,
  snapNodeToGrid,
  snapToGrid,
  startClickToConnect,
  updateNodeConfig,
  updateNodeEvent,
} from "../canvasModel";
import {
  canRedo,
  canUndo,
  createHistory,
  pushHistory,
  redoHistory,
  undoHistory,
} from "../history";

describe("grid snapping and node positioning", () => {
  it("snaps arbitrary numbers to the nearest 20px grid line", () => {
    expect(snapToGrid(0)).toBe(0);
    expect(snapToGrid(9)).toBe(0);
    expect(snapToGrid(11)).toBe(20);
    expect(snapToGrid(149)).toBe(140);
    expect(snapToGrid(151)).toBe(160);
  });

  it("clamps node positions within canvas bounds while snapping to grid", () => {
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

  it("snapNodeToGrid snaps an existing node to the 20px grid", () => {
    let state = addNodeToSlot(INITIAL_CANVAS_STATE, "clickup", {
      x: 133,
      y: 209,
    });
    const nodeId = Object.keys(state.nodes)[0];
    expect(state.nodes[nodeId].x % GRID_SIZE).toBe(0);
    expect(state.nodes[nodeId].y % GRID_SIZE).toBe(0);

    // Simulate unaligned intermediate position
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
  });

  it("nudgeNode moves a node by grid steps within bounds", () => {
    const state = addNodeToSlot(INITIAL_CANVAS_STATE, "clickup");
    const nodeId = Object.keys(state.nodes)[0];
    const startX = state.nodes[nodeId].x;
    const startY = state.nodes[nodeId].y;

    const nudged = nudgeNode(state, nodeId, 2, -1);
    expect(nudged.nodes[nodeId].x).toBe(startX + 40);
    expect(nudged.nodes[nodeId].y).toBe(startY - 20);
  });
});

describe("click-to-connect state transitions", () => {
  it("connects a trigger node to an action node and clears connectFromNodeId", () => {
    let state = addNodeToSlot(INITIAL_CANVAS_STATE, "clickup");
    const triggerId = Object.keys(state.nodes)[0];
    state = addNodeToSlot(state, "slack");
    const actionId = Object.keys(state.nodes).find((id) => id !== triggerId)!;

    state = startClickToConnect(state, triggerId);
    expect(state.connectFromNodeId).toBe(triggerId);

    state = completeClickToConnect(state, actionId);
    expect(state.connectFromNodeId).toBeNull();
    const conns = Object.values(state.connections);
    expect(conns).toHaveLength(1);
    expect(conns[0].sourceNodeId).toBe(triggerId);
    expect(conns[0].targetNodeId).toBe(actionId);
  });

  it("ignores startClickToConnect on action nodes and supports cancel", () => {
    let state = addNodeToSlot(INITIAL_CANVAS_STATE, "clickup");
    const triggerId = Object.keys(state.nodes)[0];
    state = addNodeToSlot(state, "slack");
    const actionId = Object.keys(state.nodes).find((id) => id !== triggerId)!;

    const ignored = startClickToConnect(state, actionId);
    expect(ignored.connectFromNodeId).toBeNull();

    const started = startClickToConnect(state, triggerId);
    expect(started.connectFromNodeId).toBe(triggerId);
    const cancelled = cancelClickToConnect(started);
    expect(cancelled.connectFromNodeId).toBeNull();
  });

  it("replaces an existing connection when reconnecting to a new action", () => {
    let state = addNodeToSlot(INITIAL_CANVAS_STATE, "clickup");
    const triggerId = Object.keys(state.nodes)[0];
    state = addNodeToSlot(state, "slack");
    const slackId = Object.keys(state.nodes).find((id) => id !== triggerId)!;
    state = addNodeToSlot(state, "http");
    const httpId = Object.keys(state.nodes).find(
      (id) => id !== triggerId && id !== slackId,
    )!;

    state = completeClickToConnect(startClickToConnect(state, triggerId), slackId);
    expect(Object.values(state.connections)).toHaveLength(1);

    state = completeClickToConnect(startClickToConnect(state, triggerId), httpId);
    const conns = Object.values(state.connections);
    expect(conns).toHaveLength(1);
    expect(conns[0].targetNodeId).toBe(httpId);
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

    // No-op push is ignored
    const sameHist = pushHistory(hist, structuredClone(s2));
    expect(sameHist).toBe(hist);

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

describe("serializeCanvasToWorkflow and sentence preview", () => {
  it("returns null when nodes are disconnected", () => {
    let state = addNodeToSlot(INITIAL_CANVAS_STATE, "clickup");
    state = addNodeToSlot(state, "slack");
    expect(serializeCanvasToWorkflow(state)).toBeNull();
  });

  it("serializes connected ClickUp -> Slack into WorkflowDefinitionV1 and AutomationLayout", () => {
    let state = addNodeToSlot(INITIAL_CANVAS_STATE, "clickup");
    const triggerId = Object.keys(state.nodes)[0];
    state = addNodeToSlot(state, "slack");
    const actionId = Object.keys(state.nodes).find((id) => id !== triggerId)!;

    state = completeClickToConnect(
      startClickToConnect(state, triggerId),
      actionId,
    );
    state = updateNodeEvent(state, triggerId, "task.created");
    state = updateNodeConfig(state, actionId, "channel", {
      value: "C0123ABC",
      label: "#general",
    });
    state = updateNodeConfig(
      state,
      actionId,
      "message",
      "Created: {{task.name}}",
    );

    expect(buildWorkflowSentence(state)).toBe(
      "When a task is created in ClickUp, send a message to #general in Slack.",
    );

    const serialized = serializeCanvasToWorkflow(state);
    expect(serialized).not.toBeNull();
    expect(serialized!.definition).toEqual({
      version: 1,
      trigger: {
        application: "clickup",
        event: "task.created",
        connectionId: "con_clickup_acme",
        configuration: {
          workspaceId: { value: "ws_9012345", label: "Acme Product" },
          listId: null,
        },
      },
      filters: [],
      action: {
        application: "slack",
        event: "message.send",
        connectionId: "con_slack_acme",
        configuration: {
          channel: { value: "C0123ABC", label: "#general" },
          message: "Created: {{task.name}}",
        },
      },
    });
    expect(serialized!.layout).toEqual({
      nodes: {
        trigger: { x: state.nodes[triggerId].x, y: state.nodes[triggerId].y },
        action: { x: state.nodes[actionId].x, y: state.nodes[actionId].y },
      },
    });
  });

  it("serializes webhook trigger with null connectionId", () => {
    let state = addNodeToSlot(INITIAL_CANVAS_STATE, "webhook");
    const triggerId = Object.keys(state.nodes)[0];
    state = addNodeToSlot(state, "http");
    const actionId = Object.keys(state.nodes).find((id) => id !== triggerId)!;
    state = completeClickToConnect(
      startClickToConnect(state, triggerId),
      actionId,
    );

    const serialized = serializeCanvasToWorkflow(state);
    expect(serialized).not.toBeNull();
    expect(serialized!.definition.version).toBe(1);
    expect(serialized!.definition.trigger.application).toBe("webhook");
    expect(serialized!.definition.trigger.connectionId).toBeNull();
    expect(serialized!.definition.action.application).toBe("http");
  });
});
