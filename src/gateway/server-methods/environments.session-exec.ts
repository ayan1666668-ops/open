import {
  ErrorCodes,
  errorShape,
  validateEnvironmentsSessionExecParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveConversationCapabilityProfile } from "../../agents/conversation-capability-profile.js";
import { isConversationToolAllowed } from "../../agents/conversation-tool-policy-pipeline.js";
import { resolveExecDefaults } from "../../agents/exec-defaults.js";
import { isRuntimeToolAllowed, isToolAllowedByPolicyName } from "../../agents/tool-policy-match.js";
import { getGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { approveSessionEnvironmentCommand } from "./environments.session-exec-approval.js";
import { resolveSessionEnvironmentCaller } from "./environments.session.js";
import { loadAccessorSessionEntryForGatewayTarget } from "./sessions-shared.js";
import type { GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayMethod } from "./validation.js";

export const environmentsSessionExecHandlers: GatewayRequestHandlers = {
  "environments.session.exec": defineValidatedGatewayMethod(
    "environments.session.exec",
    validateEnvironmentsSessionExecParams,
    async (options) => {
      const { params, respond, context, client } = options;
      try {
        const caller = resolveSessionEnvironmentCaller(options, params);
        const service = context.workerEnvironmentService;
        const binding = service?.getSessionAttachment(caller.identity.sessionId);
        if (
          !service ||
          !binding ||
          (params.environmentId !== undefined && params.environmentId !== binding.environmentId)
        ) {
          throw new Error("No matching environment is attached to this conversation");
        }
        const action = params.action ?? "run";
        const command = {
          argv: params.argv ? [...params.argv] : ["openclaw-internal-workspace-process"],
          input: params.input,
          timeoutMs: params.timeoutMs,
          processId: params.processId,
        };
        const ambient = getGatewayToolCallerIdentity();
        let approved = false;
        const assertCurrent = () => {
          caller.assertCurrent();
          service.assertSessionAttachment(binding);
          const cfg = context.getRuntimeConfig();
          const target = loadAccessorSessionEntryForGatewayTarget({
            cfg,
            key: caller.identity.sessionKey,
            agentId: caller.identity.agentId,
          });
          const runtime = client?.internal?.agentRuntimeIdentity;
          const capability = resolveConversationCapabilityProfile({
            config: cfg,
            ...caller.identity,
            modelProvider: runtime?.sessionSpawnContext?.resolvedModel?.provider,
            modelId: runtime?.sessionSpawnContext?.resolvedModel?.model,
          });
          const tool = action === "run" || action === "start" ? "exec" : "process";
          if (ambient) {
            if (
              ambient.agentId !== caller.identity.agentId ||
              ambient.sessionKey !== caller.identity.sessionKey ||
              !ambient.assertToolAllowed
            ) {
              throw new Error("Environment command has no matching captured tool authority");
            }
            ambient.assertToolAllowed(tool);
          } else if (
            (runtime || client?.internal?.agentToolCaller) &&
            !runtime?.sessionSpawnContext?.inheritedToolPolicy
          ) {
            throw new Error("Environment command has no captured tool authority");
          }
          const inheritedPolicy = runtime?.sessionSpawnContext?.inheritedToolPolicy;
          if (
            !isConversationToolAllowed(capability, tool) ||
            (inheritedPolicy &&
              (!isRuntimeToolAllowed(tool, inheritedPolicy.allow) ||
                !isToolAllowedByPolicyName(tool, { deny: inheritedPolicy.deny })))
          ) {
            throw new Error(`Conversation policy denies ${tool}`);
          }
          const defaults = resolveExecDefaults({
            cfg,
            ...caller.identity,
            sessionEntry: target.entry,
          });
          if (defaults.security === "deny") {
            throw new Error("Conversation policy denies environment command execution");
          }
          if (action === "run" || action === "start") {
            if (defaults.security === "allowlist" && defaults.ask === "off") {
              throw new Error(
                "Attached environment commands cannot inherit this host's executable allowlist",
              );
            }
            if (defaults.effectiveHost !== "gateway") {
              throw new Error("The conversation's exec policy binds commands to a different host");
            }
          }
        };
        assertCurrent();
        if (action === "run" || action === "start") {
          const cfg = context.getRuntimeConfig();
          const target = loadAccessorSessionEntryForGatewayTarget({
            cfg,
            key: caller.identity.sessionKey,
            agentId: caller.identity.agentId,
          });
          const policy = resolveExecDefaults({
            cfg,
            ...caller.identity,
            sessionEntry: target.entry,
          });
          if (
            policy.security !== "full" ||
            policy.ask === "always" ||
            ambient?.cronExecToolTarget?.ask === "always" ||
            client?.internal?.agentRuntimeIdentity?.cronExecToolTarget?.ask === "always"
          ) {
            await approveSessionEnvironmentCommand({
              options,
              binding,
              argv: command.argv,
              input: command.input,
              background: action === "start",
              assertCurrent,
              signal: caller.signal,
            });
            approved = true;
          }
        }
        const assertDispatch = () => {
          assertCurrent();
          if (action === "run" || action === "start") {
            const cfg = context.getRuntimeConfig();
            const target = loadAccessorSessionEntryForGatewayTarget({
              cfg,
              key: caller.identity.sessionKey,
              agentId: caller.identity.agentId,
            });
            const policy = resolveExecDefaults({
              cfg,
              ...caller.identity,
              sessionEntry: target.entry,
            });
            if (
              !approved &&
              (policy.security !== "full" ||
                policy.ask === "always" ||
                ambient?.cronExecToolTarget?.ask === "always" ||
                client?.internal?.agentRuntimeIdentity?.cronExecToolTarget?.ask === "always")
            ) {
              throw new Error(
                "Environment execution policy now requires approval; retry the command",
              );
            }
          }
        };
        assertDispatch();
        const result = await service.execSessionAttachment(binding, {
          argv: command.argv,
          ...(command.input === undefined ? {} : { input: command.input }),
          ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
          ...(action === "run" ? {} : { process: { action, processId: command.processId! } }),
          transportRetry: "never",
          signal: caller.signal,
          assertCurrent: assertDispatch,
        });
        assertCurrent();
        respond(true, { environmentId: binding.environmentId, ...result });
      } catch (error) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            error instanceof Error ? error.message : "Environment execution failed",
          ),
        );
      }
    },
  ),
};
