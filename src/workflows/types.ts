export enum WorkflowState {
  DRAFT = "draft",
  REQUEST_SENT = "request_sent",
  QUOTE_RECEIVED = "quote_received",
  AWAITING_APPROVAL = "awaiting_approval",
  AUTHORIZED = "authorized",
  SUBMITTED = "submitted",
  CONFIRMED = "confirmed",
  RECONCILED = "reconciled",
  FAILED = "failed",
  CANCELLED = "cancelled",
}

export type WorkflowType = "kitchen_replenishment" | "customer_fulfilment" | "agency_milestone";

export interface WorkflowRecord {
  id: string;
  workspaceId: string;
  workflowType: WorkflowType;
  state: WorkflowState;
  contextData: Record<string, any>;
  errorMessage?: string;
  retryCount: number;
  idempotencyKey: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface TransitionOptions {
  fromState: WorkflowState | WorkflowState[];
  toState: WorkflowState;
  patchContext?: Record<string, any>;
  errorMessage?: string;
}
