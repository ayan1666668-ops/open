// Codex tests cover conversation control plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  loadPreparedModelCatalog,
} from "openclaw/plugin-sdk/agent-runtime";
import { withPluginRuntimeRegistryScope } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { MODEL_SELECTION_LOCKED_MESSAGE } from "openclaw/plugin-sdk/model-session-runtime";
import {
  createEmptyPluginRegistry,
  createPluginRecord,
  createPluginRegistryOwner,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { upsertAuthProfile } from "openclaw/plugin-sdk/provider-auth";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  getSessionEntry,
  resolveStorePath,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodexAppServerAgentHarness } from "../harness.js";
import {
  buildCodexSupervisionTestConnectionFingerprint,
  readCodexAppServerBinding,
  resetCodexTestBindingStore,
  testCodexAppServerBindingStore,
  writeCodexAppServerBinding,
} from "./app-server/session-binding.test-helpers.js";
import { createClientHarness } from "./app-server/test-support.js";
import {
  formatPermissionsMode,
  parseCodexPermissionsModeArg,
  steerCodexConversationTurn,
  stopCodexConversationTurn,
  trackCodexConversationActiveTurn,
  setCodexConversationFastMode as setCodexConversationFastModeImpl,
  setCodexConversationModel as setCodexConversationModelImpl,
  setCodexConversationPermissions as setCodexConversationPermissionsImpl,
} from "./conversation-control.js";

function controlTarget(sessionFile: string) {
  const identity = { kind: "session" as const, agentId: "main", sessionId: sessionFile };
  const binding = testCodexAppServerBindingStore.read(identity);
  return {
    identity,
    bindingStore: testCodexAppServerBindingStore,
    binding,
    assertCurrent: () => {
      expect(testCodexAppServerBindingStore.read(identity)).toEqual(binding);
    },
  };
}

function mutateActiveTurn(command: "stop" | "steer", target: ReturnType<typeof controlTarget>) {
  return command === "stop"
    ? stopCodexConversationTurn(target)
    : steerCodexConversationTurn({ ...target, message: "focus tests" });
}

function setCodexConversationFastMode(
  params: Omit<
    Parameters<typeof setCodexConversationFastModeImpl>[0],
    "identity" | "bindingStore" | "binding" | "assertCurrent"
  > & {
    sessionFile: string;
  },
) {
  const { sessionFile, ...rest } = params;
  return setCodexConversationFastModeImpl({ ...rest, ...controlTarget(sessionFile) });
}

function setCodexConversationModel(
  params: Omit<
    Parameters<typeof setCodexConversationModelImpl>[0],
    "identity" | "bindingStore" | "binding" | "assertCurrent"
  > & {
    sessionFile: string;
  },
) {
  const { sessionFile, ...rest } = params;
  return setCodexConversationModelImpl({ ...rest, ...controlTarget(sessionFile) });
}

let tempDir: string;
const tempDirs: string[] = [];

async function withDirectModelCatalog(
  run: (params: { config: OpenClawConfig; agentDir: string }) => Promise<void>,
) {
  const agentDir = path.join(tempDir, "agents", "main", "agent");
  const config: OpenClawConfig = {
    agents: {
      list: [{ id: "main", agentDir, workspace: tempDir }],
      defaults: { model: "openai/gpt-5.4", agentRuntime: { id: "codex" } },
    },
    plugins: {
      allow: ["openai", "codex"],
      entries: { codex: { enabled: true, config: { discovery: { enabled: false } } } },
    },
    models: {
      mode: "replace",
      providers: {
        openai: {
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          models: [
            { id: "gpt-5.4", name: "Original" },
            { id: "gpt-5.5", name: "Selected" },
          ].map(({ id, name }) => ({
            id,
            name,
            reasoning: false,
            input: ["text" as const],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128_000,
            maxTokens: 8_192,
          })),
        },
      },
    },
    auth: {
      profiles: {
        "openai:personal": { provider: "openai", mode: "api_key" },
        "lmstudio:work": { provider: "lmstudio", mode: "api_key" },
      },
    },
  };
  const previousConfig = getRuntimeConfigSnapshot();
  setRuntimeConfigSnapshot(config);
  const registry = createEmptyPluginRegistry();
  registry.plugins.push(createPluginRecord({ id: "codex", agentHarnessIds: ["codex"] }));
  registry.agentHarnesses.push({
    pluginId: "codex",
    source: "test",
    harness: createCodexAppServerAgentHarness({ bindingStore: testCodexAppServerBindingStore }),
  });
  const owner = createPluginRegistryOwner(registry, tempDir);
  try {
    for (const { profileId, provider } of [
      { profileId: "openai:personal", provider: "openai" },
      { profileId: "lmstudio:work", provider: "lmstudio" },
    ]) {
      upsertAuthProfile({
        agentDir,
        profileId,
        credential: { type: "api_key", provider, key: "synthetic-control-credential" },
      });
    }
    await withPluginRuntimeRegistryScope(registry, async () => {
      const catalog = await loadPreparedModelCatalog({
        config,
        agentId: "main",
        agentDir,
        workspaceDir: tempDir,
        readOnly: false,
      });
      expect(catalog).toContainEqual(
        expect.objectContaining({ provider: "openai", id: "gpt-5.5" }),
      );
      await run({ config, agentDir });
    });
  } finally {
    try {
      expect(await owner.close()).toEqual({ memoryErrors: [], pluginFailures: [] });
    } finally {
      if (previousConfig) {
        setRuntimeConfigSnapshot(previousConfig);
      } else {
        clearRuntimeConfigSnapshot();
      }
    }
  }
}

const sharedClientMocks = vi.hoisted(() => ({
  getSharedCodexAppServerClient: vi.fn(),
  releaseLeasedSharedCodexAppServerClient: vi.fn(),
}));

vi.mock("./app-server/shared-client.js", () => ({
  ...sharedClientMocks,
  getLeasedSharedCodexAppServerClient: sharedClientMocks.getSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient:
    sharedClientMocks.releaseLeasedSharedCodexAppServerClient,
  releaseCodexAppServerClientLease: vi.fn((lease: { client?: unknown }) => {
    lease.client = undefined;
  }),
  withLeasedCodexAppServerClientStartSelectionRetry: async (params: {
    lease: { client?: unknown };
    options?: { timeoutMs?: number };
    run: (
      client: unknown,
      requestOptions: () => { timeoutMs: number; assertCurrent: () => void },
    ) => Promise<unknown>;
  }) =>
    await params.run(params.lease.client, () => ({
      timeoutMs: params.options?.timeoutMs ?? 60_000,
      assertCurrent: () => undefined,
    })),
}));

describe("codex conversation controls", () => {
  beforeEach(async () => {
    resetCodexTestBindingStore();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-control-"));
    tempDirs.push(tempDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    sharedClientMocks.getSharedCodexAppServerClient.mockReset();
    sharedClientMocks.releaseLeasedSharedCodexAppServerClient.mockReset();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    clearRuntimeAuthProfileStoreSnapshots();
  });

  afterAll(async () => {
    // The outer afterEach drains prepared catalog owners before their fixture storage is removed.
    await Promise.all(
      tempDirs.map((directory) => fs.rm(directory, { recursive: true, force: true })),
    );
  });

  it("persists fast mode on the binding and permissions on the session", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const session = {
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
    };
    const storePath = resolveStorePath(undefined, { agentId: session.agentId });
    await upsertSessionEntry({
      agentId: session.agentId,
      sessionKey: session.sessionKey,
      storePath,
      entry: {
        sessionId: session.sessionId,
        updatedAt: Date.now(),
        permissionMode: "full",
        sessionRoot: tempDir,
      },
    });
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
      model: "gpt-5.4",
      modelProvider: "openai",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });

    await expect(setCodexConversationFastMode({ sessionFile, enabled: true })).resolves.toBe(
      "Codex fast mode enabled.",
    );
    await expect(
      setCodexConversationPermissionsImpl({
        session,
        mode: "default",
        config: {},
        assertCurrent: () => {},
      }),
    ).resolves.toBe("Codex permissions set to guarded.");

    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding?.threadId).toBe("thread-1");
    expect(binding?.serviceTier).toBe("priority");
    expect(binding?.approvalPolicy).toBe("never");
    expect(binding?.sandbox).toBe("danger-full-access");
    expect(
      getSessionEntry({
        agentId: session.agentId,
        sessionKey: session.sessionKey,
        storePath,
        readConsistency: "latest",
      }),
    ).toMatchObject({ permissionMode: "guarded", sessionRoot: tempDir });

    await expect(
      setCodexConversationPermissionsImpl({
        session,
        mode: "yolo",
        config: {},
        assertCurrent: () => {},
      }),
    ).resolves.toBe("Codex permissions set to full access.");
    expect(
      getSessionEntry({
        agentId: session.agentId,
        sessionKey: session.sessionKey,
        storePath,
        readConsistency: "latest",
      })?.permissionMode,
    ).toBe("full");
  });

  it("rejects prepared binding mutations after the selected binding changes", async () => {
    const sessionFile = path.join(tempDir, "prepared-binding.jsonl");
    const identity = controlTarget(sessionFile).identity;
    const prepared = {
      threadId: "thread-prepared",
      cwd: tempDir,
      model: "gpt-5.4",
      modelProvider: "openai",
    };
    await writeCodexAppServerBinding(sessionFile, prepared);
    const assertCurrent = () => {
      expect(testCodexAppServerBindingStore.read(identity)).toEqual(prepared);
    };
    await testCodexAppServerBindingStore.mutate(identity, {
      kind: "set",
      binding: { ...prepared, threadId: "thread-replacement" },
    });

    await expect(
      setCodexConversationFastModeImpl({
        identity,
        bindingStore: testCodexAppServerBindingStore,
        binding: prepared,
        enabled: true,
        assertCurrent,
      }),
    ).rejects.toThrow();
    expect(testCodexAppServerBindingStore.read(identity)).not.toHaveProperty("serviceTier");
  });

  it.each([
    { mode: "read-only" as const, display: "read-only" },
    { mode: "guarded" as const, display: "guarded" },
    { mode: "workspace" as const, display: "workspace" },
    { mode: "full" as const, display: "full access" },
  ])("reports the explicit $mode conversation permission mode", ({ mode, display }) => {
    expect(formatPermissionsMode(mode)).toBe(display);
  });

  it.each(["default", "guardian", "guarded", "approve"])(
    "recognizes %s as an explicit guarded conversation permission command",
    (mode) => {
      expect(parseCodexPermissionsModeArg(mode)).toBe("default");
    },
  );

  it("persists a permission mode on a rootless session", async () => {
    const session = {
      agentId: "main",
      sessionId: "session-without-root",
      sessionKey: "agent:main:session-without-root",
    };
    const storePath = resolveStorePath(undefined, { agentId: session.agentId });
    await upsertSessionEntry({
      agentId: session.agentId,
      sessionKey: session.sessionKey,
      storePath,
      entry: { sessionId: session.sessionId, updatedAt: Date.now() },
    });

    await expect(
      setCodexConversationPermissionsImpl({
        session,
        mode: "default",
        config: {},
        assertCurrent: () => {},
      }),
    ).resolves.toBe("Codex permissions set to guarded.");
    expect(
      getSessionEntry({ agentId: session.agentId, sessionKey: session.sessionKey, storePath }),
    ).toMatchObject({ permissionMode: "guarded" });
  });

  it("routes supervised stop and steer requests through the native user-home connection", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-supervised",
      connectionScope: "supervision",
      supervisionSourceThreadId: "thread-supervised",
      appServerRuntimeFingerprint: buildCodexSupervisionTestConnectionFingerprint(),
      cwd: tempDir,
      model: "gpt-5.5",
      modelProvider: "openai",
      preserveNativeModel: true,
      conversationSourceTransferComplete: true,
    });
    const target = controlTarget(sessionFile);
    const request = vi.fn(async () => ({}));
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({ request });
    const stopTracking = trackCodexConversationActiveTurn({
      identity: target.identity,
      threadId: "thread-supervised",
      turnId: "turn-1",
    });

    try {
      await stopCodexConversationTurn({
        ...target,
        pluginConfig: { supervision: { enabled: true } },
      });
      await steerCodexConversationTurn({
        ...target,
        message: "focus tests",
        pluginConfig: { supervision: { enabled: true } },
      });
    } finally {
      stopTracking();
    }

    for (const [options] of sharedClientMocks.getSharedCodexAppServerClient.mock.calls) {
      expect(options).toMatchObject({
        authProfileId: null,
        startOptions: { homeScope: "user" },
      });
    }
    expect(request).toHaveBeenNthCalledWith(
      1,
      "turn/interrupt",
      { threadId: "thread-supervised", turnId: "turn-1" },
      { timeoutMs: 60_000, assertCurrent: expect.any(Function) },
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "turn/steer",
      {
        threadId: "thread-supervised",
        expectedTurnId: "turn-1",
        input: [{ type: "text", text: "focus tests", text_elements: [] }],
      },
      { timeoutMs: 60_000, assertCurrent: expect.any(Function) },
    );
  });

  it("refuses to stop or steer when the active turn no longer matches the private binding", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "replacement-thread",
      cwd: tempDir,
    });
    const target = controlTarget(sessionFile);
    const stopTracking = trackCodexConversationActiveTurn({
      identity: target.identity,
      threadId: "stale-active-thread",
      turnId: "turn-1",
    });

    try {
      await expect(stopCodexConversationTurn(target)).resolves.toEqual({
        stopped: false,
        message: "The active Codex run no longer matches this session binding.",
      });
      await expect(
        steerCodexConversationTurn({ ...target, message: "do not send" }),
      ).resolves.toEqual({
        steered: false,
        message: "The active Codex run no longer matches this session binding.",
      });
      await testCodexAppServerBindingStore.mutate(target.identity, { kind: "clear" });
      const clearedTarget = controlTarget(sessionFile);
      await expect(stopCodexConversationTurn(clearedTarget)).resolves.toEqual({
        stopped: false,
        message: "The active Codex run no longer matches this session binding.",
      });
      await expect(
        steerCodexConversationTurn({ ...clearedTarget, message: "still do not send" }),
      ).resolves.toEqual({
        steered: false,
        message: "The active Codex run no longer matches this session binding.",
      });
    } finally {
      stopTracking();
    }

    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it.each(["stop", "steer"] as const)(
    "rejects %s before a retained-client write after host rollover",
    async (command) => {
      const sessionFile = path.join(tempDir, `${command}-retained.jsonl`);
      await writeCodexAppServerBinding(sessionFile, {
        threadId: `thread-${command}-retained`,
        cwd: tempDir,
      });
      const target = controlTarget(sessionFile);
      const harness = createClientHarness({
        onWrite: (line, send) => {
          const request = JSON.parse(line) as { id: number };
          send({ id: request.id, result: {} });
        },
      });
      const stopTracking = trackCodexConversationActiveTurn({
        identity: target.identity,
        client: harness.client,
        threadId: `thread-${command}-retained`,
        turnId: "turn-1",
      });

      try {
        await expect(
          mutateActiveTurn(command, {
            ...target,
            assertCurrent: () => {
              throw new Error("host session rolled over");
            },
          }),
        ).rejects.toThrow("host session rolled over");
        expect(harness.writes).toHaveLength(0);
      } finally {
        stopTracking();
        harness.client.close();
      }
    },
  );

  it.each(["stop", "steer"] as const)(
    "rejects %s before a leased-client write when host rollover occurs during acquisition",
    async (command) => {
      const sessionFile = path.join(tempDir, `${command}-leased.jsonl`);
      await writeCodexAppServerBinding(sessionFile, {
        threadId: `thread-${command}-leased`,
        cwd: tempDir,
      });
      const target = controlTarget(sessionFile);
      const harness = createClientHarness({
        onWrite: (line, send) => {
          const request = JSON.parse(line) as { id: number };
          send({ id: request.id, result: {} });
        },
      });
      const acquired = createDeferred<typeof harness.client>();
      sharedClientMocks.getSharedCodexAppServerClient.mockReturnValue(acquired.promise);
      const stopTracking = trackCodexConversationActiveTurn({
        identity: target.identity,
        threadId: `thread-${command}-leased`,
        turnId: "turn-1",
      });
      let hostCurrent = true;

      try {
        const mutation = mutateActiveTurn(command, {
          ...target,
          assertCurrent: () => {
            if (!hostCurrent) {
              throw new Error("host session rolled over");
            }
          },
        });
        await vi.waitFor(() => {
          expect(sharedClientMocks.getSharedCodexAppServerClient).toHaveBeenCalledOnce();
        });
        hostCurrent = false;
        acquired.resolve(harness.client);

        await expect(mutation).rejects.toThrow("host session rolled over");
        expect(harness.writes).toHaveLength(0);
        expect(sharedClientMocks.releaseLeasedSharedCodexAppServerClient).toHaveBeenCalledWith(
          harness.client,
        );
      } finally {
        acquired.resolve(harness.client);
        stopTracking();
        harness.client.close();
      }
    },
  );

  it("rejects direct model changes for private supervised bindings", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-supervised",
      connectionScope: "supervision",
      supervisionSourceThreadId: "thread-supervised",
      cwd: tempDir,
      model: "gpt-5.5",
      modelProvider: "openai",
      preserveNativeModel: true,
      conversationSourceTransferComplete: true,
    });

    await expect(
      setCodexConversationModel({
        sessionFile,
        model: "gpt-5.4",
        pluginConfig: { supervision: { enabled: true } },
      }),
    ).rejects.toThrow(MODEL_SELECTION_LOCKED_MESSAGE);
    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("does not persist public OpenAI provider after model changes on native auth bindings", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const agentDir = path.join(tempDir, "agents", "bot-a", "agent");
    upsertAuthProfile({
      profileId: "work",
      credential: {
        type: "oauth",
        provider: "openai",
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() + 60_000,
      },
    });
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
      authProfileId: "work",
      model: "gpt-5.4",
      modelProvider: "openai",
    });
    await expect(
      setCodexConversationModel({ sessionFile, agentDir, model: "gpt-5.5" }),
    ).resolves.toBe("Codex model set to gpt-5.5.");

    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding?.threadId).toBe("thread-1");
    expect(binding?.authProfileId).toBe("work");
    expect(binding?.model).toBe("gpt-5.5");
    expect(binding?.modelProvider).toBeUndefined();
    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("persists provider-qualified model changes without resuming a subscribed thread", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
      model: "local-model",
      modelProvider: "lmstudio",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    await expect(
      setCodexConversationModel({
        sessionFile,
        model: "openai/gpt-5.5",
        pluginConfig: { appServer: { mode: "guardian" } },
      }),
    ).resolves.toBe("Codex model set to gpt-5.5.");

    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding?.model).toBe("gpt-5.5");
    expect(binding?.modelProvider).toBe("openai");
    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("keeps the bound local provider when switching to another unqualified model", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
      model: "local-model",
      modelProvider: "lmstudio",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    await expect(
      setCodexConversationModel({
        sessionFile,
        model: "local-model-2",
        pluginConfig: { appServer: { mode: "guardian" } },
      }),
    ).resolves.toBe("Codex model set to local-model-2.");

    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      model: "local-model-2",
      modelProvider: "lmstudio",
    });
    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("keeps the bound local provider when reselecting a model id with a slash", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
      model: "openai/gpt-oss-20b",
      modelProvider: "lmstudio",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    await expect(
      setCodexConversationModel({
        sessionFile,
        model: "openai/gpt-oss-20b",
        pluginConfig: { appServer: { mode: "guardian" } },
      }),
    ).resolves.toBe("Codex model set to openai/gpt-oss-20b.");

    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding?.model).toBe("openai/gpt-oss-20b");
    expect(binding?.modelProvider).toBe("lmstudio");
    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("persists direct-session model selection without overwriting the active native binding", async () => {
    await withDirectModelCatalog(async ({ config, agentDir }) => {
      const sessionKey = "agent:main:model-session";
      const sessionId = "session-model-authority";
      const identity = { kind: "session" as const, agentId: "main", sessionId, sessionKey };
      const storePath = resolveStorePath(undefined, { agentId: "main" });
      await upsertSessionEntry({
        agentId: "main",
        storePath,
        sessionKey,
        entry: {
          sessionId,
          updatedAt: Date.now(),
          executionSelection: {
            state: "deferred",
            request: {
              model: { provider: "openai", id: "gpt-5.4" },
              executor: { kind: "harness", id: "codex" },
            },
            fallbackPermission: "explicit",
          },
          authProfileOverride: "openai:personal",
          authProfileOverrideSource: "user",
        },
      });
      await testCodexAppServerBindingStore.mutate(identity, {
        kind: "set",
        binding: {
          threadId: "thread-model-authority",
          cwd: tempDir,
          model: "gpt-5.4",
          modelProvider: "openai",
        },
      });

      const binding = testCodexAppServerBindingStore.read(identity);
      const before = getSessionEntry({ agentId: "main", storePath, sessionKey });
      if (!before) {
        throw new Error("Expected the persisted direct-session fixture");
      }
      await expect(
        setCodexConversationModelImpl({
          identity,
          bindingStore: testCodexAppServerBindingStore,
          binding,
          config,
          agentDir,
          model: "gpt-5.5",
          storePath,
          assertCurrent: () => {
            expect(testCodexAppServerBindingStore.read(identity)).toEqual(binding);
            const current = getSessionEntry({ agentId: "main", storePath, sessionKey });
            expect(current?.sessionId).toBe(before.sessionId);
            expect(current?.lifecycleRevision).toBe(before.lifecycleRevision);
          },
        }),
      ).resolves.toBe("Now using Selected in Codex agent harness.");

      expect(getSessionEntry({ storePath, sessionKey })).toMatchObject({
        authProfileOverride: "openai:personal",
        authProfileOverrideSource: "user",
        liveModelSwitchPending: true,
      });
      expect(
        getSessionEntry({ agentId: "main", storePath, sessionKey })?.executionSelection,
      ).toMatchObject({
        state: "accepted",
        selection: {
          model: { provider: "openai", id: "gpt-5.5" },
          executor: { kind: "harness", id: "codex" },
        },
      });
      expect(testCodexAppServerBindingStore.read(identity)).toMatchObject({
        threadId: "thread-model-authority",
        model: "gpt-5.4",
      });
      expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
    });
  });

  it("clears incompatible direct-session auth when the selected provider changes", async () => {
    await withDirectModelCatalog(async ({ config, agentDir }) => {
      const sessionKey = "agent:main:model-provider-switch";
      const sessionId = "session-provider-switch";
      const identity = { kind: "session" as const, agentId: "main", sessionId, sessionKey };
      const storePath = resolveStorePath(undefined, { agentId: "main" });
      await upsertSessionEntry({
        agentId: "main",
        storePath,
        sessionKey,
        entry: {
          sessionId,
          updatedAt: Date.now(),
          executionSelection: {
            state: "deferred",
            request: {
              model: { provider: "lmstudio", id: "local-model" },
              executor: { kind: "harness", id: "codex" },
            },
            fallbackPermission: "explicit",
          },
          authProfileOverride: "lmstudio:work",
          authProfileOverrideSource: "user",
        },
      });
      await testCodexAppServerBindingStore.mutate(identity, {
        kind: "set",
        binding: {
          threadId: "thread-provider-switch",
          cwd: tempDir,
          model: "local-model",
          modelProvider: "lmstudio",
        },
      });

      const binding = testCodexAppServerBindingStore.read(identity);
      const before = getSessionEntry({ agentId: "main", storePath, sessionKey });
      if (!before) {
        throw new Error("Expected the persisted direct-session fixture");
      }
      await expect(
        setCodexConversationModelImpl({
          identity,
          bindingStore: testCodexAppServerBindingStore,
          binding,
          config,
          agentDir,
          model: "openai/gpt-5.5",
          storePath,
          assertCurrent: () => {
            expect(testCodexAppServerBindingStore.read(identity)).toEqual(binding);
            const current = getSessionEntry({ agentId: "main", storePath, sessionKey });
            expect(current?.sessionId).toBe(before.sessionId);
            expect(current?.lifecycleRevision).toBe(before.lifecycleRevision);
          },
        }),
      ).resolves.toBe("Now using Selected in Codex agent harness.");

      expect(
        getSessionEntry({ agentId: "main", storePath, sessionKey })?.executionSelection,
      ).toMatchObject({
        state: "accepted",
        selection: {
          model: { provider: "openai", id: "gpt-5.5" },
          executor: { kind: "harness", id: "codex" },
        },
      });
      expect(testCodexAppServerBindingStore.read(identity)).toMatchObject({
        threadId: "thread-provider-switch",
        model: "local-model",
        modelProvider: "lmstudio",
      });
      expect(getSessionEntry({ storePath, sessionKey })).toMatchObject({
        liveModelSwitchPending: true,
      });
      expect(getSessionEntry({ storePath, sessionKey })?.authProfileOverride).toBeUndefined();
      expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
    });
  });

  it("escapes requested model names before chat display", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
      model: "gpt-5.4",
      modelProvider: "openai",
    });
    await expect(
      setCodexConversationModel({
        sessionFile,
        model: "gpt-5.5 <@U123> [trusted](evil)",
      }),
    ).resolves.toBe(
      "Codex model set to gpt-5.5 &lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08evil\uff09.",
    );
  });
});
