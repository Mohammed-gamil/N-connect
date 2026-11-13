export type AppId = "clickup" | "slack" | "webhook" | "http";

export type AuthKind = "oauth2" | "api_token" | "none";

export type NodeRole = "trigger" | "action";

export type ConfigValue =
  | string
  | { value: string; label: string }
  | { key: string; value: string }[]
  | null;

export type FilterOp =
  | "equals"
  | "not_equals"
  | "contains"
  | "not_contains"
  | "is_empty"
  | "is_not_empty";

export interface Filter {
  path: string;
  op: FilterOp;
  value?: string;
}

export interface WorkflowStep {
  application: AppId;
  event: string;
  connectionId: string | null;
  configuration: Record<string, ConfigValue>;
}

export interface WorkflowDefinitionV1 {
  version: 1;
  trigger: WorkflowStep;
  filters: Filter[];
  action: WorkflowStep;
}

export interface AutomationLayout {
  nodes: Record<string, { x: number; y: number }>;
}

export interface SerializedWorkflow {
  definition: WorkflowDefinitionV1;
  layout: AutomationLayout;
}

export interface ApplicationNode {
  id: string;
  applicationId: AppId;
  role: NodeRole;
  x: number;
  y: number;
  event: string;
  connectionId: string | null;
  configuration: Record<string, ConfigValue>;
}

export interface Connection {
  id: string;
  sourceNodeId: string;
  targetNodeId: string | null;
  freeEnd: { x: number; y: number } | null;
}

export interface CanvasState {
  nodes: Record<string, ApplicationNode>;
  connections: Record<string, Connection>;
  selectedNodeId: string | null;
  connectFromNodeId: string | null;
}
