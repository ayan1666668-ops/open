import type { Result } from "@openclaw/normalization-core/result";
import type { ErrorShape } from "../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { ModelExecutionSelection } from "../model-picker/execution-selection.js";

export type GatewaySessionTitleModelSelection = {
  executionSelection: ModelExecutionSelection;
  validate: () => string | undefined;
  authProfileOverride?: string;
};

export type PreparedGatewaySessionLifecycle = {
  spawnedCwd?: string;
  sessionRoot?: string;
  worktree?: NonNullable<SessionEntry["worktree"]>;
  repositoryWorkspaceId?: string;
  rollback?: () => Promise<void>;
};

export type PrepareGatewaySessionLifecycle = (target: {
  agentId: string;
  entry?: SessionEntry;
  key: string;
  storePath: string;
  titleModelSelection?: GatewaySessionTitleModelSelection | null;
  projectId?: string;
  /** Inherited or existing policy, resolved while the creation owner holds lifecycle custody. */
  sandboxRequired?: boolean;
}) => Promise<Result<PreparedGatewaySessionLifecycle, ErrorShape>>;

export async function rollbackGatewaySessionPreparation(params: {
  onError?: (error: unknown) => void;
  prepared?: PreparedGatewaySessionLifecycle;
}): Promise<void> {
  try {
    await params.prepared?.rollback?.();
  } catch (error) {
    params.onError?.(error);
  }
}
