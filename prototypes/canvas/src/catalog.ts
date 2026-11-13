import type { AppId, ConfigValue, NodeRole } from "./types";

export interface FieldOption {
  value: string;
  label: string;
}

export interface FieldSpec {
  key: string;
  label: string;
  type: "select" | "dynamic_select" | "template";
  required: boolean;
  placeholder?: string;
  options?: FieldOption[];
}

export interface VariableSpec {
  path: string;
  label: string;
  example: string;
}

export interface EventSpec {
  id: string;
  label: string;
  phrase: string;
}

export interface AppCatalogEntry {
  id: AppId;
  name: string;
  shortTag: string;
  role: NodeRole;
  accent: string;
  badgeBg: string;
  badgeText: string;
  defaultConnectionId: string | null;
  events: EventSpec[];
  fields: FieldSpec[];
  variables: VariableSpec[];
  defaultConfig: () => Record<string, ConfigValue>;
}

export const APP_ORDER: AppId[] = ["clickup", "slack", "webhook", "http"];

export const APP_CATALOG: Record<AppId, AppCatalogEntry> = {
  clickup: {
    id: "clickup",
    name: "ClickUp",
    shortTag: "CU",
    role: "trigger",
    accent: "#7B68EE",
    badgeBg: "#EEF2FF",
    badgeText: "#4F46E5",
    defaultConnectionId: "con_clickup_acme",
    events: [
      {
        id: "task.created",
        label: "When a task is created",
        phrase: "a task is created in ClickUp",
      },
      {
        id: "task.updated",
        label: "When a task is updated",
        phrase: "a task is updated in ClickUp",
      },
      {
        id: "task.completed",
        label: "When a task is completed",
        phrase: "a task is completed in ClickUp",
      },
      {
        id: "task.assigned",
        label: "When a task is assigned",
        phrase: "a task is assigned in ClickUp",
      },
    ],
    fields: [
      {
        key: "workspaceId",
        label: "Workspace",
        type: "dynamic_select",
        required: true,
        options: [
          { value: "ws_9012345", label: "Acme Product" },
          { value: "ws_9012999", label: "Engineering Ops" },
        ],
      },
      {
        key: "listId",
        label: "List (optional)",
        type: "dynamic_select",
        required: false,
        options: [
          { value: "", label: "Any list in workspace" },
          { value: "list_sprint", label: "Sprint Backlog" },
          { value: "list_triage", label: "Bug Triage" },
          { value: "list_roadmap", label: "Product Roadmap" },
        ],
      },
    ],
    variables: [
      { path: "task.name", label: "Task name", example: "Ship the new onboarding" },
      { path: "task.url", label: "Task URL", example: "https://app.clickup.com/t/86a1" },
      { path: "task.status", label: "Status", example: "in progress" },
      { path: "task.assignees", label: "Assignees", example: "Alex Rivera" },
      { path: "task.list", label: "List", example: "Sprint Backlog" },
      { path: "task.priority", label: "Priority", example: "high" },
    ],
    defaultConfig: () => ({
      workspaceId: { value: "ws_9012345", label: "Acme Product" },
      listId: null,
    }),
  },
  slack: {
    id: "slack",
    name: "Slack",
    shortTag: "SL",
    role: "action",
    accent: "#E01E5A",
    badgeBg: "#FDF2F8",
    badgeText: "#BE185D",
    defaultConnectionId: "con_slack_acme",
    events: [
      {
        id: "message.send",
        label: "Send a message",
        phrase: "send a message",
      },
    ],
    fields: [
      {
        key: "channel",
        label: "Where should we send the message?",
        type: "dynamic_select",
        required: true,
        options: [
          { value: "C0123ABC", label: "#general" },
          { value: "C0456DEF", label: "#engineering" },
          { value: "C0789GHI", label: "#product-alerts" },
        ],
      },
      {
        key: "message",
        label: "Message",
        type: "template",
        required: true,
        placeholder: "New task: {{task.name}} ({{task.url}})",
      },
    ],
    variables: [],
    defaultConfig: () => ({
      channel: { value: "C0123ABC", label: "#general" },
      message: "New task: {{task.name}}",
    }),
  },
  webhook: {
    id: "webhook",
    name: "Webhook",
    shortTag: "WH",
    role: "trigger",
    accent: "#0F766E",
    badgeBg: "#F0FDFA",
    badgeText: "#0F766E",
    defaultConnectionId: null,
    events: [
      {
        id: "webhook.received",
        label: "When a webhook is received",
        phrase: "a webhook is received",
      },
    ],
    fields: [
      {
        key: "verification",
        label: "Signature verification",
        type: "select",
        required: true,
        options: [
          { value: "hmac_sha256", label: "HMAC-SHA256" },
          { value: "shared_token", label: "Shared token" },
          { value: "none", label: "None" },
        ],
      },
    ],
    variables: [
      { path: "body.id", label: "Payload ID", example: "evt_01J" },
      { path: "body.event", label: "Event name", example: "deploy.completed" },
      { path: "body.message", label: "Message", example: "Release v1.4 live" },
    ],
    defaultConfig: () => ({
      verification: "hmac_sha256",
    }),
  },
  http: {
    id: "http",
    name: "HTTP Request",
    shortTag: "HT",
    role: "action",
    accent: "#334155",
    badgeBg: "#F1F5F9",
    badgeText: "#334155",
    defaultConnectionId: "con_http_default",
    events: [
      {
        id: "http.request",
        label: "Send HTTP request",
        phrase: "send an HTTP request",
      },
    ],
    fields: [
      {
        key: "method",
        label: "Method",
        type: "select",
        required: true,
        options: [
          { value: "POST", label: "POST" },
          { value: "PUT", label: "PUT" },
          { value: "PATCH", label: "PATCH" },
          { value: "GET", label: "GET" },
        ],
      },
      {
        key: "url",
        label: "Endpoint URL",
        type: "template",
        required: true,
        placeholder: "https://api.example.com/hooks",
      },
      {
        key: "body",
        label: "Request body",
        type: "template",
        required: false,
        placeholder: '{"task": "{{task.name}}"}',
      },
    ],
    variables: [],
    defaultConfig: () => ({
      method: "POST",
      url: "https://api.example.com/hooks",
      body: '{"task": "{{task.name}}"}',
    }),
  },
};
