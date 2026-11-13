import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import type { AppId, UnixMs } from "../contracts";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatRelativeTime(timestampMs: UnixMs | null, nowMs = Date.now()): string {
  if (timestampMs === null || timestampMs === undefined) {
    return "No runs yet";
  }

  const diffSeconds = Math.max(0, Math.floor((nowMs - timestampMs) / 1000));
  if (diffSeconds < 45) return "Just now";

  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(new Date(timestampMs));
}

const APP_NAMES: Record<AppId, string> = {
  clickup: "ClickUp",
  slack: "Slack",
  webhook: "Custom Webhook",
  http: "HTTP Request",
};

export function getAppName(appId: AppId): string {
  return APP_NAMES[appId] ?? appId;
}
