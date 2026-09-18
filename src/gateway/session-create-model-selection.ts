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
import {
  prepareSessionExecutionSelection,
  resolveExecutionSelectionExecutorKind,
} from "../model-picker/apply-session-model-selection.js";
import { isModelExecutionSelection } from "../model-picker/execution-selection.js";
import { resolveSessionPatchModelSelection } from "./server-methods/sessions-patch-model-selection.js";
import type { GatewaySessionTitleModelSelection } from "./session-lifecycle-preparation.js";

export async function resolveSessionCreateModelSelection(
  cfg: OpenClawConfig,
  agentId: string,
  input: string | { model: string; agentRuntime?: string } | undefined,
  source?: { entry: SessionEntry; agentId: string; sessionKey: string; storePath: string },
  preparedModelSelection?: ModelRef,
): Promise<GatewaySessionTitleModelSelection | null> {
  const model = normalizeOptionalString(typeof input === "string" ? input : input?.model);
  const defaults = resolveDefaultModelForAgent({ cfg, agentId });
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
  if (runtime && !kind) {
    return null;
  }
  const prepared = await prepareSessionExecutionSelection({
    cfg,
    agentId,
    sessionEntry: resolved?.profile
      ? {
          ...source?.entry,
          authProfileOverride: resolved.profile,
          authProfileOverrideSource: "user",
        }
      : source?.entry,
    profileProvider: resolved?.provider,
    sessionAgentId: source?.agentId,
    sessionKey: source?.sessionKey,
    storePath: source?.storePath,
    request: resolved
      ? {
          kind: "model",
          model: { provider: resolved.provider, id: resolved.model },
          ...(runtime && kind ? { executor: { kind, id: runtime } } : {}),
        }
      : { kind: "initialize" },
  });
  if (prepared.status !== "ready" || !isModelExecutionSelection(prepared.selection)) {
    return null;
  }
  return {
    executionSelection: prepared.selection,
    validate: prepared.validateCommit,
    authProfileOverride: resolved?.profile ?? source?.entry.authProfileOverride,
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
