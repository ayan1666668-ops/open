import type { AgentModelPrimaryWriteTarget } from "../agents/agent-scope.js";
import type {
  PreparedSessionAuthSelection,
  ReplySessionAuthContext,
} from "../agents/auth-profiles/session-override.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import type { ModelManifestNormalizationContext, ModelRef } from "../agents/model-ref-shared.js";
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
  runtime?: string;
  executor?: ExecutionSelection["executor"];
} & (
  | {
      model?: { provider?: string; id: string } | "native-managed";
      defaultSelection?: never;
    }
  | { model?: never; defaultSelection: "inherit" | "configured" }
);

export type LegacyExecutionRequest = {
  provider: string;
  source?: "auto" | "user" | "default";
};

export type SessionExecutionSelection =
  | {
      state: "accepted";
      selection: ExecutionSelection;
      fallbackPermission: ExecutionFallbackPermission;
      legacyRequest?: LegacyExecutionRequest;
    }
  | {
      state: "deferred";
      request: DeferredExecutionSelectionRequest;
      fallbackPermission: ExecutionFallbackPermission;
      legacyRequest?: LegacyExecutionRequest;
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
  | { kind: "initialize"; fallbackPermission?: ExecutionFallbackPermission }
  | { kind: "reset" | "user" }
  | { kind: "inherit"; entry: Partial<SessionEntry> };

export type ExecutionSelectionRequest =
  | {
      kind: "model";
      model: { provider?: string; id: string };
      executor?: ModelExecutionSelection["executor"];
    }
  | { kind: "selection"; selection: ExecutionSelection }
  | {
      kind: "fallback";
      selection: ModelExecutionSelection;
      explicitModels?: string[];
      /** A validated one-turn user choice constrains fallback without changing stored intent. */
      userSelection?: ModelExecutionSelection;
    }
  | { kind: "initialize"; model?: ModelExecutionSelection["model"] }
  | {
      kind: "reset";
      model?: { provider?: string; id: string };
      executor?: ModelExecutionSelection["executor"];
    };

export type PreparedSessionExecutionSelection =
  | {
      status: "deferred";
      reason: "unknown" | "unavailable";
      message: string;
      selection: Extract<SessionExecutionSelection, { state: "deferred" }>;
      validateCommit: () => string | undefined;
    }
  | {
      status: "ready";
      selection: ExecutionSelection;
      before?: ExecutionSelection;
      reason: "initialized" | "model" | "explicit" | "reset" | "unsupported";
      message: string;
      catalogEntry?: ModelCatalogEntry;
      auth?: PreparedSessionAuthSelection;
      fallbackPermission?: ExecutionFallbackPermission;
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
  /** Preserve entry-specific fallback authorization without resetting the selected executor. */
  fallbackPermission?: ExecutionFallbackPermission;
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
export type PrepareSessionExecutionSelectionParams = ModelManifestNormalizationContext & {
  workspaceDir?: string;
  cfg: OpenClawConfig;
  agentId: string;
  /** Owner of sessionEntry for inherited-parent reads; agentId remains the policy target. */
  sessionAgentId?: string;
  parentSessionKey?: string;
  storePath?: string;
  readSessionEntry?: () => Partial<SessionEntry> | undefined;
  modelCatalog?: readonly ModelCatalogEntry[];
  profileProvider?: string;
  request: ExecutionSelectionRequest;
  /** Resolve raw input and account preference within the same prepared owner. */
  modelInput?: {
    raw: string;
    resolvedRef?: ModelRef;
    fallbacks?: string[];
    requiresTools?: boolean;
  };
} & (
    | {
        replyAuth?: undefined;
        sessionKey?: string;
        sessionEntry?: Partial<SessionEntry>;
      }
    | {
        replyAuth: ReplySessionAuthContext;
        sessionKey: string;
        sessionEntry: SessionEntry;
      }
  );
export type PreparedSessionExecutionCommitParams<T> = {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  prepared: Extract<PreparedSessionExecutionSelection, { status: "ready" }>;
  assertActive: () => void;
  assertSelectionCurrent: () => void;
  commitAccepted: (selection: ExecutionSelection, assertCommitActive: () => void) => Promise<T>;
};

export type SessionModelFallbackParams = {
  cfg: OpenClawConfig;
  agentId?: string;
  sessionKey?: string | null;
  sessionEntry?: Partial<SessionEntry>;
  model: ModelExecutionSelection["model"];
  userSelection?: ModelExecutionSelection;
  modelFallbacksOverride?: string[];
  configuredFallbacksOverride?: string[];
  modelSelectionLocked?: boolean;
  /** A model request may own its chain before an executor has been admitted. */
  ownsCandidateChain?: boolean;
  subagentSpawnLineage?: boolean;
};
