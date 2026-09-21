import { expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import { createClientHarness } from "./test-support.js";

export function registerClientRuntimeOwnershipTests(
  runtime: typeof import("./client-runtime.js"),
  creations: typeof import("./client-runtime-state.js"),
  clients: CodexAppServerClient[],
  mocks: { refreshAuth: ReturnType<typeof vi.fn>; mergeRateLimitUpdate: ReturnType<typeof vi.fn> },
  EXPECTED_LIVE_THREAD_IDLE_TIMEOUT_MS: number,
  EXPECTED_MAX_IDLE_LIVE_THREADS: number,
) {
  const {
    ensureCodexAppServerClientRuntime,
    retainCodexAppServerLiveThread,
    consumeCodexAppServerLiveThread,
    hasCodexAppServerLiveThread,
    releaseCodexAppServerLiveThread,
    protectCodexAppServerLiveThread,
  } = runtime;
  const {
    recordCodexEphemeralThreadCreation,
    readCodexNativeHookInstallation,
    readCodexEphemeralThreadCatalog,
  } = creations;
  it("retains ephemeral policy and history beyond persistent idle and capacity limits", async () => {
    vi.useFakeTimers();
    const { client } = createClientHarness();
    clients.push(client);
    ensureCodexAppServerClientRuntime(client, { agentDir: "/tmp/agent" });
    const release = vi.fn(async (_threadId: string) => undefined);
    await retainCodexAppServerLiveThread(client, "ephemeral", release, "creation-config", null, "");
    for (let i = 0; i <= EXPECTED_MAX_IDLE_LIVE_THREADS; i++) {
      await retainCodexAppServerLiveThread(client, `persistent-${i}`, release);
    }
    await vi.advanceTimersByTimeAsync(EXPECTED_LIVE_THREAD_IDLE_TIMEOUT_MS + 1);
    const ownership = await consumeCodexAppServerLiveThread(client, "ephemeral");
    expect(ownership).toMatchObject({ configFingerprint: "creation-config", ephemeralPolicy: "" });
    expect(release.mock.calls.some(([threadId]) => threadId === "ephemeral")).toBe(false);
    await ownership?.release("ephemeral");
    expect(hasCodexAppServerLiveThread(client, "ephemeral")).toBe(false);
  });

  it("keeps hook creation facts and catalogs through claim return and clears only exact retirement", async () => {
    const a = createClientHarness();
    const b = createClientHarness();
    clients.push(a.client, b.client);
    for (const client of [a.client, b.client]) {
      ensureCodexAppServerClientRuntime(client, { agentDir: "/tmp/agent" });
    }
    recordCodexEphemeralThreadCreation(a.client, "thread", {
      hookInstallation: "installed",
      dynamicTools: [],
    });
    recordCodexEphemeralThreadCreation(a.client, "sibling", {
      hookInstallation: "sibling-installed",
      dynamicTools: [],
    });
    expect(readCodexNativeHookInstallation(b.client, "thread")).toBeUndefined();
    expect(readCodexEphemeralThreadCatalog(b.client, "thread")).toBeUndefined();
    expect(readCodexEphemeralThreadCatalog(a.client, "thread")).toEqual([]);
    const copy = readCodexEphemeralThreadCatalog(a.client, "thread")!;
    copy.push({ type: "function", name: "changed", description: "Changed", inputSchema: {} });
    expect(readCodexEphemeralThreadCatalog(a.client, "thread")).toEqual([]);
    const release = vi.fn(async () => undefined);
    await retainCodexAppServerLiveThread(a.client, "thread", release, "config", null, "policy");
    const claim = await consumeCodexAppServerLiveThread(a.client, "thread");
    expect(claim).toBeDefined();
    expect(readCodexNativeHookInstallation(a.client, "thread")).toBe("installed");
    await retainCodexAppServerLiveThread(
      a.client,
      "thread",
      claim!.release,
      "config",
      null,
      "policy",
    );
    a.send({ method: "thread/compacted", params: { threadId: "thread" } });
    expect(readCodexNativeHookInstallation(a.client, "thread")).toBe("installed");
    expect(readCodexEphemeralThreadCatalog(a.client, "thread")).toEqual([]);
    await releaseCodexAppServerLiveThread(a.client, "thread");
    expect(readCodexNativeHookInstallation(a.client, "thread")).toBeUndefined();
    expect(readCodexEphemeralThreadCatalog(a.client, "thread")).toBeUndefined();
    expect(readCodexNativeHookInstallation(a.client, "sibling")).toBe("sibling-installed");
    a.client.close();
    expect(readCodexNativeHookInstallation(a.client, "sibling")).toBeUndefined();
    expect(readCodexEphemeralThreadCatalog(a.client, "sibling")).toBeUndefined();
  });

  it("installs shared handlers once per physical client", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);
    const context = {
      agentDir: "/tmp/agent",
      authProfileId: "openai:default",
      config: {},
    };
    const updatedContext = {
      ...context,
      authProfileStore: { version: 1 as const, profiles: {} },
      config: { models: { mode: "merge" as const } },
    };
    const addNotificationHandler = vi.spyOn(harness.client, "addNotificationHandler");
    const addRequestHandler = vi.spyOn(harness.client, "addRequestHandler");
    const addCloseHandler = vi.spyOn(harness.client, "addCloseHandler");

    ensureCodexAppServerClientRuntime(harness.client, context);
    ensureCodexAppServerClientRuntime(harness.client, updatedContext);

    expect(addNotificationHandler).toHaveBeenCalledTimes(1);
    expect(addRequestHandler).toHaveBeenCalledTimes(1);
    expect(addCloseHandler).toHaveBeenCalledTimes(1);
    harness.send({
      method: "account/rateLimits/updated",
      params: { rateLimits: { primary: { usedPercent: 12 } } },
    });
    harness.send({
      id: "refresh-1",
      method: "account/chatgptAuthTokens/refresh",
      params: { reason: "expired" },
    });

    await vi.waitFor(() => expect(mocks.mergeRateLimitUpdate).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(mocks.refreshAuth).toHaveBeenCalledTimes(1));
    expect(mocks.refreshAuth).toHaveBeenCalledWith({
      ...context,
      config: updatedContext.config,
    });
    expect(mocks.mergeRateLimitUpdate).toHaveBeenCalledWith(harness.client, {
      rateLimits: { primary: { usedPercent: 12 } },
    });
    await vi.waitFor(() =>
      expect(harness.writes.map((line) => JSON.parse(line) as unknown)).toContainEqual({
        id: "refresh-1",
        result: { accessToken: "refreshed", chatgptAccountId: "account" },
      }),
    );
  });

  it("shares creation facts and branded subscription ownership across module generations", async () => {
    const { client } = createClientHarness();
    const sibling = createClientHarness().client;
    clients.push(client, sibling);
    const notification = vi.spyOn(client, "addNotificationHandler");
    const request = vi.spyOn(client, "addRequestHandler");
    const close = vi.spyOn(client, "addCloseHandler");
    ensureCodexAppServerClientRuntime(client, { agentDir: "/tmp/agent" });
    ensureCodexAppServerClientRuntime(sibling, { agentDir: "/tmp/sibling" });
    const creation = {
      hookInstallation: "installed",
      dynamicTools: [
        { type: "function" as const, name: "read", description: "Read", inputSchema: {} },
      ],
    };
    recordCodexEphemeralThreadCreation(client, "thread", creation);
    recordCodexEphemeralThreadCreation(sibling, "thread", creation);
    const release = vi.fn(async () => undefined);
    await retainCodexAppServerLiveThread(client, "thread", release, "config", null, "policy");
    const original = await consumeCodexAppServerLiveThread(client, "thread");
    expect(original).toBeDefined();

    vi.resetModules();
    const replacement = await import("./client-runtime.js");
    const replacementCreations = await import("./client-runtime-state.js");
    replacement.ensureCodexAppServerClientRuntime(client, { agentDir: "/tmp/agent", config: {} });
    expect(notification).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(replacement.isCodexAppServerLiveThreadClaimed(client, "thread")).toBe(true);
    expect(replacementCreations.readCodexNativeHookInstallation(client, "thread")).toBe(
      "installed",
    );
    expect(replacementCreations.readCodexEphemeralThreadCatalog(client, "thread")).toEqual(
      creation.dynamicTools,
    );
    expect(
      await replacement.retainCodexAppServerLiveThread(
        client,
        "thread",
        original!.release,
        "config",
        null,
        "policy",
      ),
    ).toBe(true);
    const successor = await replacement.consumeCodexAppServerLiveThread(client, "thread");
    expect(successor).toMatchObject({ configFingerprint: "config", ephemeralPolicy: "policy" });
    await original!.release("thread");
    expect(release).not.toHaveBeenCalled();
    expect(() => successor!.assertCurrent()).not.toThrow();
    await successor!.release("thread");
    expect(release).toHaveBeenCalledExactlyOnceWith("thread");
    expect(readCodexNativeHookInstallation(client, "thread")).toBeUndefined();
    expect(replacementCreations.readCodexEphemeralThreadCatalog(client, "thread")).toBeUndefined();
    expect(replacementCreations.readCodexNativeHookInstallation(sibling, "thread")).toBe(
      "installed",
    );
    sibling.close();
    expect(replacementCreations.readCodexNativeHookInstallation(sibling, "thread")).toBeUndefined();
  });

  it("keeps native-child protection and exact close ownership across module generations", async () => {
    vi.useFakeTimers();
    const { client } = createClientHarness();
    const sibling = createClientHarness().client;
    clients.push(client, sibling);
    ensureCodexAppServerClientRuntime(client, { agentDir: "/tmp/agent" });
    ensureCodexAppServerClientRuntime(sibling, { agentDir: "/tmp/sibling" });
    const release = vi.fn(async () => undefined);
    const unprotect = protectCodexAppServerLiveThread(client, "parent");
    await retainCodexAppServerLiveThread(client, "parent", release, "config");
    await retainCodexAppServerLiveThread(
      sibling,
      "sibling",
      release,
      "sibling-config",
      null,
      "policy",
    );

    vi.resetModules();
    const replacement = await import("./client-runtime.js");

    replacement.ensureCodexAppServerClientRuntime(client, { agentDir: "/tmp/agent" });
    await replacement.retainCodexAppServerLiveThread(client, "parent", release, "config");
    await vi.advanceTimersByTimeAsync(EXPECTED_LIVE_THREAD_IDLE_TIMEOUT_MS + 1);
    expect(replacement.hasCodexAppServerLiveThread(client, "parent")).toBe(true);
    expect(release).not.toHaveBeenCalled();
    client.close();
    unprotect();
    expect(replacement.hasCodexAppServerLiveThread(client, "parent")).toBe(false);
    expect(replacement.hasCodexAppServerLiveThread(sibling, "sibling")).toBe(true);
    await replacement.releaseCodexAppServerLiveThread(sibling, "sibling");
    expect(release).toHaveBeenCalledExactlyOnceWith("sibling");
  });
}
