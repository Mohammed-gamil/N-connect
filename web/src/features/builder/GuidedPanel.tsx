import * as React from "react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ExternalLink,
  KeyRound,
  Play,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
} from "lucide-react";
import { AppIcon } from "../../components/AppIcon";
import {
  Badge,
  Button,
  Input,
  Label,
  useToast,
} from "../../components/ui";
import type {
  AppDefinition,
  AppId,
  AutomationStatus,
  ConfigValue,
  Connection,
  FieldDefinition,
  FieldOption,
  Filter,
  OAuthAppConfigStatus,
  TestRunResult,
  VariableDefinition,
} from "../../contracts";
import {
  buildWorkflowSentence,
  getActionNode,
  getTriggerNode,
} from "../../canvas/canvasModel";
import { getAppById, getTriggerVariables, getVisibleApps } from "../../canvas/appMeta";
import type { ApplicationNode, CanvasState } from "../../canvas/types";
import { api, ApiClientError } from "../../lib/api";
import { OAuthAppSetupDialog } from "../connections/OAuthAppSetupDialog";
import { TOKEN_CONNECT_META, TokenGuideBox } from "../connections/TokenGuideBox";
import { FilterEditor } from "./FilterEditor";
import { HttpActionSection } from "./HttpActionSection";
import { insertVariableIntoInput, VariableChips } from "./VariableChips";
import { WebhookSection } from "./WebhookSection";

export type GuidedStep = 1 | 2 | 3 | 4 | 5 | 6 | 7;

const STEP_LABELS: { step: GuidedStep; short: string; title: string }[] = [
  { step: 1, short: "Trigger", title: "What should start this automation?" },
  { step: 2, short: "Account", title: "Connect your trigger account" },
  { step: 3, short: "Event", title: "What event should trigger this?" },
  { step: 4, short: "Action", title: "What should happen next?" },
  { step: 5, short: "Account", title: "Connect your action account" },
  { step: 6, short: "Configure", title: "Configure your action" },
  { step: 7, short: "Review", title: "Review & Activate" },
];

export interface GuidedPanelProps {
  automationId?: string;
  automationStatus: AutomationStatus;
  state: CanvasState;
  apps: AppDefinition[];
  connections: Connection[];
  oauthApps?: OAuthAppConfigStatus[];
  advancedMode: boolean;
  activeStep: GuidedStep;
  fieldErrors: Record<string, string>;
  activating: boolean;
  testingRun: boolean;
  testRunResult: TestRunResult | null;
  onStepChange: (step: GuidedStep) => void;
  onSelectApp: (appId: AppId) => void;
  onChangeNodeEvent: (nodeId: string, event: string) => void;
  onChangeNodeConnection: (nodeId: string, connectionId: string | null) => void;
  onChangeNodeConfig: (nodeId: string, key: string, value: ConfigValue) => void;
  onChangeFilters: (filters: Filter[]) => void;
  onRemoveNode: (nodeId: string) => void;
  onStartOAuth: (appId: AppId) => Promise<void>;
  onOAuthAppUpdated?: (updated: OAuthAppConfigStatus) => void;
  onConnectionCreated: (conn: Connection) => void;
  onEnsureSavedDraft: () => Promise<string | null>;
  onActivateOrPause: () => Promise<void>;
  onTestRun: () => Promise<void>;
}

function getConfigStringOrValue(val: ConfigValue | undefined): string {
  if (!val) return "";
  if (typeof val === "string") return val;
  if (!Array.isArray(val) && typeof val === "object") return val.value;
  return "";
}

export const GuidedPanel: React.FC<GuidedPanelProps> = ({
  automationId,
  automationStatus,
  state,
  apps,
  connections,
  oauthApps = [],
  advancedMode,
  activeStep,
  fieldErrors,
  activating,
  testingRun,
  testRunResult,
  onStepChange,
  onSelectApp,
  onChangeNodeEvent,
  onChangeNodeConnection,
  onChangeNodeConfig,
  onChangeFilters,
  onRemoveNode,
  onStartOAuth,
  onOAuthAppUpdated,
  onConnectionCreated,
  onEnsureSavedDraft,
  onActivateOrPause,
  onTestRun,
}) => {
  const { toast } = useToast();

  const [appSearch, setAppSearch] = React.useState("");
  const [showTokenForm, setShowTokenForm] = React.useState(false);
  const [tokenLabel, setTokenLabel] = React.useState("");
  const [tokenSecret, setTokenSecret] = React.useState("");
  const [savingToken, setSavingToken] = React.useState(false);
  const [oauthBusyApp, setOauthBusyApp] = React.useState<AppId | null>(null);
  const [oauthSetupAppId, setOauthSetupAppId] = React.useState<
    "clickup" | "slack" | null
  >(null);

  const [dynamicOptions, setDynamicOptions] = React.useState<
    Record<string, { loading: boolean; options: FieldOption[]; error?: string }>
  >({});
  const [discoveredWebhookVars, setDiscoveredWebhookVars] = React.useState<
    VariableDefinition[]
  >([]);

  const templateRefs = React.useRef<Record<string, HTMLTextAreaElement | null>>({});

  const triggerNode = getTriggerNode(state);
  const actionNode = getActionNode(state);

  const triggerApp = triggerNode
    ? getAppById(apps, triggerNode.applicationId)
    : null;
  const actionApp = actionNode
    ? getAppById(apps, actionNode.applicationId)
    : null;

  const visibleApps = React.useMemo(
    () => getVisibleApps(apps, advancedMode),
    [apps, advancedMode],
  );

  const triggerApps = React.useMemo(
    () =>
      visibleApps.filter(
        (a) =>
          a.triggers.length > 0 &&
          a.name.toLowerCase().includes(appSearch.trim().toLowerCase()),
      ),
    [visibleApps, appSearch],
  );

  const actionApps = React.useMemo(
    () =>
      visibleApps.filter(
        (a) =>
          a.actions.length > 0 &&
          a.name.toLowerCase().includes(appSearch.trim().toLowerCase()),
      ),
    [visibleApps, appSearch],
  );

  const triggerVariables = React.useMemo(() => {
    const base = getTriggerVariables(
      apps,
      triggerNode?.applicationId,
      triggerNode?.event,
    );
    if (triggerNode?.applicationId !== "webhook") {
      return base;
    }
    const merged = new Map<string, VariableDefinition>();
    for (const v of base) merged.set(v.path, v);
    for (const v of discoveredWebhookVars) merged.set(v.path, v);
    return Array.from(merged.values());
  }, [apps, discoveredWebhookVars, triggerNode?.applicationId, triggerNode?.event]);

  // Reset search & token disclosure when switching steps
  React.useEffect(() => {
    setAppSearch("");
    setShowTokenForm(false);
    setTokenLabel("");
    setTokenSecret("");
  }, [activeStep]);

  const loadDynamicFieldOptions = React.useCallback(
    async (
      node: ApplicationNode,
      field: FieldDefinition,
      parentVal?: string,
    ) => {
      if (!node.connectionId) return;
      const cacheKey = `${node.id}:${node.connectionId}:${field.key}:${parentVal ?? ""}`;
      setDynamicOptions((prev) => ({
        ...prev,
        [cacheKey]: {
          loading: true,
          options: prev[cacheKey]?.options ?? [],
        },
      }));

      try {
        const res = await api.getFieldOptions(
          node.connectionId,
          field.key,
          parentVal,
        );
        setDynamicOptions((prev) => ({
          ...prev,
          [cacheKey]: { loading: false, options: res.options },
        }));
      } catch (err) {
        const message =
          err instanceof ApiClientError
            ? err.message
            : "Couldn't load options.";
        setDynamicOptions((prev) => ({
          ...prev,
          [cacheKey]: { loading: false, options: [], error: message },
        }));
      }
    },
    [],
  );

  // Auto-load dynamic_select fields when entering Step 3 (trigger) or Step 6 (action)
  React.useEffect(() => {
    if (activeStep === 3 && triggerNode && triggerApp && triggerNode.connectionId) {
      const trigDef =
        triggerApp.triggers.find((t) => t.id === triggerNode.event) ??
        triggerApp.triggers[0];
      if (!trigDef) return;
      for (const field of trigDef.fields) {
        if (field.type !== "dynamic_select") continue;
        const parentVal = field.dependsOn
          ? getConfigStringOrValue(triggerNode.configuration[field.dependsOn])
          : undefined;
        if (field.dependsOn && !parentVal) continue;
        const cacheKey = `${triggerNode.id}:${triggerNode.connectionId}:${field.key}:${parentVal ?? ""}`;
        if (!dynamicOptions[cacheKey]) {
          void loadDynamicFieldOptions(triggerNode, field, parentVal);
        }
      }
    }
  }, [
    activeStep,
    dynamicOptions,
    loadDynamicFieldOptions,
    triggerApp,
    triggerNode,
  ]);

  React.useEffect(() => {
    if (activeStep === 6 && actionNode && actionApp && actionNode.connectionId) {
      const actDef =
        actionApp.actions.find((a) => a.id === actionNode.event) ??
        actionApp.actions[0];
      if (!actDef) return;
      for (const field of actDef.fields) {
        if (field.type !== "dynamic_select") continue;
        const parentVal = field.dependsOn
          ? getConfigStringOrValue(actionNode.configuration[field.dependsOn])
          : undefined;
        if (field.dependsOn && !parentVal) continue;
        const cacheKey = `${actionNode.id}:${actionNode.connectionId}:${field.key}:${parentVal ?? ""}`;
        if (!dynamicOptions[cacheKey]) {
          void loadDynamicFieldOptions(actionNode, field, parentVal);
        }
      }
    }
  }, [
    activeStep,
    actionApp,
    actionNode,
    dynamicOptions,
    loadDynamicFieldOptions,
  ]);

  async function handleOAuthClick(appId: AppId) {
    if (oauthBusyApp) return;
    setOauthBusyApp(appId);
    try {
      await onStartOAuth(appId);
    } finally {
      setOauthBusyApp(null);
    }
  }

  async function handleCreateToken(app: AppDefinition, node: ApplicationNode) {
    const trimmed = tokenSecret.trim();
    if (!trimmed || savingToken) return;
    setSavingToken(true);
    try {
      const created = await api.createTokenConnection({
        applicationId: app.id,
        token: trimmed,
        displayName: tokenLabel.trim() || undefined,
      });
      onConnectionCreated(created);
      onChangeNodeConnection(node.id, created.id);
      setShowTokenForm(false);
      setTokenLabel("");
      setTokenSecret("");
      toast({
        title: `${app.name} connected`,
        description: `Saved “${created.displayName}”.`,
        variant: "success",
      });
      onStepChange(node.role === "trigger" ? 3 : 6);
    } catch (err) {
      toast({
        title: "Couldn't save token",
        description:
          err instanceof ApiClientError
            ? err.message
            : "Please verify your token and try again.",
        variant: "error",
      });
    } finally {
      setSavingToken(false);
    }
  }

  const currentPrompt = React.useMemo(() => {
    if (activeStep === 2 && triggerApp) {
      return `Connect your ${triggerApp.name} account`;
    }
    if (activeStep === 5 && actionApp) {
      return `Connect your ${actionApp.name} account`;
    }
    return STEP_LABELS.find((s) => s.step === activeStep)?.title ?? "";
  }, [actionApp, activeStep, triggerApp]);

  function renderAccountStep(node: ApplicationNode | null, app: AppDefinition | null, nextStep: GuidedStep) {
    if (!node || !app) {
      return (
        <div className="rounded-xl border border-dashed border-border p-4 text-center text-xs text-ink-secondary">
          Select an app first to connect its account.
        </div>
      );
    }

    if (app.authKind === "none") {
      return (
        <div className="space-y-3 rounded-xl border border-border bg-subtle/40 p-4">
          <p className="text-xs text-ink-secondary">
            {app.name} doesn&apos;t require an external account connection.
          </p>
          <Button size="sm" onClick={() => onStepChange(nextStep)}>
            Continue
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </div>
      );
    }

    const matchingConnections = connections.filter(
      (c) => c.applicationId === app.id,
    );

    return (
      <div className="space-y-4">
        {matchingConnections.length > 0 && (
          <div className="space-y-2">
            <Label>Choose a connected {app.name} account</Label>
            <div className="space-y-2">
              {matchingConnections.map((conn) => {
                const selected = node.connectionId === conn.id;
                const healthy = conn.status === "connected";
                return (
                  <button
                    key={conn.id}
                    type="button"
                    onClick={() => onChangeNodeConnection(node.id, conn.id)}
                    className={`flex w-full items-center justify-between gap-2 rounded-xl border p-3 text-left transition-colors ${
                      selected
                        ? "border-accent bg-accent-soft/50"
                        : "border-border bg-surface hover:bg-subtle"
                    }`}
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <AppIcon appId={app.id} size="sm" />
                      <div className="min-w-0">
                        <div className="truncate text-xs font-semibold text-ink">
                          {conn.displayName}
                        </div>
                        <div className="text-[11px] text-ink-muted">
                          {healthy ? "Ready" : "Needs attention"}
                        </div>
                      </div>
                    </div>
                    {selected && (
                      <CheckCircle2
                        className="h-4 w-4 shrink-0 text-accent"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {app.authKind === "oauth2" && (() => {
          const oauthAppId =
            app.id === "clickup" || app.id === "slack" ? app.id : null;
          const oauthStatus = oauthAppId
            ? oauthApps.find((a) => a.applicationId === oauthAppId)
            : undefined;
          const isOAuthConfigured = oauthStatus ? oauthStatus.configured : true;
          const tokenMeta = oauthAppId ? TOKEN_CONNECT_META[oauthAppId] : null;
          const tokenToggleLabel =
            app.id === "slack"
              ? "Or paste a Slack Bot token (xoxb-...)"
              : "Or paste a personal API token (pk_...)";

          return (
            <div className="space-y-3">
              {isOAuthConfigured ? (
                <div className="space-y-2">
                  <Button
                    className="w-full"
                    size="md"
                    loading={oauthBusyApp === app.id}
                    onClick={() => void handleOAuthClick(app.id)}
                  >
                    <ExternalLink className="h-4 w-4" aria-hidden="true" />
                    {matchingConnections.length > 0
                      ? `Connect another ${app.name} account`
                      : `Connect ${app.name}`}
                  </Button>
                  {oauthStatus && oauthAppId && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="w-full text-xs text-ink-secondary"
                      onClick={() => setOauthSetupAppId(oauthAppId)}
                    >
                      <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
                      Configure {app.name} OAuth app
                    </Button>
                  )}
                </div>
              ) : (
                <div className="space-y-2 rounded-xl border border-border bg-subtle/40 p-3">
                  <p className="text-xs font-medium text-ink">
                    Quick setup for {app.name}
                  </p>
                  <p className="text-[11px] leading-relaxed text-ink-secondary">
                    Paste a token directly for instant setup, or configure your workspace&apos;s 1-click OAuth app.
                  </p>
                  <div className="flex flex-col gap-2 pt-1">
                    {app.tokenAuth && (
                      <Button
                        size="sm"
                        className="w-full"
                        onClick={() => setShowTokenForm(true)}
                      >
                        <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
                        {app.id === "slack"
                          ? "Paste Bot token (xoxb-...)"
                          : "Paste API token (pk_...)"}
                      </Button>
                    )}
                    {oauthAppId && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full"
                        onClick={() => setOauthSetupAppId(oauthAppId)}
                      >
                        <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
                        Configure 1-click OAuth app
                      </Button>
                    )}
                  </div>
                </div>
              )}

              {app.tokenAuth && (
                <div className="space-y-2 pt-1">
                  {(isOAuthConfigured || showTokenForm) && (
                    <button
                      type="button"
                      onClick={() => setShowTokenForm((v) => !v)}
                      className="text-xs font-medium text-ink-secondary underline-offset-2 hover:text-ink hover:underline"
                    >
                      {showTokenForm ? "Hide token form" : tokenToggleLabel}
                    </button>
                  )}

                  {showTokenForm && (
                    <div className="space-y-2.5 rounded-xl border border-border bg-subtle/50 p-3">
                      {oauthAppId && (
                        <TokenGuideBox appId={oauthAppId} compact />
                      )}
                      <Input
                        placeholder={
                          tokenMeta?.namePlaceholder ?? "Account label (optional)"
                        }
                        value={tokenLabel}
                        onChange={(e) => setTokenLabel(e.target.value)}
                        className="h-8 text-xs"
                      />
                      <Input
                        type="password"
                        placeholder={
                          tokenMeta?.tokenPlaceholder ?? "Paste API token..."
                        }
                        value={tokenSecret}
                        onChange={(e) => setTokenSecret(e.target.value)}
                        className="h-8 text-xs"
                      />
                      <Button
                        size="sm"
                        loading={savingToken}
                        onClick={() => void handleCreateToken(app, node)}
                      >
                        <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
                        Verify & Save token
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })()}

        {app.authKind === "api_token" && (
          <div className="space-y-2.5 rounded-xl border border-border bg-subtle/50 p-3">
            <div className="text-xs font-medium text-ink">
              Add {app.tokenAuth?.label ?? "API credential"}
            </div>
            <p className="text-[11px] text-ink-secondary">
              {app.tokenAuth?.help ?? "Credentials are encrypted at rest."}
            </p>
            <Input
              placeholder="Label (e.g. Production API Key)"
              value={tokenLabel}
              onChange={(e) => setTokenLabel(e.target.value)}
              className="h-8 text-xs"
            />
            <Input
              type="password"
              placeholder="Paste token or user:password"
              value={tokenSecret}
              onChange={(e) => setTokenSecret(e.target.value)}
              className="h-8 text-xs"
            />
            <Button
              size="sm"
              loading={savingToken}
              onClick={() => void handleCreateToken(app, node)}
            >
              <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
              Save credential
            </Button>
          </div>
        )}

        <div className="flex justify-end pt-2">
          <Button
            size="sm"
            variant={node.connectionId ? "primary" : "outline"}
            onClick={() => onStepChange(nextStep)}
          >
            Continue
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </div>
      </div>
    );
  }

  function renderDynamicSelectField(
    node: ApplicationNode,
    field: FieldDefinition,
    stepPrefix: "trigger" | "action",
  ) {
    const rawVal = node.configuration[field.key];
    const currentValue = getConfigStringOrValue(rawVal);
    const parentVal = field.dependsOn
      ? getConfigStringOrValue(node.configuration[field.dependsOn])
      : undefined;

    const cacheKey = node.connectionId
      ? `${node.id}:${node.connectionId}:${field.key}:${parentVal ?? ""}`
      : "";
    const entry = cacheKey ? dynamicOptions[cacheKey] : undefined;
    const options = entry?.options ?? [];
    const currentLabel =
      rawVal && typeof rawVal === "object" && !Array.isArray(rawVal)
        ? rawVal.label
        : currentValue;

    const errMsg = fieldErrors[`${stepPrefix}.configuration.${field.key}`];
    const needsParent = Boolean(field.dependsOn && !parentVal);

    return (
      <div key={field.key} className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor={`field-${stepPrefix}-${field.key}`}>
            {field.label}
          </Label>
          {node.connectionId && !needsParent && (
            <button
              type="button"
              onClick={() =>
                void loadDynamicFieldOptions(node, field, parentVal)
              }
              className="inline-flex items-center gap-1 text-[11px] font-medium text-ink-muted hover:text-ink"
              title="Refresh options"
            >
              <RefreshCw
                className={`h-3 w-3 ${entry?.loading ? "animate-spin" : ""}`}
                aria-hidden="true"
              />
              Refresh
            </button>
          )}
        </div>

        <select
          id={`field-${stepPrefix}-${field.key}`}
          data-testid={`field-${field.key}`}
          disabled={!node.connectionId || needsParent}
          value={currentValue}
          onChange={(e) => {
            const val = e.target.value;
            if (!val) {
              onChangeNodeConfig(node.id, field.key, null);
            } else {
              const found = options.find((o) => o.value === val);
              onChangeNodeConfig(node.id, field.key, {
                value: val,
                label: found?.label ?? val,
              });
            }
            // Clear dependent child fields (e.g. listId when workspaceId changes)
            if (field.key === "workspaceId") {
              onChangeNodeConfig(node.id, "listId", null);
            }
          }}
          className="h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:bg-subtle disabled:opacity-60"
        >
          <option value="">
            {!node.connectionId
              ? "Connect an account first"
              : needsParent
                ? "Select workspace first"
                : entry?.loading
                  ? "Loading options..."
                  : (field.placeholder ?? "Choose an option...")}
          </option>
          {currentValue &&
            !options.some((o) => o.value === currentValue) && (
              <option value={currentValue}>{currentLabel}</option>
            )}
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>

        {field.help && (
          <p className="text-[11px] text-ink-muted">{field.help}</p>
        )}
        {entry?.error && (
          <p className="text-xs text-danger-text">{entry.error}</p>
        )}
        {errMsg && <p className="text-xs text-danger-text">{errMsg}</p>}
      </div>
    );
  }

  const allErrors = Object.entries(fieldErrors);

  return (
    <aside
      data-testid="guided-panel"
      aria-label="Automation setup guide"
      className="flex w-full flex-col border-t border-border bg-surface lg:w-[400px] lg:shrink-0 lg:border-l lg:border-t-0"
    >
      {/* Step indicator */}
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-accent">
            Step {activeStep} of 7
          </span>
          {(activeStep === 2 || activeStep === 3) && triggerNode && (
            <button
              type="button"
              onClick={() => onRemoveNode(triggerNode.id)}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-ink-muted hover:text-danger-text"
            >
              <Trash2 className="h-3 w-3" aria-hidden="true" />
              Change trigger
            </button>
          )}
          {(activeStep === 5 || activeStep === 6) && actionNode && (
            <button
              type="button"
              onClick={() => onRemoveNode(actionNode.id)}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-ink-muted hover:text-danger-text"
            >
              <Trash2 className="h-3 w-3" aria-hidden="true" />
              Change action
            </button>
          )}
        </div>

        <h2 className="mt-1 text-base font-semibold tracking-tight text-ink">
          {currentPrompt}
        </h2>

        {/* Compact clickable step pills */}
        <div className="mt-3 flex flex-wrap gap-1">
          {STEP_LABELS.map((item) => {
            const isCurrent = activeStep === item.step;
            return (
              <button
                key={item.step}
                type="button"
                onClick={() => onStepChange(item.step)}
                className={`rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors ${
                  isCurrent
                    ? "bg-accent text-accent-foreground"
                    : "bg-subtle text-ink-secondary hover:bg-muted hover:text-ink"
                }`}
              >
                {item.step}. {item.short}
              </button>
            );
          })}
        </div>
      </div>

      {/* Step Body */}
      <div className="flex-1 space-y-5 overflow-y-auto p-4">
        {/* Step 1: Choose trigger app */}
        {activeStep === 1 && (
          <div className="space-y-3">
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-ink-muted"
                aria-hidden="true"
              />
              <Input
                aria-label="Search trigger apps"
                placeholder="Search trigger apps..."
                value={appSearch}
                onChange={(e) => setAppSearch(e.target.value)}
                className="h-9 pl-9 text-sm"
              />
            </div>

            <div className="space-y-2">
              {triggerApps.map((app) => {
                const isSelected = triggerNode?.applicationId === app.id;
                return (
                  <button
                    key={app.id}
                    type="button"
                    data-testid={`guided-app-card-${app.id}`}
                    onClick={() => onSelectApp(app.id)}
                    className={`flex w-full items-start gap-3 rounded-xl border p-3.5 text-left transition-all ${
                      isSelected
                        ? "border-accent bg-accent-soft/40 shadow-2xs"
                        : "border-border bg-surface hover:border-border-strong hover:bg-subtle/50"
                    }`}
                  >
                    <AppIcon appId={app.id} size="lg" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-ink">
                          {app.name}
                        </span>
                        {app.advanced && <Badge variant="neutral">Advanced</Badge>}
                      </div>
                      <p className="mt-0.5 text-xs leading-relaxed text-ink-secondary">
                        {app.description}
                      </p>
                    </div>
                  </button>
                );
              })}
              {triggerApps.length === 0 && (
                <p className="py-6 text-center text-xs text-ink-muted">
                  No trigger apps match “{appSearch}”.
                </p>
              )}
            </div>
          </div>
        )}

        {/* Step 2: Connect trigger account */}
        {activeStep === 2 &&
          renderAccountStep(triggerNode, triggerApp, 3)}

        {/* Step 3: Trigger event + dynamic fields + Advanced webhook/filters */}
        {activeStep === 3 && (
          <div className="space-y-4">
            {!triggerNode || !triggerApp ? (
              <div className="rounded-xl border border-dashed border-border p-4 text-center text-xs text-ink-secondary">
                Choose a trigger app in Step 1 first.
              </div>
            ) : (
              <>
                {triggerApp.authKind !== "none" && !triggerNode.connectionId && (
                  <div className="flex items-center justify-between gap-2 rounded-lg border border-warning-border bg-warning-soft p-2.5 text-xs text-warning-text">
                    <span>Connect your {triggerApp.name} account to load options.</span>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onStepChange(2)}
                    >
                      Connect
                    </Button>
                  </div>
                )}

                <div className="space-y-2">
                  <Label>Trigger event</Label>
                  <div className="space-y-2">
                    {triggerApp.triggers.map((trig) => {
                      const checked = triggerNode.event === trig.id;
                      return (
                        <label
                          key={trig.id}
                          className={`flex cursor-pointer items-start gap-2.5 rounded-xl border p-3 transition-colors ${
                            checked
                              ? "border-accent bg-accent-soft/40"
                              : "border-border bg-surface hover:bg-subtle/40"
                          }`}
                        >
                          <input
                            type="radio"
                            name="trigger-event"
                            value={trig.id}
                            checked={checked}
                            onChange={() =>
                              onChangeNodeEvent(triggerNode.id, trig.id)
                            }
                            className="mt-0.5 accent-accent"
                          />
                          <div>
                            <div className="text-xs font-semibold text-ink">
                              {trig.label}
                            </div>
                            <div className="text-[11px] text-ink-secondary">
                              {trig.description}
                            </div>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </div>

                {/* Trigger fields */}
                {(() => {
                  const trigDef =
                    triggerApp.triggers.find((t) => t.id === triggerNode.event) ??
                    triggerApp.triggers[0];
                  if (!trigDef) return null;
                  return trigDef.fields
                    .filter((f) => !f.advanced || advancedMode)
                    .map((field) => {
                      if (field.type === "dynamic_select") {
                        return renderDynamicSelectField(
                          triggerNode,
                          field,
                          "trigger",
                        );
                      }
                      return null;
                    });
                })()}

                {/* Advanced: Custom Webhook section */}
                {advancedMode && triggerNode.applicationId === "webhook" && (
                  <WebhookSection
                    automationId={automationId}
                    verification={
                      typeof triggerNode.configuration.verification === "string"
                        ? triggerNode.configuration.verification
                        : "hmac_sha256"
                    }
                    onChangeVerification={(val) =>
                      onChangeNodeConfig(triggerNode.id, "verification", val)
                    }
                    onEnsureSavedDraft={onEnsureSavedDraft}
                    onVariablesDiscovered={setDiscoveredWebhookVars}
                  />
                )}

                {/* Advanced: Optional Filter conditions */}
                {advancedMode && (
                  <FilterEditor
                    filters={state.filters}
                    variables={triggerVariables}
                    fieldErrors={fieldErrors}
                    onChange={onChangeFilters}
                  />
                )}

                <div className="flex items-center justify-between pt-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onStepChange(1)}
                  >
                    <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                    Back
                  </Button>
                  <Button size="sm" onClick={() => onStepChange(4)}>
                    Continue to action
                    <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                </div>
              </>
            )}
          </div>
        )}

        {/* Step 4: Choose action app */}
        {activeStep === 4 && (
          <div className="space-y-3">
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-ink-muted"
                aria-hidden="true"
              />
              <Input
                aria-label="Search action apps"
                placeholder="Search action apps..."
                value={appSearch}
                onChange={(e) => setAppSearch(e.target.value)}
                className="h-9 pl-9 text-sm"
              />
            </div>

            <div className="space-y-2">
              {actionApps.map((app) => {
                const isSelected = actionNode?.applicationId === app.id;
                return (
                  <button
                    key={app.id}
                    type="button"
                    data-testid={`guided-app-card-${app.id}`}
                    onClick={() => onSelectApp(app.id)}
                    className={`flex w-full items-start gap-3 rounded-xl border p-3.5 text-left transition-all ${
                      isSelected
                        ? "border-accent bg-accent-soft/40 shadow-2xs"
                        : "border-border bg-surface hover:border-border-strong hover:bg-subtle/50"
                    }`}
                  >
                    <AppIcon appId={app.id} size="lg" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-ink">
                          {app.name}
                        </span>
                        {app.advanced && <Badge variant="neutral">Advanced</Badge>}
                      </div>
                      <p className="mt-0.5 text-xs leading-relaxed text-ink-secondary">
                        {app.description}
                      </p>
                    </div>
                  </button>
                );
              })}
              {actionApps.length === 0 && (
                <p className="py-6 text-center text-xs text-ink-muted">
                  No action apps match “{appSearch}”.
                </p>
              )}
            </div>
          </div>
        )}

        {/* Step 5: Connect action account */}
        {activeStep === 5 &&
          renderAccountStep(actionNode, actionApp, 6)}

        {/* Step 6: Configure action */}
        {activeStep === 6 && (
          <div className="space-y-4">
            {!actionNode || !actionApp ? (
              <div className="rounded-xl border border-dashed border-border p-4 text-center text-xs text-ink-secondary">
                Choose an action app in Step 4 first.
              </div>
            ) : actionNode.applicationId === "http" && advancedMode ? (
              <>
                <HttpActionSection
                  node={actionNode}
                  connections={connections}
                  variables={triggerVariables}
                  fieldErrors={fieldErrors}
                  onChangeConfig={(key, value) =>
                    onChangeNodeConfig(actionNode.id, key, value)
                  }
                  onChangeConnection={(cid) =>
                    onChangeNodeConnection(actionNode.id, cid)
                  }
                  onConnectionCreated={onConnectionCreated}
                />
                <div className="flex items-center justify-between pt-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onStepChange(4)}
                  >
                    <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                    Back
                  </Button>
                  <Button size="sm" onClick={() => onStepChange(7)}>
                    Review &amp; Activate
                    <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                </div>
              </>
            ) : (
              <>
                {actionApp.authKind !== "none" && !actionNode.connectionId && (
                  <div className="flex items-center justify-between gap-2 rounded-lg border border-warning-border bg-warning-soft p-2.5 text-xs text-warning-text">
                    <span>Connect your {actionApp.name} account first.</span>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onStepChange(5)}
                    >
                      Connect
                    </Button>
                  </div>
                )}

                {(() => {
                  const actDef =
                    actionApp.actions.find((a) => a.id === actionNode.event) ??
                    actionApp.actions[0];
                  if (!actDef) return null;

                  return actDef.fields.map((field) => {
                    if (field.type === "dynamic_select") {
                      return renderDynamicSelectField(
                        actionNode,
                        field,
                        "action",
                      );
                    }

                    if (field.type === "template") {
                      const textVal =
                        typeof actionNode.configuration[field.key] === "string"
                          ? (actionNode.configuration[field.key] as string)
                          : "";
                      const errMsg =
                        fieldErrors[`action.configuration.${field.key}`];

                      return (
                        <div key={field.key} className="space-y-2">
                          <Label htmlFor={`field-action-${field.key}`}>
                            {field.label}
                          </Label>
                          <textarea
                            id={`field-action-${field.key}`}
                            data-testid={`field-${field.key}`}
                            ref={(el) => {
                              templateRefs.current[field.key] = el;
                            }}
                            rows={4}
                            value={textVal}
                            placeholder={field.placeholder}
                            onChange={(e) =>
                              onChangeNodeConfig(
                                actionNode.id,
                                field.key,
                                e.target.value,
                              )
                            }
                            className={`w-full rounded-lg border bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-muted focus-visible:outline-none focus-visible:ring-2 ${
                              errMsg
                                ? "border-danger focus-visible:ring-danger"
                                : "border-border focus-visible:ring-accent"
                            }`}
                          />
                          {errMsg && (
                            <p className="text-xs text-danger-text">{errMsg}</p>
                          )}
                          {field.help && (
                            <p className="text-[11px] text-ink-muted">
                              {field.help}
                            </p>
                          )}
                          <VariableChips
                            variables={triggerVariables}
                            onInsert={(path) =>
                              insertVariableIntoInput(
                                templateRefs.current[field.key] ?? null,
                                textVal,
                                path,
                                (next) =>
                                  onChangeNodeConfig(
                                    actionNode.id,
                                    field.key,
                                    next,
                                  ),
                              )
                            }
                          />
                        </div>
                      );
                    }

                    return null;
                  });
                })()}

                <div className="flex items-center justify-between pt-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onStepChange(4)}
                  >
                    <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                    Back
                  </Button>
                  <Button size="sm" onClick={() => onStepChange(7)}>
                    Review &amp; Activate
                    <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                </div>
              </>
            )}
          </div>
        )}

        {/* Step 7: Review & Activate */}
        {activeStep === 7 && (
          <div className="space-y-4">
            <div className="rounded-xl border border-border bg-subtle/50 p-4">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
                Summary
              </div>
              <p
                data-testid="review-summary-sentence"
                className="mt-1.5 text-sm font-medium leading-relaxed text-ink"
              >
                {buildWorkflowSentence(state, apps)}
              </p>
            </div>

            <div className="space-y-2 text-xs">
              <button
                type="button"
                onClick={() => onStepChange(triggerNode ? 3 : 1)}
                className="flex w-full items-center justify-between rounded-lg border border-border bg-surface px-3 py-2 text-left hover:bg-subtle/50"
              >
                <span className="font-medium text-ink">
                  1. Trigger: {triggerApp ? triggerApp.name : "Not selected"}
                </span>
                {triggerNode ? (
                  <Check className="h-3.5 w-3.5 text-success" aria-hidden="true" />
                ) : (
                  <span className="text-warning-text">Pick trigger</span>
                )}
              </button>

              {state.filters.length > 0 && (
                <button
                  type="button"
                  onClick={() => onStepChange(3)}
                  className="flex w-full items-center justify-between rounded-lg border border-border bg-surface px-3 py-2 text-left hover:bg-subtle/50"
                >
                  <span className="font-medium text-ink">
                    Filters: {state.filters.length} condition
                    {state.filters.length === 1 ? "" : "s"}
                  </span>
                  <Check className="h-3.5 w-3.5 text-success" aria-hidden="true" />
                </button>
              )}

              <button
                type="button"
                onClick={() => onStepChange(actionNode ? 6 : 4)}
                className="flex w-full items-center justify-between rounded-lg border border-border bg-surface px-3 py-2 text-left hover:bg-subtle/50"
              >
                <span className="font-medium text-ink">
                  2. Action: {actionApp ? actionApp.name : "Not selected"}
                </span>
                {actionNode ? (
                  <Check className="h-3.5 w-3.5 text-success" aria-hidden="true" />
                ) : (
                  <span className="text-warning-text">Pick action</span>
                )}
              </button>
            </div>

            {allErrors.length > 0 && (
              <div
                role="alert"
                className="space-y-1.5 rounded-xl border border-danger-border bg-danger-soft p-3 text-xs text-danger-text"
              >
                <div className="flex items-center gap-1.5 font-semibold">
                  <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                  Fix these fields before activating:
                </div>
                <ul className="list-disc space-y-1 pl-5">
                  {allErrors.map(([key, msg]) => (
                    <li key={key}>{msg}</li>
                  ))}
                </ul>
              </div>
            )}

            {testRunResult && (
              <div
                data-testid="test-run-result"
                className={`rounded-xl border p-3 text-xs ${
                  testRunResult.ok
                    ? "border-success-border bg-success-soft text-success-text"
                    : "border-danger-border bg-danger-soft text-danger-text"
                }`}
              >
                <p className="font-semibold">
                  {testRunResult.ok ? "Test run succeeded" : "Test run failed"}
                </p>
                <p className="mt-0.5">{testRunResult.message}</p>
              </div>
            )}

            <div className="flex flex-col gap-2 pt-2">
              <Button
                size="lg"
                className="w-full"
                loading={activating}
                onClick={() => void onActivateOrPause()}
              >
                {automationStatus === "active"
                  ? "Pause automation"
                  : "Activate automation"}
              </Button>
              <Button
                variant="outline"
                size="md"
                className="w-full"
                loading={testingRun}
                onClick={() => void onTestRun()}
              >
                <Play className="h-3.5 w-3.5" aria-hidden="true" />
                Test run
              </Button>
            </div>
          </div>
        )}
      </div>

      <OAuthAppSetupDialog
        open={Boolean(oauthSetupAppId)}
        status={
          oauthSetupAppId
            ? (oauthApps.find((a) => a.applicationId === oauthSetupAppId) ?? null)
            : null
        }
        onOpenChange={(open) => {
          if (!open) setOauthSetupAppId(null);
        }}
        onSaved={(updated) => onOAuthAppUpdated?.(updated)}
        onSaveAndConnect={async (appId) => {
          await handleOAuthClick(appId);
        }}
      />
    </aside>
  );
};
