// Plugin-facing ACP runtime contract: high-level one-shot harness runs owned by the calling plugin.
import type { AgentWaitResult } from "../../agents/run-wait.types.js";
import type { TaskRunCancelResult, TaskRunDetail, TaskRunView } from "./task-domain-types.js";

export type PluginAcpErrorCode =
  | "ACP_PLUGIN_PRINCIPAL_REQUIRED"
  | "ACP_PLUGIN_GATEWAY_REQUIRED"
  | "ACP_PLUGIN_RUNTIME_CLOSED"
  | "ACP_PLUGIN_DETACHED_FORBIDDEN"
  | "ACP_PLUGIN_UNSUPPORTED_OPTION"
  | "ACP_PLUGIN_INVALID_INPUT"
  | "ACP_PLUGIN_DISABLED"
  | "ACP_PLUGIN_AGENT_FORBIDDEN"
  | "ACP_PLUGIN_ADMISSION_REJECTED"
  | "ACP_PLUGIN_SPAWN_FAILED"
  | "ACP_PLUGIN_RUN_NOT_FOUND";

/** Structured failure raised by every `api.runtime.acp` method. */
export class PluginAcpRuntimeError extends Error {
  readonly code: PluginAcpErrorCode;
  /** Owner-side detail code (for example the ACP spawn `errorCode`) or the offending option name. */
  readonly detailCode?: string;

  constructor(code: PluginAcpErrorCode, message: string, detailCode?: string) {
    super(message);
    this.name = "PluginAcpRuntimeError";
    this.code = code;
    if (detailCode) {
      this.detailCode = detailCode;
    }
  }
}

/** Task/registry owner key for every ACP run a plugin spawns; deliberately not a session key. */
export function resolvePluginAcpOwnerKey(pluginId: string): string {
  return `plugin:${pluginId}:acp`;
}

export type PluginAcpAuthorityMode = "request" | "detached";

export type PluginAcpAvailability =
  | { ok: true; mode: PluginAcpAuthorityMode }
  | { ok: false; code: PluginAcpErrorCode; reason: string };

export type PluginAcpImageAttachment = {
  mediaType: string;
  /** Base64 image payload; the same shape `sessions_spawn(runtime="acp")` admits. */
  data: string;
};

export type PluginAcpSpawnParams = {
  task: string;
  /** Bounded display label; trimmed and truncated by the host. */
  label?: string;
  /** Target OpenClaw ACP agent id. Falls back to the configured default ACP target. */
  agentId?: string;
  /** Absolute working directory for the harness. */
  cwd?: string;
  model?: string;
  thinking?: string;
  runTimeoutSeconds?: number;
  cleanup?: "delete" | "keep";
  /** Same key + same canonical input replays the accepted result for a bounded window. */
  idempotencyKey?: string;
  attachments?: PluginAcpImageAttachment[];
};

export type PluginAcpSpawnResult = {
  runId: string;
  taskId?: string;
  sessionKey: string;
  agentId: string;
  runTimeoutSeconds: number;
  /** True when an idempotent replay returned the earlier accepted result. */
  replayed?: boolean;
};

export type PluginAcpRunDetail = TaskRunDetail;
export type PluginAcpRunView = TaskRunView;
export type PluginAcpCancelResult = TaskRunCancelResult;

export type PluginAcpSessionDetail = {
  sessionKey: string;
  agentId: string;
  backend?: string;
  mode?: "oneshot" | "persistent";
  cwd?: string;
  state?: "idle" | "running" | "error";
  lastActivityAt?: number;
  lastError?: string;
  label?: string;
  createdAt?: number;
  updatedAt?: number;
};

export type PluginAcpObserveEvent = {
  runId: string;
  seq: number;
  ts: number;
  stream: "lifecycle" | "acp" | "tool" | "error";
  data: Record<string, unknown>;
  /** Set on the final delivered event when the observer stops before the run ends. */
  truncated?: boolean;
};

export type PluginAcpObserveParams = {
  runId: string;
  /** Maximum events delivered before the observer unsubscribes (default 500, capped by the host). */
  maxEvents?: number;
  signal?: AbortSignal;
};

/** High-level, plugin-principal-scoped ACP runtime. Raw manager/backend controls are never exposed. */
export type PluginRuntimeAcp = {
  isAvailable: () => Promise<PluginAcpAvailability>;
  spawn: (params: PluginAcpSpawnParams) => Promise<PluginAcpSpawnResult>;
  getRun: (
    params: { runId: string } | { taskId: string },
  ) => Promise<PluginAcpRunDetail | undefined>;
  listRuns: (params?: { limit?: number; includeTerminal?: boolean }) => Promise<PluginAcpRunView[]>;
  getSession: (params: { sessionKey: string }) => Promise<PluginAcpSessionDetail | undefined>;
  waitForRun: (params: { runId: string; timeoutMs?: number }) => Promise<AgentWaitResult>;
  cancel: (params: { runId: string; reason?: string }) => Promise<PluginAcpCancelResult>;
  /** Returns an unsubscribe function; the host also unsubscribes on terminal, abort, or truncation. */
  observe: (
    params: PluginAcpObserveParams,
    listener: (event: PluginAcpObserveEvent) => void,
  ) => Promise<() => void>;
};
