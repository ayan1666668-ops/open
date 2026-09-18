import { createHash } from "node:crypto";
import type { BootstrapContextMode } from "../../agents/bootstrap-files.js";
import { SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { HookExternalContentSource } from "../../security/external-content-source.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { CronJob } from "../types.js";
import { buildCurrentConversationContextBlock } from "./run-current-context.js";
import type { RunCronAgentTurnParams } from "./run-prepare-runtime.js";
import {
  isExternalHookSession,
  logWarn,
  mapHookExternalContentSource,
  resolveCronStyleNow,
} from "./run.runtime.js";

const COMMAND_STYLE_CRON_PREFIX =
  /^(?:(?:[A-Z_][A-Z0-9_]*=\S+\s+)+)?(?:cd\s+\S+|(?:\.{1,2}|~)?\/\S+|[A-Za-z]:[\\/]\S+|(?:bash|bun|cargo|deno|docker|gh|git|go|make|node|npm|npx|pnpm|python|python3|ruby|sh|tsx|uv|zsh)\b)/u;
const cronExternalContentRuntimeLoader = createLazyImportLoader(
  () => import("./run-external-content.runtime.js"),
);

export function resolveIsolatedCronPromptCacheKey(params: {
  job: CronJob;
  agentId: string;
  agentSessionKey: string;
  provider: string;
  model: string;
}): string | undefined {
  if (params.job.sessionTarget !== "isolated") {
    return undefined;
  }
  const material = JSON.stringify({
    version: 1,
    kind: "isolated-cron",
    jobId: params.job.id,
    agentId: params.agentId,
    agentSessionKey: params.agentSessionKey,
    provider: params.provider,
    model: params.model,
  });
  const digest = createHash("sha256").update(material).digest("hex").slice(0, 32);
  // Isolated cron rotates transcript/session ids per run; keep cache affinity
  // on stable job identity without sending raw local session labels upstream.
  return `openclaw-cron-${digest}`;
}

export function resolveCronBootstrapContextMode(
  payload: Extract<CronJob["payload"], { kind: "agentTurn" }> | null,
): BootstrapContextMode | undefined {
  // Command-like cron prompts benefit from lightweight bootstrap context so
  // simple scheduled command tasks do not spend budget on full repo context.
  if (payload?.lightContext === true) {
    return "lightweight";
  }
  if (payload?.lightContext === false) {
    return undefined;
  }
  const message = payload?.message.trim() ?? "";
  return !message.includes("\n") && COMMAND_STYLE_CRON_PREFIX.test(message)
    ? "lightweight"
    : undefined;
}

export async function buildCronCommandBody(params: {
  input: RunCronAgentTurnParams;
  runtimeCfg: OpenClawConfig;
  agentId: string;
  baseSessionKey: string;
  sourceSessionKey?: string;
  sourceEntry?: SessionEntry;
  storePath: string;
  now: number;
  runId: string;
  runSessionKey: string;
  hookExternalContentSource: HookExternalContentSource | undefined;
}): Promise<{ commandBody: string; inputProvenance?: InputProvenance }> {
  const { input, hookExternalContentSource } = params;
  const agentPayload = input.job.payload.kind === "agentTurn" ? input.job.payload : null;
  const { formattedTime, timeLine } = resolveCronStyleNow(params.runtimeCfg, params.now);
  // Current jobs stay detached; a bounded tail preserves context without transcript continuation.
  const currentConversationContext =
    input.job.sessionTarget === "current" &&
    agentPayload &&
    params.sourceSessionKey &&
    params.sourceEntry
      ? await buildCurrentConversationContextBlock({
          agentId: params.agentId,
          sourceSessionEntry: params.sourceEntry,
          sourceSessionKey: params.sourceSessionKey,
          storePath: params.storePath,
        })
      : undefined;
  const turnMessage = agentPayload?.message ?? input.message;
  const message = currentConversationContext
    ? `${currentConversationContext}\n\n${turnMessage}`
    : turnMessage;
  const sourcePromptPrefix = `[cron:${input.job.id} ${input.job.name}]`;
  const base = `${sourcePromptPrefix} ${message}`.trim();
  const isExternalHook =
    hookExternalContentSource !== undefined || isExternalHookSession(params.baseSessionKey);
  const allowUnsafeExternalContent =
    agentPayload?.allowUnsafeExternalContent === true ||
    (hookExternalContentSource === "gmail" &&
      input.cfg.hooks?.gmail?.allowUnsafeExternalContent === true);
  let commandBody: string;
  if (isExternalHook) {
    const { detectSuspiciousPatterns } = await cronExternalContentRuntimeLoader.load();
    const suspiciousPatterns = detectSuspiciousPatterns(message);
    if (suspiciousPatterns.length > 0) {
      logWarn(
        `[security] Suspicious patterns detected in external hook content ` +
          `(session=${params.baseSessionKey}, patterns=${suspiciousPatterns.length}): ${suspiciousPatterns.slice(0, 3).join(", ")}`,
      );
    }
  }
  if (isExternalHook && !allowUnsafeExternalContent) {
    const { buildSafeExternalPrompt } = await cronExternalContentRuntimeLoader.load();
    const hookType = mapHookExternalContentSource(hookExternalContentSource ?? "webhook");
    const safeContent = buildSafeExternalPrompt({
      content: message,
      source: hookType,
      jobName: input.job.name,
      jobId: input.job.id,
      timestamp: formattedTime,
    });
    commandBody = `${safeContent}\n\n${timeLine}`.trim();
  } else {
    commandBody = `${base}\n${timeLine}`.trim();
  }
  const core = `This is an unattended scheduled run. Nobody is present to clarify or approve, so complete the task with what you have. Your final reply is the deliverable — not a plan, an acknowledgement, or a request for input. If nothing needs doing, reply exactly ${SILENT_REPLY_TOKEN}. If something failed, state plainly what failed and what you tried — the scheduler owns retries and failure alerts.`;
  const trustedExtra =
    " Where the job's own instructions conflict with this preamble, the job's instructions win (a question or plan the job explicitly requests is a valid deliverable). If this job is no longer needed, remove it if your available tools allow.";
  return {
    commandBody: `${commandBody}\n\n${core}${isExternalHook ? "" : trustedExtra}`,
    inputProvenance:
      agentPayload && !isExternalHook
        ? {
            kind: "internal_system",
            sourceTool: "cron",
            sourcePromptPrefix,
            jobId: input.job.id,
            runId: params.runId,
            sourceSessionKey: params.runSessionKey,
          }
        : undefined,
  };
}
