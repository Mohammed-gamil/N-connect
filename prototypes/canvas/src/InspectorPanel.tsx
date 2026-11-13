import React, { useRef } from "react";
import { APP_CATALOG, type VariableSpec } from "./catalog";
import type {
  ApplicationNode,
  CanvasState,
  ConfigValue,
} from "./types";

interface InspectorPanelProps {
  state: CanvasState;
  selectedNode: ApplicationNode | null;
  onChangeEvent: (nodeId: string, event: string) => void;
  onChangeConfig: (nodeId: string, key: string, value: ConfigValue) => void;
  onStartConnect: (nodeId: string) => void;
  onCancelConnect: () => void;
  onDisconnect: (connectionId: string) => void;
  onDeleteNode: (nodeId: string) => void;
}

function getAvailableVariables(
  state: CanvasState,
  actionNode: ApplicationNode,
): VariableSpec[] {
  const incoming = Object.values(state.connections).find(
    (c) => c.targetNodeId === actionNode.id,
  );
  if (incoming && state.nodes[incoming.sourceNodeId]) {
    return APP_CATALOG[state.nodes[incoming.sourceNodeId].applicationId]
      .variables;
  }
  const anyTrigger = Object.values(state.nodes).find(
    (n) => n.role === "trigger",
  );
  if (anyTrigger) {
    return APP_CATALOG[anyTrigger.applicationId].variables;
  }
  return APP_CATALOG.clickup.variables;
}

export const InspectorPanel: React.FC<InspectorPanelProps> = ({
  state,
  selectedNode,
  onChangeEvent,
  onChangeConfig,
  onStartConnect,
  onCancelConnect,
  onDisconnect,
  onDeleteNode,
}) => {
  const textareaRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});

  if (!selectedNode) {
    return (
      <aside
        data-testid="inspector-panel"
        className="flex w-88 shrink-0 flex-col border-l border-zinc-200 bg-white p-5"
      >
        <div className="mb-4">
          <h2 className="text-sm font-semibold text-zinc-900">
            Step configuration
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-zinc-500">
            Select a node on the canvas to configure its trigger, action, or
            message template.
          </p>
        </div>

        <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3.5 text-xs text-zinc-600">
          <div className="font-medium text-zinc-800">Interactions</div>
          <ul className="mt-2 space-y-1.5 leading-relaxed">
            <li>• Drag an app chip into When / Then slots or anywhere on canvas</li>
            <li>• Drag a node to move (20px grid snap)</li>
            <li>• Drag from a trigger output port to an action input port</li>
            <li>• Use Arrow keys to nudge a selected node, Tab to cycle</li>
          </ul>
        </div>
      </aside>
    );
  }

  const entry = APP_CATALOG[selectedNode.applicationId];
  const activeConnection = Object.values(state.connections).find(
    (c) =>
      c.targetNodeId !== null &&
      (c.sourceNodeId === selectedNode.id || c.targetNodeId === selectedNode.id),
  );
  const isConnectingFromThis = state.connectFromNodeId === selectedNode.id;
  const availableVariables =
    selectedNode.role === "action"
      ? getAvailableVariables(state, selectedNode)
      : [];

  const insertVariable = (fieldKey: string, variablePath: string) => {
    const token = `{{${variablePath}}}`;
    const current =
      typeof selectedNode.configuration[fieldKey] === "string"
        ? (selectedNode.configuration[fieldKey] as string)
        : "";
    const el = textareaRefs.current[fieldKey];
    if (
      el &&
      document.activeElement === el &&
      typeof el.selectionStart === "number"
    ) {
      const start = el.selectionStart;
      const end = el.selectionEnd ?? start;
      const next = `${current.slice(0, start)}${token}${current.slice(end)}`;
      onChangeConfig(selectedNode.id, fieldKey, next);
      requestAnimationFrame(() => {
        el.focus();
        const cursor = start + token.length;
        el.setSelectionRange(cursor, cursor);
      });
      return;
    }
    const separator = current.length > 0 && !current.endsWith(" ") ? " " : "";
    onChangeConfig(
      selectedNode.id,
      fieldKey,
      `${current}${separator}${token}`,
    );
  };

  return (
    <aside
      data-testid="inspector-panel"
      className="flex w-88 shrink-0 flex-col overflow-y-auto border-l border-zinc-200 bg-white p-5"
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3 border-b border-zinc-100 pb-4">
        <div className="flex items-center gap-2.5">
          <div
            className="flex h-9 w-9 items-center justify-center rounded-lg text-xs font-bold"
            style={{ backgroundColor: entry.badgeBg, color: entry.badgeText }}
          >
            {entry.shortTag}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-zinc-900">
                {entry.name}
              </h2>
              <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-600">
                {selectedNode.role}
              </span>
            </div>
            <div className="text-xs text-zinc-500">
              Position ({selectedNode.x}, {selectedNode.y})
            </div>
          </div>
        </div>
        <button
          type="button"
          data-testid="delete-node-btn"
          onClick={() => onDeleteNode(selectedNode.id)}
          className="rounded-md border border-zinc-200 px-2 py-1 text-xs font-medium text-zinc-600 transition hover:border-red-200 hover:bg-red-50 hover:text-red-600"
        >
          Remove
        </button>
      </div>

      {/* Connection controls */}
      <div className="mt-4 rounded-lg border border-zinc-200 bg-zinc-50 p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-zinc-700">Connection</span>
          {activeConnection && activeConnection.targetNodeId && (
            <button
              type="button"
              data-testid="disconnect-btn"
              onClick={() => onDisconnect(activeConnection.id)}
              className="text-xs font-medium text-zinc-500 hover:text-red-600"
            >
              Disconnect
            </button>
          )}
        </div>

        {selectedNode.role === "trigger" ? (
          <div className="mt-2">
            {activeConnection && activeConnection.targetNodeId && state.nodes[activeConnection.targetNodeId] ? (
              <div className="text-xs text-zinc-600">
                Connected to{" "}
                <span className="font-medium text-zinc-900">
                  {
                    APP_CATALOG[
                      state.nodes[activeConnection.targetNodeId].applicationId
                    ].name
                  }
                </span>
              </div>
            ) : (
              <div className="text-xs text-zinc-500">
                Not connected to an action yet.
              </div>
            )}

            <button
              type="button"
              data-testid="connect-to-btn"
              onClick={() =>
                isConnectingFromThis
                  ? onCancelConnect()
                  : onStartConnect(selectedNode.id)
              }
              className={`mt-2.5 w-full rounded-md px-3 py-1.5 text-xs font-medium transition ${
                isConnectingFromThis
                  ? "bg-indigo-600 text-white hover:bg-indigo-700"
                  : "border border-zinc-200 bg-white text-zinc-800 hover:bg-zinc-100"
              }`}
            >
              {isConnectingFromThis
                ? "Click target action node... (Cancel)"
                : "Connect to..."}
            </button>
          </div>
        ) : (
          <div className="mt-1.5 text-xs text-zinc-600">
            {activeConnection && state.nodes[activeConnection.sourceNodeId]
              ? `Receives events from ${APP_CATALOG[state.nodes[activeConnection.sourceNodeId].applicationId].name}`
              : "Waiting for a trigger connection"}
          </div>
        )}
      </div>

      {/* Event select */}
      <div className="mt-4">
        <label
          htmlFor="node-event-select"
          className="block text-xs font-medium text-zinc-700"
        >
          {selectedNode.role === "trigger" ? "Trigger event" : "Action event"}
        </label>
        <select
          id="node-event-select"
          data-testid="node-event-select"
          value={selectedNode.event}
          onChange={(e) => onChangeEvent(selectedNode.id, e.target.value)}
          className="mt-1.5 w-full rounded-lg border border-zinc-200 bg-white px-2.5 py-2 text-xs text-zinc-900 shadow-2xs focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
        >
          {entry.events.map((ev) => (
            <option key={ev.id} value={ev.id}>
              {ev.label}
            </option>
          ))}
        </select>
      </div>

      {/* Dynamic configuration fields */}
      <div className="mt-4 space-y-4">
        {entry.fields.map((field) => {
          const rawVal = selectedNode.configuration[field.key];

          if (field.type === "dynamic_select") {
            const currentValue =
              rawVal && typeof rawVal === "object" && !Array.isArray(rawVal)
                ? rawVal.value
                : "";
            return (
              <div key={field.key}>
                <label
                  htmlFor={`field-${field.key}`}
                  className="block text-xs font-medium text-zinc-700"
                >
                  {field.label}
                </label>
                <select
                  id={`field-${field.key}`}
                  data-testid={`field-${field.key}`}
                  value={currentValue}
                  onChange={(e) => {
                    const selectedOpt = field.options?.find(
                      (o) => o.value === e.target.value,
                    );
                    if (!selectedOpt || selectedOpt.value === "") {
                      onChangeConfig(selectedNode.id, field.key, null);
                    } else {
                      onChangeConfig(selectedNode.id, field.key, {
                        value: selectedOpt.value,
                        label: selectedOpt.label,
                      });
                    }
                  }}
                  className="mt-1.5 w-full rounded-lg border border-zinc-200 bg-white px-2.5 py-2 text-xs text-zinc-900 shadow-2xs focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                >
                  {field.options?.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            );
          }

          if (field.type === "select") {
            const currentValue = typeof rawVal === "string" ? rawVal : "";
            return (
              <div key={field.key}>
                <label
                  htmlFor={`field-${field.key}`}
                  className="block text-xs font-medium text-zinc-700"
                >
                  {field.label}
                </label>
                <select
                  id={`field-${field.key}`}
                  data-testid={`field-${field.key}`}
                  value={currentValue}
                  onChange={(e) =>
                    onChangeConfig(selectedNode.id, field.key, e.target.value)
                  }
                  className="mt-1.5 w-full rounded-lg border border-zinc-200 bg-white px-2.5 py-2 text-xs text-zinc-900 shadow-2xs focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                >
                  {field.options?.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            );
          }

          const textVal = typeof rawVal === "string" ? rawVal : "";
          return (
            <div key={field.key}>
              <label
                htmlFor={`field-${field.key}`}
                className="block text-xs font-medium text-zinc-700"
              >
                {field.label}
              </label>
              <textarea
                id={`field-${field.key}`}
                data-testid={`field-${field.key}`}
                ref={(el) => {
                  textareaRefs.current[field.key] = el;
                }}
                rows={3}
                value={textVal}
                placeholder={field.placeholder}
                onChange={(e) =>
                  onChangeConfig(selectedNode.id, field.key, e.target.value)
                }
                className="mt-1.5 w-full rounded-lg border border-zinc-200 bg-white px-2.5 py-2 text-xs text-zinc-900 shadow-2xs focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
              />

              {availableVariables.length > 0 && (
                <div className="mt-2">
                  <div className="text-[11px] font-medium text-zinc-500">
                    Insert variable
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {availableVariables.map((v) => (
                      <button
                        key={v.path}
                        type="button"
                        data-testid={`var-chip-${v.path}`}
                        onClick={() => insertVariable(field.key, v.path)}
                        className="rounded-md border border-indigo-200 bg-indigo-50 px-2 py-0.5 font-mono text-[11px] text-indigo-700 transition hover:bg-indigo-100"
                        title={`Example: ${v.example}`}
                      >
                        {`{{${v.path}}}`}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
};
