/** Lazy runtime adapter for plugin-owned embedded-agent execution. */
import { randomUUID } from "node:crypto";
import {
  createOperationalRunInstanceRef,
  getAdmittedRunDelegatedAuthority,
  prepareAgentRunAdmission,
  type AdmittedRunContext,
} from "../../agents/admitted-run-context.js";
import {
  isDefaultAgentRuntimeId,
  normalizeOptionalAgentRuntimeId,
} from "../../agents/agent-runtime-id.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { runEmbeddedAgent as runEmbeddedAgentCore } from "../../agents/embedded-agent.js";
import { resolveDefaultModelForAgent } from "../../agents/model-selection-config.js";
import { recordRuntimeActionDecision } from "../../audit/runtime-action-decision.js";
import { getRuntimeConfig } from "../../config/config.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import {
  prepareSessionExecutionSelection,
  resolveSessionModelFallbacks,
  resolveExecutionSelectionExecutorKind,
} from "../../model-picker/apply-session-model-selection.js";
import {
  getSessionExecutionSelection,
  isAcpExecutionSelection,
  isModelExecutionSelection,
} from "../../model-picker/execution-selection.js";
import { getPluginRuntimeGatewayRequestScope } from "./gateway-request-scope.js";
import type { PluginRuntime } from "./types.js";

export const runPluginEmbeddedAgent: PluginRuntime["agent"]["runEmbeddedAgent"] = async (
  params,
) => {
  const pluginId = getPluginRuntimeGatewayRequestScope()?.pluginId;
  if (!pluginId) {
    throw new Error("Plugin embedded-agent execution requires an active plugin runtime scope.");
  }
  if (
    "admittedRunContext" in params ||
    "preparedRunAdmission" in params ||
    "compactionCountOwner" in params ||
    "onCompactionAccounting" in params ||
    "onContextAccountingEvent" in params ||
    "onDeferredLifecycleOwner" in params ||
    "onDeferredLifecycleAbort" in params ||
    "onRetryWait" in params
  ) {
    throw new Error("Plugin embedded-agent execution cannot supply host run authority.");
  }
  params.abortSignal?.throwIfAborted();
  const decisionOccurrenceId = randomUUID();
  let admittedRunContext: AdmittedRunContext | undefined;
  const config = params.config ?? getRuntimeConfig();
  const sessionKey = params.sessionKey ?? params.sessionTarget?.sessionKey;
  const isRawModelRun = params.modelRun === true || params.promptMode === "none";
  // Auxiliary runs borrow identity for authority, not the conversation's execution selection.
  const selectionSessionKey =
    params.sessionPersistence === "detached" || isRawModelRun ? undefined : sessionKey;
  const agentId = resolveSessionAgentId({
    config,
    sessionKey,
    agentId: params.sessionTarget?.agentId ?? params.agentId,
  });
  const preparedRunAdmission = prepareAgentRunAdmission({
    cfg: config,
    operationalRunInstance: createOperationalRunInstanceRef(params.runId),
    facts: {
      runId: params.runId,
      agentId,
      ingress: {
        kind: "plugin",
        boundary: "plugin-runtime",
        rawSourceRef: pluginId,
        state: "present",
      },
    },
    onAdmitted: (context) => {
      admittedRunContext = context;
      const token = context.executionIdentityToken;
      recordRuntimeActionDecision({
        token,
        family: "plugin",
        operation: "run",
        outcome: "allowed",
        coverageState: "enforced",
        reasonCode: "plugin_runtime_owner_admitted",
        owner: "plugin-runtime",
        decisionBoundary: "plugin.runtime.run-embedded-agent",
        policyRefs: ["plugin:registered-owner", "run:admission"],
        summary: "The registered plugin owner passed exact run admission.",
        remediation: [],
        discriminator: JSON.stringify([pluginId, params.runId, decisionOccurrenceId, "admission"]),
      });
    },
  });
  let closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      preparedRunAdmission.close();
    }
  };
  // Abort owns authority revocation independently of core completion; the
  // post-registration check closes the prepare-to-listener race.
  params.abortSignal?.addEventListener("abort", close, { once: true });
  try {
    params.abortSignal?.throwIfAborted();
    const sessionEntry = selectionSessionKey
      ? loadSessionEntryReadOnly({
          agentId,
          sessionKey: selectionSessionKey,
          storePath: params.sessionTarget?.storePath,
          readConsistency: "latest",
        })
      : undefined;
    const accepted = getSessionExecutionSelection(sessionEntry);
    const configured = resolveDefaultModelForAgent({ cfg: config, agentId });
    const selectedModel =
      accepted && isModelExecutionSelection(accepted)
        ? accepted.model
        : { provider: configured.provider, id: configured.model };
    const runtimeId = normalizeOptionalAgentRuntimeId(
      isRawModelRun ? "openclaw" : (params.agentHarnessId ?? params.agentHarnessRuntimeOverride),
    );
    const explicitRuntime =
      runtimeId && !isDefaultAgentRuntimeId(runtimeId) ? runtimeId : undefined;
    const executorKind = explicitRuntime
      ? resolveExecutionSelectionExecutorKind(config, explicitRuntime)
      : undefined;
    if (explicitRuntime && !executorKind) {
      throw new Error("Could not confirm support for the selected app.");
    }
    const prepared = await prepareSessionExecutionSelection({
      cfg: config,
      agentId,
      sessionKey: selectionSessionKey,
      storePath: params.sessionTarget?.storePath,
      sessionEntry,
      request:
        params.provider || params.model || explicitRuntime
          ? {
              kind: "model",
              model: {
                provider: params.provider ?? selectedModel.provider,
                id: params.model ?? selectedModel.id,
              },
              ...(explicitRuntime && executorKind
                ? { executor: { kind: executorKind, id: explicitRuntime } }
                : {}),
            }
          : { kind: "initialize" },
    });
    if (prepared.status !== "ready") {
      throw new Error(prepared.message);
    }
    if (
      isAcpExecutionSelection(prepared.selection) ||
      prepared.selection.executor.kind !== "harness"
    ) {
      throw new Error("The selected app cannot run this embedded operation.");
    }
    const model = isModelExecutionSelection(prepared.selection)
      ? prepared.selection.model
      : undefined;
    const selectionError = prepared.validateCommit?.();
    if (selectionError) {
      throw new Error(selectionError);
    }
    params.abortSignal?.throwIfAborted();
    const result = await runEmbeddedAgentCore({
      ...params,
      config,
      preparedRunAdmission,
      provider: model?.provider,
      model: model?.id,
      agentHarnessId: prepared.selection.executor.id,
      agentHarnessRuntimeOverride: prepared.selection.executor.id,
      modelFallbackAvailability: isModelExecutionSelection(prepared.selection)
        ? resolveSessionModelFallbacks({
            cfg: config,
            agentId,
            sessionKey: selectionSessionKey,
            sessionEntry,
            model: prepared.selection.model,
            modelFallbacksOverride: params.modelFallbacksOverride,
          })
        : undefined,
    });
    if (admittedRunContext && getAdmittedRunDelegatedAuthority(admittedRunContext)) {
      recordRuntimeActionDecision({
        token: admittedRunContext.executionIdentityToken,
        family: "plugin",
        operation: "run",
        outcome: "allowed",
        coverageState: "attribution-only",
        reasonCode: "plugin_runtime_completed",
        owner: "plugin-runtime",
        decisionBoundary: "plugin.runtime.run-embedded-agent",
        summary: "The plugin-owned runtime completed; this is attribution, not authorization.",
        remediation: [],
        discriminator: JSON.stringify([pluginId, params.runId, decisionOccurrenceId, "completion"]),
      });
    }
    return result;
  } finally {
    params.abortSignal?.removeEventListener("abort", close);
    close();
  }
};
