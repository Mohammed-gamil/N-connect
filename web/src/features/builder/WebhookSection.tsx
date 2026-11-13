import * as React from "react";
import { Check, Copy, KeyRound, RefreshCw, ShieldCheck } from "lucide-react";
import {
  Badge,
  Button,
  Input,
  Label,
  useToast,
} from "../../components/ui";
import type {
  VariableDefinition,
  WebhookInfo,
  WebhookSample,
} from "../../contracts";
import { api, ApiClientError } from "../../lib/api";
import { formatRelativeTime } from "../../lib/utils";

const VERIFICATION_OPTIONS = [
  { value: "hmac_sha256", label: "HMAC-SHA256 signature (X-Hub-Signature-256)" },
  { value: "shared_token", label: "Shared bearer / header token" },
  { value: "none", label: "None (accept any POST payload)" },
];

export function extractBodyVariablesFromSamples(
  samples: WebhookSample[],
): VariableDefinition[] {
  const seen = new Map<string, VariableDefinition>();

  function walk(obj: unknown, prefix: string, depth: number) {
    if (depth > 2 || obj === null || typeof obj !== "object" || Array.isArray(obj)) {
      return;
    }
    for (const [key, val] of Object.entries(obj)) {
      if (!/^[a-zA-Z0-9_]+$/.test(key)) continue;
      const path = `${prefix}.${key}`;
      if (val !== null && typeof val === "object" && !Array.isArray(val) && depth < 2) {
        walk(val, path, depth + 1);
      } else if (!seen.has(path)) {
        const example =
          typeof val === "string"
            ? val.slice(0, 48)
            : typeof val === "number" || typeof val === "boolean"
              ? String(val)
              : JSON.stringify(val ?? "").slice(0, 48);
        seen.set(path, {
          path,
          label: path.replace(/^body\./, ""),
          example,
        });
      }
    }
  }

  for (const sample of samples) {
    walk(sample.payload, "body", 0);
  }

  return Array.from(seen.values());
}

export interface WebhookSectionProps {
  automationId?: string;
  verification: string;
  onChangeVerification: (verification: string) => void;
  onEnsureSavedDraft: () => Promise<string | null>;
  onVariablesDiscovered?: (vars: VariableDefinition[]) => void;
}

export const WebhookSection: React.FC<WebhookSectionProps> = ({
  automationId,
  verification,
  onChangeVerification,
  onEnsureSavedDraft,
  onVariablesDiscovered,
}) => {
  const { toast } = useToast();

  const [info, setInfo] = React.useState<WebhookInfo | null>(null);
  const [samples, setSamples] = React.useState<WebhookSample[]>([]);
  const [oneTimeSecret, setOneTimeSecret] = React.useState<string | null>(null);
  const [loadingInfo, setLoadingInfo] = React.useState(false);
  const [loadingSamples, setLoadingSamples] = React.useState(false);
  const [rotating, setRotating] = React.useState(false);
  const [copiedUrl, setCopiedUrl] = React.useState(false);
  const [copiedSecret, setCopiedSecret] = React.useState(false);

  const loadWebhookData = React.useCallback(
    async (id: string, signal?: AbortSignal) => {
      setLoadingInfo(true);
      setLoadingSamples(true);
      try {
        const [whInfo, whSamples] = await Promise.all([
          api.getWebhookInfo(id, signal),
          api.listWebhookSamples(id, signal),
        ]);
        setInfo(whInfo);
        setSamples(whSamples.samples);
        onVariablesDiscovered?.(extractBodyVariablesFromSamples(whSamples.samples));
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
      } finally {
        setLoadingInfo(false);
        setLoadingSamples(false);
      }
    },
    [onVariablesDiscovered],
  );

  React.useEffect(() => {
    if (!automationId) return;
    const controller = new AbortController();
    void loadWebhookData(automationId, controller.signal);
    return () => controller.abort();
  }, [automationId, loadWebhookData]);

  async function handleCopy(text: string, which: "url" | "secret") {
    try {
      await navigator.clipboard.writeText(text);
      if (which === "url") {
        setCopiedUrl(true);
        setTimeout(() => setCopiedUrl(false), 1800);
      } else {
        setCopiedSecret(true);
        setTimeout(() => setCopiedSecret(false), 1800);
      }
      toast({
        title: which === "url" ? "Webhook URL copied" : "Secret copied",
        variant: "success",
        durationMs: 2500,
      });
    } catch {
      toast({
        title: "Copy failed",
        description: "Select and copy the text manually.",
        variant: "error",
      });
    }
  }

  async function handleRotateSecret() {
    if (rotating) return;
    setRotating(true);
    try {
      const id = automationId ?? (await onEnsureSavedDraft());
      if (!id) return;
      const rotated = await api.rotateWebhookSecret(id);
      setInfo(rotated);
      if (rotated.secret) {
        setOneTimeSecret(rotated.secret);
      }
      toast({
        title: "Webhook secret generated",
        description: "Copy it now — it will only be shown once.",
        variant: "success",
      });
    } catch (err) {
      toast({
        title: "Couldn't generate secret",
        description:
          err instanceof ApiClientError
            ? err.message
            : "Please save your draft and try again.",
        variant: "error",
      });
    } finally {
      setRotating(false);
    }
  }

  async function handleRefreshSamples() {
    if (loadingSamples) return;
    setLoadingSamples(true);
    try {
      const id = automationId ?? (await onEnsureSavedDraft());
      if (!id) return;
      const res = await api.listWebhookSamples(id);
      setSamples(res.samples);
      onVariablesDiscovered?.(extractBodyVariablesFromSamples(res.samples));
    } catch (err) {
      toast({
        title: "Couldn't refresh payloads",
        description:
          err instanceof ApiClientError
            ? err.message
            : "Please try again in a moment.",
        variant: "error",
      });
    } finally {
      setLoadingSamples(false);
    }
  }

  return (
    <div
      data-testid="webhook-advanced-section"
      className="space-y-4 rounded-xl border border-border bg-subtle/40 p-3.5"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <ShieldCheck className="h-4 w-4 text-accent" aria-hidden="true" />
          <h3 className="text-xs font-semibold text-ink">
            Webhook endpoint &amp; security
          </h3>
        </div>
        {info?.lastReceivedAt && (
          <Badge variant="success">
            Last event {formatRelativeTime(info.lastReceivedAt)}
          </Badge>
        )}
      </div>

      {/* Generated URL */}
      <div className="space-y-1.5">
        <Label htmlFor="webhook-url-input">Webhook URL</Label>
        {info?.url ? (
          <div className="flex items-center gap-2">
            <Input
              id="webhook-url-input"
              readOnly
              value={info.url}
              className="h-8 font-mono text-xs"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label="Copy webhook URL"
              onClick={() => void handleCopy(info.url, "url")}
            >
              {copiedUrl ? (
                <Check className="h-3.5 w-3.5 text-success" aria-hidden="true" />
              ) : (
                <Copy className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              Copy
            </Button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-dashed border-border bg-surface px-3 py-2 text-xs text-ink-secondary">
            <span>
              {loadingInfo
                ? "Generating webhook URL..."
                : "Save draft to generate your unique webhook URL."}
            </span>
            {!automationId && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void onEnsureSavedDraft()}
              >
                Generate URL
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Verification mode */}
      <div className="space-y-1.5">
        <Label htmlFor="webhook-verification-select">Verification mode</Label>
        <select
          id="webhook-verification-select"
          value={verification || "hmac_sha256"}
          onChange={(e) => onChangeVerification(e.target.value)}
          className="h-9 w-full rounded-lg border border-border bg-surface px-2.5 text-xs text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {VERIFICATION_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {/* Generate / Rotate secret */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-ink-secondary">
            Signing secret
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            loading={rotating}
            onClick={() => void handleRotateSecret()}
          >
            <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
            Generate / Rotate secret
          </Button>
        </div>

        {oneTimeSecret && (
          <div
            data-testid="webhook-one-time-secret"
            className="space-y-1.5 rounded-lg border border-warning-border bg-warning-soft p-2.5"
          >
            <p className="text-[11px] font-semibold text-warning-text">
              Copy this secret now — it will never be shown again.
            </p>
            <div className="flex items-center gap-2">
              <Input
                readOnly
                aria-label="Generated webhook secret"
                value={oneTimeSecret}
                className="h-8 bg-surface font-mono text-xs"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void handleCopy(oneTimeSecret, "secret")}
              >
                {copiedSecret ? (
                  <Check className="h-3.5 w-3.5 text-success" aria-hidden="true" />
                ) : (
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                Copy
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Recent payloads inspector */}
      <div className="space-y-2 border-t border-border pt-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-ink">
            Recent payloads ({samples.length})
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            loading={loadingSamples}
            onClick={() => void handleRefreshSamples()}
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            Refresh
          </Button>
        </div>

        {samples.length === 0 ? (
          <p className="text-xs text-ink-muted">
            Send a test POST request to your webhook URL to inspect incoming JSON
            fields as clickable variables.
          </p>
        ) : (
          <div className="max-h-48 space-y-2 overflow-y-auto pr-1">
            {samples.map((sample) => (
              <div
                key={sample.eventId}
                className="rounded-lg border border-border bg-surface p-2.5"
              >
                <div className="mb-1 flex items-center justify-between text-[11px] text-ink-muted">
                  <span className="font-mono">{sample.eventId}</span>
                  <span>{formatRelativeTime(sample.receivedAt)}</span>
                </div>
                <pre className="max-h-28 overflow-auto rounded bg-subtle p-2 font-mono text-[11px] text-ink-secondary">
                  {JSON.stringify(sample.payload, null, 2)}
                </pre>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
