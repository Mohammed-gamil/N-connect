import { produce } from "immer";
import { APP_CATALOG, APP_ORDER } from "./catalog";
import type {
  AppId,
  ApplicationNode,
  CanvasState,
  ConfigValue,
  Connection,
  SerializedWorkflow,
} from "./types";

export const SVG_WIDTH = 860;
export const SVG_HEIGHT = 480;

export const PALETTE_BAR_Y = 16;
export const PALETTE_CHIP_W = 148;
export const PALETTE_CHIP_H = 44;
export const PALETTE_CHIP_GAP = 16;

export const NODE_W = 228;
export const NODE_H = 104;
export const PORT_R = 7;

export const GRID_SIZE = 20;

export const CANVAS_MIN_X = 20;
export const CANVAS_MAX_X =
  Math.floor((SVG_WIDTH - NODE_W - 20) / GRID_SIZE) * GRID_SIZE;
export const CANVAS_MIN_Y = 100;
export const CANVAS_MAX_Y =
  Math.floor((SVG_HEIGHT - NODE_H - 20) / GRID_SIZE) * GRID_SIZE;

export const WHEN_SLOT = { x: 120, y: 200 };
export const THEN_SLOT = { x: 500, y: 200 };

export const INITIAL_CANVAS_STATE: CanvasState = {
  nodes: {},
  connections: {},
  selectedNodeId: null,
  connectFromNodeId: null,
};

export function paletteChipPos(appId: AppId): { x: number; y: number } {
  const idx = APP_ORDER.indexOf(appId);
  const totalWidth =
    APP_ORDER.length * PALETTE_CHIP_W +
    (APP_ORDER.length - 1) * PALETTE_CHIP_GAP;
  const startX = (SVG_WIDTH - totalWidth) / 2;
  return {
    x: startX + idx * (PALETTE_CHIP_W + PALETTE_CHIP_GAP),
    y: PALETTE_BAR_Y,
  };
}

export function snapToGrid(value: number, grid = GRID_SIZE): number {
  return Math.round(value / grid) * grid;
}

export function clampNodePosition(
  x: number,
  y: number,
): { x: number; y: number } {
  return {
    x: Math.max(CANVAS_MIN_X, Math.min(CANVAS_MAX_X, snapToGrid(x))),
    y: Math.max(CANVAS_MIN_Y, Math.min(CANVAS_MAX_Y, snapToGrid(y))),
  };
}

export function snapNodeToGrid(state: CanvasState, nodeId: string): CanvasState {
  const node = state.nodes[nodeId];
  if (!node) return state;
  const { x, y } = clampNodePosition(node.x, node.y);
  if (x === node.x && y === node.y) return state;
  return produce(state, (draft) => {
    draft.nodes[nodeId].x = x;
    draft.nodes[nodeId].y = y;
  });
}

export function outputPortPos(node: ApplicationNode): { x: number; y: number } {
  return { x: node.x + NODE_W, y: node.y + NODE_H / 2 };
}

export function inputPortPos(node: ApplicationNode): { x: number; y: number } {
  return { x: node.x, y: node.y + NODE_H / 2 };
}

export function connectionEndPos(
  state: CanvasState,
  conn: Connection,
): { x: number; y: number } {
  if (conn.targetNodeId && state.nodes[conn.targetNodeId]) {
    return inputPortPos(state.nodes[conn.targetNodeId]);
  }
  return conn.freeEnd ?? { x: 0, y: 0 };
}

export function nextNodeId(state: CanvasState, appId: AppId): string {
  let i = 1;
  while (`${appId}-${i}` in state.nodes) i++;
  return `${appId}-${i}`;
}

export function nextConnectionId(state: CanvasState): string {
  let i = 1;
  while (`conn-${i}` in state.connections) i++;
  return `conn-${i}`;
}

export function createNode(
  appId: AppId,
  x: number,
  y: number,
  id: string,
): ApplicationNode {
  const entry = APP_CATALOG[appId];
  return {
    id,
    applicationId: appId,
    role: entry.role,
    x,
    y,
    event: entry.events[0]?.id ?? "",
    connectionId: entry.defaultConnectionId,
    configuration: entry.defaultConfig(),
  };
}

export function addNodeToSlot(
  state: CanvasState,
  appId: AppId,
  customPos?: { x: number; y: number },
): CanvasState {
  const entry = APP_CATALOG[appId];
  const baseSlot = entry.role === "trigger" ? WHEN_SLOT : THEN_SLOT;
  let pos = customPos
    ? clampNodePosition(customPos.x, customPos.y)
    : { ...baseSlot };

  if (!customPos) {
    const existingSameRole = Object.values(state.nodes).filter(
      (n) => n.role === entry.role,
    );
    if (existingSameRole.length > 0) {
      pos = clampNodePosition(
        baseSlot.x + existingSameRole.length * 20,
        baseSlot.y + existingSameRole.length * 120,
      );
    }
  }

  const id = nextNodeId(state, appId);
  return produce(state, (draft) => {
    draft.nodes[id] = createNode(appId, pos.x, pos.y, id);
    draft.selectedNodeId = id;
    draft.connectFromNodeId = null;
  });
}

export function nudgeNode(
  state: CanvasState,
  nodeId: string,
  dxSteps: number,
  dySteps: number,
): CanvasState {
  const node = state.nodes[nodeId];
  if (!node) return state;
  const { x, y } = clampNodePosition(
    node.x + dxSteps * GRID_SIZE,
    node.y + dySteps * GRID_SIZE,
  );
  if (x === node.x && y === node.y) return state;
  return produce(state, (draft) => {
    draft.nodes[nodeId].x = x;
    draft.nodes[nodeId].y = y;
  });
}

export function startClickToConnect(
  state: CanvasState,
  sourceNodeId: string,
): CanvasState {
  const node = state.nodes[sourceNodeId];
  if (!node || node.role !== "trigger") return state;
  return produce(state, (draft) => {
    draft.connectFromNodeId =
      draft.connectFromNodeId === sourceNodeId ? null : sourceNodeId;
    draft.selectedNodeId = sourceNodeId;
  });
}

export function cancelClickToConnect(state: CanvasState): CanvasState {
  if (!state.connectFromNodeId) return state;
  return produce(state, (draft) => {
    draft.connectFromNodeId = null;
  });
}

export function completeClickToConnect(
  state: CanvasState,
  targetNodeId: string,
): CanvasState {
  const sourceId = state.connectFromNodeId;
  if (!sourceId || sourceId === targetNodeId) return state;
  const source = state.nodes[sourceId];
  const target = state.nodes[targetNodeId];
  if (!source || !target) return state;
  if (source.role !== "trigger" || target.role !== "action") {
    return produce(state, (draft) => {
      draft.connectFromNodeId = null;
    });
  }

  const connId = nextConnectionId(state);
  return produce(state, (draft) => {
    for (const [cid, conn] of Object.entries(draft.connections)) {
      if (conn.sourceNodeId === sourceId || conn.targetNodeId === targetNodeId) {
        delete draft.connections[cid];
      }
    }
    draft.connections[connId] = {
      id: connId,
      sourceNodeId: sourceId,
      targetNodeId,
      freeEnd: null,
    };
    draft.connectFromNodeId = null;
    draft.selectedNodeId = targetNodeId;
  });
}

export function connectNodes(
  state: CanvasState,
  sourceNodeId: string,
  targetNodeId: string,
): CanvasState {
  const source = state.nodes[sourceNodeId];
  const target = state.nodes[targetNodeId];
  if (!source || !target || source.role !== "trigger" || target.role !== "action") {
    return state;
  }
  const connId = nextConnectionId(state);
  return produce(state, (draft) => {
    for (const [cid, conn] of Object.entries(draft.connections)) {
      if (conn.sourceNodeId === sourceNodeId || conn.targetNodeId === targetNodeId) {
        delete draft.connections[cid];
      }
    }
    draft.connections[connId] = {
      id: connId,
      sourceNodeId,
      targetNodeId,
      freeEnd: null,
    };
    draft.connectFromNodeId = null;
  });
}

export function removeConnection(
  state: CanvasState,
  connectionId: string,
): CanvasState {
  if (!(connectionId in state.connections)) return state;
  return produce(state, (draft) => {
    delete draft.connections[connectionId];
  });
}

export function removeNode(state: CanvasState, nodeId: string): CanvasState {
  if (!(nodeId in state.nodes)) return state;
  return produce(state, (draft) => {
    delete draft.nodes[nodeId];
    for (const [cid, conn] of Object.entries(draft.connections)) {
      if (conn.sourceNodeId === nodeId || conn.targetNodeId === nodeId) {
        delete draft.connections[cid];
      }
    }
    if (draft.selectedNodeId === nodeId) {
      draft.selectedNodeId = null;
    }
    if (draft.connectFromNodeId === nodeId) {
      draft.connectFromNodeId = null;
    }
  });
}

export function updateNodeEvent(
  state: CanvasState,
  nodeId: string,
  event: string,
): CanvasState {
  if (!(nodeId in state.nodes)) return state;
  return produce(state, (draft) => {
    draft.nodes[nodeId].event = event;
  });
}

export function updateNodeConfig(
  state: CanvasState,
  nodeId: string,
  key: string,
  value: ConfigValue,
): CanvasState {
  if (!(nodeId in state.nodes)) return state;
  return produce(state, (draft) => {
    draft.nodes[nodeId].configuration[key] = value;
  });
}

function getCompletedConnection(state: CanvasState): Connection | null {
  for (const conn of Object.values(state.connections)) {
    if (
      conn.targetNodeId &&
      state.nodes[conn.sourceNodeId]?.role === "trigger" &&
      state.nodes[conn.targetNodeId]?.role === "action"
    ) {
      return conn;
    }
  }
  return null;
}

export function serializeCanvasToWorkflow(
  state: CanvasState,
): SerializedWorkflow | null {
  const conn = getCompletedConnection(state);
  if (!conn || !conn.targetNodeId) return null;

  const triggerNode = state.nodes[conn.sourceNodeId];
  const actionNode = state.nodes[conn.targetNodeId];
  if (!triggerNode || !actionNode) return null;

  return {
    definition: {
      version: 1,
      trigger: {
        application: triggerNode.applicationId,
        event: triggerNode.event,
        connectionId: triggerNode.connectionId,
        configuration: structuredClone(triggerNode.configuration),
      },
      filters: [],
      action: {
        application: actionNode.applicationId,
        event: actionNode.event,
        connectionId: actionNode.connectionId,
        configuration: structuredClone(actionNode.configuration),
      },
    },
    layout: {
      nodes: {
        trigger: { x: triggerNode.x, y: triggerNode.y },
        action: { x: actionNode.x, y: actionNode.y },
      },
    },
  };
}

function formatConfigLabel(val: ConfigValue | undefined): string | null {
  if (!val) return null;
  if (typeof val === "string") return val;
  if (!Array.isArray(val) && typeof val === "object") return val.label;
  return null;
}

export function buildWorkflowSentence(state: CanvasState): string {
  const nodeCount = Object.keys(state.nodes).length;
  if (nodeCount === 0) {
    return "Drag or add a trigger (ClickUp, Webhook) and an action (Slack, HTTP) to build an automation.";
  }

  const conn = getCompletedConnection(state);
  if (!conn || !conn.targetNodeId) {
    const triggers = Object.values(state.nodes).filter((n) => n.role === "trigger");
    const actions = Object.values(state.nodes).filter((n) => n.role === "action");
    if (triggers.length === 0) {
      return "Add a trigger app (ClickUp or Webhook) to define when this automation starts.";
    }
    if (actions.length === 0) {
      return "Add an action app (Slack or HTTP Request) to define what happens next.";
    }
    return `Connect ${APP_CATALOG[triggers[0].applicationId].name} to ${APP_CATALOG[actions[0].applicationId].name} to preview the workflow.`;
  }

  const triggerNode = state.nodes[conn.sourceNodeId];
  const actionNode = state.nodes[conn.targetNodeId];
  const triggerEntry = APP_CATALOG[triggerNode.applicationId];
  const actionEntry = APP_CATALOG[actionNode.applicationId];

  const triggerEvent =
    triggerEntry.events.find((e) => e.id === triggerNode.event) ??
    triggerEntry.events[0];
  const triggerPhrase = triggerEvent
    ? triggerEvent.phrase
    : `an event occurs in ${triggerEntry.name}`;

  let actionPhrase = "";
  if (actionNode.applicationId === "slack") {
    const channelLabel =
      formatConfigLabel(actionNode.configuration.channel) ?? "#general";
    actionPhrase = `send a message to ${channelLabel} in Slack`;
  } else if (actionNode.applicationId === "http") {
    const method =
      formatConfigLabel(actionNode.configuration.method) ?? "POST";
    const url = formatConfigLabel(actionNode.configuration.url) ?? "endpoint";
    actionPhrase = `send a ${method} request to ${url} via HTTP Request`;
  } else {
    const actionEvent = actionEntry.events.find((e) => e.id === actionNode.event);
    actionPhrase = actionEvent
      ? `${actionEvent.phrase} in ${actionEntry.name}`
      : `run ${actionEntry.name}`;
  }

  return `When ${triggerPhrase}, ${actionPhrase}.`;
}
