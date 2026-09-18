import type { OpenClawConfig } from "../config/types.openclaw.js";

export type CloseAcpSession = (params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
  reason: string;
}) => Promise<void>;

export async function loadTaskAcpSessionCloser(): Promise<CloseAcpSession> {
  const { getAcpSessionManagerCore } = await import("../acp/control-plane/manager.js");
  return async ({ cfg, sessionKey, agentId, reason }) => {
    await getAcpSessionManagerCore().closeSession({
      cfg,
      sessionKey,
      agentId,
      reason,
      discardPersistentState: true,
      clearMeta: true,
      allowBackendUnavailable: true,
      requireAcpSession: false,
    });
  };
}
