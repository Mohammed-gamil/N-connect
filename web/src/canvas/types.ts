import type {
  AppDefinition,
  AppId,
  AuthKind,
  Automation,
  AutomationLayout,
  ConfigValue,
  FieldDefinition,
  Filter,
  FilterOp,
  VariableDefinition,
  WorkflowDefinitionV1,
  WorkflowStep,
} from "../contracts";

export type {
  AppDefinition,
  AppId,
  AuthKind,
  Automation,
  AutomationLayout,
  ConfigValue,
  FieldDefinition,
  Filter,
  FilterOp,
  VariableDefinition,
  WorkflowDefinitionV1,
  WorkflowStep,
};

export type NodeRole = "trigger" | "action";

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

export interface CanvasConnection {
  id: string;
  sourceNodeId: string;
  targetNodeId: string | null;
  freeEnd: { x: number; y: number } | null;
}

export interface CanvasState {
  nodes: Record<string, ApplicationNode>;
  connections: Record<string, CanvasConnection>;
  filters: Filter[];
  selectedNodeId: string | null;
  selectedSlot: NodeRole | null;
  connectFromNodeId: string | null;
}

export interface SerializedWorkflow {
  definition: WorkflowDefinitionV1;
  layout: AutomationLayout;
}
