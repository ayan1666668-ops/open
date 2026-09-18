import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import {
  ensureSessionEntrySync,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawAgentDatabases } from "../../state/openclaw-agent-db.js";
import { createGatewayPortalService } from "../portals/portal-service.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import {
  environmentsSessionHandlers,
  resolveSessionEnvironmentCaller,
} from "../server-methods/environments.session.js";
import { portalHandlers } from "../server-methods/portals.js";
import type { GatewayRequestHandlerOptions } from "../server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import * as support from "./service.test-support.js";

describe("conversation-owned temporary environments", () => {
  support.setupWorkerEnvironmentServiceSuite();
  const identity = {
    sessionId: "conversation-one",
    sessionKey: "agent:main:crabbox",
    agentId: "main",
  };
  const request = { ...identity, profileId: "development", idempotencyKey: "open-desktop" };
  const authorize = () => {};
  const scope = () => ({
    agentId: identity.agentId,
    sessionKey: identity.sessionKey,
    storePath: support.testState.config.session!.store,
  });

  beforeEach(() => {
    support.testState.config.session = {
      store: path.join(support.testState.root, "sessions.json"),
    };
    ensureSessionEntrySync(scope(), { sessionId: identity.sessionId, updatedAt: 1 });
  });
  afterEach(() => closeOpenClawAgentDatabases());

  it("admits the actual plugin RPC through ambient run authority and fences a retained caller after revocation", async () => {
    const service = support.createService(support.createProvider());
    const respond = vi.fn();
    const context = createDirectChatContext({
      getRuntimeConfig: () => support.testState.config,
      workerEnvironmentService: service,
    });
    const options: GatewayRequestHandlerOptions = {
      req: { type: "req", id: "request-one", method: "environments.session.create" },
      params: { profileId: request.profileId, idempotencyKey: request.idempotencyKey },
      context,
      client: createSyntheticPluginRuntimeClient({ pluginRuntimeOwnerId: "crabbox" }),
      isWebchatConnect: () => false,
      respond,
    };
    expect(() => resolveSessionEnvironmentCaller(options)).toThrow(
      "authenticated operator or admitted agent run",
    );
    let live = true;
    await withGatewayToolCallerIdentity(
      {
        ...identity,
        operationalRunInstance: { instanceId: "run-instance", runId: "run-one" },
        receiptAuthority: () => live,
      },
      async () => {
        const caller = resolveSessionEnvironmentCaller(options);
        expect(() =>
          resolveSessionEnvironmentCaller(options, { sessionKey: "agent:main:other" }),
        ).toThrow("only manage its own");
        await environmentsSessionHandlers["environments.session.create"]!(options);
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({
            environment: expect.objectContaining({ status: "available" }),
          }),
        );
        live = false;
        expect(caller.assertCurrent).toThrow("no longer active");
      },
    );
  });

  it("opens a portal through ambient plugin authority and closes an unused carrier when that authority ends", async () => {
    const service = support.createService(support.createProvider());
    const created = await service.createSessionAttachment(request, authorize);
    const portalService = createGatewayPortalService({
      httpBindHosts: ["127.0.0.1"],
      httpServers: [],
    });
    const closeConnection = vi.fn(async () => {});
    let live = true;
    let revokeDuringDiscovery = false;
    const openNodePortal = vi.spyOn(service, "openNodePortal").mockImplementation(async () => {
      if (revokeDuringDiscovery) {
        live = false;
      }
      return { connect: vi.fn(), close: closeConnection };
    });
    const context = createDirectChatContext({
      getRuntimeConfig: () => support.testState.config,
      workerEnvironmentService: service,
      portalService,
      broadcast: vi.fn(),
    });
    const invoke = async (environmentId: string, port: number) => {
      const respond = vi.fn();
      await portalHandlers["portal.open"]!({
        req: { type: "req", id: "portal-one", method: "portal.open" },
        params: { environmentId, port },
        context,
        client: createSyntheticPluginRuntimeClient({ pluginRuntimeOwnerId: "crabbox" }),
        isWebchatConnect: () => false,
        respond,
      });
      return respond;
    };
    try {
      await withGatewayToolCallerIdentity(
        {
          ...identity,
          operationalRunInstance: { instanceId: "portal-instance", runId: "portal-run" },
          receiptAuthority: () => live,
          gatewayContextResolver: () => context,
        },
        async () => {
          const opened = await invoke(created.attachment.environmentId, 3000);
          expect(opened.mock.calls[0]?.[0]).toBe(true);
          expect(
            portalService.listWorkerPortals(
              created.attachment.environmentId,
              created.attachment.ownerEpoch,
            ),
          ).toHaveLength(1);
          expect((await invoke("worker:another-conversation", 3000)).mock.calls[0]?.[0]).toBe(
            false,
          );
          expect(openNodePortal).toHaveBeenCalledTimes(1);
          revokeDuringDiscovery = true;
          expect((await invoke(created.attachment.environmentId, 3001)).mock.calls[0]?.[0]).toBe(
            false,
          );
          expect(closeConnection).toHaveBeenCalledOnce();
          expect(portalService.list()).toHaveLength(1);
        },
      );
    } finally {
      await portalService.closeAll();
    }
  });

  it("reuses concurrent and changed-key retries without moving the conversation or allowing placement adoption", async () => {
    const provision = vi.fn(async () => ({ leaseId: "lease-one", ssh: support.SSH_ENDPOINT }));
    const service = support.createService(support.createProvider({ provision }));
    const [first, retry] = await Promise.all([
      service.createSessionAttachment({ ...request, os: "linux", machineClass: "tiny" }, authorize),
      service.createSessionAttachment(
        { ...request, idempotencyKey: "retried-tool-call" },
        authorize,
      ),
    ]);
    expect(provision).toHaveBeenCalledOnce();
    expect(retry.attachment).toEqual(first.attachment);
    expect(retry.reused).toBe(true);
    expect(
      support.testState.store.get(first.attachment.environmentId)?.profileSnapshot,
    ).toMatchObject({ os: "linux", machineClass: "tiny" });
    const explicitRetry = await service.createSessionAttachment(
      { ...request, os: "linux", machineClass: "tiny" },
      authorize,
    );
    expect(explicitRetry.attachment.environmentId).toBe(first.attachment.environmentId);
    for (const incompatible of [{ os: "windows" }, { machineClass: "large" }]) {
      await expect(
        service.createSessionAttachment({ ...request, ...incompatible }, authorize),
      ).rejects.toThrow("already owns a different environment");
    }
    expect(provision).toHaveBeenCalledOnce();
    expect(first.environment).toMatchObject({ state: "ready", attachedSessionIds: [] });
    expect(service.findSessionAttachment(identity)).toMatchObject({
      ...identity,
      environmentId: first.attachment.environmentId,
    });
    await expect(service.attachSession(first.attachment)).rejects.toThrow("cannot be adopted");
  });

  it("cancels a queued allocation when Stop arrives before its attachment is reserved", async () => {
    const provision = vi.fn(async () => ({ leaseId: "lease-one", ssh: support.SSH_ENDPOINT }));
    const service = support.createService(support.createProvider({ provision }));
    const creation = service.createSessionAttachment(request, authorize);
    await service.destroySessionAttachment({ sessionId: identity.sessionId }, authorize);
    await expect(creation).rejects.toThrow("was stopped");
    expect(provision).not.toHaveBeenCalled();
    expect(support.testState.store.list()).toEqual([]);
  });

  it("preserves the attachment through reopen and rejects the old session incarnation after replacement", async () => {
    const provider = support.createProvider();
    let service = support.createService(provider);
    const created = await service.createSessionAttachment(request, authorize);
    await support.reopenWorkerEnvironmentStore();
    service = support.createService(provider);
    expect(service.findSessionAttachment(identity)).toMatchObject({
      ...identity,
      environmentId: created.attachment.environmentId,
    });
    replaceSessionEntrySync(scope(), {
      sessionId: identity.sessionId,
      lifecycleRevision: "reset-incarnation",
      updatedAt: 2,
    });
    expect(service.findSessionAttachment(identity)).toBeUndefined();
    expect(() => service.assertSessionAttachment(created.attachment)).toThrow("no longer current");
    await service.reconcileSessionAttachments();
    expect(service.get(created.attachment.environmentId)?.state).toBe("destroyed");
  });

  it("closes authorization before waiting for provider teardown and requires a fresh key for a replacement", async () => {
    const stopped = createDeferredCore<void>();
    const destroy = vi.fn(async () => await stopped.promise);
    let allocations = 0;
    const service = support.createService(
      support.createProvider({
        destroy,
        provision: async () => ({ leaseId: `lease-${++allocations}`, ssh: support.SSH_ENDPOINT }),
      }),
    );
    const created = await service.createSessionAttachment(request, authorize);
    const teardown = service.destroySessionAttachment({ sessionId: identity.sessionId }, authorize);
    expect(service.findSessionAttachment(identity)).toBeUndefined();
    expect(() => service.assertSessionAttachment(created.attachment)).toThrow("no longer current");
    stopped.resolve();
    await teardown;
    expect(service.get(created.attachment.environmentId)?.state).toBe("destroyed");
    await expect(service.createSessionAttachment(request, authorize)).rejects.toThrow(
      "already stopped",
    );
    const next = await service.createSessionAttachment(
      { ...request, idempotencyKey: "new-box" },
      authorize,
    );
    expect(next.attachment.generation).toBe(created.attachment.generation + 1);
  });

  it("retains a failed cleanup owner and forbids replacement until provider destruction is confirmed", async () => {
    const destroy = vi
      .fn()
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockResolvedValue(undefined);
    const service = support.createService(support.createProvider({ destroy }));
    const created = await service.createSessionAttachment(request, authorize);
    await expect(
      service.destroySessionAttachment({ sessionId: identity.sessionId }, authorize),
    ).rejects.toThrow("provider unavailable");
    await expect(
      service.createSessionAttachment({ ...request, idempotencyKey: "replacement" }, authorize),
    ).rejects.toThrow("already owns");
    expect(
      service.getSessionAttachmentStatus(identity.sessionId)?.attachment.closedAtMs,
    ).not.toBeNull();
    await service.reconcileSessionAttachments();
    expect(service.get(created.attachment.environmentId)?.state).toBe("destroyed");
    expect(destroy).toHaveBeenCalledTimes(2);
  });

  it("does not allocate after caller revocation and expires only the unchanged idle attachment", async () => {
    const provision = vi.fn(async () => ({ leaseId: "lease-one", ssh: support.SSH_ENDPOINT }));
    const service = support.createService(support.createProvider({ provision }));
    await expect(
      service.createSessionAttachment(request, () => {
        throw new Error("run ended");
      }),
    ).rejects.toThrow("run ended");
    expect(provision).not.toHaveBeenCalled();
    expect(support.testState.store.list()).toEqual([]);
    support.getDevelopmentProfile().suspendAfter = "1m";
    const created = await service.createSessionAttachment(request, authorize);
    support.testState.nowMs += 59_000;
    service.touchSessionAttachment(created.attachment);
    support.testState.nowMs += 59_000;
    await service.reconcileSessionAttachments();
    expect(service.findSessionAttachment(identity)).toBeDefined();
    support.testState.nowMs += 1_001;
    await service.reconcileSessionAttachments();
    expect(service.findSessionAttachment(identity)).toBeUndefined();
    expect(service.get(created.attachment.environmentId)?.state).toBe("destroyed");
  });
});
