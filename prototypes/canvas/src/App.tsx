import { useCallback, useEffect, useMemo, useState } from "react";
import { CanvasView } from "./CanvasView";
import {
  addNodeToSlot,
  buildWorkflowSentence,
  cancelClickToConnect,
  INITIAL_CANVAS_STATE,
  removeConnection,
  removeNode,
  serializeCanvasToWorkflow,
  startClickToConnect,
  updateNodeConfig,
  updateNodeEvent,
} from "./canvasModel";
import { APP_CATALOG, APP_ORDER } from "./catalog";
import {
  canRedo,
  canUndo,
  createHistory,
  pushHistory,
  redoHistory,
  undoHistory,
} from "./history";
import { InspectorPanel } from "./InspectorPanel";
import type { AppId, CanvasState, ConfigValue } from "./types";

export function App() {
  const [history, setHistory] = useState(() =>
    createHistory<CanvasState>(INITIAL_CANVAS_STATE),
  );
  const [showJson, setShowJson] = useState(false);

  const state = history.present;

  const commitState = useCallback((next: CanvasState) => {
    setHistory((prev) => pushHistory(prev, next));
  }, []);

  const handleUndo = useCallback(() => {
    setHistory((prev) => undoHistory(prev));
  }, []);

  const handleRedo = useCallback(() => {
    setHistory((prev) => redoHistory(prev));
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isTextInput =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT";
      if (isTextInput) return;

      const isMod = e.metaKey || e.ctrlKey;
      if (!isMod) return;

      if (e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
      } else if (
        (e.key.toLowerCase() === "z" && e.shiftKey) ||
        e.key.toLowerCase() === "y"
      ) {
        e.preventDefault();
        handleRedo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleUndo, handleRedo]);

  const selectedNode = state.selectedNodeId
    ? (state.nodes[state.selectedNodeId] ?? null)
    : null;

  const sentence = useMemo(() => buildWorkflowSentence(state), [state]);
  const serialized = useMemo(() => serializeCanvasToWorkflow(state), [state]);

  const handleAddClick = (appId: AppId) => {
    commitState(addNodeToSlot(state, appId));
  };

  const handleChangeEvent = (nodeId: string, event: string) => {
    commitState(updateNodeEvent(state, nodeId, event));
  };

  const handleChangeConfig = (
    nodeId: string,
    key: string,
    value: ConfigValue,
  ) => {
    commitState(updateNodeConfig(state, nodeId, key, value));
  };

  return (
    <div className="flex h-screen flex-col bg-zinc-50 text-zinc-900">
      {/* Top Bar */}
      <header className="flex items-center justify-between border-b border-zinc-200 bg-white px-5 py-3">
        <div className="flex items-center gap-3">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-indigo-600 text-xs font-bold text-white">
            N
          </div>
          <div>
            <h1 className="text-sm font-semibold tracking-tight text-zinc-900">
              Integration Hub — Canvas Prototype
            </h1>
            <p className="text-[11px] text-zinc-500">
              Dragology 0.2.0 interactive workflow prototype
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="undo-btn"
            disabled={!canUndo(history)}
            onClick={handleUndo}
            title="Undo (Cmd+Z)"
            className="rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Undo
          </button>
          <button
            type="button"
            data-testid="redo-btn"
            disabled={!canRedo(history)}
            onClick={handleRedo}
            title="Redo (Shift+Cmd+Z)"
            className="rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Redo
          </button>
          <div className="mx-1 h-4 w-px bg-zinc-200" />
          <button
            type="button"
            data-testid="toggle-json-btn"
            onClick={() => setShowJson((v) => !v)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
              showJson
                ? "bg-indigo-600 text-white"
                : "border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50"
            }`}
          >
            Workflow JSON
          </button>
        </div>
      </header>

      {/* Sentence Preview & Click-to-Add Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 bg-white px-5 py-2.5">
        <div
          data-testid="sentence-preview"
          className="flex items-center gap-2 text-xs font-medium text-zinc-800"
        >
          <span
            className={`h-2 w-2 rounded-full ${
              serialized ? "bg-emerald-500" : "bg-amber-400"
            }`}
          />
          <span>{sentence}</span>
        </div>

        <div className="flex items-center gap-1.5">
          <span className="mr-1 text-[11px] font-medium text-zinc-500">
            Quick add:
          </span>
          {APP_ORDER.map((appId) => {
            const entry = APP_CATALOG[appId];
            return (
              <button
                key={appId}
                type="button"
                data-testid={`quick-add-${appId}`}
                onClick={() => handleAddClick(appId)}
                className="rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-1 text-xs font-medium text-zinc-700 transition hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700"
              >
                + {entry.name}
              </button>
            );
          })}
        </div>
      </div>

      {/* Main Content */}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <CanvasView
            state={state}
            onCommitState={commitState}
            onOpenInspector={() => {
              // Focus inspector event select when Enter is pressed on a node
              const el = document.getElementById("node-event-select");
              el?.focus();
            }}
          />

          {showJson && (
            <section
              data-testid="workflow-json-panel"
              className="max-h-60 overflow-auto border-t border-zinc-200 bg-zinc-950 p-4 text-zinc-100"
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                  Serialized WorkflowDefinitionV1 + AutomationLayout
                </span>
                <span className="text-[11px] text-zinc-400">
                  {serialized ? "Valid v1 workflow" : "Incomplete (connect trigger -> action)"}
                </span>
              </div>
              <pre
                data-testid="workflow-json-output"
                className="font-mono text-xs leading-relaxed text-emerald-300"
              >
                {serialized
                  ? JSON.stringify(serialized, null, 2)
                  : JSON.stringify(
                      {
                        status: "incomplete",
                        nodesCount: Object.keys(state.nodes).length,
                        connectionsCount: Object.keys(state.connections).length,
                      },
                      null,
                      2,
                    )}
              </pre>
            </section>
          )}
        </div>

        <InspectorPanel
          state={state}
          selectedNode={selectedNode}
          onChangeEvent={handleChangeEvent}
          onChangeConfig={handleChangeConfig}
          onStartConnect={(id) => commitState(startClickToConnect(state, id))}
          onCancelConnect={() => commitState(cancelClickToConnect(state))}
          onDisconnect={(cid) => commitState(removeConnection(state, cid))}
          onDeleteNode={(id) => commitState(removeNode(state, id))}
        />
      </div>
    </div>
  );
}

export default App;
