import type { OpenClawConfig } from "../../../config/types.openclaw.js";

export function createDefaultSpawnConfig(): OpenClawConfig {
  return {
    acp: {
      enabled: true,
      backend: "acpx",
      allowedAgents: ["codex"],
    },
    agents: {
      defaults: {
        subagents: {
          allowAgents: ["codex"],
          maxSpawnDepth: 2,
        },
      },
    },
    session: {
      mainKey: "main",
      scope: "per-sender",
      threadBindings: {
        enabled: true,
        spawnSessions: true,
      },
    },
  };
}
