import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { evaluate } from "./src/client.js";
import { ConfigSchema } from "./src/config.js";
import { resolveRuntimeConfig } from "./src/credentials.js";
import {
  DecisionEvaluateInput,
  DecisionEvaluateOutput,
  decisionToolResult,
  parseDecisionEvaluateInput,
  rubricVersion,
} from "./src/decision-tool.js";
import { createDecisionProvider } from "./src/decisions.js";
import { EvaluateInput, EvaluateOutput } from "./src/schema.js";

export default definePluginEntry({
  id: "typesafe",
  name: "TypeSafe AI",
  description: "Explicit typed evaluations, not a conversational model provider.",
  configSchema: { jsonSchema: { ...ConfigSchema } },
  register(api) {
    api.registerDecisionProvider(
      createDecisionProvider(() => resolveRuntimeConfig(api.runtime.config.current())),
    );
    api.registerTool(
      {
        name: "typesafe_evaluate",
        label: "TypeSafe typed decisions",
        description:
          "Ask the configured System One model for typed decisions over explicit shared state: classify/select with Choice (2–255 options), rate with Score (2–10 ordered levels; fractional zero-based result), or estimate probability of yes with Noul (optional true/false criteria). Batch independent questions; they cannot see each other’s answers. Instructions and descriptions accept text, JSON objects/arrays, or null. Returns distributions, confidence for Choice/Score, model, and usage—not generated explanations or authorization. Hosted Jev requires credentials and may incur API charges; a configured local Kev endpoint receives supplied data without hosted credentials.",
        parameters: EvaluateInput,
        outputSchema: EvaluateOutput,
        resultContentSource: "network",
        async execute(_id, params, signal) {
          signal?.throwIfAborted();
          const config = resolveRuntimeConfig(api.runtime.config.current());
          if (!config.baseUrl && !config.apiKey) {
            throw new Error(
              "TypeSafe API key is missing. Configure a SecretRef in plugin Settings.",
            );
          }
          const details = await evaluate(params, config, signal);
          signal?.throwIfAborted();
          return { content: [{ type: "text", text: JSON.stringify(details) }], details };
        },
      },
      { optional: true },
    );
    api.registerTool(
      (ctx) => ({
        name: "decision_evaluate",
        label: "Provider-neutral decision evaluation",
        description:
          "Evaluate explicit evidence with the calling agent's configured decision model. Supports independent boolean, choice, and score questions and preserves provider-reported distributions. The tool does not collect ambient context or authorize actions.",
        parameters: DecisionEvaluateInput,
        outputSchema: DecisionEvaluateOutput,
        resultContentSource: "network",
        async execute(_id, params, signal) {
          if (!ctx.agentId) {
            throw new Error("decision_evaluate requires trusted agent context.");
          }
          const batch = parseDecisionEvaluateInput(params);
          const inspection = api.runtime.decisions.inspect({ agentId: ctx.agentId });
          const operationSignal = signal ?? new AbortController().signal;
          operationSignal.throwIfAborted();
          const outcome = await api.runtime.decisions.evaluate(batch, {
            agentId: ctx.agentId,
            purpose: "decision_evaluate",
            rubricVersion: rubricVersion(batch),
            timeoutMs: 30_000,
            signal: operationSignal,
          });
          operationSignal.throwIfAborted();
          return decisionToolResult(outcome, inspection);
        },
      }),
      { optional: true },
    );
  },
});
