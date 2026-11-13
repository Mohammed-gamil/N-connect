import type { AppDefinition, AppId, ConfigValue, VariableDefinition } from "../contracts";
import type { NodeRole } from "./types";

export interface AppVisualMeta {
  shortTag: string;
  role: NodeRole;
  accent: string;
  badgeBg: string;
  badgeText: string;
}

export const APP_VISUAL_META: Record<AppId, AppVisualMeta> = {
  clickup: {
    shortTag: "CU",
    role: "trigger",
    accent: "#7B68EE",
    badgeBg: "#EEF2FF",
    badgeText: "#4F46E5",
  },
  slack: {
    shortTag: "SL",
    role: "action",
    accent: "#E01E5A",
    badgeBg: "#FDF2F8",
    badgeText: "#BE185D",
  },
  webhook: {
    shortTag: "WH",
    role: "trigger",
    accent: "#0F766E",
    badgeBg: "#F0FDFA",
    badgeText: "#0F766E",
  },
  http: {
    shortTag: "HT",
    role: "action",
    accent: "#334155",
    badgeBg: "#F1F5F9",
    badgeText: "#334155",
  },
};

export const CLICKUP_DEFAULT_VARIABLES: VariableDefinition[] = [
  { path: "task.id", label: "Task ID", example: "8688abc12" },
  { path: "task.name", label: "Task name", example: "Ship the new onboarding" },
  { path: "task.url", label: "Task URL", example: "https://app.clickup.com/t/8688abc12" },
  { path: "task.status", label: "Status", example: "in progress" },
  { path: "task.description", label: "Description", example: "Update the welcome checklist" },
  { path: "task.assignees", label: "Assignees", example: "Alex Rivera" },
  { path: "task.creator", label: "Creator", example: "Sam Lee" },
  { path: "task.list", label: "List", example: "Product Roadmap" },
  { path: "task.due_date", label: "Due date", example: "2026-11-20" },
  { path: "task.priority", label: "Priority", example: "high" },
  { path: "event.type", label: "Event type", example: "taskCreated" },
];

export const DEFAULT_APPS: AppDefinition[] = [
  {
    id: "clickup",
    name: "ClickUp",
    description: "Trigger automations when tasks are created, updated, completed, or assigned.",
    iconUrl: "/icons/clickup.svg",
    authKind: "oauth2",
    tokenAuth: {
      label: "Personal API token",
      help: "Paste a ClickUp personal API token (pk_...) for quick testing without an OAuth app.",
      advanced: true,
    },
    triggers: [
      {
        id: "task.created",
        label: "When a task is created",
        description: "Runs whenever a new task is added.",
        fields: [
          {
            key: "workspaceId",
            label: "Which ClickUp workspace should we watch?",
            type: "dynamic_select",
            required: true,
            placeholder: "Select a workspace",
          },
          {
            key: "listId",
            label: "Limit to a specific list (optional)",
            type: "dynamic_select",
            required: false,
            placeholder: "All lists in workspace",
            help: "Leave empty to trigger for every list in the workspace.",
            dependsOn: "workspaceId",
          },
        ],
        variables: CLICKUP_DEFAULT_VARIABLES,
      },
      {
        id: "task.updated",
        label: "When a task is updated",
        description: "Runs whenever a task is edited.",
        fields: [
          {
            key: "workspaceId",
            label: "Which ClickUp workspace should we watch?",
            type: "dynamic_select",
            required: true,
            placeholder: "Select a workspace",
          },
          {
            key: "listId",
            label: "Limit to a specific list (optional)",
            type: "dynamic_select",
            required: false,
            placeholder: "All lists in workspace",
            dependsOn: "workspaceId",
          },
        ],
        variables: CLICKUP_DEFAULT_VARIABLES,
      },
      {
        id: "task.completed",
        label: "When a task is completed",
        description: "Runs when a task moves into a closed/done status.",
        fields: [
          {
            key: "workspaceId",
            label: "Which ClickUp workspace should we watch?",
            type: "dynamic_select",
            required: true,
            placeholder: "Select a workspace",
          },
          {
            key: "listId",
            label: "Limit to a specific list (optional)",
            type: "dynamic_select",
            required: false,
            placeholder: "All lists in workspace",
            dependsOn: "workspaceId",
          },
        ],
        variables: CLICKUP_DEFAULT_VARIABLES,
      },
      {
        id: "task.assigned",
        label: "When a task is assigned",
        description: "Runs when someone is assigned to a task.",
        fields: [
          {
            key: "workspaceId",
            label: "Which ClickUp workspace should we watch?",
            type: "dynamic_select",
            required: true,
            placeholder: "Select a workspace",
          },
          {
            key: "listId",
            label: "Limit to a specific list (optional)",
            type: "dynamic_select",
            required: false,
            placeholder: "All lists in workspace",
            dependsOn: "workspaceId",
          },
        ],
        variables: CLICKUP_DEFAULT_VARIABLES,
      },
    ],
    actions: [],
  },
  {
    id: "slack",
    name: "Slack",
    description: "Post formatted messages to Slack channels.",
    iconUrl: "/icons/slack.svg",
    authKind: "oauth2",
    triggers: [],
    actions: [
      {
        id: "message.send",
        label: "Send a message",
        description: "Post a message to a public or private Slack channel.",
        fields: [
          {
            key: "channel",
            label: "Where should we send the message?",
            type: "dynamic_select",
            required: true,
            placeholder: "Choose a channel",
          },
          {
            key: "message",
            label: "What should the message say?",
            type: "template",
            required: true,
            placeholder: "New task: {{task.name}} ({{task.url}})",
            help: "Use {{variable}} placeholders from your trigger.",
          },
        ],
      },
    ],
  },
  {
    id: "webhook",
    name: "Custom Webhook",
    description: "Start an automation when any external service sends an HTTP POST.",
    iconUrl: "/icons/webhook.svg",
    authKind: "none",
    advanced: true,
    triggers: [
      {
        id: "webhook.received",
        label: "When a webhook is received",
        description: "Generates a unique URL you can call with JSON payloads.",
        fields: [
          {
            key: "verification",
            label: "How should incoming requests be verified?",
            type: "select",
            required: true,
            advanced: true,
            options: [
              { value: "hmac_sha256", label: "HMAC-SHA256 signature" },
              { value: "shared_token", label: "Shared bearer/header token" },
              { value: "none", label: "No signature check" },
            ],
          },
        ],
        variables: [
          { path: "body.event", label: "Event name", example: "order.paid" },
          { path: "body.id", label: "Payload ID", example: "evt_123" },
          { path: "body.data", label: "Payload data", example: "{\"amount\":42}" },
        ],
      },
    ],
    actions: [],
  },
  {
    id: "http",
    name: "HTTP Request",
    description: "Call any external HTTPS API endpoint with SSRF protection.",
    iconUrl: "/icons/http.svg",
    authKind: "api_token",
    advanced: true,
    tokenAuth: {
      label: "API credential",
      help: "Store an encrypted token or credential for HTTP requests.",
      advanced: true,
    },
    triggers: [],
    actions: [
      {
        id: "http.request",
        label: "Send an HTTP request",
        description: "Make an outbound HTTP call with templated URL, headers, and body.",
        advanced: true,
        fields: [
          {
            key: "method",
            label: "HTTP method",
            type: "select",
            required: true,
            advanced: true,
            options: [
              { value: "POST", label: "POST" },
              { value: "GET", label: "GET" },
              { value: "PUT", label: "PUT" },
              { value: "PATCH", label: "PATCH" },
              { value: "DELETE", label: "DELETE" },
            ],
          },
          {
            key: "url",
            label: "Destination URL",
            type: "template",
            required: true,
            placeholder: "https://api.example.com/webhooks",
            advanced: true,
          },
          {
            key: "headers",
            label: "Headers",
            type: "key_value",
            required: false,
            advanced: true,
          },
          {
            key: "authType",
            label: "Authentication",
            type: "select",
            required: false,
            advanced: true,
            options: [
              { value: "none", label: "None" },
              { value: "bearer", label: "Bearer token" },
              { value: "api_key", label: "API key header" },
              { value: "basic", label: "Basic auth" },
            ],
          },
          {
            key: "body",
            label: "Request body",
            type: "template",
            required: false,
            placeholder: "{\"task\":\"{{task.name}}\"}",
            advanced: true,
          },
        ],
      },
    ],
  },
];

export function getAppById(apps: AppDefinition[], appId: AppId): AppDefinition {
  return (
    apps.find((a) => a.id === appId) ??
    DEFAULT_APPS.find((a) => a.id === appId) ??
    DEFAULT_APPS[0]
  );
}

export function getAppRole(app: AppDefinition): NodeRole {
  if (app.triggers.length > 0) return "trigger";
  if (app.actions.length > 0) return "action";
  return APP_VISUAL_META[app.id]?.role ?? "action";
}

export function getVisibleApps(
  apps: AppDefinition[],
  advancedMode: boolean,
): AppDefinition[] {
  const source = apps.length > 0 ? apps : DEFAULT_APPS;
  return source.filter((app) => !app.advanced || advancedMode);
}

export function getDefaultConfigForApp(
  app: AppDefinition,
): Record<string, ConfigValue> {
  if (app.id === "webhook") {
    return { verification: "hmac_sha256" };
  }
  if (app.id === "http") {
    return {
      method: "POST",
      url: "",
      headers: [],
      authType: "none",
      body: "",
    };
  }
  return {};
}

export function getTriggerVariables(
  apps: AppDefinition[],
  triggerAppId?: AppId,
  triggerEvent?: string,
): VariableDefinition[] {
  if (!triggerAppId) return [];
  const app = getAppById(apps, triggerAppId);
  const trigger =
    app.triggers.find((t) => t.id === triggerEvent) ?? app.triggers[0];
  return trigger?.variables ?? [];
}
