import type { InternalAuditRunInspectResult } from "./execution-decision-receipts.js";

export type ExecutionIdentityInspectionParams =
  | {
      runId: string;
      executionOffset?: number;
      executionLimit?: number;
      decisionCursor?: string;
      decisionLimit?: number;
    }
  | { executionId: string; decisionCursor?: string; decisionLimit?: number };

export type ExecutionIdentityInspectionQuery = ExecutionIdentityInspectionParams & { now: number };

export type ExecutionIdentityInspectionOutcome =
  | { status: "inspected"; inspection: InternalAuditRunInspectResult }
  | { status: "invalid-cursor"; message: string };
