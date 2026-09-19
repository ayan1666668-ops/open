import type { AgentRunTerminalReplySnapshot } from "../../agents/agent-run-terminal-reply.types.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type { AgentLifecycleTerminalBackstop } from "../../auto-reply/reply/agent-lifecycle-terminal.js";
import type { NormalizeReplySkipReason } from "../../auto-reply/reply/normalize-reply-skip-reason.js";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { AgentDefaultsConfig } from "../../config/types.agent-defaults.js";
/** Execution and result contracts for isolated cron agent runs. */
import type {
  CronAgentExecutionPhaseUpdate,
  CronJob,
  CronDeliveryTrace,
  CronResolvedDeliveryState,
  CronNextCheckProposal,
  CronRunOutcome,
  CronRunTelemetry,
} from "../types.js";
import type { runCliAgent } from "./run-execution.runtime.js";
import type { RunCronAgentTurnParams } from "./run-prepare-runtime.js";
import type { PreparedCronRunContext } from "./run-prepare.js";
import type { CronRunContinuationSession } from "./run-session-state.js";

/** Pre-run disposition returned when isolated cron work never enters an agent runner. */
export type CronAgentAdmissionDisposition = "session-conflict" | "rejected";

/** Final isolated cron turn result merged into service state and run logs. */
export type RunCronAgentTurnResult = {
  /** Typed pre-run rejection so callers never infer admission state from error prose. */
  admissionDisposition?: CronAgentAdmissionDisposition;
  /** Delivery fact authored by the dispatcher, separate from execution status. */
  deliveryState?: CronResolvedDeliveryState;
  /** Last non-empty agent text output (not truncated). */
  outputText?: string;
  /** Terminal model-reply fact without exposing reply text. */
  replyDisposition?: AgentRunTerminalReplySnapshot["disposition"];
  /** Confirmed target delivery, including matching message-tool sends; unknown is omitted. */
  delivered?: boolean;
  /**
   * `true` when cron attempted announce/direct delivery for this run.
   * This is tracked separately from `delivered` because some announce paths
   * cannot guarantee a final delivery ack synchronously.
   */
  deliveryAttempted?: boolean;
  /** Post-run delivery failure on an otherwise successful isolated turn. */
  deliveryError?: string;
  /** Intentional direct-delivery non-outcome recorded before transport custody. */
  deliverySuppressionReason?: NormalizeReplySkipReason;
  delivery?: CronDeliveryTrace;
  nextCheck?: CronNextCheckProposal;
} & CronRunOutcome &
  CronRunTelemetry;

/** Agent payload accepted by an isolated cron execution. */
export type AgentTurnPayload = Extract<CronJob["payload"], { kind: "agentTurn" }> | null;

type CronPromptRunResult = Awaited<ReturnType<typeof runCliAgent>>;

/** Runner-start metadata delivered to the outer execution owner. */
export type CronRunnerStartedInfo = {
  lifecycleGeneration?: string;
  isFallback?: boolean;
  provider?: string;
  model?: string;
};

/** Completed prompt result recorded by the outer execution owner. */
export type CronCompletedPromptRun = {
  runResult: CronPromptRunResult;
  fallbackProvider: string;
  fallbackModel: string;
  runStartedAt: number;
  runEndedAt: number;
};

/** Result envelope returned after an isolated cron prompt completes. */
export type CronExecutionResult = CronCompletedPromptRun & {
  completedPromptRuns: readonly CronCompletedPromptRun[];
};

/** Inputs owned by one isolated cron execution. */
export type CronRunExecutionParams = Pick<
  PreparedCronRunContext,
  | "cfgWithAgentDefaults"
  | "agentId"
  | "agentDir"
  | "agentSessionKey"
  | "runSessionKey"
  | "usesDetachedRunSession"
  | "workspaceDir"
  | "executionRoot"
  | "timeoutMs"
  | "runTimeoutOverrideMs"
  | "suppressExecNotifyOnExit"
  | "resolvedDelivery"
  | "deliveryRequested"
  | "sourceDelivery"
  | "skillsSnapshot"
  | "agentPayload"
  | "useSubagentFallbacks"
  | "inheritDefaultFallbacksForAgentStringModel"
  | "modelFallbacksOverride"
  | "liveSelection"
  | "cronSession"
  | "commandBody"
  | "inputProvenance"
  | "persistSessionEntry"
> &
  Pick<RunCronAgentTurnParams, "cfg" | "job" | "lane" | "onLaneWait" | "executionIdentity"> & {
    runId: string;
    agentVerboseDefault: AgentDefaultsConfig["verboseDefault"];
    immutableThinkLevel: ThinkLevel | undefined;
    thinkingCatalog?: ModelCatalogEntry[];
    loadThinkingCatalog: (
      provider: string,
      model: string,
      agentRuntime: string,
    ) => Promise<ModelCatalogEntry[]>;
    persistRunContinuationSession?: CronRunContinuationSession["sync"];
    setRunContinuationCliExecutionProvider?: (provider?: string) => Promise<void>;
    abortSignal?: AbortSignal;
    abortReason: () => string;
    isAborted: () => boolean;
    lifecycle: Omit<AgentLifecycleTerminalBackstop, "emit">;
    onExecutionStarted?: (info?: CronRunnerStartedInfo) => void;
    onExecutionPhase?: (
      info: Pick<CronAgentExecutionPhaseUpdate, "phase"> &
        Partial<Omit<CronAgentExecutionPhaseUpdate, "jobId" | "phase">>,
    ) => void;
    onPromptCompleted?: (runs: readonly CronCompletedPromptRun[]) => void;
    runStartedAt?: number;
  };
