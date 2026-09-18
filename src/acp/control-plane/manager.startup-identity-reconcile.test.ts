/** Tests startup reconciliation of pending ACP session identities. */
import { describe, expect, it } from "vitest";
import { createAcpSessionStoreEntryFixture } from "../../test-utils/acp-session-store-entry.js";
import {
  AcpSessionManager,
  baseCfg,
  createRuntime,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  installPublicAcpSessionFixture,
  readySessionMeta,
  type SessionAcpMeta,
} from "./manager.test-helpers.js";

describe("AcpSessionManager startup identity reconcile", () => {
  installAcpSessionManagerTestLifecycle();

  it("reconciles pending ACP identities during startup scan", async () => {
    const runtimeState = createRuntime();
    runtimeState.getStatus.mockResolvedValue({
      summary: "status=alive",
      acpxRecordId: "acpx-record-1",
      backendSessionId: "acpx-session-1",
      agentSessionId: "agent-session-1",
      details: { status: "alive" },
    });
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });

    const initialMeta = {
      ...readySessionMeta(),
      identity: {
        state: "pending",
        source: "ensure",
        acpxSessionId: "acpx-stale",
        lastUpdatedAt: Date.now(),
      },
    } satisfies SessionAcpMeta;
    const sessionKey = "agent:codex:acp:session-1";
    const metaState = installPublicAcpSessionFixture(sessionKey, initialMeta);
    hoisted.listAcpSessionEntriesMock.mockResolvedValue([
      {
        cfg: baseCfg,
        storePath: "/tmp/sessions-acp.json",
        sessionKey,
        storeSessionKey: sessionKey,
        entry: metaState.readEntry(),
        acp: metaState.currentMeta,
      },
    ]);

    const manager = new AcpSessionManager();
    const result = await manager.reconcilePendingSessionIdentities({ cfg: baseCfg });

    expect(result).toEqual({ checked: 1, resolved: 1, failed: 0 });
    expect(metaState.currentMeta.identity?.state).toBe("resolved");
    expect(metaState.currentMeta.identity?.acpxRecordId).toBe("acpx-record-1");
    expect(metaState.currentMeta.identity?.acpxSessionId).toBe("acpx-session-1");
    expect(metaState.currentMeta.identity?.agentSessionId).toBe("agent-session-1");
  });

  it("skips startup reconcile for pending identities without stable runtime ids", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });

    const sessionKey = "agent:claude:acp:binding:discord:default:9373ab192b2317f4";
    const acp = {
      ...readySessionMeta({
        agent: "claude",
      }),
      identity: {
        state: "pending" as const,
        acpxRecordId: sessionKey,
        source: "status" as const,
        lastUpdatedAt: Date.now(),
      },
    };
    hoisted.listAcpSessionEntriesMock.mockResolvedValue([
      createAcpSessionStoreEntryFixture({ cfg: baseCfg, sessionKey, acp }),
    ]);

    const manager = new AcpSessionManager();
    const result = await manager.reconcilePendingSessionIdentities({ cfg: baseCfg });

    expect(result).toEqual({ checked: 0, resolved: 0, failed: 0 });
    expect(runtimeState.ensureSession).not.toHaveBeenCalled();
    expect(runtimeState.getStatus).not.toHaveBeenCalled();
  });

  it("skips startup identity reconciliation for already resolved sessions", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const sessionKey = "agent:codex:acp:session-1";
    const resolvedMeta: SessionAcpMeta = {
      ...readySessionMeta(),
      identity: {
        state: "resolved",
        source: "status",
        acpxSessionId: "acpx-sid-1",
        agentSessionId: "agent-sid-1",
        lastUpdatedAt: Date.now(),
      },
    };
    hoisted.listAcpSessionEntriesMock.mockResolvedValue([
      createAcpSessionStoreEntryFixture({ cfg: baseCfg, sessionKey, acp: resolvedMeta }),
    ]);

    const manager = new AcpSessionManager();
    const result = await manager.reconcilePendingSessionIdentities({ cfg: baseCfg });

    expect(result).toEqual({ checked: 0, resolved: 0, failed: 0 });
    expect(runtimeState.getStatus).not.toHaveBeenCalled();
    expect(runtimeState.ensureSession).not.toHaveBeenCalled();
  });

  it("skips pending oneshot identities during startup reconciliation", async () => {
    const runtimeState = createRuntime();
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({
      id: "acpx",
      runtime: runtimeState.runtime,
    });
    const sessionKey = "agent:codex:acp:oneshot:session-1";
    const acp: SessionAcpMeta = {
      ...readySessionMeta(),
      mode: "oneshot",
      identity: {
        state: "pending",
        source: "ensure",
        acpxSessionId: "acpx-stale",
        lastUpdatedAt: Date.now(),
      },
    };
    hoisted.listAcpSessionEntriesMock.mockResolvedValue([
      createAcpSessionStoreEntryFixture({ cfg: baseCfg, sessionKey, acp }),
    ]);

    const result = await new AcpSessionManager().reconcilePendingSessionIdentities({
      cfg: baseCfg,
    });

    expect(result).toEqual({ checked: 0, resolved: 0, failed: 0 });
    expect(runtimeState.ensureSession).not.toHaveBeenCalled();
    expect(runtimeState.getStatus).not.toHaveBeenCalled();
  });
});
