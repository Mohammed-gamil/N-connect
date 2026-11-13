import * as React from "react";
import { Check, Copy, ExternalLink, ShieldCheck, Trash2 } from "lucide-react";
import { AppIcon } from "../../components/AppIcon";
import {
  Badge,
  Button,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  useToast,
} from "../../components/ui";
import type { OAuthAppConfigStatus } from "../../contracts";
import { api, ApiClientError } from "../../lib/api";

export interface OAuthAppSetupDialogProps {
  open: boolean;
  status: OAuthAppConfigStatus | null;
  onOpenChange: (open: boolean) => void;
  onSaved: (updated: OAuthAppConfigStatus) => void;
  onSaveAndConnect?: (appId: "clickup" | "slack") => Promise<void>;
}

const APP_PORTAL_LINKS: Record<
  "clickup" | "slack",
  { url: string; label: string }
> = {
  clickup: { url: "https://app.clickup.com", label: "Open ClickUp" },
  slack: { url: "https://api.slack.com/apps", label: "Open Slack API Apps" },
};

export function OAuthAppSetupDialog({
  open,
  status,
  onOpenChange,
  onSaved,
  onSaveAndConnect,
}: OAuthAppSetupDialogProps) {
  const { toast } = useToast();
  const [clientId, setClientId] = React.useState("");
  const [clientSecret, setClientSecret] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [removing, setRemoving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [copiedRedirect, setCopiedRedirect] = React.useState(false);
  const [copiedScopes, setCopiedScopes] = React.useState(false);

  React.useEffect(() => {
    if (!open || !status) return;
    setClientId(status.clientId ?? "");
    setClientSecret("");
    setError(null);
    setCopiedRedirect(false);
    setCopiedScopes(false);
  }, [open, status]);

  if (!status) return null;
  const appId = status.applicationId;
  const appName = status.name;
  const isOrgConfigured = status.source === "organization";
  const portal = APP_PORTAL_LINKS[appId];

  async function copyText(text: string, which: "redirect" | "scopes") {
    try {
      await navigator.clipboard.writeText(text);
      if (which === "redirect") {
        setCopiedRedirect(true);
        setTimeout(() => setCopiedRedirect(false), 1800);
      } else {
        setCopiedScopes(true);
        setTimeout(() => setCopiedScopes(false), 1800);
      }
    } catch {
      toast({
        title: "Copy failed",
        description: "Please select and copy the text manually.",
        variant: "error",
      });
    }
  }

  async function saveConfig(andConnect: boolean) {
    if (saving || removing) return;
    const trimmedId = clientId.trim();
    const trimmedSecret = clientSecret.trim();

    if (!trimmedId) {
      setError("Please enter your OAuth Client ID.");
      return;
    }
    if (!trimmedSecret && !isOrgConfigured) {
      setError("Please enter your OAuth Client Secret.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const updated = await api.saveOAuthApp(appId, {
        clientId: trimmedId,
        clientSecret: trimmedSecret || undefined,
      });
      onSaved(updated);
      toast({
        title: `${appName} OAuth saved`,
        description: "Your OAuth Client Secret is encrypted at rest.",
        variant: "success",
      });
      onOpenChange(false);
      if (andConnect && onSaveAndConnect) {
        await onSaveAndConnect(appId);
      }
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : "Couldn't save OAuth settings. Please check your inputs.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleRemoveCustom() {
    if (saving || removing) return;
    setRemoving(true);
    setError(null);
    try {
      await api.deleteOAuthApp(appId);
      const refreshed = await api.listOAuthApps();
      const next = refreshed.apps.find((a) => a.applicationId === appId);
      if (next) onSaved(next);
      toast({
        title: `Removed custom ${appName} OAuth`,
        description: "Workspace OAuth override has been deleted.",
        variant: "success",
      });
      onOpenChange(false);
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : "Couldn't remove OAuth settings right now.",
      );
    } finally {
      setRemoving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!saving && !removing) onOpenChange(next);
      }}
      labelledBy="oauth-setup-title"
      describedBy="oauth-setup-desc"
      className="max-w-lg max-h-[90vh] overflow-y-auto"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void saveConfig(Boolean(onSaveAndConnect));
        }}
      >
        <DialogHeader>
          <div className="flex items-center gap-3">
            <AppIcon appId={appId} size="md" />
            <div>
              <div className="flex items-center gap-2">
                <DialogTitle id="oauth-setup-title">
                  Configure {status.name} OAuth App
                </DialogTitle>
                {status.source === "organization" && (
                  <Badge variant="success">Custom</Badge>
                )}
                {status.source === "server" && (
                  <Badge variant="neutral">Server default</Badge>
                )}
              </div>
              <DialogDescription id="oauth-setup-desc">
                Allow anyone in your workspace to connect {status.name} with one click.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="mt-4 space-y-4">
          {/* Step 1: Copy Redirect URL */}
          <div className="space-y-1.5 rounded-xl border border-border bg-subtle/60 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-ink">
                1. Redirect URL (paste into {status.name})
              </span>
              <a
                href={portal.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
              >
                {portal.label}
                <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </a>
            </div>
            <div className="flex items-center gap-2">
              <Input
                readOnly
                value={status.redirectUrl}
                aria-label={`${status.name} OAuth Redirect URL`}
                onFocus={(e) => e.currentTarget.select()}
                className="h-8 bg-surface font-mono text-xs"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void copyText(status.redirectUrl, "redirect")}
              >
                {copiedRedirect ? (
                  <>
                    <Check className="h-3.5 w-3.5 text-success-text" aria-hidden="true" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                    Copy
                  </>
                )}
              </Button>
            </div>
          </div>

          {/* Step 2: Required Scopes (Slack) */}
          {status.requiredScopes.length > 0 && (
            <div className="space-y-2 rounded-xl border border-border bg-subtle/60 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-ink">
                  2. Required Bot Token Scopes
                </span>
                <button
                  type="button"
                  onClick={() =>
                    void copyText(status.requiredScopes.join(", "), "scopes")
                  }
                  className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
                >
                  {copiedScopes ? (
                    <>
                      <Check className="h-3 w-3" aria-hidden="true" />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy className="h-3 w-3" aria-hidden="true" />
                      Copy scopes
                    </>
                  )}
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {status.requiredScopes.map((scope) => (
                  <code
                    key={scope}
                    className="rounded-md border border-border bg-surface px-2 py-0.5 font-mono text-[11px] text-ink"
                  >
                    {scope}
                  </code>
                ))}
              </div>
            </div>
          )}

          <p className="text-xs leading-relaxed text-ink-secondary">
            {status.docsHint}
          </p>

          {/* Step 3: Client ID & Client Secret */}
          <div className="space-y-3 border-t border-border pt-3">
            <div className="space-y-1.5">
              <Label htmlFor="oauth-client-id">Client ID</Label>
              <Input
                id="oauth-client-id"
                autoComplete="off"
                placeholder={`Paste ${status.name} Client ID`}
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="oauth-client-secret">Client Secret</Label>
              <Input
                id="oauth-client-secret"
                type="password"
                autoComplete="off"
                placeholder={
                  isOrgConfigured
                    ? "Saved securely — leave blank to keep current"
                    : `Paste ${status.name} Client Secret`
                }
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
              />
              <p className="flex items-center gap-1.5 text-[11px] text-ink-muted">
                <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-success-text" aria-hidden="true" />
                Encrypted per workspace with AES-256-GCM and never shown again.
              </p>
            </div>

            {error && <p className="text-xs text-danger-text">{error}</p>}
          </div>
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            {isOrgConfigured && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                loading={removing}
                disabled={saving}
                onClick={() => void handleRemoveCustom()}
                className="text-danger-text hover:bg-danger-soft"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                Remove custom OAuth
              </Button>
            )}
          </div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button
              type="button"
              variant="outline"
              disabled={saving || removing}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            {onSaveAndConnect ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  loading={saving}
                  disabled={removing}
                  onClick={() => void saveConfig(false)}
                >
                  Save only
                </Button>
                <Button type="submit" loading={saving} disabled={removing}>
                  Save & Connect
                </Button>
              </>
            ) : (
              <Button type="submit" loading={saving} disabled={removing}>
                Save OAuth app
              </Button>
            )}
          </div>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
