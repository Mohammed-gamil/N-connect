import { ExternalLink } from "lucide-react";

export type TokenAppId = "clickup" | "slack" | "http";

export const TOKEN_CONNECT_META: Record<
  TokenAppId,
  {
    title: string;
    description: string;
    tokenLabel: string;
    tokenPlaceholder: string;
    namePlaceholder: string;
    steps: string[];
    portalUrl?: string;
    portalLabel?: string;
  }
> = {
  clickup: {
    title: "Connect ClickUp with an API token",
    description:
      "Fastest way to connect ClickUp without creating an OAuth app. Your token is encrypted at rest.",
    tokenLabel: "Personal API token",
    tokenPlaceholder: "pk_...",
    namePlaceholder: "e.g. Acme ClickUp Workspace",
    steps: [
      "Open ClickUp, click your avatar, and go to Settings.",
      "Select Apps under My Settings.",
      "Click Generate (or Copy) next to API Token and paste it below.",
    ],
    portalUrl: "https://app.clickup.com",
    portalLabel: "Open ClickUp",
  },
  slack: {
    title: "Connect Slack with a Bot token",
    description:
      "Instant Slack setup without OAuth Redirect URLs. Your Bot token is encrypted at rest and never shown again.",
    tokenLabel: "Bot User OAuth token",
    tokenPlaceholder: "xoxb-...",
    namePlaceholder: "e.g. Acme Slack Workspace",
    steps: [
      "Open Slack API Apps and create a new app (From scratch).",
      "Under OAuth & Permissions → Bot Token Scopes, add: chat:write, chat:write.public, channels:read, groups:read.",
      "Click Install to Workspace, then copy the Bot User OAuth Token (xoxb-...) and paste it below.",
    ],
    portalUrl: "https://api.slack.com/apps",
    portalLabel: "Open Slack API Apps",
  },
  http: {
    title: "Add HTTP credential",
    description:
      "Store a Bearer token, API key, or user:password Basic credential encrypted at rest.",
    tokenLabel: "Token or secret",
    tokenPlaceholder: "Paste secret...",
    namePlaceholder: "e.g. Production API Key",
    steps: [],
  },
};

export function TokenGuideBox({
  appId,
  compact = false,
}: {
  appId: TokenAppId;
  compact?: boolean;
}) {
  const meta = TOKEN_CONNECT_META[appId];
  if (meta.steps.length === 0) return null;

  return (
    <div
      className={`rounded-lg border border-border bg-subtle/60 ${
        compact ? "p-2.5 text-[11px]" : "p-3 text-xs"
      } space-y-1.5 text-ink-secondary`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold text-ink">How to get your token</span>
        {meta.portalUrl && (
          <a
            href={meta.portalUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-medium text-accent hover:underline"
          >
            {meta.portalLabel}
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </a>
        )}
      </div>
      <ol className="list-decimal space-y-1 pl-4">
        {meta.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
    </div>
  );
}
