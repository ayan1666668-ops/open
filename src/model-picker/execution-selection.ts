import type { AgentModelPrimaryWriteTarget } from "../agents/agent-scope.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import type { ModelVisibilityPolicy } from "../agents/model-visibility-policy.js";
import type { StickyModelSelectionDispatchOutcome } from "../agents/sticky-model-selection.js";
import type { ThinkLevel } from "../auto-reply/thinking.shared.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/** A prepared model and its executor are one accepted session choice. */
export type ModelExecutionSelection = {
  model: { provider: string; id: string };
  executor: { kind: "harness" | "cli"; id: string };
};

export type NativeManagedExecutionSelection = {
  model: "native-managed";
  executor: { kind: "harness"; id: string };
};

export type AcpExecutionSelection = {
  model: { id: string } | "native-managed";
  executor: { kind: "acp"; backend: string; agent: string };
};

export type ExecutionSelection =
  | ModelExecutionSelection
  | NativeManagedExecutionSelection
  | AcpExecutionSelection;
export type ExecutionFallbackPermission = "configured" | "explicit";

export const SESSION_EXECUTION_SELECTION_TRANSACTION_FIELDS = [
  "executionSelection",
  "authProfileOverride",
  "authProfileOverrideSource",
  "authProfileOverrideCompactionCount",
] as const;

/** Deferred requests preserve imported or legacy SDK intent without claiming an executor. */
export type DeferredExecutionSelectionRequest = {
  model?: { provider?: string; id: string } | "native-managed";
  runtime?: string;
  executor?: ExecutionSelection["executor"];
};

export type SessionExecutionSelection =
  | {
      state: "accepted";
      selection: ExecutionSelection;
      fallbackPermission: ExecutionFallbackPermission;
    }
  | {
      state: "deferred";
      request: DeferredExecutionSelectionRequest;
      fallbackPermission: ExecutionFallbackPermission;
      previous?: ExecutionSelection;
    };

export function isAcpExecutionSelection(
  selection: ExecutionSelection,
): selection is AcpExecutionSelection {
  return selection.executor.kind === "acp";
}

export function isModelExecutionSelection(
  selection: ExecutionSelection,
): selection is ModelExecutionSelection {
  return selection.executor.kind !== "acp" && selection.model !== "native-managed";
}

/** Pure view of accepted intent; deferred requests are not runnable selections. */
export function getSessionExecutionSelection(
  entry: Pick<SessionEntry, "executionSelection"> | undefined,
): ExecutionSelection | undefined {
  return entry?.executionSelection?.state === "accepted"
    ? entry.executionSelection.selection
    : undefined;
}

export function getCommittedSessionExecutionSelection(
  entry: Pick<SessionEntry, "executionSelection"> | undefined,
): ExecutionSelection | undefined {
  const stored = entry?.executionSelection;
  return stored?.state === "accepted" ? stored.selection : stored?.previous;
}

export type ExecutionSelectionCommitCause =
  | { kind: "initialize" | "reset" | "user" }
  | { kind: "inherit"; entry: Partial<SessionEntry> };

export type ExecutionSelectionRequest =
  | {
      kind: "model";
      model: { provider?: string; id: string };
      executor?: ModelExecutionSelection["executor"];
    }
  | { kind: "selection"; selection: ExecutionSelection }
  | { kind: "fallback"; selection: ModelExecutionSelection; explicitModels?: string[] }
  | { kind: "initialize"; model?: ModelExecutionSelection["model"] }
  | { kind: "reset"; model?: { provider?: string; id: string } };

export type PreparedSessionExecutionSelection =
  | {
      status: "ready";
      selection: ExecutionSelection;
      before?: ExecutionSelection;
      reason: "initialized" | "model" | "explicit" | "reset" | "unsupported";
      message: string;
      catalogEntry?: ModelCatalogEntry;
      validateCommit: () => string | undefined;
    }
  | {
      status: "rejected";
      reason: "locked" | "not-allowed" | "unknown" | "unavailable" | "unsupported";
      message: string;
    };

export type ApplySessionExecutionSelectionResult =
  | {
      status: "applied";
      before?: ExecutionSelection;
      reason: Extract<PreparedSessionExecutionSelection, { status: "ready" }>["reason"];
      selection: ExecutionSelection;
      message: string;
      changed: boolean;
      contextTokens?: number;
      configuredDefaultUpdate?: StickyModelSelectionDispatchOutcome;
      thinkingRemap?: {
        from: ThinkLevel;
        to: ThinkLevel;
        provider: string;
        model: string;
      };
    }
  | {
      status: "rejected";
      reason: "locked" | "not-allowed" | "unknown" | "unavailable" | "unsupported";
      message: string;
    }
  | { status: "conflict"; message: string };

export type ApplySessionExecutionSelectionParams = {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  request: ExecutionSelectionRequest;
  storePath?: string;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  modelCatalog?: readonly ModelCatalogEntry[];
  thinkingCatalog?: readonly ModelCatalogEntry[];
  profileOverride?: string;
  currentProvider?: string;
  modelPolicy?: Omit<ModelVisibilityPolicy, "catalog">;
  validateCommit?: () => string | undefined;
  allowCreate?: boolean;
  markLiveSwitchPending?: boolean;
  canPersistStickyModelSelection?: boolean;
  stickyModelSelectionTarget?: AgentModelPrimaryWriteTarget;
  patchModel?: string;
};
export type PrepareSessionExecutionSelectionParams = {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey?: string;
  sessionEntry?: Partial<SessionEntry>;
  storePath?: string;
  readSessionEntry?: () => Partial<SessionEntry> | undefined;
  modelCatalog?: readonly ModelCatalogEntry[];
  profileProvider?: string;
  request: ExecutionSelectionRequest;
};
export type PreparedSessionExecutionCommitParams<T> = {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  prepared: Extract<PreparedSessionExecutionSelection, { status: "ready" }>;
  assertActive: () => void;
  assertSelectionCurrent: () => void;
  commitAccepted: (selection: ExecutionSelection) => Promise<T>;
};
