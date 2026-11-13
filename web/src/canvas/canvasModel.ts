import { produce } from "immer";
import type { AppDefinition, AppId, Automation, ConfigValue, Filter } from "../contracts";
import {
  DEFAULT_APPS,
  getAppById,
  getAppRole,
  getDefaultConfigForApp,
} from "./appMeta";
import type {
  ApplicationNode,
  CanvasConnection,
  CanvasState,
  NodeRole,
  SerializedWorkflow,
} from "./types";

export const SVG_WIDTH = 860;
export const SVG_HEIGHT = 480;

export const PALETTE_BAR_Y = 16;
export const PALETTE_CHIP_W = 156;
export const PALETTE_CHIP_H = 44;
export const PALETTE_CHIP_GAP = 14;

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
  filters: [],
  selectedNodeId: null,
  selectedSlot: "trigger",
  connectFromNodeId: null,
};

export function paletteChipPos(
  appId: AppId,
  visibleAppIds: AppId[],
): { x: number; y: number } {
  const idx = visibleAppIds.indexOf(appId);
  const safeIdx = idx === -1 ? 0 : idx;
  const count = Math.max(visibleAppIds.length, 1);
  const totalWidth =
    count * PALETTE_CHIP_W + (count - 1) * PALETTE_CHIP_GAP;
  const startX = Math.max(104, (SVG_WIDTH - totalWidth) / 2);
  return {
    x: startX + safeIdx * (PALETTE_CHIP_W + PALETTE_CHIP_GAP),
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
  conn: CanvasConnection,
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
  apps: AppDefinition[] = DEFAULT_APPS,
  connectionId: string | null = null,
): ApplicationNode {
  const app = getAppById(apps, appId);
  const role = getAppRole(app);
  const defaultEvent =
    role === "trigger"
      ? (app.triggers[0]?.id ?? "")
      : (app.actions[0]?.id ?? "");

  return {
    id,
    applicationId: appId,
    role,
    x,
    y,
    event: defaultEvent,
    connectionId: app.authKind === "none" ? null : connectionId,
    configuration: getDefaultConfigForApp(app),
  };
}

export function addNodeToSlot(
  state: CanvasState,
  appId: AppId,
  customPos?: { x: number; y: number },
  apps: AppDefinition[] = DEFAULT_APPS,
  connectionId: string | null = null,
): CanvasState {
  const app = getAppById(apps, appId);
  const role = getAppRole(app);
  const baseSlot = role === "trigger" ? WHEN_SLOT : THEN_SLOT;
  let pos = customPos
    ? clampNodePosition(customPos.x, customPos.y)
    : { ...baseSlot };

  if (!customPos) {
    const existingSameRole = Object.values(state.nodes).filter(
      (n) => n.role === role,
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
    draft.nodes[id] = createNode(appId, pos.x, pos.y, id, apps, connectionId);
    draft.selectedNodeId = id;
    draft.selectedSlot = null;
    draft.connectFromNodeId = null;
  });
}

/**
 * Places or replaces the trigger/action step for the guided 1-trigger -> 1-action flow,
 * automatically connecting trigger -> action when both slots are populated.
 */
export function placeGuidedStepNode(
  state: CanvasState,
  appId: AppId,
  apps: AppDefinition[] = DEFAULT_APPS,
  connectionId: string | null = null,
): CanvasState {
  const app = getAppById(apps, appId);
  const role = getAppRole(app);
  const existingSameRole = Object.values(state.nodes).find(
    (n) => n.role === role,
  );

  if (existingSameRole && existingSameRole.applicationId === appId) {
    return produce(state, (draft) => {
      draft.selectedNodeId = existingSameRole.id;
      draft.selectedSlot = null;
      draft.connectFromNodeId = null;
      if (!draft.nodes[existingSameRole.id].connectionId && connectionId && app.authKind !== "none") {
        draft.nodes[existingSameRole.id].connectionId = connectionId;
      }
    });
  }

  const slot = role === "trigger" ? WHEN_SLOT : THEN_SLOT;
  const pos = existingSameRole ? { x: existingSameRole.x, y: existingSameRole.y } : slot;
  const newId = nextNodeId(state, appId);

  return produce(state, (draft) => {
    const newNode = createNode(appId, pos.x, pos.y, newId, apps, connectionId);
    draft.nodes[newId] = newNode;

    if (existingSameRole) {
      for (const conn of Object.values(draft.connections)) {
        if (conn.sourceNodeId === existingSameRole.id) {
          conn.sourceNodeId = newId;
        }
        if (conn.targetNodeId === existingSameRole.id) {
          conn.targetNodeId = newId;
        }
      }
      delete draft.nodes[existingSameRole.id];
    }

    // Auto-connect if opposite role node exists and no completed connection exists yet
    const hasCompleted = Object.values(draft.connections).some(
      (c) =>
        c.targetNodeId !== null &&
        draft.nodes[c.sourceNodeId]?.role === "trigger" &&
        draft.nodes[c.targetNodeId]?.role === "action",
    );

    if (!hasCompleted) {
      const triggerNode = Object.values(draft.nodes).find((n) => n.role === "trigger");
      const actionNode = Object.values(draft.nodes).find((n) => n.role === "action");
      if (triggerNode && actionNode) {
        const cid = nextConnectionId(draft);
        draft.connections[cid] = {
          id: cid,
          sourceNodeId: triggerNode.id,
          targetNodeId: actionNode.id,
          freeEnd: null,
        };
      }
    }

    draft.selectedNodeId = newId;
    draft.selectedSlot = null;
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

export function selectNode(
  state: CanvasState,
  nodeId: string | null,
): CanvasState {
  if (state.selectedNodeId === nodeId && state.selectedSlot === null) {
    return state;
  }
  return produce(state, (draft) => {
    draft.selectedNodeId = nodeId;
    draft.selectedSlot = null;
  });
}

export function selectSlot(
  state: CanvasState,
  slot: NodeRole | null,
): CanvasState {
  return produce(state, (draft) => {
    draft.selectedNodeId = null;
    draft.selectedSlot = slot;
    draft.connectFromNodeId = null;
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
    draft.selectedSlot = null;
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
    draft.selectedSlot = null;
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
  const removedRole = state.nodes[nodeId].role;
  return produce(state, (draft) => {
    delete draft.nodes[nodeId];
    for (const [cid, conn] of Object.entries(draft.connections)) {
      if (conn.sourceNodeId === nodeId || conn.targetNodeId === nodeId) {
        delete draft.connections[cid];
      }
    }
    if (draft.selectedNodeId === nodeId) {
      draft.selectedNodeId = null;
      draft.selectedSlot = removedRole;
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

export function updateNodeConnection(
  state: CanvasState,
  nodeId: string,
  connectionId: string | null,
): CanvasState {
  if (!(nodeId in state.nodes)) return state;
  return produce(state, (draft) => {
    draft.nodes[nodeId].connectionId = connectionId;
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

export function setCanvasFilters(
  state: CanvasState,
  filters: Filter[],
): CanvasState {
  return produce(state, (draft) => {
    draft.filters = structuredClone(filters);
  });
}

export function getCompletedConnection(state: CanvasState): CanvasConnection | null {
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

export function getTriggerNode(state: CanvasState): ApplicationNode | null {
  const conn = getCompletedConnection(state);
  if (conn && state.nodes[conn.sourceNodeId]) {
    return state.nodes[conn.sourceNodeId];
  }
  return Object.values(state.nodes).find((n) => n.role === "trigger") ?? null;
}

export function getActionNode(state: CanvasState): ApplicationNode | null {
  const conn = getCompletedConnection(state);
  if (conn && conn.targetNodeId && state.nodes[conn.targetNodeId]) {
    return state.nodes[conn.targetNodeId];
  }
  return Object.values(state.nodes).find((n) => n.role === "action") ?? null;
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
      filters: structuredClone(state.filters),
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

/**
 * Serializes even partial/disconnected canvas states into a valid draft WorkflowDefinitionV1
 * for draft autosaving per `docs/API.md` draft rules.
 */
export function serializeCanvasToDraftWorkflow(
  state: CanvasState,
): SerializedWorkflow | null {
  const full = serializeCanvasToWorkflow(state);
  if (full) return full;

  const triggerNode = getTriggerNode(state);
  const actionNode = getActionNode(state);
  if (!triggerNode && !actionNode) return null;

  const layoutNodes: Record<string, { x: number; y: number }> = {};
  if (triggerNode) {
    layoutNodes.trigger = { x: triggerNode.x, y: triggerNode.y };
  }
  if (actionNode) {
    layoutNodes.action = { x: actionNode.x, y: actionNode.y };
  }

  return {
    definition: {
      version: 1,
      trigger: triggerNode
        ? {
            application: triggerNode.applicationId,
            event: triggerNode.event,
            connectionId: triggerNode.connectionId,
            configuration: structuredClone(triggerNode.configuration),
          }
        : {
            application: "clickup",
            event: "",
            connectionId: null,
            configuration: {},
          },
      filters: structuredClone(state.filters),
      action: actionNode
        ? {
            application: actionNode.applicationId,
            event: actionNode.event,
            connectionId: actionNode.connectionId,
            configuration: structuredClone(actionNode.configuration),
          }
        : {
            application: "slack",
            event: "",
            connectionId: null,
            configuration: {},
          },
    },
    layout: { nodes: layoutNodes },
  };
}

/**
 * Reconstructs CanvasState from a persisted Automation (WorkflowDefinitionV1 + AutomationLayout).
 */
export function fromWorkflowAndLayout(
  automation: Pick<Automation, "definition" | "layout">,
  apps: AppDefinition[] = DEFAULT_APPS,
): CanvasState {
  const { definition, layout } = automation;
  const triggerStep = definition.trigger;
  const actionStep = definition.action;

  const hasSavedTriggerLayout = Boolean(layout?.nodes?.trigger);
  const hasSavedActionLayout = Boolean(layout?.nodes?.action);

  const isPlaceholderTrigger =
    !hasSavedTriggerLayout &&
    triggerStep.event === "" &&
    triggerStep.connectionId === null &&
    Object.keys(triggerStep.configuration).length === 0 &&
    (hasSavedActionLayout || actionStep.event !== "");

  const isPlaceholderAction =
    !hasSavedActionLayout &&
    actionStep.event === "" &&
    actionStep.connectionId === null &&
    Object.keys(actionStep.configuration).length === 0 &&
    (hasSavedTriggerLayout || triggerStep.event !== "");

  const nodes: Record<string, ApplicationNode> = {};
  const connections: Record<string, CanvasConnection> = {};

  let triggerId: string | null = null;
  let actionId: string | null = null;

  if (!isPlaceholderTrigger) {
    const tPosRaw = layout?.nodes?.trigger ?? WHEN_SLOT;
    const tPos = clampNodePosition(tPosRaw.x, tPosRaw.y);
    const tApp = getAppById(apps, triggerStep.application);
    triggerId = `${triggerStep.application}-1`;
    nodes[triggerId] = {
      id: triggerId,
      applicationId: triggerStep.application,
      role: "trigger",
      x: tPos.x,
      y: tPos.y,
      event: triggerStep.event,
      connectionId: tApp.authKind === "none" ? null : triggerStep.connectionId,
      configuration: structuredClone(triggerStep.configuration ?? {}),
    };
  }

  if (!isPlaceholderAction) {
    const aPosRaw = layout?.nodes?.action ?? THEN_SLOT;
    const aPos = clampNodePosition(aPosRaw.x, aPosRaw.y);
    const aApp = getAppById(apps, actionStep.application);
    actionId =
      actionStep.application === triggerStep.application
        ? `${actionStep.application}-2`
        : `${actionStep.application}-1`;
    nodes[actionId] = {
      id: actionId,
      applicationId: actionStep.application,
      role: "action",
      x: aPos.x,
      y: aPos.y,
      event: actionStep.event,
      connectionId: aApp.authKind === "none" ? null : actionStep.connectionId,
      configuration: structuredClone(actionStep.configuration ?? {}),
    };
  }

  if (triggerId && actionId) {
    connections["conn-1"] = {
      id: "conn-1",
      sourceNodeId: triggerId,
      targetNodeId: actionId,
      freeEnd: null,
    };
  }

  return {
    nodes,
    connections,
    filters: structuredClone(definition.filters ?? []),
    selectedNodeId: triggerId ?? actionId ?? null,
    selectedSlot: triggerId ? null : "trigger",
    connectFromNodeId: null,
  };
}

function formatConfigLabel(val: ConfigValue | undefined): string | null {
  if (!val) return null;
  if (typeof val === "string") return val.trim() || null;
  if (!Array.isArray(val) && typeof val === "object") return val.label;
  return null;
}

export function buildWorkflowSentence(
  state: CanvasState,
  apps: AppDefinition[] = DEFAULT_APPS,
): string {
  const nodeCount = Object.keys(state.nodes).length;
  if (nodeCount === 0) {
    return "Choose what starts your automation, then pick what happens next.";
  }

  const conn = getCompletedConnection(state);
  if (!conn || !conn.targetNodeId) {
    const triggerNode = getTriggerNode(state);
    const actionNode = getActionNode(state);
    if (!triggerNode) {
      return "Add a trigger step to define when this automation starts.";
    }
    if (!actionNode) {
      return `Starting with ${getAppById(apps, triggerNode.applicationId).name}. Now pick an action step.`;
    }
    return `Connect ${getAppById(apps, triggerNode.applicationId).name} to ${getAppById(apps, actionNode.applicationId).name} to complete your workflow.`;
  }

  const triggerNode = state.nodes[conn.sourceNodeId];
  const actionNode = state.nodes[conn.targetNodeId];
  const triggerApp = getAppById(apps, triggerNode.applicationId);
  const actionApp = getAppById(apps, actionNode.applicationId);

  const triggerDef =
    triggerApp.triggers.find((t) => t.id === triggerNode.event) ??
    triggerApp.triggers[0];

  let triggerPhrase = triggerDef
    ? triggerDef.label.replace(/^When\s+/i, "")
    : `an event occurs`;
  if (triggerNode.applicationId === "clickup") {
    const ws = formatConfigLabel(triggerNode.configuration.workspaceId);
    triggerPhrase = `${triggerPhrase} in ClickUp${ws ? ` (${ws})` : ""}`;
  } else if (triggerNode.applicationId === "webhook") {
    triggerPhrase = `a custom webhook is received`;
  }

  let actionPhrase = "";
  if (actionNode.applicationId === "slack") {
    const channelLabel =
      formatConfigLabel(actionNode.configuration.channel) ?? "a Slack channel";
    actionPhrase = `send a message to ${channelLabel} in Slack`;
  } else if (actionNode.applicationId === "http") {
    const method = formatConfigLabel(actionNode.configuration.method) ?? "POST";
    const url = formatConfigLabel(actionNode.configuration.url) ?? "your endpoint";
    actionPhrase = `send a ${method} request to ${url}`;
  } else {
    const actionDef = actionApp.actions.find((a) => a.id === actionNode.event);
    actionPhrase = actionDef ? actionDef.label.toLowerCase() : `run ${actionApp.name}`;
  }

  const filterNote =
    state.filters.length > 0
      ? state.filters.length === 1
        ? " (if 1 filter matches)"
        : ` (if ${state.filters.length} filters match)`
      : "";

  return `When ${triggerPhrase}${filterNote}, ${actionPhrase}.`;
}
