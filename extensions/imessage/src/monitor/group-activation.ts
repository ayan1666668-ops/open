import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeGroupActivation } from "openclaw/plugin-sdk/group-activation";
import { getSessionEntry, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";

export function createIMessageGroupActivationResolver(logVerbose: (message: string) => void) {
  return (params: { agentId: string; sessionKey: string; cfg: OpenClawConfig }) => {
    const storePath = resolveStorePath(params.cfg.session?.store, { agentId: params.agentId });
    try {
      const activation = normalizeGroupActivation(
        getSessionEntry({ storePath, sessionKey: params.sessionKey })?.groupActivation,
      );
      if (activation === "always") {
        return false;
      }
      if (activation === "mention") {
        return true;
      }
    } catch (err) {
      logVerbose(`Failed to load session for activation check: ${String(err)}`);
    }
    return undefined;
  };
}
