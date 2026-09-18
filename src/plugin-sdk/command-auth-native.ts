/**
 * Public SDK subpath for native command specs, parsing, and authorization helpers.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isDefaultAgentRuntimeId } from "../agents/agent-runtime-id.js";
import { resolveAvailableAgentHarnessPolicy } from "../agents/harness/availability.js";
import type { AgentRuntimePolicyScope } from "../agents/model-runtime-policy.js";
import { resolveCompatibleAgentRuntimeForProvider } from "../agents/session-runtime-compat.js";
import { resolveEffectiveAgentRuntimeCore as resolveCanonicalAgentRuntime } from "../agents/thinking-runtime.js";
import { resolveSessionPinnedHarnessId } from "../sessions/agent-harness-session-key.js";
import type { OpenClawConfig } from "./config-contracts.js";
import type { SessionEntry } from "./session-store-runtime-internal.js";

export {
  buildCommandTextFromArgs,
  canResolveCommandArgMenu,
  findCommandByNativeName,
  formatCommandArgMenuTitle,
  listChatCommands,
  listNativeCommandSpecs,
  listNativeCommandSpecsForConfig,
  maybeResolveTextAlias,
  normalizeCommandBody,
  parseCommandArgs,
  serializeCommandArgs,
  resolveCommandArgChoices,
  resolveCommandArgMenu,
} from "../auto-reply/commands-registry.js";
export type {
  ChatCommandDefinition,
  CommandArgDefinition,
  CommandArgValues,
  CommandArgs,
  NativeCommandSpec,
} from "../auto-reply/commands-registry.js";
export type { CommandArgsParsing } from "../auto-reply/commands-registry.types.js";
export {
  hasControlCommand,
  shouldComputeCommandAuthorized,
} from "../auto-reply/command-detection.js";
export {
  resolveCommandAuthorizedFromAuthorizers,
  resolveControlCommandGate,
} from "../channels/command-gating.js";
export { resolveNativeCommandSessionTargets } from "../channels/native-command-session-targets.js";
export {
  resolveCommandAuthorization,
  type CommandAuthorization,
} from "../auto-reply/command-auth.js";
export { resolveStoredModelOverride } from "../sessions/stored-model-overrides.js";
export {
  formatFastModeCommandOptions,
  formatFastModeCurrentStatus,
  formatFastModeSourceSuffix,
  formatFastModeStatusValue,
  resolveFastModeState,
} from "../agents/fast-mode.js";
export type { ModelsProviderData } from "../auto-reply/reply/commands-models.js";
export { listSkillCommandsForAgents } from "../skills/discovery/chat-commands.js";
export { listProviderPluginCommandSpecs } from "../plugins/command-specs.js";

/** Preserve the released runtime projection input; only the session owner accepts execution. */
export function resolveEffectiveAgentRuntime(
  params: {
    cfg: OpenClawConfig;
    provider: string;
    modelId: string;
    modelApi?: string | null;
    modelBaseUrl?: unknown;
    sessionEntry?: Pick<
      SessionEntry,
      | "agentHarnessId"
      | "agentRuntimeOverride"
      | "modelSelectionLocked"
      | "pluginOwnerId"
      | "executionSelection"
    >;
  } & AgentRuntimePolicyScope,
): string {
  if (params.sessionEntry?.executionSelection) {
    return resolveCanonicalAgentRuntime(params);
  }
  const pinned = resolveSessionPinnedHarnessId(params.sessionEntry);
  const runtime =
    pinned && !isDefaultAgentRuntimeId(pinned)
      ? pinned
      : resolveCompatibleAgentRuntimeForProvider({
          provider: params.provider,
          runtime: params.sessionEntry?.agentRuntimeOverride,
          cfg: params.cfg,
        });
  if (!runtime) {
    return resolveCanonicalAgentRuntime(params);
  }
  return resolveAvailableAgentHarnessPolicy({
    ...params,
    mode: "projection",
    config: params.cfg,
    modelProvider: {
      api: params.modelApi ?? undefined,
      baseUrl: normalizeOptionalString(params.modelBaseUrl),
    },
    agentHarnessId: params.sessionEntry?.modelSelectionLocked ? runtime : undefined,
    agentHarnessRuntimeOverride: runtime,
  }).runtime;
}
