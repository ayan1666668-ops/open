import { AsyncLocalStorage } from "node:async_hooks";
import { resolveSessionModelRefCore as resolveSessionModelRef } from "../agents/session-model-ref.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createAgentPatchedSessionModelFallback } from "../model-picker/apply-session-model-selection.js";

const agentSessionModelPatch = new AsyncLocalStorage<boolean>();

export function withAgentSessionModelPatchOrigin<T>(run: () => T): T {
  return agentSessionModelPatch.run(true, run);
}

export function isAgentSessionModelPatchOrigin(): boolean {
  return agentSessionModelPatch.getStore() === true;
}

export function snapshotAgentModelFallback(
  cfg: OpenClawConfig,
  entry: SessionEntry,
  agentId: string,
  now: number,
): NonNullable<SessionEntry["modelFallback"]> {
  const prior = resolveSessionModelRef(cfg, entry, agentId);
  return createAgentPatchedSessionModelFallback({
    model: prior.model,
    provider: prior.provider,
    entry,
    ts: now,
  });
}
