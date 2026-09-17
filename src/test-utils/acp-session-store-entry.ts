import type { SessionAcpMeta } from "@openclaw/acp-core/types";
import type { AcpSessionStoreEntry } from "../acp/runtime/session-meta.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { commitSessionExecutionSelection } from "../model-picker/apply-session-model-selection.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";

/** Seed both sides of the real agent-row/lifecycle join before installing a mock reader. */
export function createAcpSessionStoreEntryFixture(params: {
  sessionKey: string;
  agentId?: string;
  acp: SessionAcpMeta;
  entry?: SessionEntry;
  cfg?: OpenClawConfig;
}): AcpSessionStoreEntry & { entry: SessionEntry } {
  const { backend, agent, runtimeOptions, ...lifecycle } = params.acp;
  const { model, ...options } = runtimeOptions ?? {};
  const entry = structuredClone(params.entry ?? { sessionId: "session-1", updatedAt: 1 });
  delete entry.acp;
  commitSessionExecutionSelection(entry, {
    executor: { kind: "acp", backend, agent },
    model: model ? { id: model } : "native-managed",
  });
  const acp = {
    ...lifecycle,
    ...(Object.keys(options).length ? { runtimeOptions: options } : {}),
  };
  return {
    cfg: params.cfg ?? {},
    agentId: resolveAgentIdFromSessionKey(params.sessionKey, params.agentId),
    storePath: "/synthetic/agent.sqlite",
    sessionKey: params.sessionKey,
    storeSessionKey: params.sessionKey,
    entry,
    acp,
  };
}
