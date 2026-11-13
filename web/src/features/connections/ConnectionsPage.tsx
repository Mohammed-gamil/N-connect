import * as React from "react";
import { useSearchParams } from "react-router-dom";
import {
  CheckCircle2,
  ExternalLink,
  KeyRound,
  Plug,
  RefreshCw,
  Settings2,
  Trash2,
} from "lucide-react";
import { AppIcon } from "../../components/AppIcon";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Input,
  Label,
  Skeleton,
  useToast,
} from "../../components/ui";
import type {
  AppId,
  Connection,
  ConnectionStatus,
  OAuthAppConfigStatus,
} from "../../contracts";
import { api, ApiClientError } from "../../lib/api";
import { formatRelativeTime, getAppName } from "../../lib/utils";
import { OAuthAppSetupDialog } from "./OAuthAppSetupDialog";
import {
  TOKEN_CONNECT_META,
  TokenGuideBox,
  type TokenAppId,
} from "./TokenGuideBox";

const STATUS_BADGE: Record<
  ConnectionStatus,
  { label: string; variant: "success" | "warning" | "danger" }
> = {
  connected: { label: "Connected", variant: "success" },
  needs_attention: { label: "Needs attention", variant: "warning" },
  revoked: { label: "Revoked", variant: "danger" },
};

const CONNECT_ERROR_MESSAGES: Record<string, string> = {
  access_denied: "Authorization was canceled before connecting.",
  invalid_state: "Your OAuth session expired. Please try connecting again.",
  oauth_failed: "The app provider rejected the connection request.",
  missing_code: "No authorization code was returned from the provider.",
};

function formatDate(timestampMs: number): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(timestampMs));
}

function defaultOAuthStatus(appId: "clickup" | "slack"): OAuthAppConfigStatus {
  const origin =
    typeof window !== "undefined" ? window.location.origin : "http://localhost:8787";
  return appId === "slack"
    ? {
        applicationId: "slack",
        name: "Slack",
        configured: false,
        source: "none",
        clientId: null,
        redirectUrl: `${origin}/api/oauth/slack/callback`,
        requiredScopes: [
          "chat:write",
          "chat:write.public",
          "channels:read",
          "groups:read",
        ],
        docsHint:
          "In api.slack.com/apps → Create New App → OAuth & Permissions, add the Redirect URL and Bot Token Scopes above, then copy Client ID and Client Secret from Basic Information.",
        updatedAt: null,
      }
    : {
        applicationId: "clickup",
        name: "ClickUp",
        configured: false,
        source: "none",
        clientId: null,
        redirectUrl: `${origin}/api/oauth/clickup/callback`,
        requiredScopes: [],
        docsHint:
          "In ClickUp → Settings → ClickUp API (or Integrations) → Create an App, paste the Redirect URL above, then copy your Client ID and Client Secret.",
        updatedAt: null,
      };
}

export function ConnectionsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { toast } = useToast();

  const [connections, setConnections] = React.useState<Connection[]>([]);
  const [oauthApps, setOauthApps] = React.useState<OAuthAppConfigStatus[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const [testingIds, setTestingIds] = React.useState<Record<string, boolean>>({});
  const [testMessages, setTestMessages] = React.useState<
    Record<string, { ok: boolean; message: string }>
  >({});
  const [oauthLoadingApp, setOauthLoadingApp] = React.useState<AppId | null>(null);

  const [disconnectTarget, setDisconnectTarget] = React.useState<Connection | null>(
    null,
  );
  const [disconnecting, setDisconnecting] = React.useState(false);

  const [tokenModalApp, setTokenModalApp] = React.useState<TokenAppId | null>(null);
  const [tokenDisplayName, setTokenDisplayName] = React.useState("");
  const [tokenValue, setTokenValue] = React.useState("");
  const [savingToken, setSavingToken] = React.useState(false);
  const [tokenError, setTokenError] = React.useState<string | null>(null);

  const [oauthSetupAppId, setOauthSetupAppId] = React.useState<
    "clickup" | "slack" | null
  >(null);

  const loadConnections = React.useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setLoadError(null);
    try {
      const [connData, oauthData] = await Promise.all([
        api.listConnections(signal),
        api.listOAuthApps(signal).catch(() => ({ apps: [] })),
      ]);
      setConnections(connData.connections);
      setOauthApps(oauthData.apps);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        return;
      }
      setLoadError(
        err instanceof ApiClientError
          ? err.message
          : "We couldn't load your connected apps right now.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    const controller = new AbortController();
    void loadConnections(controller.signal);
    return () => controller.abort();
  }, [loadConnections]);

  // Read OAuth redirect result params (?connected=... or ?connectError=...)
  React.useEffect(() => {
    const connectedId = searchParams.get("connected");
    const connectError = searchParams.get("connectError");
    if (!connectedId && !connectError) return;

    if (connectedId) {
      toast({
        title: "App connected",
        description: "Your account is ready to use in automations.",
        variant: "success",
      });
      void loadConnections();
    } else if (connectError) {
      toast({
        title: "Couldn't connect account",
        description:
          CONNECT_ERROR_MESSAGES[connectError] ??
          "Authorization didn't complete. Please try again.",
        variant: "error",
      });
    }

    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete("connected");
    nextParams.delete("connectError");
    setSearchParams(nextParams, { replace: true });
  }, [loadConnections, searchParams, setSearchParams, toast]);

  function getOAuthStatus(appId: "clickup" | "slack"): OAuthAppConfigStatus {
    return (
      oauthApps.find((a) => a.applicationId === appId) ?? defaultOAuthStatus(appId)
    );
  }

  function handleOAuthAppSaved(updated: OAuthAppConfigStatus) {
    setOauthApps((prev) => {
      const exists = prev.some((a) => a.applicationId === updated.applicationId);
      if (exists) {
        return prev.map((a) =>
          a.applicationId === updated.applicationId ? updated : a,
        );
      }
      return [...prev, updated];
    });
  }

  async function handleStartOAuth(appId: "clickup" | "slack") {
    if (oauthLoadingApp) return;
    setOauthLoadingApp(appId);
    try {
      const { redirectUrl } = await api.startOAuth(appId, "/connections");
      window.location.assign(redirectUrl);
    } catch (err) {
      toast({
        title: `Couldn't start ${getAppName(appId)} OAuth`,
        description:
          err instanceof ApiClientError
            ? err.message
            : "Please try again in a moment.",
        variant: "error",
      });
      setOauthLoadingApp(null);
    }
  }

  async function handleTestConnection(conn: Connection) {
    if (testingIds[conn.id]) return;
    setTestingIds((prev) => ({ ...prev, [conn.id]: true }));
    try {
      const result = await api.testConnection(conn.id);
      setTestMessages((prev) => ({ ...prev, [conn.id]: result }));
      toast({
        title: result.ok
          ? `${conn.displayName} is healthy`
          : `${conn.displayName} needs attention`,
        description: result.message,
        variant: result.ok ? "success" : "error",
      });
      if (!result.ok) {
        setConnections((prev) =>
          prev.map((c) =>
            c.id === conn.id ? { ...c, status: "needs_attention" } : c,
          ),
        );
      }
    } catch (err) {
      const message =
        err instanceof ApiClientError
          ? err.message
          : "Connection check failed. Please try again.";
      setTestMessages((prev) => ({
        ...prev,
        [conn.id]: { ok: false, message },
      }));
      toast({
        title: "Connection test failed",
        description: message,
        variant: "error",
      });
    } finally {
      setTestingIds((prev) => {
        const next = { ...prev };
        delete next[conn.id];
        return next;
      });
    }
  }

  function handleReconnect(conn: Connection) {
    if (conn.applicationId === "http") {
      openTokenModal("http", conn.displayName);
      return;
    }
    if (conn.applicationId === "clickup" || conn.applicationId === "slack") {
      const status = getOAuthStatus(conn.applicationId);
      if (status.configured) {
        void handleStartOAuth(conn.applicationId);
      } else {
        openTokenModal(conn.applicationId, conn.displayName);
      }
    }
  }

  function openTokenModal(appId: TokenAppId, initialDisplayName = "") {
    setTokenModalApp(appId);
    setTokenDisplayName(initialDisplayName);
    setTokenValue("");
    setTokenError(null);
  }

  async function handleCreateTokenConnection(e: React.FormEvent) {
    e.preventDefault();
    if (!tokenModalApp || savingToken) return;
    const trimmedToken = tokenValue.trim();
    if (!trimmedToken) {
      setTokenError("Please paste an API token or credential.");
      return;
    }

    setSavingToken(true);
    setTokenError(null);
    try {
      const created = await api.createTokenConnection({
        applicationId: tokenModalApp,
        token: trimmedToken,
        displayName: tokenDisplayName.trim() || undefined,
      });
      setConnections((prev) => [created, ...prev]);
      setTokenModalApp(null);
      setTokenDisplayName("");
      setTokenValue("");
      toast({
        title: `${getAppName(tokenModalApp)} connected`,
        description: `Saved “${created.displayName}” securely.`,
        variant: "success",
      });
    } catch (err) {
      setTokenError(
        err instanceof ApiClientError
          ? err.message
          : "Couldn't save that credential. Please check the token and try again.",
      );
    } finally {
      setSavingToken(false);
    }
  }

  async function handleConfirmDisconnect() {
    if (!disconnectTarget || disconnecting) return;
    const target = disconnectTarget;
    setDisconnecting(true);
    try {
      await api.deleteConnection(target.id);
      setConnections((prev) => prev.filter((c) => c.id !== target.id));
      setDisconnectTarget(null);
      toast({
        title: "Connection removed",
        description: `“${target.displayName}” has been disconnected.`,
        variant: "success",
      });
    } catch (err) {
      toast({
        title: "Couldn't disconnect account",
        description:
          err instanceof ApiClientError
            ? err.message
            : "Please try again in a moment.",
        variant: "error",
      });
    } finally {
      setDisconnecting(false);
    }
  }

  function renderOAuthAppCard(appId: "clickup" | "slack") {
    const status = getOAuthStatus(appId);
    const isClickUp = appId === "clickup";
    const description = isClickUp
      ? "Trigger automations when tasks change"
      : "Deliver formatted messages to channels";
    const tokenBtnLabel = isClickUp
      ? "Paste API token (pk_...)"
      : "Paste Bot token (xoxb-...)";

    return (
      <Card key={appId} className="flex flex-col justify-between">
        <CardHeader className="flex-row items-start justify-between gap-3 space-y-0 pb-3">
          <div className="flex items-start gap-3">
            <AppIcon appId={appId} size="lg" />
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle className="text-base">{status.name}</CardTitle>
                {status.source === "organization" ? (
                  <Badge variant="success">Custom OAuth</Badge>
                ) : status.source === "server" ? (
                  <Badge variant="success">OAuth ready</Badge>
                ) : (
                  <Badge variant="neutral">Token ready</Badge>
                )}
              </div>
              <CardDescription className="mt-0.5">{description}</CardDescription>
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-2.5 pt-0">
          {status.configured ? (
            <>
              <Button
                className="w-full"
                size="sm"
                loading={oauthLoadingApp === appId}
                onClick={() => void handleStartOAuth(appId)}
              >
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                Connect {status.name}
              </Button>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => openTokenModal(appId)}
                >
                  <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
                  Use token
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setOauthSetupAppId(appId)}
                >
                  <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
                  OAuth setup
                </Button>
              </div>
            </>
          ) : (
            <>
              <Button
                className="w-full"
                size="sm"
                onClick={() => openTokenModal(appId)}
              >
                <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
                {tokenBtnLabel}
              </Button>
              <Button
                variant="outline"
                className="w-full"
                size="sm"
                onClick={() => setOauthSetupAppId(appId)}
              >
                <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
                Configure 1-click OAuth app
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    );
  }

  const tokenMeta = tokenModalApp ? TOKEN_CONNECT_META[tokenModalApp] : null;
  const activeOAuthSetupStatus = oauthSetupAppId
    ? getOAuthStatus(oauthSetupAppId)
    : null;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">
          Connections
        </h1>
        <p className="mt-1 text-sm text-ink-secondary">
          Connect ClickUp, Slack, or HTTP credentials directly with an API/Bot token, or configure your workspace&apos;s own OAuth app.
        </p>
      </div>

      {/* Connected accounts list */}
      <section aria-label="Connected accounts" className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-ink-secondary">
            Connected accounts ({connections.length})
          </h2>
        </div>

        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-20 w-full rounded-xl" />
            <Skeleton className="h-20 w-full rounded-xl" />
          </div>
        ) : loadError ? (
          <Card className="p-6">
            <p className="text-sm font-medium text-ink">
              Unable to load connections
            </p>
            <p className="mt-1 text-sm text-ink-secondary">{loadError}</p>
            <div className="mt-4">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void loadConnections()}
              >
                Try again
              </Button>
            </div>
          </Card>
        ) : connections.length === 0 ? (
          <EmptyState
            icon={<Plug className="h-5 w-5" aria-hidden="true" />}
            title="No connected apps yet"
            description="Paste an API/Bot token or set up OAuth below to connect ClickUp and Slack in seconds."
          />
        ) : (
          <div className="space-y-3">
            {connections.map((conn) => {
              const badge = STATUS_BADGE[conn.status];
              const testResult = testMessages[conn.id];
              const isTesting = Boolean(testingIds[conn.id]);

              return (
                <Card key={conn.id} data-testid={`connection-card-${conn.id}`}>
                  <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 items-start gap-3.5">
                      <AppIcon appId={conn.applicationId} size="lg" />
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="truncate text-sm font-semibold text-ink">
                            {conn.displayName}
                          </h3>
                          <Badge variant={badge.variant}>{badge.label}</Badge>
                        </div>
                        <p className="mt-0.5 text-xs text-ink-secondary">
                          {getAppName(conn.applicationId)} · Connected{" "}
                          {formatDate(conn.createdAt)} (
                          {formatRelativeTime(conn.createdAt)})
                        </p>
                        {testResult && (
                          <p
                            className={`mt-1.5 flex items-center gap-1.5 text-xs ${
                              testResult.ok
                                ? "text-success-text"
                                : "text-danger-text"
                            }`}
                          >
                            {testResult.ok && (
                              <CheckCircle2
                                className="h-3.5 w-3.5 shrink-0"
                                aria-hidden="true"
                              />
                            )}
                            <span>{testResult.message}</span>
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        loading={isTesting}
                        onClick={() => void handleTestConnection(conn)}
                      >
                        Test
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        loading={oauthLoadingApp === conn.applicationId}
                        onClick={() => handleReconnect(conn)}
                      >
                        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                        Reconnect
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Disconnect ${conn.displayName}`}
                        onClick={() => setDisconnectTarget(conn)}
                        className="text-ink-secondary hover:bg-danger-soft hover:text-danger-text"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        Disconnect
                      </Button>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      {/* Connect an app section */}
      <section aria-label="Connect an app" className="space-y-3">
        <h2 className="text-sm font-medium text-ink-secondary">Connect an app</h2>
        <div className="grid gap-4 md:grid-cols-3">
          {renderOAuthAppCard("clickup")}
          {renderOAuthAppCard("slack")}

          {/* HTTP Credential */}
          <Card className="flex flex-col justify-between">
            <CardHeader className="flex-row items-start gap-3 space-y-0 pb-3">
              <AppIcon appId="http" size="lg" />
              <div>
                <CardTitle className="text-base">HTTP Credential</CardTitle>
                <CardDescription>
                  Encrypted Bearer, API key, or Basic auth secret
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              <Button
                variant="outline"
                className="w-full"
                size="sm"
                onClick={() => openTokenModal("http")}
              >
                <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
                Add HTTP credential
              </Button>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Token / Credential Modal */}
      <Dialog
        open={Boolean(tokenModalApp)}
        onOpenChange={(open) => {
          if (!open && !savingToken) setTokenModalApp(null);
        }}
        labelledBy="token-modal-title"
        describedBy="token-modal-desc"
        className="max-w-lg max-h-[90vh] overflow-y-auto"
      >
        {tokenModalApp && tokenMeta && (
          <form onSubmit={handleCreateTokenConnection}>
            <DialogHeader>
              <DialogTitle id="token-modal-title">
                {tokenMeta.title}
              </DialogTitle>
              <DialogDescription id="token-modal-desc">
                {tokenMeta.description}
              </DialogDescription>
            </DialogHeader>

            <div className="mt-4 space-y-4">
              <TokenGuideBox appId={tokenModalApp} />

              <div className="space-y-1.5">
                <Label htmlFor="token-display-name">Label (optional)</Label>
                <Input
                  id="token-display-name"
                  placeholder={tokenMeta.namePlaceholder}
                  value={tokenDisplayName}
                  onChange={(e) => setTokenDisplayName(e.target.value)}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="token-secret-input">
                  {tokenMeta.tokenLabel}
                </Label>
                <Input
                  id="token-secret-input"
                  type="password"
                  autoComplete="off"
                  placeholder={tokenMeta.tokenPlaceholder}
                  value={tokenValue}
                  error={Boolean(tokenError)}
                  onChange={(e) => setTokenValue(e.target.value)}
                />
                {tokenError && (
                  <p className="text-xs text-danger-text">{tokenError}</p>
                )}
              </div>
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                disabled={savingToken}
                onClick={() => setTokenModalApp(null)}
              >
                Cancel
              </Button>
              <Button type="submit" loading={savingToken}>
                Verify & Save
              </Button>
            </DialogFooter>
          </form>
        )}
      </Dialog>

      {/* OAuth App Setup Modal */}
      <OAuthAppSetupDialog
        open={Boolean(oauthSetupAppId)}
        status={activeOAuthSetupStatus}
        onOpenChange={(open) => {
          if (!open) setOauthSetupAppId(null);
        }}
        onSaved={handleOAuthAppSaved}
        onSaveAndConnect={handleStartOAuth}
      />

      {/* Disconnect confirmation dialog */}
      <Dialog
        open={Boolean(disconnectTarget)}
        onOpenChange={(open) => {
          if (!open && !disconnecting) setDisconnectTarget(null);
        }}
        labelledBy="disconnect-dialog-title"
        describedBy="disconnect-dialog-desc"
      >
        <DialogHeader>
          <DialogTitle id="disconnect-dialog-title">
            Disconnect account?
          </DialogTitle>
          <DialogDescription id="disconnect-dialog-desc">
            {disconnectTarget
              ? `“${disconnectTarget.displayName}” will be removed. Any active automations using this account will stop working until you reconnect.`
              : ""}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={disconnecting}
            onClick={() => setDisconnectTarget(null)}
          >
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={disconnecting}
            onClick={() => void handleConfirmDisconnect()}
          >
            Disconnect
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
