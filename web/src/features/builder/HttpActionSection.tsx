import * as React from "react";
import { KeyRound, Play, Plus, Trash2 } from "lucide-react";
import {
  Badge,
  Button,
  Input,
  Label,
  useToast,
} from "../../components/ui";
import type {
  ConfigValue,
  Connection,
  HttpTestRequest,
  HttpTestResult,
  VariableDefinition,
} from "../../contracts";
import type { ApplicationNode } from "../../canvas/types";
import { api, ApiClientError } from "../../lib/api";
import { insertVariableIntoInput, VariableChips } from "./VariableChips";

const METHODS: HttpTestRequest["method"][] = [
  "POST",
  "GET",
  "PUT",
  "PATCH",
  "DELETE",
];

const AUTH_TYPES = [
  { value: "none", label: "No authentication" },
  { value: "bearer", label: "Bearer token" },
  { value: "api_key", label: "API key header" },
  { value: "basic", label: "Basic auth (user:password)" },
] as const;

export interface HttpActionSectionProps {
  node: ApplicationNode;
  connections: Connection[];
  variables: VariableDefinition[];
  fieldErrors?: Record<string, string>;
  onChangeConfig: (key: string, value: ConfigValue) => void;
  onChangeConnection: (connectionId: string | null) => void;
  onConnectionCreated: (conn: Connection) => void;
}

export const HttpActionSection: React.FC<HttpActionSectionProps> = ({
  node,
  connections,
  variables,
  fieldErrors = {},
  onChangeConfig,
  onChangeConnection,
  onConnectionCreated,
}) => {
  const { toast } = useToast();

  const urlInputRef = React.useRef<HTMLInputElement | null>(null);
  const bodyTextareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const headerValueRefs = React.useRef<Record<number, HTMLInputElement | null>>({});
  const [activeHeaderIdx, setActiveHeaderIdx] = React.useState<number | null>(null);

  const [testing, setTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState<HttpTestResult | null>(null);

  const [showInlineCred, setShowInlineCred] = React.useState(false);
  const [credName, setCredName] = React.useState("");
  const [credToken, setCredToken] = React.useState("");
  const [savingCred, setSavingCred] = React.useState(false);

  const httpConnections = React.useMemo(
    () => connections.filter((c) => c.applicationId === "http"),
    [connections],
  );

  const method =
    typeof node.configuration.method === "string" &&
    METHODS.includes(node.configuration.method as HttpTestRequest["method"])
      ? (node.configuration.method as HttpTestRequest["method"])
      : "POST";
  const url =
    typeof node.configuration.url === "string" ? node.configuration.url : "";
  const headers: { key: string; value: string }[] = Array.isArray(
    node.configuration.headers,
  )
    ? node.configuration.headers
    : [];
  const authType =
    typeof node.configuration.authType === "string"
      ? (node.configuration.authType as "none" | "bearer" | "api_key" | "basic")
      : "none";
  const headerName =
    typeof node.configuration.headerName === "string"
      ? node.configuration.headerName
      : "X-API-Key";
  const body =
    typeof node.configuration.body === "string" ? node.configuration.body : "";

  function updateHeader(idx: number, patch: Partial<{ key: string; value: string }>) {
    const next = headers.map((h, i) => (i === idx ? { ...h, ...patch } : h));
    onChangeConfig("headers", next);
  }

  function addHeader() {
    onChangeConfig("headers", [...headers, { key: "", value: "" }]);
    setActiveHeaderIdx(headers.length);
  }

  function removeHeader(idx: number) {
    onChangeConfig(
      "headers",
      headers.filter((_, i) => i !== idx),
    );
    setActiveHeaderIdx(null);
  }

  async function handleSaveInlineCredential() {
    const trimmed = credToken.trim();
    if (!trimmed || savingCred) return;
    setSavingCred(true);
    try {
      const created = await api.createTokenConnection({
        applicationId: "http",
        token: trimmed,
        displayName: credName.trim() || undefined,
      });
      onConnectionCreated(created);
      onChangeConnection(created.id);
      setCredName("");
      setCredToken("");
      setShowInlineCred(false);
      toast({
        title: "HTTP credential saved",
        description: `Linked “${created.displayName}”.`,
        variant: "success",
      });
    } catch (err) {
      toast({
        title: "Couldn't save credential",
        description:
          err instanceof ApiClientError
            ? err.message
            : "Please check the credential and try again.",
        variant: "error",
      });
    } finally {
      setSavingCred(false);
    }
  }

  async function handleTestRequest() {
    if (testing) return;
    if (!url.trim()) {
      toast({
        title: "Destination URL required",
        description: "Enter an HTTPS URL before testing the request.",
        variant: "error",
      });
      return;
    }

    if (authType !== "none" && !node.connectionId) {
      toast({
        title: "Select an HTTP credential",
        description: "Choose or add a credential before testing authenticated requests.",
        variant: "error",
      });
      return;
    }

    setTesting(true);
    setTestResult(null);
    try {
      const sampleVariables: Record<string, string> = {};
      for (const v of variables) {
        sampleVariables[v.path] = v.example;
      }

      const auth: HttpTestRequest["auth"] =
        authType === "none" || !node.connectionId
          ? { type: "none" }
          : authType === "bearer"
            ? { type: "bearer", credentialConnectionId: node.connectionId }
            : authType === "api_key"
              ? {
                  type: "api_key",
                  credentialConnectionId: node.connectionId,
                  headerName: headerName.trim() || "X-API-Key",
                }
              : { type: "basic", credentialConnectionId: node.connectionId };

      const res = await api.testHttp({
        method,
        url,
        headers: headers.filter((h) => h.key.trim().length > 0),
        auth,
        body: method === "GET" ? null : body || null,
        sampleVariables,
      });
      setTestResult(res);
    } catch (err) {
      const message =
        err instanceof ApiClientError
          ? err.message
          : "HTTP test failed. Please check the URL and try again.";
      setTestResult({
        ok: false,
        status: null,
        durationMs: 0,
        responsePreview: "",
        message,
      });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div data-testid="http-action-section" className="space-y-4">
      {/* Method + URL */}
      <div className="grid gap-2.5 sm:grid-cols-[110px_1fr]">
        <div className="space-y-1.5">
          <Label htmlFor="http-method-select">Method</Label>
          <select
            id="http-method-select"
            value={method}
            onChange={(e) => onChangeConfig("method", e.target.value)}
            className="h-10 w-full rounded-lg border border-border bg-surface px-2.5 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="http-url-input">Destination URL</Label>
          <Input
            id="http-url-input"
            ref={urlInputRef}
            placeholder="https://api.example.com/webhooks"
            value={url}
            error={Boolean(fieldErrors["action.configuration.url"])}
            onChange={(e) => onChangeConfig("url", e.target.value)}
          />
          {fieldErrors["action.configuration.url"] && (
            <p className="text-xs text-danger-text">
              {fieldErrors["action.configuration.url"]}
            </p>
          )}
        </div>
      </div>

      <VariableChips
        variables={variables}
        label="Insert into URL"
        onInsert={(path) =>
          insertVariableIntoInput(urlInputRef.current, url, path, (next) =>
            onChangeConfig("url", next),
          )
        }
      />

      {/* Authentication */}
      <div className="space-y-2.5 rounded-xl border border-border bg-subtle/40 p-3">
        <div className="space-y-1.5">
          <Label htmlFor="http-auth-type-select">Authentication</Label>
          <select
            id="http-auth-type-select"
            value={authType}
            onChange={(e) => onChangeConfig("authType", e.target.value)}
            className="h-9 w-full rounded-lg border border-border bg-surface px-2.5 text-xs text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {AUTH_TYPES.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        {authType === "api_key" && (
          <div className="space-y-1.5">
            <Label htmlFor="http-api-key-header">Header name</Label>
            <Input
              id="http-api-key-header"
              value={headerName}
              placeholder="X-API-Key"
              onChange={(e) => onChangeConfig("headerName", e.target.value)}
              className="h-8 text-xs"
            />
          </div>
        )}

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="http-credential-select">
              Encrypted HTTP credential
            </Label>
            <button
              type="button"
              onClick={() => setShowInlineCred((v) => !v)}
              className="text-xs font-medium text-accent hover:underline"
            >
              {showInlineCred ? "Cancel" : "+ New credential"}
            </button>
          </div>
          <select
            id="http-credential-select"
            value={node.connectionId ?? ""}
            onChange={(e) => onChangeConnection(e.target.value || null)}
            className="h-9 w-full rounded-lg border border-border bg-surface px-2.5 text-xs text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <option value="">
              {httpConnections.length === 0
                ? "No credentials saved yet"
                : "Select a credential..."}
            </option>
            {httpConnections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.displayName}
              </option>
            ))}
          </select>
          {fieldErrors["action.connectionId"] && (
            <p className="text-xs text-danger-text">
              {fieldErrors["action.connectionId"]}
            </p>
          )}
        </div>

        {showInlineCred && (
          <div className="space-y-2 rounded-lg border border-border bg-surface p-2.5">
            <Input
              placeholder="Credential label (e.g. Acme API)"
              value={credName}
              onChange={(e) => setCredName(e.target.value)}
              className="h-8 text-xs"
            />
            <Input
              type="password"
              placeholder="Paste token or user:password"
              value={credToken}
              onChange={(e) => setCredToken(e.target.value)}
              className="h-8 text-xs"
            />
            <Button
              type="button"
              size="sm"
              loading={savingCred}
              onClick={() => void handleSaveInlineCredential()}
            >
              <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
              Save credential
            </Button>
          </div>
        )}
      </div>

      {/* Headers key/value editor */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>Headers</Label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addHeader}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Add header
          </Button>
        </div>

        {headers.length > 0 && (
          <div className="space-y-2">
            {headers.map((h, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <Input
                  aria-label={`Header ${idx + 1} key`}
                  placeholder="Content-Type"
                  value={h.key}
                  onChange={(e) => updateHeader(idx, { key: e.target.value })}
                  className="h-8 flex-1 text-xs"
                />
                <Input
                  aria-label={`Header ${idx + 1} value`}
                  ref={(el) => {
                    headerValueRefs.current[idx] = el;
                  }}
                  placeholder="application/json"
                  value={h.value}
                  onFocus={() => setActiveHeaderIdx(idx)}
                  onChange={(e) => updateHeader(idx, { value: e.target.value })}
                  className="h-8 flex-1 text-xs"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove header ${idx + 1}`}
                  onClick={() => removeHeader(idx)}
                  className="h-8 w-8 p-0 text-ink-muted hover:text-danger-text"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              </div>
            ))}

            {activeHeaderIdx !== null && headers[activeHeaderIdx] && (
              <VariableChips
                variables={variables}
                label={`Insert into header ${activeHeaderIdx + 1}`}
                onInsert={(path) => {
                  const idx = activeHeaderIdx;
                  const target = headers[idx];
                  if (!target) return;
                  insertVariableIntoInput(
                    headerValueRefs.current[idx] ?? null,
                    target.value,
                    path,
                    (next) => updateHeader(idx, { value: next }),
                  );
                }}
              />
            )}
          </div>
        )}
      </div>

      {/* Body template */}
      {method !== "GET" && (
        <div className="space-y-2">
          <Label htmlFor="http-body-textarea">Request body</Label>
          <textarea
            id="http-body-textarea"
            ref={bodyTextareaRef}
            rows={4}
            value={body}
            placeholder={'{"task": "{{task.name}}", "url": "{{task.url}}"}'}
            onChange={(e) => onChangeConfig("body", e.target.value)}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 font-mono text-xs text-ink placeholder:text-ink-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          />
          {fieldErrors["action.configuration.body"] && (
            <p className="text-xs text-danger-text">
              {fieldErrors["action.configuration.body"]}
            </p>
          )}
          <VariableChips
            variables={variables}
            label="Insert into body"
            onInsert={(path) =>
              insertVariableIntoInput(
                bodyTextareaRef.current,
                body,
                path,
                (next) => onChangeConfig("body", next),
              )
            }
          />
        </div>
      )}

      {/* Test Request */}
      <div className="space-y-2.5 border-t border-border pt-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          loading={testing}
          onClick={() => void handleTestRequest()}
        >
          <Play className="h-3.5 w-3.5" aria-hidden="true" />
          Test Request
        </Button>

        {testResult && (
          <div
            data-testid="http-test-result"
            className={`space-y-2 rounded-lg border p-3 text-xs ${
              testResult.ok
                ? "border-success-border bg-success-soft/50"
                : "border-danger-border bg-danger-soft/50"
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Badge variant={testResult.ok ? "success" : "danger"}>
                  {testResult.status !== null
                    ? `HTTP ${testResult.status}`
                    : "Blocked / Failed"}
                </Badge>
                <span className="font-medium text-ink">{testResult.message}</span>
              </div>
              {testResult.durationMs > 0 && (
                <span className="text-ink-muted">{testResult.durationMs} ms</span>
              )}
            </div>

            {testResult.responsePreview && (
              <pre className="max-h-36 overflow-auto rounded border border-border bg-surface p-2 font-mono text-[11px] text-ink-secondary">
                {testResult.responsePreview}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
