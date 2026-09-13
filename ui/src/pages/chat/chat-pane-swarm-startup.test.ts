/* @vitest-environment jsdom */

import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";

const swarmImport = vi.hoisted(() => {
  let release!: () => void;
  let markStarted!: () => void;
  return {
    held: new Promise<void>((resolve) => {
      release = resolve;
    }),
    started: new Promise<void>((resolve) => {
      markStarted = resolve;
    }),
    release: () => release(),
    markStarted: () => markStarted(),
  };
});

vi.mock("../../lib/sessions/swarm-roster.ts", async (importOriginal) => {
  swarmImport.markStarted();
  await swarmImport.held;
  return importOriginal();
});

describe("global pane Swarm startup ownership", () => {
  it("admits the latest agent after a stale module load without bypassing its foreground hold", async () => {
    vi.useFakeTimers();
    const parentAgents: unknown[] = [];
    const childParents: unknown[] = [];
    const agents = {
      defaultId: "main",
      mainKey: "main",
      scope: "global" as const,
      agents: [{ id: "main" }, { id: "research" }],
    };
    const client = createTestGatewayClient(async (method, raw) => {
      const params = asOptionalRecord(raw);
      if (method === "agents.list") {
        return agents;
      }
      if (method === "sessions.subscribe") {
        return { subscribed: true };
      }
      if (method === "sessions.describe" && params?.key === "global") {
        parentAgents.push(params.agentId);
        return { session: null };
      }
      if (method === "sessions.list") {
        if (params?.spawnedBy) {
          childParents.push(params.spawnedBy);
        }
        return sessionsResult([], 1);
      }
      return {};
    });
    const { pane, state } = createTestChatPane({ client });
    state.sessionKey = "global";
    state.assistantAgentId = "main";
    state.agentsList = agents;
    pane.sessionKey = "global";
    const snapshot = {
      ...pane.context.gateway.snapshot,
      assistantAgentId: "main",
      hello: {
        ...state.hello!,
        snapshot: {
          sessionDefaults: {
            defaultAgentId: "main",
            mainKey: "main",
            mainSessionKey: "global",
            scope: "global",
          },
        },
      },
    };
    const coordinator = pane.context.connectionBootstrap;
    try {
      pane.applyGatewaySnapshot(snapshot);
      await swarmImport.started;
      pane.context.agentSelection.set("research");
      pane.applyGatewaySnapshot(snapshot);
      expect(state.sessionKey).toBe("global");
      expect(state.assistantAgentId).toBe("research");

      coordinator.setForegroundRoute(undefined);
      swarmImport.release();
      await vi.dynamicImportSettled();
      await vi.advanceTimersByTimeAsync(500);
      expect(parentAgents).toEqual([]);
      expect(childParents).toEqual([]);

      coordinator.setForegroundRoute(null);
      await vi.dynamicImportSettled();
      await vi.advanceTimersByTimeAsync(250);
      expect(parentAgents).toEqual(["research"]);
      expect(childParents).toEqual(["global"]);
    } finally {
      swarmImport.release();
      coordinator.reset();
      vi.useRealTimers();
    }
  });
});
