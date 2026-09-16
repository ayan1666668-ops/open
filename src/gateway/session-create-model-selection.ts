import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type SessionsCreateParams,
} from "../../packages/gateway-protocol/src/index.js";
import { normalizeOptionalAgentRuntimeId } from "../agents/agent-runtime-id.js";
import { resolveDefaultModelForAgent, type ModelRef } from "../agents/model-selection.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareSessionExecutionSelection } from "../model-picker/apply-session-model-selection.js";
import { resolveExecutionSelectionExecutorKind } from "../model-picker/apply-session-model-selection.js";
import { isModelExecutionSelection } from "../model-picker/execution-selection.js";
import { resolveSessionPatchModelSelection } from "./server-methods/sessions-patch-model-selection.js";
import type { GatewaySessionTitleModelSelection } from "./session-lifecycle-preparation.js";

export async function resolveSessionCreateModelSelection(
  cfg: OpenClawConfig,
  agentId: string,
  input: string | { model: string; agentRuntime?: string } | undefined,
  parentEntry?: SessionEntry,
  preparedModelSelection?: ModelRef,
): Promise<GatewaySessionTitleModelSelection | null> {
  const model = normalizeOptionalString(typeof input === "string" ? input : input?.model);
  const defaults = resolveDefaultModelForAgent({ cfg, agentId });
  // Reuse patch policy with the config-owned catalog projection. Persisted creation
  // remains the sole live-catalog availability validator.
  const resolved = model
    ? resolveSessionPatchModelSelection({
        cfg,
        agentId,
        catalog: [],
        raw: model,
        defaultProvider: defaults.provider,
        defaultModel: defaults.model,
        preparedModelSelection,
      })
    : undefined;
  if (resolved && !resolved.ok) {
    return null;
  }
  const runtime = normalizeOptionalAgentRuntimeId(
    typeof input === "string" ? undefined : input?.agentRuntime,
  );
  const kind = runtime ? resolveExecutionSelectionExecutorKind(cfg, runtime) : undefined;
  if (runtime && !kind) return null;
  const prepared = await prepareSessionExecutionSelection({
    cfg,
    agentId,
    sessionEntry: parentEntry,
    request: resolved
      ? {
          kind: "model",
          model: { provider: resolved.provider, id: resolved.model },
          ...(runtime && kind ? { executor: { kind, id: runtime } } : {}),
        }
      : { kind: "initialize" },
  });
  if (prepared.status !== "ready" || !isModelExecutionSelection(prepared.selection)) return null;
  return {
    executionSelection: prepared.selection,
    validate: prepared.validateCommit,
    authProfileOverride: resolved?.profile ?? parentEntry?.authProfileOverride,
  };
}

/** Catalog-owned creations cannot mix independent model or key selections. */
export function resolveSessionCreateCatalogSelectionError(
  params: Pick<SessionsCreateParams, "catalogId" | "model" | "agentRuntime" | "key">,
): ErrorShape | undefined {
  const catalogId = normalizeOptionalString(params.catalogId);
  const conflict = params.model
    ? "model"
    : params.agentRuntime
      ? "agentRuntime"
      : params.key
        ? "key"
        : undefined;
  return catalogId && conflict
    ? errorShape(ErrorCodes.INVALID_REQUEST, `sessions.create catalogId cannot include ${conflict}`)
    : undefined;
}
