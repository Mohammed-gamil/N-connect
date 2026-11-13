import * as React from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  Check,
  Loader2,
  Play,
  Redo2,
  Save,
  Undo2,
} from "lucide-react";
import {
  Badge,
  Button,
  Card,
  Input,
  Skeleton,
  Switch,
  useToast,
} from "../../components/ui";
import { DEFAULT_APPS, getAppById, getAppRole } from "../../canvas/appMeta";
import {
  buildWorkflowSentence,
  fromWorkflowAndLayout,
  getActionNode,
  getTriggerNode,
  INITIAL_CANVAS_STATE,
  placeGuidedStepNode,
  removeNode,
  selectSlot,
  serializeCanvasToDraftWorkflow,
  setCanvasFilters,
  updateNodeConfig,
  updateNodeConnection,
  updateNodeEvent,
} from "../../canvas/canvasModel";
import { CanvasView } from "../../canvas/CanvasView";
import {
  canRedo,
  canUndo,
  createHistory,
  pushHistory,
  redoHistory,
  undoHistory,
} from "../../canvas/history";
import type { CanvasState, NodeRole } from "../../canvas/types";
import type {
  AppDefinition,
  AppId,
  Automation,
  AutomationStatus,
  ConfigValue,
  Connection,
  Filter,
  TestRunResult,
} from "../../contracts";
import { api, ApiClientError } from "../../lib/api";
import { GuidedPanel, type GuidedStep } from "./GuidedPanel";

const STATUS_BADGE: Record<
  AutomationStatus,
  { label: string; variant: "neutral" | "success" | "warning" | "danger" }
> = {
  draft: { label: "Draft", variant: "neutral" },
  active: { label: "Active", variant: "success" },
  paused: { label: "Paused", variant: "warning" },
  error: { label: "Needs attention", variant: "danger" },
};

function stepForNode(
  nodeId: string,
  state: CanvasState,
  apps: AppDefinition[],
): GuidedStep {
  const node = state.nodes[nodeId];
  if (!node) return 1;
  const app = getAppById(apps, node.applicationId);
  if (node.role === "trigger") {
    if (app.authKind !== "none" && !node.connectionId) return 2;
    return 3;
  }
  const httpNoAuth =
    node.applicationId === "http" &&
    (node.configuration.authType === "none" || !node.configuration.authType);
  if (app.authKind !== "none" && !node.connectionId && !httpNoAuth) return 5;
  return 6;
}

function stepForValidationField(fieldKey: string): GuidedStep {
  if (fieldKey.startsWith("trigger.connectionId")) return 2;
  if (fieldKey.startsWith("trigger.") || fieldKey.startsWith("filters")) return 3;
  if (fieldKey.startsWith("action.connectionId")) return 5;
  if (fieldKey.startsWith("action.")) return 6;
  return 7;
}

export function BuilderPage() {
  const { id } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { toast } = useToast();

  const [automationId, setAutomationId] = React.useState<string | undefined>(id);
  const [automationStatus, setAutomationStatus] =
    React.useState<AutomationStatus>("draft");
  const [name, setName] = React.useState("Untitled automation");
  const [apps, setApps] = React.useState<AppDefinition[]>(DEFAULT_APPS);
  const [connections, setConnections] = React.useState<Connection[]>([]);

  const [history, setHistory] = React.useState(() =>
    createHistory<CanvasState>(INITIAL_CANVAS_STATE),
  );
  const state = history.present;

  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const [advancedMode, setAdvancedMode] = React.useState(false);
  const [activeStep, setActiveStep] = React.useState<GuidedStep>(1);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>(
    {},
  );

  const [saveState, setSaveState] = React.useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [activating, setActivating] = React.useState(false);
  const [testingRun, setTestingRun] = React.useState(false);
  const [testRunResult, setTestRunResult] = React.useState<TestRunResult | null>(
    null,
  );

  const autosaveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const lastSavedSnapshotRef = React.useRef<{
    name: string;
    state: CanvasState;
  }>({ name: "Untitled automation", state: INITIAL_CANVAS_STATE });
  const isHydratedRef = React.useRef(false);
  const hasUserEditedRef = React.useRef(false);

  // Keep automationId synced with URL param
  React.useEffect(() => {
    setAutomationId(id);
  }, [id]);

  // Initial load: apps, connections, and existing automation if editing
  const loadInitialData = React.useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setLoadError(null);
      try {
        const [appsRes, connsRes, existing] = await Promise.all([
          api.listApps(signal).catch(() => ({ apps: DEFAULT_APPS })),
          api.listConnections(signal).catch(() => ({ connections: [] })),
          id ? api.getAutomation(id, signal) : Promise.resolve(null),
        ]);

        const loadedApps =
          appsRes.apps.length > 0 ? appsRes.apps : DEFAULT_APPS;
        setApps(loadedApps);
        setConnections(connsRes.connections);

        if (existing) {
          setAutomationId(existing.id);
          setAutomationStatus(existing.status);
          setName(existing.name);

          const initialCanvas = fromWorkflowAndLayout(existing, loadedApps);
          setHistory(createHistory(initialCanvas));
          lastSavedSnapshotRef.current = {
            name: existing.name,
            state: initialCanvas,
          };

          const usesAdvanced =
            existing.definition.trigger.application === "webhook" ||
            existing.definition.action.application === "http" ||
            (existing.definition.filters?.length ?? 0) > 0;
          if (usesAdvanced) {
            setAdvancedMode(true);
          }

          if (initialCanvas.selectedNodeId) {
            setActiveStep(
              stepForNode(initialCanvas.selectedNodeId, initialCanvas, loadedApps),
            );
          } else {
            setActiveStep(1);
          }
        } else {
          setAutomationStatus("draft");
          setName("Untitled automation");
          setHistory(createHistory(INITIAL_CANVAS_STATE));
          lastSavedSnapshotRef.current = {
            name: "Untitled automation",
            state: INITIAL_CANVAS_STATE,
          };
          setActiveStep(1);
        }

        hasUserEditedRef.current = false;
        isHydratedRef.current = true;
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setLoadError(
          err instanceof ApiClientError
            ? err.message
            : "We couldn't load this automation right now.",
        );
      } finally {
        setLoading(false);
      }
    },
    [id],
  );

  React.useEffect(() => {
    const controller = new AbortController();
    void loadInitialData(controller.signal);
    return () => controller.abort();
  }, [loadInitialData]);

  // Handle OAuth redirect back to /automations/:id?connected=...
  React.useEffect(() => {
    const connectedId = searchParams.get("connected");
    const connectError = searchParams.get("connectError");
    if (!connectedId && !connectError) return;

    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete("connected");
    nextParams.delete("connectError");
    setSearchParams(nextParams, { replace: true });

    if (connectError) {
      toast({
        title: "Account connection failed",
        description: "Please try connecting your account again.",
        variant: "error",
      });
      return;
    }

    if (connectedId) {
      api
        .listConnections()
        .then((res) => {
          setConnections(res.connections);
          const newlyConnected = res.connections.find(
            (c) => c.id === connectedId,
          );
          if (newlyConnected) {
            setHistory((prev) => {
              let next = prev.present;
              for (const node of Object.values(next.nodes)) {
                if (
                  node.applicationId === newlyConnected.applicationId &&
                  !node.connectionId
                ) {
                  next = updateNodeConnection(next, node.id, newlyConnected.id);
                }
              }
              return pushHistory(prev, next);
            });
            const app = getAppById(apps, newlyConnected.applicationId);
            setActiveStep(getAppRole(app) === "trigger" ? 3 : 6);
            toast({
              title: `${app.name} connected`,
              description: `Selected “${newlyConnected.displayName}”.`,
              variant: "success",
            });
          }
        })
        .catch(() => {
          // Ignore silent refresh error
        });
    }
  }, [apps, searchParams, setSearchParams, toast]);

  const commitState = React.useCallback(
    (nextOrUpdater: CanvasState | ((prev: CanvasState) => CanvasState)) => {
      hasUserEditedRef.current = true;
      setFieldErrors((prev) => (Object.keys(prev).length > 0 ? {} : prev));
      setHistory((prev) => {
        const next =
          typeof nextOrUpdater === "function"
            ? nextOrUpdater(prev.present)
            : nextOrUpdater;
        return pushHistory(prev, next);
      });
    },
    [],
  );

  const prevSelectionRef = React.useRef<{
    nodeId: string | null;
    slot: NodeRole | null;
  }>({ nodeId: null, slot: null });

  React.useEffect(() => {
    const prev = prevSelectionRef.current;
    if (state.selectedNodeId && state.selectedNodeId !== prev.nodeId) {
      setActiveStep(stepForNode(state.selectedNodeId, state, apps));
    } else if (state.selectedSlot && state.selectedSlot !== prev.slot) {
      setActiveStep(state.selectedSlot === "trigger" ? 1 : 4);
    }
    prevSelectionRef.current = {
      nodeId: state.selectedNodeId,
      slot: state.selectedSlot,
    };
  }, [state, apps]);

  const handleUndo = React.useCallback(() => {
    hasUserEditedRef.current = true;
    setHistory((prev) => undoHistory(prev));
  }, []);

  const handleRedo = React.useCallback(() => {
    hasUserEditedRef.current = true;
    setHistory((prev) => redoHistory(prev));
  }, []);

  // Keyboard shortcuts: Cmd/Ctrl+Z and Shift+Cmd/Ctrl+Z
  React.useEffect(() => {
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

  const persistDraft = React.useCallback(
    async (
      targetState: CanvasState,
      targetName: string,
      options: { rollbackOnFailure?: boolean; silent?: boolean } = {},
    ): Promise<Automation | null> => {
      const payload = serializeCanvasToDraftWorkflow(targetState);
      if (!payload) {
        if (!options.silent) {
          toast({
            title: "Add a step first",
            description: "Pick a trigger or action app before saving.",
            variant: "error",
          });
        }
        return null;
      }

      const trimmedName = targetName.trim() || "Untitled automation";
      setSaveState("saving");

      try {
        const saved = automationId
          ? await api.updateAutomation(automationId, {
              name: trimmedName,
              definition: payload.definition,
              layout: payload.layout,
            })
          : await api.createAutomation({
              name: trimmedName,
              definition: payload.definition,
              layout: payload.layout,
            });

        setAutomationId(saved.id);
        setAutomationStatus(saved.status);
        lastSavedSnapshotRef.current = {
          name: trimmedName,
          state: targetState,
        };
        setSaveState("saved");

        if (!automationId) {
          navigate(`/automations/${saved.id}`, { replace: true });
        }
        return saved;
      } catch (err) {
        setSaveState("error");

        if (options.rollbackOnFailure) {
          const rollback = lastSavedSnapshotRef.current;
          setName(rollback.name);
          setHistory((prev) => pushHistory(prev, rollback.state));
        }

        if (err instanceof ApiClientError && err.fields) {
          setFieldErrors(err.fields);
        }

        toast({
          title: "Couldn't save draft",
          description:
            err instanceof ApiClientError
              ? err.message
              : "Changes were reverted. Please try again.",
          variant: "error",
        });
        return null;
      }
    },
    [automationId, navigate, toast],
  );

  // Debounced draft autosave on committed edits
  React.useEffect(() => {
    if (!isHydratedRef.current || loading || !hasUserEditedRef.current) {
      return;
    }
    // Autosave only for drafts (or creating a draft on first change)
    if (automationId && automationStatus !== "draft") {
      return;
    }
    const draftPayload = serializeCanvasToDraftWorkflow(state);
    if (!draftPayload) return;

    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
    }

    autosaveTimerRef.current = setTimeout(() => {
      void persistDraft(state, name, {
        rollbackOnFailure: true,
        silent: true,
      });
    }, 900);

    return () => {
      if (autosaveTimerRef.current) {
        clearTimeout(autosaveTimerRef.current);
      }
    };
  }, [automationId, automationStatus, loading, name, persistDraft, state]);

  async function handleManualSave() {
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    const saved = await persistDraft(state, name);
    if (saved) {
      toast({
        title: "Automation saved",
        description: `Saved “${saved.name}”.`,
        variant: "success",
        durationMs: 2500,
      });
    }
  }

  async function handleEnsureSavedDraft(): Promise<string | null> {
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    if (automationId && !hasUserEditedRef.current) {
      return automationId;
    }
    const saved = await persistDraft(state, name);
    return saved?.id ?? automationId ?? null;
  }

  async function handleStartOAuth(appId: AppId) {
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }

    let returnTo = automationId ? `/automations/${automationId}` : "/automations/new";
    if (!automationId && serializeCanvasToDraftWorkflow(state)) {
      const saved = await persistDraft(state, name, { silent: true });
      if (saved) {
        returnTo = `/automations/${saved.id}`;
      }
    }

    try {
      const { redirectUrl } = await api.startOAuth(appId, returnTo);
      window.location.assign(redirectUrl);
    } catch (err) {
      toast({
        title: `Couldn't start ${getAppById(apps, appId).name} OAuth`,
        description:
          err instanceof ApiClientError
            ? err.message
            : "Please try again in a moment.",
        variant: "error",
      });
    }
  }

  async function handleActivateOrPause() {
    if (activating) return;
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }

    setActivating(true);
    setFieldErrors({});
    const previousStatus = automationStatus;

    try {
      if (automationStatus === "active" && automationId) {
        setAutomationStatus("paused");
        const paused = await api.pauseAutomation(automationId);
        setAutomationStatus(paused.status);
        toast({
          title: "Automation paused",
          description: `“${paused.name}” will no longer run on new events.`,
          variant: "success",
        });
        return;
      }

      const saved = await persistDraft(state, name);
      if (!saved) return;

      // Optimistically set active
      setAutomationStatus("active");
      const activated = await api.activateAutomation(saved.id);
      setAutomationStatus(activated.status);
      toast({
        title: "Automation activated",
        description: `“${activated.name}” is now live.`,
        variant: "success",
      });
    } catch (err) {
      setAutomationStatus(previousStatus);
      if (err instanceof ApiClientError) {
        if (err.fields) {
          setFieldErrors(err.fields);
          const firstField = Object.keys(err.fields)[0];
          if (firstField) {
            setActiveStep(stepForValidationField(firstField));
          }
        }
        toast({
          title: "Couldn't activate automation",
          description: err.message,
          variant: "error",
        });
      } else {
        toast({
          title: "Couldn't activate automation",
          description: "Please check all required steps and try again.",
          variant: "error",
        });
      }
    } finally {
      setActivating(false);
    }
  }

  async function handleTestRun() {
    if (testingRun) return;
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }

    setTestingRun(true);
    setTestRunResult(null);
    try {
      const saved = await persistDraft(state, name);
      if (!saved) return;
      const res = await api.testAutomation(saved.id);
      setTestRunResult(res);
      toast({
        title: res.ok ? "Test run succeeded" : "Test run failed",
        description: res.message,
        variant: res.ok ? "success" : "error",
      });
    } catch (err) {
      const message =
        err instanceof ApiClientError
          ? err.message
          : "Test run failed. Check your configuration and try again.";
      setTestRunResult({ ok: false, message, usedSampleData: true });
      toast({
        title: "Test run failed",
        description: message,
        variant: "error",
      });
    } finally {
      setTestingRun(false);
    }
  }

  function handleSelectGuidedApp(appId: AppId) {
    const app = getAppById(apps, appId);
    const matchingConn = connections.find(
      (c) => c.applicationId === appId && c.status === "connected",
    );
    hasUserEditedRef.current = true;
    setFieldErrors({});
    setHistory((prev) =>
      pushHistory(
        prev,
        placeGuidedStepNode(
          prev.present,
          appId,
          apps,
          matchingConn?.id ?? null,
        ),
      ),
    );

    const role = getAppRole(app);
    if (role === "trigger") {
      setActiveStep(app.authKind !== "none" && !matchingConn ? 2 : 3);
    } else {
      const isHttpNoAuth = appId === "http";
      setActiveStep(
        app.authKind !== "none" && !matchingConn && !isHttpNoAuth ? 5 : 6,
      );
    }
  }

  function handleRemoveNode(nodeId: string) {
    const node = state.nodes[nodeId];
    commitState((prev) => removeNode(prev, nodeId));
    if (node) {
      setActiveStep(node.role === "trigger" ? 1 : 4);
    }
  }

  function handleSelectSlot(role: NodeRole) {
    commitState((prev) => selectSlot(prev, role));
    setActiveStep(role === "trigger" ? 1 : 4);
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-14 w-full rounded-xl" />
        <div className="grid gap-4 lg:grid-cols-[1fr_400px]">
          <Skeleton className="h-[520px] w-full rounded-xl" />
          <Skeleton className="h-[520px] w-full rounded-xl" />
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <Card className="p-6">
        <p className="text-sm font-medium text-ink">Unable to load builder</p>
        <p className="mt-1 text-sm text-ink-secondary">{loadError}</p>
        <div className="mt-4 flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void loadInitialData()}>
            Try again
          </Button>
          <Link to="/">
            <Button variant="ghost" size="sm">
              Back to Dashboard
            </Button>
          </Link>
        </div>
      </Card>
    );
  }

  const badge = STATUS_BADGE[automationStatus];
  const triggerNode = getTriggerNode(state);
  const actionNode = getActionNode(state);

  return (
    <div className="flex flex-col gap-4">
      {/* Builder Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface px-4 py-3 shadow-2xs">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Link to="/">
            <Button variant="ghost" size="sm" aria-label="Back to Dashboard">
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            </Button>
          </Link>

          <Input
            aria-label="Automation name"
            data-testid="automation-name-input"
            value={name}
            onChange={(e) => {
              hasUserEditedRef.current = true;
              setName(e.target.value);
            }}
            className="h-9 max-w-xs font-semibold"
          />

          <Badge variant={badge.variant}>{badge.label}</Badge>

          {saveState === "saving" && (
            <span className="hidden items-center gap-1 text-xs text-ink-muted sm:inline-flex">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
              Saving...
            </span>
          )}
          {saveState === "saved" && (
            <span className="hidden items-center gap-1 text-xs text-ink-muted sm:inline-flex">
              <Check className="h-3 w-3 text-success" aria-hidden="true" />
              Saved
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Advanced mode switch (OFF by default) */}
          <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-subtle/50 px-2.5 py-1.5 text-xs font-medium text-ink-secondary">
            <span>Advanced mode</span>
            <Switch
              aria-label="Advanced mode"
              checked={advancedMode}
              onCheckedChange={setAdvancedMode}
            />
          </label>

          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              data-testid="undo-btn"
              aria-label="Undo"
              disabled={!canUndo(history)}
              onClick={handleUndo}
              title="Undo (Cmd/Ctrl+Z)"
            >
              <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              data-testid="redo-btn"
              aria-label="Redo"
              disabled={!canRedo(history)}
              onClick={handleRedo}
              title="Redo (Shift+Cmd/Ctrl+Z)"
            >
              <Redo2 className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          </div>

          <Button
            variant="outline"
            size="sm"
            loading={saveState === "saving"}
            onClick={() => void handleManualSave()}
          >
            <Save className="h-3.5 w-3.5" aria-hidden="true" />
            Save
          </Button>

          <Button
            variant="outline"
            size="sm"
            loading={testingRun}
            disabled={!triggerNode || !actionNode}
            onClick={() => void handleTestRun()}
          >
            <Play className="h-3.5 w-3.5" aria-hidden="true" />
            Test run
          </Button>

          <Button
            variant={automationStatus === "active" ? "secondary" : "primary"}
            size="sm"
            loading={activating}
            onClick={() => void handleActivateOrPause()}
          >
            {automationStatus === "active" ? "Pause" : "Activate automation"}
          </Button>
        </div>
      </div>

      {/* Natural-language preview bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-surface px-4 py-2.5 text-xs">
        <div
          data-testid="sentence-preview"
          className="flex items-center gap-2 font-medium text-ink"
        >
          <span
            className={`h-2 w-2 rounded-full ${
              triggerNode && actionNode ? "bg-success" : "bg-warning"
            }`}
          />
          <span>{buildWorkflowSentence(state, apps)}</span>
        </div>
        <span className="text-[11px] text-ink-muted">
          Click any step or drag apps on the canvas · Arrow keys nudge · Del removes
        </span>
      </div>

      {/* Main Split View: Dragology Canvas + Guided Panel */}
      <div className="flex min-h-[540px] flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-2xs lg:min-h-[calc(100vh-14rem)] lg:flex-row">
        <div className="flex min-w-0 flex-1 flex-col">
          <CanvasView
            state={state}
            apps={apps}
            connections={connections}
            advancedMode={advancedMode}
            onCommitState={commitState}
            onSelectSlot={handleSelectSlot}
            onOpenInspector={() => {
              if (state.selectedNodeId) {
                setActiveStep(stepForNode(state.selectedNodeId, state, apps));
              }
            }}
          />
        </div>

        <GuidedPanel
          automationId={automationId}
          automationStatus={automationStatus}
          state={state}
          apps={apps}
          connections={connections}
          advancedMode={advancedMode}
          activeStep={activeStep}
          fieldErrors={fieldErrors}
          activating={activating}
          testingRun={testingRun}
          testRunResult={testRunResult}
          onStepChange={setActiveStep}
          onSelectApp={handleSelectGuidedApp}
          onChangeNodeEvent={(nodeId, ev) =>
            commitState((prev) => updateNodeEvent(prev, nodeId, ev))
          }
          onChangeNodeConnection={(nodeId, cid) =>
            commitState((prev) => updateNodeConnection(prev, nodeId, cid))
          }
          onChangeNodeConfig={(nodeId, key, value: ConfigValue) =>
            commitState((prev) => updateNodeConfig(prev, nodeId, key, value))
          }
          onChangeFilters={(filters: Filter[]) =>
            commitState((prev) => setCanvasFilters(prev, filters))
          }
          onRemoveNode={handleRemoveNode}
          onStartOAuth={handleStartOAuth}
          onConnectionCreated={(conn) =>
            setConnections((prev) => [conn, ...prev])
          }
          onEnsureSavedDraft={handleEnsureSavedDraft}
          onActivateOrPause={handleActivateOrPause}
          onTestRun={handleTestRun}
        />
      </div>
    </div>
  );
}
