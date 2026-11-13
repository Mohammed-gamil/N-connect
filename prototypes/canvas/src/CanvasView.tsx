import { produce } from "immer";
import React, { useCallback } from "react";
import {
  and,
  type Draggable,
  DraggableRenderer,
  inOrder,
  param,
  translate,
  Vec2,
} from "dragology";
import {
  CANVAS_MAX_X,
  CANVAS_MAX_Y,
  CANVAS_MIN_X,
  CANVAS_MIN_Y,
  completeClickToConnect,
  connectionEndPos,
  createNode,
  inputPortPos,
  nextConnectionId,
  nextNodeId,
  NODE_H,
  NODE_W,
  nudgeNode,
  outputPortPos,
  PALETTE_BAR_Y,
  PALETTE_CHIP_H,
  PALETTE_CHIP_W,
  paletteChipPos,
  PORT_R,
  removeConnection,
  removeNode,
  snapNodeToGrid,
  startClickToConnect,
  SVG_HEIGHT,
  SVG_WIDTH,
  THEN_SLOT,
  WHEN_SLOT,
} from "./canvasModel";
import { APP_CATALOG, APP_ORDER } from "./catalog";
import type { ApplicationNode, CanvasState, ConfigValue } from "./types";

interface CanvasViewProps {
  state: CanvasState;
  onCommitState: (next: CanvasState) => void;
  onOpenInspector?: () => void;
}

function summarizeNodeConfig(node: ApplicationNode): string {
  const entry = APP_CATALOG[node.applicationId];
  const eventLabel =
    entry.events.find((e) => e.id === node.event)?.label ?? node.event;

  if (node.applicationId === "slack") {
    const ch = node.configuration.channel as ConfigValue | undefined;
    const chLabel =
      ch && typeof ch === "object" && !Array.isArray(ch) ? ch.label : "#general";
    return `${eventLabel} -> ${chLabel}`;
  }
  if (node.applicationId === "clickup") {
    const ws = node.configuration.workspaceId as ConfigValue | undefined;
    const wsLabel =
      ws && typeof ws === "object" && !Array.isArray(ws)
        ? ws.label
        : "Workspace";
    return `${eventLabel} (${wsLabel})`;
  }
  if (node.applicationId === "http") {
    const method =
      typeof node.configuration.method === "string"
        ? node.configuration.method
        : "POST";
    return `${method} request`;
  }
  return eventLabel;
}

export const CanvasView: React.FC<CanvasViewProps> = ({
  state,
  onCommitState,
  onOpenInspector,
}) => {
  const draggable: Draggable<CanvasState> = useCallback(
    ({ state: s, d, draggedId, setState }) => {
      const nodesList = Object.values(s.nodes);
      const hasTriggerNode = nodesList.some((n) => n.role === "trigger");
      const hasActionNode = nodesList.some((n) => n.role === "action");

      function endDragSpec(wid: string) {
        const conn = s.connections[wid];
        if (!conn) return d.fixed(s);

        const targetNodes = Object.values(s.nodes).filter(
          (n) => n.role === "action" && n.id !== conn.sourceNodeId,
        );

        const snapSpecs = targetNodes.map((targetNode) => {
          const port = inputPortPos(targetNode);
          const snappedState = produce(s, (draft) => {
            for (const [cid, c] of Object.entries(draft.connections)) {
              if (
                cid !== wid &&
                (c.sourceNodeId === conn.sourceNodeId ||
                  c.targetNodeId === targetNode.id)
              ) {
                delete draft.connections[cid];
              }
            }
            draft.connections[wid] = {
              id: wid,
              sourceNodeId: conn.sourceNodeId,
              targetNodeId: targetNode.id,
              freeEnd: null,
            };
          });

          return d.fixed(snappedState).withOverlay(
            <g transform={translate(port.x, port.y)}>
              <circle
                r={16}
                fill="rgba(62, 99, 221, 0.14)"
                stroke="#3E63DD"
                strokeWidth={2}
              />
              <circle r={5} fill="#3E63DD" />
            </g>,
          );
        });

        const end = connectionEndPos(s, conn);
        const freeState = produce(s, (draft) => {
          draft.connections[wid] = {
            id: wid,
            sourceNodeId: conn.sourceNodeId,
            targetNodeId: null,
            freeEnd: { x: end.x, y: end.y },
          };
        });

        const varyFreeEnd = d
          .vary(freeState, [
            param("connections", wid, "freeEnd", "x"),
            param("connections", wid, "freeEnd", "y"),
          ])
          .onDrop(
            produce(freeState, (draft) => {
              delete draft.connections[wid];
            }),
          );

        return d.closest(snapSpecs).whenFar(varyFreeEnd, { gap: 36 });
      }

      return (
        <g id="canvas-root">
          <rect
            id="canvas-backdrop"
            width={SVG_WIDTH}
            height={SVG_HEIGHT}
            rx={12}
            fill="transparent"
            stroke="#e4e4e7"
            strokeWidth={1}
            onClick={() => {
              if (s.selectedNodeId !== null || s.connectFromNodeId !== null) {
                setState(
                  produce(s, (draft) => {
                    draft.selectedNodeId = null;
                    draft.connectFromNodeId = null;
                  }),
                  { transition: false },
                );
              }
            }}
          />

          {/* Top palette bar */}
          <rect
            id="palette-tray-bg"
            width={SVG_WIDTH}
            height={76}
            rx={12}
            fill="#ffffff"
            stroke="#e4e4e7"
            strokeWidth={1}
            pointerEvents="none"
          />
          <line
            x1={0}
            y1={76}
            x2={SVG_WIDTH}
            y2={76}
            stroke="#e4e4e7"
            strokeWidth={1}
            pointerEvents="none"
          />
          <text
            x={16}
            y={42}
            fontSize={11}
            fontWeight={600}
            fill="#71717a"
            pointerEvents="none"
          >
            DRAG APP
          </text>

          {/* When / Then slot guides */}
          <g
            id="slot-when"
            transform={translate(WHEN_SLOT.x, WHEN_SLOT.y)}
            pointerEvents="none"
          >
            <rect
              width={NODE_W}
              height={NODE_H}
              rx={12}
              fill={hasTriggerNode ? "transparent" : "#ffffff"}
              stroke={hasTriggerNode ? "#e4e4e7" : "#d4d4d8"}
              strokeWidth={1.5}
              strokeDasharray="6 4"
            />
            <g id="slot-when-label" opacity={hasTriggerNode ? 0 : 1}>
              <text
                x={NODE_W / 2}
                y={NODE_H / 2 - 8}
                textAnchor="middle"
                fontSize={12}
                fontWeight={600}
                fill="#52525b"
              >
                When...
              </text>
              <text
                x={NODE_W / 2}
                y={NODE_H / 2 + 12}
                textAnchor="middle"
                fontSize={11}
                fill="#a1a1aa"
              >
                Drop ClickUp or Webhook
              </text>
            </g>
          </g>

          <g
            id="slot-then"
            transform={translate(THEN_SLOT.x, THEN_SLOT.y)}
            pointerEvents="none"
          >
            <rect
              width={NODE_W}
              height={NODE_H}
              rx={12}
              fill={hasActionNode ? "transparent" : "#ffffff"}
              stroke={hasActionNode ? "#e4e4e7" : "#d4d4d8"}
              strokeWidth={1.5}
              strokeDasharray="6 4"
            />
            <g id="slot-then-label" opacity={hasActionNode ? 0 : 1}>
              <text
                x={NODE_W / 2}
                y={NODE_H / 2 - 8}
                textAnchor="middle"
                fontSize={12}
                fontWeight={600}
                fill="#52525b"
              >
                Then...
              </text>
              <text
                x={NODE_W / 2}
                y={NODE_H / 2 + 12}
                textAnchor="middle"
                fontSize={11}
                fill="#a1a1aa"
              >
                Drop Slack or HTTP
              </text>
            </g>
          </g>

          {/* Palette app chips (drag-to-create into When/Then slots or free canvas) */}
          {APP_ORDER.map((appId) => {
            const entry = APP_CATALOG[appId];
            const chipPos = paletteChipPos(appId);
            return (
              <g
                id={`palette-${appId}`}
                data-testid={`palette-chip-${appId}`}
                transform={translate(chipPos.x, chipPos.y)}
                style={{ cursor: "grab" }}
                dragologyOnDrag={() => {
                  const newId = nextNodeId(s, appId);
                  const baseState = produce(s, (draft) => {
                    draft.nodes[newId] = createNode(
                      appId,
                      chipPos.x,
                      chipPos.y,
                      newId,
                    );
                    draft.selectedNodeId = newId;
                    draft.connectFromNodeId = null;
                  });

                  const targetSlot =
                    entry.role === "trigger" ? WHEN_SLOT : THEN_SLOT;
                  const slotState = produce(baseState, (draft) => {
                    draft.nodes[newId].x = targetSlot.x;
                    draft.nodes[newId].y = targetSlot.y;
                  });

                  const slotHighlight = (
                    <g transform={translate(targetSlot.x, targetSlot.y)}>
                      <rect
                        width={NODE_W}
                        height={NODE_H}
                        rx={12}
                        fill="rgba(62, 99, 221, 0.08)"
                        stroke="#3E63DD"
                        strokeWidth={2}
                        strokeDasharray="6 4"
                      />
                    </g>
                  );

                  const freeVarySpec = d
                    .vary(
                      baseState,
                      [param("nodes", newId, "x"), param("nodes", newId, "y")],
                      {
                        constraint: (st) =>
                          and(
                            ...inOrder([CANVAS_MIN_X, st.nodes[newId].x, CANVAS_MAX_X]),
                            ...inOrder([PALETTE_BAR_Y, st.nodes[newId].y, CANVAS_MAX_Y]),
                          ),
                      },
                    )
                    .onDrop((previewState) => {
                      const placed = previewState.nodes[newId];
                      if (!placed || placed.y < 80) {
                        return s;
                      }
                      return snapNodeToGrid(previewState, newId);
                    });

                  const followSpec = d
                    .closest([slotState])
                    .withFloating()
                    .withOverlay(slotHighlight)
                    .withDropTransition("cubic-out")
                    .whenFar(freeVarySpec, { gap: 110 });

                  return d.switchToStateAndFollow(
                    baseState,
                    `node-${newId}`,
                    followSpec,
                  );
                }}
              >
                <rect
                  width={PALETTE_CHIP_W}
                  height={PALETTE_CHIP_H}
                  rx={10}
                  fill="#ffffff"
                  stroke="#e4e4e7"
                  strokeWidth={1}
                />
                <rect
                  x={10}
                  y={10}
                  width={24}
                  height={24}
                  rx={6}
                  fill={entry.badgeBg}
                />
                <text
                  x={22}
                  y={26}
                  textAnchor="middle"
                  fontSize={10}
                  fontWeight={700}
                  fill={entry.badgeText}
                >
                  {entry.shortTag}
                </text>
                <text
                  x={42}
                  y={21}
                  fontSize={12}
                  fontWeight={600}
                  fill="#18181b"
                >
                  {entry.name}
                </text>
                <text
                  x={42}
                  y={34}
                  fontSize={10}
                  fill="#71717a"
                >
                  {entry.role === "trigger" ? "Trigger" : "Action"}
                </text>
              </g>
            );
          })}

          {/* Application nodes */}
          {nodesList.map((node) => {
            const entry = APP_CATALOG[node.applicationId];
            const isSelected = s.selectedNodeId === node.id;
            const isConnectSource = s.connectFromNodeId === node.id;
            const isConnectCandidate =
              Boolean(s.connectFromNodeId) &&
              s.connectFromNodeId !== node.id &&
              node.role === "action";
            const isDragged = draggedId === `node-${node.id}`;
            const subline = summarizeNodeConfig(node);

            return (
              <g
                id={`node-${node.id}`}
                data-testid={`canvas-node-${node.id}`}
                data-node-id={node.id}
                data-app-id={node.applicationId}
                data-x={node.x}
                data-y={node.y}
                transform={translate(node.x, node.y)}
                dragologyZIndex={isDragged ? "/1" : false}
                tabIndex={0}
                role="button"
                aria-label={`${entry.name} ${node.role} node`}
                style={{ cursor: isConnectCandidate ? "pointer" : "grab", outline: "none" }}
                onClick={(e) => {
                  e.stopPropagation();
                  if (s.connectFromNodeId && node.role === "action") {
                    setState(completeClickToConnect(s, node.id), {
                      transition: false,
                    });
                    return;
                  }
                  setState(
                    produce(s, (draft) => {
                      draft.selectedNodeId = node.id;
                    }),
                    { transition: false },
                  );
                }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowLeft") {
                    e.preventDefault();
                    setState(nudgeNode(s, node.id, -1, 0), {
                      transition: false,
                    });
                  } else if (e.key === "ArrowRight") {
                    e.preventDefault();
                    setState(nudgeNode(s, node.id, 1, 0), {
                      transition: false,
                    });
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setState(nudgeNode(s, node.id, 0, -1), {
                      transition: false,
                    });
                  } else if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setState(nudgeNode(s, node.id, 0, 1), {
                      transition: false,
                    });
                  } else if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setState(
                      produce(s, (draft) => {
                        draft.selectedNodeId = node.id;
                      }),
                      { transition: false },
                    );
                    onOpenInspector?.();
                  } else if (e.key === "Backspace" || e.key === "Delete") {
                    e.preventDefault();
                    setState(removeNode(s, node.id), { transition: false });
                  } else if (e.key === "Escape" && s.connectFromNodeId) {
                    e.preventDefault();
                    setState(
                      produce(s, (draft) => {
                        draft.connectFromNodeId = null;
                      }),
                      { transition: false },
                    );
                  }
                }}
                dragologyOnDrag={() =>
                  d
                    .vary(
                      s,
                      [
                        param("nodes", node.id, "x"),
                        param("nodes", node.id, "y"),
                      ],
                      {
                        constraint: (st) =>
                          and(
                            ...inOrder([
                              CANVAS_MIN_X,
                              st.nodes[node.id].x,
                              CANVAS_MAX_X,
                            ]),
                            ...inOrder([
                              CANVAS_MIN_Y,
                              st.nodes[node.id].y,
                              CANVAS_MAX_Y,
                            ]),
                          ),
                      },
                    )
                    .onDrop((previewState) =>
                      snapNodeToGrid(previewState, node.id),
                    )
                }
              >
                {/* Selection / connect highlight rings (always mounted, constant strokeDasharray for Dragology lerp) */}
                <rect
                  x={-4}
                  y={-4}
                  width={NODE_W + 8}
                  height={NODE_H + 8}
                  rx={15}
                  fill="none"
                  stroke="#3E63DD"
                  strokeWidth={2}
                  opacity={
                    !isConnectCandidate && (isSelected || isConnectSource)
                      ? 1
                      : 0
                  }
                />
                <rect
                  x={-4}
                  y={-4}
                  width={NODE_W + 8}
                  height={NODE_H + 8}
                  rx={15}
                  fill="none"
                  stroke="#10b981"
                  strokeWidth={2}
                  strokeDasharray="5 3"
                  opacity={isConnectCandidate ? 1 : 0}
                />

                {/* Card body */}
                <rect
                  width={NODE_W}
                  height={NODE_H}
                  rx={12}
                  fill="#ffffff"
                  stroke={isSelected ? "#3E63DD" : "#d4d4d8"}
                  strokeWidth={isSelected ? 1.5 : 1}
                />

                {/* Accent strip */}
                <rect
                  x={1}
                  y={16}
                  width={3}
                  height={NODE_H - 32}
                  rx={1.5}
                  fill={entry.accent}
                />

                {/* App badge */}
                <rect
                  x={16}
                  y={16}
                  width={32}
                  height={32}
                  rx={8}
                  fill={entry.badgeBg}
                />
                <text
                  x={32}
                  y={36}
                  textAnchor="middle"
                  fontSize={12}
                  fontWeight={700}
                  fill={entry.badgeText}
                >
                  {entry.shortTag}
                </text>

                {/* Role pill */}
                <rect
                  x={NODE_W - 68}
                  y={16}
                  width={54}
                  height={20}
                  rx={10}
                  fill={node.role === "trigger" ? "#EEF2FF" : "#F4F4F5"}
                />
                <text
                  x={NODE_W - 41}
                  y={29}
                  textAnchor="middle"
                  fontSize={10}
                  fontWeight={600}
                  fill={node.role === "trigger" ? "#3E63DD" : "#52525b"}
                >
                  {node.role === "trigger" ? "WHEN" : "THEN"}
                </text>

                {/* Title & subtitle */}
                <text
                  x={58}
                  y={30}
                  fontSize={14}
                  fontWeight={600}
                  fill="#18181b"
                >
                  {entry.name}
                </text>
                <text
                  x={58}
                  y={47}
                  fontSize={11}
                  fill="#71717a"
                >
                  {node.role === "trigger" ? "Trigger step" : "Action step"}
                </text>
                <line
                  x1={16}
                  y1={62}
                  x2={NODE_W - 16}
                  y2={62}
                  stroke="#f4f4f5"
                  strokeWidth={1}
                />
                <text
                  x={16}
                  y={84}
                  fontSize={11.5}
                  fontWeight={500}
                  fill="#3f3f46"
                >
                  {subline.length > 30 ? `${subline.slice(0, 29)}...` : subline}
                </text>

                {/* Trigger output port */}
                {node.role === "trigger" && (
                  <g
                    id={`port-out-wrap-${node.id}`}
                    transform={translate(NODE_W, NODE_H / 2)}
                  >
                    <circle
                      id={`port-out-${node.id}`}
                      data-testid={`port-out-${node.id}`}
                      r={PORT_R + 2}
                      fill={isConnectSource ? "#3E63DD" : "#ffffff"}
                      stroke="#3E63DD"
                      strokeWidth={2.5}
                      style={{ cursor: "crosshair" }}
                      onClick={(e) => {
                        e.stopPropagation();
                        setState(startClickToConnect(s, node.id), {
                          transition: false,
                        });
                      }}
                      dragologyOnDrag={() => {
                        const outPos = outputPortPos(node);
                        const wid = nextConnectionId(s);
                        const startWireState = produce(s, (draft) => {
                          for (const [cid, c] of Object.entries(
                            draft.connections,
                          )) {
                            if (c.sourceNodeId === node.id) {
                              delete draft.connections[cid];
                            }
                          }
                          draft.connections[wid] = {
                            id: wid,
                            sourceNodeId: node.id,
                            targetNodeId: null,
                            freeEnd: { x: outPos.x, y: outPos.y },
                          };
                          draft.connectFromNodeId = null;
                        });
                        return d
                          .switchToStateAndFollow(
                            startWireState,
                            `wire-${wid}-to`,
                          )
                          .withInitContext({ anchorPos: Vec2(0) });
                      }}
                    />
                  </g>
                )}

                {/* Action input port */}
                {node.role === "action" && (
                  <g
                    id={`port-in-wrap-${node.id}`}
                    transform={translate(0, NODE_H / 2)}
                  >
                    <circle
                      id={`port-in-${node.id}`}
                      data-testid={`port-in-${node.id}`}
                      r={PORT_R + 2}
                      fill={isConnectCandidate ? "#10b981" : "#ffffff"}
                      stroke={isConnectCandidate ? "#059669" : "#3E63DD"}
                      strokeWidth={2.5}
                      style={{ cursor: "pointer" }}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (s.connectFromNodeId) {
                          setState(completeClickToConnect(s, node.id), {
                            transition: false,
                          });
                        }
                      }}
                    />
                  </g>
                )}
              </g>
            );
          })}

          {/* Connections (animated bezier paths + draggable endpoints) */}
          {Object.entries(s.connections).map(([wid, conn]) => {
            const sourceNode = s.nodes[conn.sourceNodeId];
            if (!sourceNode) return null;
            const from = outputPortPos(sourceNode);
            const to = connectionEndPos(s, conn);
            const dx = Math.max(Math.abs(to.x - from.x) * 0.45, 52);
            const pathD = `M${from.x},${from.y} C${from.x + dx},${from.y} ${to.x - dx},${to.y} ${to.x},${to.y}`;
            const isConnected = Boolean(conn.targetNodeId);
            const isDraggingWire =
              draggedId === `wire-${wid}-to` || !isConnected;

            return (
              <g
                id={`wire-${wid}`}
                data-testid={`wire-${wid}`}
                dragologyZIndex={isDraggingWire ? "/1" : 0}
              >
                <path
                  d={pathD}
                  fill="none"
                  stroke="#e0e7ff"
                  strokeWidth={5}
                  strokeLinecap="round"
                />
                <path
                  data-testid={`wire-path-${wid}`}
                  d={pathD}
                  fill="none"
                  stroke="#3E63DD"
                  strokeWidth={2.5}
                  strokeLinecap="round"
                  className={isConnected ? "wire-animated" : undefined}
                />
                <circle
                  id={`wire-${wid}-to`}
                  data-testid={`wire-end-${wid}`}
                  transform={translate(to.x, to.y)}
                  r={isConnected ? 8 : 7}
                  fill={isConnected ? "transparent" : "#3E63DD"}
                  stroke={isConnected ? "transparent" : "#ffffff"}
                  strokeWidth={isConnected ? 0 : 2}
                  style={{ cursor: "crosshair" }}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    setState(removeConnection(s, wid), { transition: false });
                  }}
                  dragologyOnDrag={() => endDragSpec(wid)}
                />
              </g>
            );
          })}
        </g>
      );
    },
    [onOpenInspector],
  );

  return (
    <div className="relative flex flex-1 items-center justify-center overflow-auto bg-zinc-50 p-4">
      <div
        className="rounded-xl border border-zinc-200 bg-white p-2 shadow-xs"
        style={{
          backgroundImage: "radial-gradient(#d4d4d8 1px, transparent 1px)",
          backgroundSize: "20px 20px",
          backgroundColor: "#fafafa",
        }}
      >
        <DraggableRenderer
          draggable={draggable}
          state={state}
          onDropState={onCommitState}
          width={SVG_WIDTH}
          height={SVG_HEIGHT}
        />
      </div>

      {/* Visually hidden accessible summary of the canvas */}
      <div className="sr-only-live" aria-live="polite">
        Canvas has {Object.keys(state.nodes).length} nodes and{" "}
        {
          Object.values(state.connections).filter(
            (c) => c.targetNodeId !== null,
          ).length
        }{" "}
        connections.
        {Object.values(state.nodes).map((n) => (
          <span key={n.id}>
            {" "}
            {APP_CATALOG[n.applicationId].name} ({n.role}) at {n.x}, {n.y}.
          </span>
        ))}
      </div>
    </div>
  );
};
