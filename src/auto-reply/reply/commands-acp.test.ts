// Tests ACP commands for status, reset, and runtime session control.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindTestChannelParticipantAdmissionEvidence } from "../../../test/helpers/channel-admission-evidence.js";
import type { AcpSessionManagerDeps } from "../../acp/control-plane/manager.types.js";
import {
  requireAcpExecutionSelection,
  requireReadySession,
  resolveMissingMetaError,
} from "../../acp/control-plane/manager.utils.js";
import { AcpRuntimeError } from "../../acp/runtime/errors.js";
import { resolveSessionStorePathForAcp } from "../../acp/runtime/session-meta-store.js";
import type { AcpSessionStoreEntry } from "../../acp/runtime/session-meta.js";
import { createTestAdmittedRunContext } from "../../agents/admitted-run-context.test-support.js";
import { configureExecutionIdentityAdmissionSink } from "../../audit/execution-identity-admission.js";
import { configureChannelAdmissionEvidenceCollection } from "../../channels/message-access/admission-evidence.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { SessionBindingRecord } from "../../infra/outbound/session-binding-service.js";
import { commitSessionExecutionSelection } from "../../model-picker/apply-session-model-selection.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createInMemoryTaskRegistryStore } from "../../test-utils/task-registry-store.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";

const hoisted = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
  cleanupFailedAcpSpawnMock: vi.fn(),
  closeRuntimeOnFailureMock: vi.fn(),
  requireAcpRuntimeBackendMock: vi.fn(),
  getAcpRuntimeBackendMock: vi.fn(),
  listAcpSessionEntriesMock: vi.fn(),
  readAcpSessionEntryMock: vi.fn(),
  upsertAcpSessionMetaMock: vi.fn(),
  resolveSessionStorePathForAcpMock: vi.fn(),
  loadSessionStoreMock: vi.fn(),
  sessionBindingCapabilitiesMock: vi.fn(),
  sessionBindingBindMock: vi.fn(),
  sessionBindingListBySessionMock: vi.fn(),
  sessionBindingResolveByConversationMock: vi.fn(),
  sessionBindingUnbindMock: vi.fn(),
  ensureSessionMock: vi.fn(),
  runTurnMock: vi.fn(),
  cancelMock: vi.fn(),
  closeMock: vi.fn(),
  getCapabilitiesMock: vi.fn(),
  getStatusMock: vi.fn(),
  setModeMock: vi.fn(),
  setConfigOptionMock: vi.fn(),
  updateSessionRuntimeOptionsMock: vi.fn(),
  updateSessionEntryMock: vi.fn(),
  doctorMock: vi.fn(),
}));

function createAcpCommandSessionBindingService() {
  const forward =
    <A extends unknown[], T>(fn: (...args: A) => T) =>
    (...args: A) =>
      fn(...args);
  return {
    bind: (input: unknown) => hoisted.sessionBindingBindMock(input),
    getCapabilities: forward((params: unknown) => hoisted.sessionBindingCapabilitiesMock(params)),
    inspectByConversation: (
      ref: unknown,
    ): { status: "available"; binding: SessionBindingRecord | null } => ({
      status: "available",
      binding: hoisted.sessionBindingResolveByConversationMock(ref),
    }),
    listBySession: (targetSessionKey: string) =>
      hoisted.sessionBindingListBySessionMock(targetSessionKey),
    resolveByConversation: (ref: unknown) => hoisted.sessionBindingResolveByConversationMock(ref),
    touch: vi.fn(),
    unbind: (input: unknown) => hoisted.sessionBindingUnbindMock(input),
  };
}

vi.mock("../../acp/control-plane/spawn.js", () => ({
  cleanupFailedAcpSpawn: (args: unknown) => hoisted.cleanupFailedAcpSpawnMock(args),
}));

vi.mock("../../gateway/call.js", () => ({
  callGateway: (args: unknown) => hoisted.callGatewayMock(args),
}));

vi.mock("../../acp/runtime/registry.js", () => ({
  requireAcpRuntimeBackend: (id?: string) => hoisted.requireAcpRuntimeBackendMock(id),
  getAcpRuntimeBackend: (id?: string) => hoisted.getAcpRuntimeBackendMock(id),
}));

vi.mock("../../acp/runtime/session-meta.js", () => ({
  listAcpSessionEntries: (args: unknown) => hoisted.listAcpSessionEntriesMock(args),
  readAcpSessionEntryCore: (args: unknown) => hoisted.readAcpSessionEntryMock(args),
  upsertAcpSessionMeta: (args: unknown) => hoisted.upsertAcpSessionMetaMock(args),
  resolveSessionStorePathForAcp: (args: unknown) => hoisted.resolveSessionStorePathForAcpMock(args),
}));

vi.mock("../../config/sessions.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions.js")>(
    "../../config/sessions.js",
  );
  return {
    ...actual,
    loadSessionStore: (...args: unknown[]) => hoisted.loadSessionStoreMock(...args),
  };
});

vi.mock("../../config/sessions/session-accessor.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions/session-accessor.js")>(
    "../../config/sessions/session-accessor.js",
  );
  return {
    ...actual,
    updateSessionEntry: (...args: unknown[]) => hoisted.updateSessionEntryMock(...args),
  };
});

vi.mock("../../infra/outbound/session-binding-service.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../infra/outbound/session-binding-service.js")
  >("../../infra/outbound/session-binding-service.js");
  const patched = { ...actual } as typeof actual & {
    getSessionBindingService: () => ReturnType<typeof createAcpCommandSessionBindingService>;
  };
  patched.getSessionBindingService = () => createAcpCommandSessionBindingService();
  return patched;
});

const { handleAcpCommand } = await import("./commands-acp.js");
const { buildCommandTestParams } = await import("./commands-spawn.test-harness.js");
const { AcpSessionManager, testing: acpManagerTesting } =
  await import("../../acp/control-plane/manager.js");
const { resolveEffectiveResetTargetSessionKey } = await import("./acp-reset-target.js");
const { createTaskRecord } = await import("../../tasks/task-registry.js");
const { resetTaskRegistryForTests } = await import("../../tasks/task-runtime.test-helpers.js");
const { configureTaskRegistryRuntime } = await import("../../tasks/task-registry.store.js");
const { failTaskRunByRunIdCore } = await import("../../tasks/task-executor.js");

function configureInMemoryTaskRegistryStoreForTests(): void {
  configureTaskRegistryRuntime({
    store: {
      ...createInMemoryTaskRegistryStore(),
      upsertTaskWithDeliveryState: () => {},
      deleteTaskWithDeliveryState: () => {},
      upsertDeliveryState: () => {},
      close: () => {},
    },
  });
}

function parseTelegramChatIdForTest(raw?: string | null): string | undefined {
  const trimmed = raw?.trim().replace(/^telegram:/i, "");
  if (!trimmed) {
    return undefined;
  }
  const topicMatch = /^(.*):topic:\d+$/i.exec(trimmed);
  return (topicMatch?.[1] ?? trimmed).trim() || undefined;
}

function parseDiscordConversationIdForTest(
  targets: Array<string | undefined | null>,
): string | undefined {
  for (const rawTarget of targets) {
    const target = rawTarget?.trim();
    if (!target) {
      continue;
    }
    const mentionMatch = /^<#(\d+)>$/.exec(target);
    if (mentionMatch?.[1]) {
      return mentionMatch[1];
    }
    if (/^channel:/i.test(target)) {
      return target;
    }
  }
  return undefined;
}

function parseDiscordParentChannelFromSessionKeyForTest(raw?: string | null): string | undefined {
  const sessionKey = raw?.trim().toLowerCase() ?? "";
  const match = sessionKey.match(/(?:^|:)channel:([^:]+)$/);
  return match?.[1] ? `channel:${match[1]}` : undefined;
}

function resolveFirstConversationTargetForTest(params: {
  channel?: string;
  commandTo?: string;
  fallbackTo?: string;
  originatingTo?: string;
}): string | null {
  for (const rawTarget of [params.originatingTo, params.commandTo, params.fallbackTo]) {
    const target = rawTarget?.trim();
    if (!target) {
      continue;
    }
    return params.channel && target.toLowerCase().startsWith(`${params.channel}:`)
      ? target.slice(params.channel.length + 1)
      : target;
  }
  return null;
}

function parsePrefixedConversationIdForTest(
  raw: string | undefined | null,
  channel: "imessage",
): string | undefined {
  const trimmed = raw
    ?.trim()
    .replace(new RegExp(`^${channel}:`, "i"), "")
    .replace(/^chat_guid:/i, "");
  return trimmed || undefined;
}

function resolvePrefixedConversationIdForTest(
  targets: Array<string | undefined | null>,
  channel: "imessage",
): string | undefined {
  return targets.map((target) => parsePrefixedConversationIdForTest(target, channel)).find(Boolean);
}

function setMinimalAcpCommandRegistryForTests(): void {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "telegram",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id: "telegram", label: "Telegram" }),
          conversationBindings: {
            defaultTopLevelPlacement: "current",
            buildBoundReplyPayload: ({
              operation,
              conversation,
            }: {
              operation: "acp-spawn";
              conversation: { conversationId: string };
            }) =>
              operation === "acp-spawn" && conversation.conversationId.includes(":topic:")
                ? { delivery: { pin: { enabled: true } } }
                : null,
          },
          bindings: {
            resolveCommandConversation: ({
              threadId,
              originatingTo,
              commandTo,
              fallbackTo,
            }: {
              threadId?: string;
              originatingTo?: string;
              commandTo?: string;
              fallbackTo?: string;
            }) => {
              const chatId = [originatingTo, commandTo, fallbackTo]
                .map((candidate) => parseTelegramChatIdForTest(candidate))
                .find(Boolean);
              if (!chatId) {
                return null;
              }
              if (threadId) {
                return {
                  conversationId: `${chatId}:topic:${threadId}`,
                  parentConversationId: chatId,
                };
              }
              if (chatId.startsWith("-")) {
                return null;
              }
              return { conversationId: chatId, parentConversationId: chatId };
            },
          },
        },
      },
      {
        pluginId: "discord",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id: "discord", label: "Discord" }),
          conversationBindings: {
            defaultTopLevelPlacement: "child",
          },
          bindings: {
            resolveCommandConversation: ({
              threadId,
              threadParentId,
              parentSessionKey,
              originatingTo,
              commandTo,
              fallbackTo,
            }: {
              threadId?: string;
              threadParentId?: string;
              parentSessionKey?: string;
              originatingTo?: string;
              commandTo?: string;
              fallbackTo?: string;
            }) => {
              if (threadId) {
                const parentConversationId =
                  (threadParentId?.trim()
                    ? `channel:${threadParentId.trim().replace(/^channel:/i, "")}`
                    : undefined) ??
                  parseDiscordParentChannelFromSessionKeyForTest(parentSessionKey) ??
                  parseDiscordConversationIdForTest([originatingTo, commandTo, fallbackTo]);
                return {
                  conversationId: threadId,
                  ...(parentConversationId && parentConversationId !== threadId
                    ? { parentConversationId }
                    : {}),
                };
              }
              const conversationId = parseDiscordConversationIdForTest([
                originatingTo,
                commandTo,
                fallbackTo,
              ]);
              return conversationId ? { conversationId } : null;
            },
          },
        },
      },
      {
        pluginId: "imessage",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id: "imessage", label: "iMessage" }),
          bindings: {
            resolveCommandConversation: ({
              originatingTo,
              commandTo,
              fallbackTo,
            }: {
              originatingTo?: string;
              commandTo?: string;
              fallbackTo?: string;
            }) => {
              const conversationId = resolvePrefixedConversationIdForTest(
                [originatingTo, commandTo, fallbackTo],
                "imessage",
              );
              return conversationId ? { conversationId } : null;
            },
          },
        },
      },
      {
        pluginId: "slack",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id: "slack", label: "Slack" }),
          bindings: {
            resolveCommandConversation: ({
              originatingTo,
              commandTo,
              fallbackTo,
            }: {
              originatingTo?: string;
              commandTo?: string;
              fallbackTo?: string;
            }) => {
              const conversationId = [originatingTo, commandTo, fallbackTo]
                .map((candidate) => candidate?.trim())
                .find((candidate) => candidate && candidate.length > 0);
              return conversationId ? { conversationId } : null;
            },
          },
        },
      },
      {
        pluginId: "matrix",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id: "matrix", label: "Matrix" }),
          conversationBindings: {
            defaultTopLevelPlacement: "child",
          },
          bindings: {
            resolveCommandConversation: ({
              threadId,
              originatingTo,
              commandTo,
              fallbackTo,
            }: {
              threadId?: string;
              originatingTo?: string;
              commandTo?: string;
              fallbackTo?: string;
            }) => {
              const roomId = [originatingTo, commandTo, fallbackTo]
                .map((candidate) => candidate?.trim().replace(/^room:/i, ""))
                .find((candidate) => candidate && candidate.length > 0);
              if (!threadId || !roomId) {
                return null;
              }
              return {
                conversationId: threadId,
                parentConversationId: roomId,
              };
            },
          },
        },
      },
      ...(["feishu", "line"] as const).map((channelId) => ({
        pluginId: channelId,
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id: channelId, label: channelId }),
          bindings: {
            resolveCommandConversation: ({
              originatingTo,
              commandTo,
              fallbackTo,
            }: {
              originatingTo?: string;
              commandTo?: string;
              fallbackTo?: string;
            }) => {
              const conversationId = resolveFirstConversationTargetForTest({
                channel: channelId,
                originatingTo,
                commandTo,
                fallbackTo,
              });
              return conversationId ? { conversationId } : null;
            },
          },
        },
      })),
    ]),
  );
}

type FakeBinding = {
  bindingId: string;
  targetSessionKey: string;
  targetKind: "subagent" | "session";
  conversation: {
    channel: string;
    accountId: string;
    conversationId: string;
    parentConversationId?: string;
  };
  status: "active";
  boundAt: number;
  metadata?: {
    agentId?: string;
    label?: string;
    boundBy?: string;
    webhookId?: string;
  };
};

function createSessionBinding(overrides?: Partial<FakeBinding>): FakeBinding {
  return {
    bindingId: "default:thread-created",
    targetSessionKey: "agent:codex:acp:s1",
    targetKind: "session",
    conversation: {
      channel: "discord",
      accountId: "default",
      conversationId: "thread-created",
      parentConversationId: "parent-1",
    },
    status: "active",
    boundAt: Date.now(),
    metadata: {
      agentId: "codex",
      boundBy: "user-1",
    },
    ...overrides,
  };
}

const baseCfg = {
  acp: {
    enabled: true,
    dispatch: { enabled: true },
    backend: "acpx",
  },
  session: {
    mainKey: "main",
    scope: "per-sender",
    threadBindings: {
      enabled: true,
      spawnSessions: true,
    },
  },
} satisfies OpenClawConfig;

function createMatrixBindingConfig(spawnSessions: boolean): OpenClawConfig {
  return {
    ...baseCfg,
    channels: { matrix: { threadBindings: { enabled: true, spawnSessions } } },
  };
}

function createDiscordParams(commandBody: string, cfg: OpenClawConfig = baseCfg) {
  const params = buildCommandTestParams(commandBody, cfg, {
    Provider: "discord",
    Surface: "discord",
    OriginatingChannel: "discord",
    OriginatingTo: "channel:parent-1",
    AccountId: "default",
  });
  params.command.senderId = "user-1";
  params.command.senderIsOwner = true;
  return params;
}

const defaultAcpSessionKey = "agent:codex:acp:s1";
const defaultThreadId = "thread-1";

type AcpSessionIdentity = {
  state: "resolved";
  source: "status";
  acpxSessionId: string;
  agentSessionId: string;
  lastUpdatedAt: number;
};

function createThreadConversation(conversationId: string = defaultThreadId) {
  return {
    channel: "discord" as const,
    accountId: "default",
    conversationId,
    parentConversationId: "parent-1",
  };
}

function createBoundThreadSession(sessionKey: string = defaultAcpSessionKey) {
  return createSessionBinding({
    targetSessionKey: sessionKey,
    conversation: createThreadConversation(),
  });
}

function createAcpSessionEntry(options?: {
  sessionKey?: string;
  state?: "idle" | "running";
  identity?: AcpSessionIdentity;
}) {
  const sessionKey = options?.sessionKey ?? defaultAcpSessionKey;
  const entry: SessionEntry = {
    sessionId: "sess-acp",
    lifecycleRevision: "acp-command-generation",
    updatedAt: Date.now(),
    label: "codex-main",
  };
  commitSessionExecutionSelection(entry, {
    executor: { kind: "acp", backend: "acpx", agent: "codex" },
    model: "native-managed",
  });
  return {
    sessionKey,
    storeSessionKey: sessionKey,
    entry,
    acp: {
      backend: "acpx",
      agent: "codex",
      runtimeSessionName: "runtime-1",
      ...(options?.identity ? { identity: options.identity } : {}),
      mode: "persistent",
      state: options?.state ?? "idle",
      lastActivityAt: Date.now(),
    },
  };
}

function createSessionBindingCapabilities() {
  return {
    adapterAvailable: true,
    bindSupported: true,
    unbindSupported: true,
    placements: ["current", "child"] as const,
  };
}

type AcpBindInput = {
  targetSessionKey: string;
  conversation: {
    channel?: string;
    accountId: string;
    conversationId: string;
    parentConversationId?: string;
  };
  placement: "current" | "child";
  metadata?: Record<string, unknown>;
};

function createAcpThreadBinding(input: AcpBindInput): FakeBinding {
  const nextConversationId =
    input.placement === "child" ? "thread-created" : input.conversation.conversationId;
  const boundBy = typeof input.metadata?.boundBy === "string" ? input.metadata.boundBy : "user-1";
  const channel = input.conversation.channel ?? "discord";
  const nextParentConversationId =
    input.placement === "child"
      ? input.conversation.conversationId
      : input.conversation.parentConversationId;
  const conversation = {
    channel,
    accountId: input.conversation.accountId,
    conversationId: nextConversationId,
    ...(nextParentConversationId ? { parentConversationId: nextParentConversationId } : {}),
  };
  return createSessionBinding({
    targetSessionKey: input.targetSessionKey,
    conversation,
    metadata: { boundBy, webhookId: "wh-1" },
  });
}

type MockWithCalls = {
  mock: {
    calls: Array<Array<unknown>>;
  };
};

function mockCallArg(mock: MockWithCalls, callIndex = 0, argIndex = 0): unknown {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call[argIndex];
}

function expectRecordFields(
  record: unknown,
  expected: Record<string, unknown>,
): Record<string, unknown> {
  if (!record || typeof record !== "object") {
    throw new Error("Expected record");
  }
  const actual = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
  return actual;
}

function expectMockCallFields(
  mock: MockWithCalls,
  expected: Record<string, unknown>,
  callIndex = 0,
): Record<string, unknown> {
  return expectRecordFields(mockCallArg(mock, callIndex), expected);
}

function expectBindingBindCall(
  expected: {
    conversation?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    placement?: "current" | "child";
    targetKind?: "session";
  },
  callIndex = 0,
): Record<string, unknown> {
  const input = expectMockCallFields(
    hoisted.sessionBindingBindMock,
    {
      ...(expected.placement ? { placement: expected.placement } : {}),
      ...(expected.targetKind ? { targetKind: expected.targetKind } : {}),
    },
    callIndex,
  );
  if (expected.conversation) {
    expectRecordFields(input.conversation, expected.conversation);
  }
  if (expected.metadata) {
    expectRecordFields(input.metadata, expected.metadata);
  }
  return input;
}

function gatewayRequests(): Array<Record<string, unknown>> {
  return hoisted.callGatewayMock.mock.calls.map((call) => call[0] as Record<string, unknown>);
}

function mockGatewaySessionResolution(key: string | null) {
  hoisted.callGatewayMock.mockImplementation(async (request: { method?: string }) =>
    request.method === "sessions.resolve" ? (key === null ? null : { key }) : { ok: true },
  );
}

function expectGatewayMethodNotCalled(method: string): void {
  expect(gatewayRequests().some((request) => request.method === method)).toBe(false);
}

function expectBoundIntroTextToExclude(match: string): void {
  const calls = hoisted.sessionBindingBindMock.mock.calls as Array<
    [{ metadata?: { introText?: unknown } }]
  >;
  const introText = calls
    .map((call) => call[0]?.metadata?.introText)
    .find((value): value is string => typeof value === "string");
  expect((introText ?? "").includes(match)).toBe(false);
}

function mockBoundThreadSession(options?: {
  sessionKey?: string;
  state?: "idle" | "running";
  identity?: AcpSessionIdentity;
}) {
  const sessionKey = options?.sessionKey ?? defaultAcpSessionKey;
  hoisted.sessionBindingResolveByConversationMock.mockReturnValue(
    createBoundThreadSession(sessionKey),
  );
  hoisted.readAcpSessionEntryMock.mockReturnValue(
    createAcpSessionEntry({
      sessionKey,
      state: options?.state,
      identity: options?.identity,
    }),
  );
}

async function withStoredAcpCommandSession(
  run: (cfg: OpenClawConfig, manager: InstanceType<typeof AcpSessionManager>) => Promise<void>,
): Promise<void> {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = baseCfg;
    const sessionMeta = await vi.importActual<typeof import("../../acp/runtime/session-meta.js")>(
      "../../acp/runtime/session-meta.js",
    );
    const deps: AcpSessionManagerDeps = {
      listAcpSessions: sessionMeta.listAcpSessionEntries,
      loadSessionEntry: (input) => sessionMeta.readAcpSessionEntryCore({ ...input, cfg }),
      upsertSessionMeta: (input) => sessionMeta.upsertAcpSessionMeta({ ...input, cfg }),
      getRuntimeBackend: (id) => hoisted.getAcpRuntimeBackendMock(id),
      requireRuntimeBackend: (id) => hoisted.requireAcpRuntimeBackendMock(id),
    };
    hoisted.readAcpSessionEntryMock.mockImplementation(deps.loadSessionEntry);
    hoisted.upsertAcpSessionMetaMock.mockImplementation(deps.upsertSessionMeta);
    const manager = new AcpSessionManager(deps);
    acpManagerTesting.setAcpSessionManagerForTests(manager);
    try {
      const initialized = await manager.initializeSession({
        cfg,
        sessionKey: defaultAcpSessionKey,
        agent: "codex",
        agentId: "codex",
        mode: "persistent",
      });
      const accessor = await vi.importActual<
        typeof import("../../config/sessions/session-accessor.js")
      >("../../config/sessions/session-accessor.js");
      const target = sessionMeta.resolveSessionStorePathForAcp({
        cfg,
        agentId: "codex",
        sessionKey: defaultAcpSessionKey,
      });
      const persisted = accessor.loadSessionEntryReadOnly({
        agentId: target.agentId,
        sessionKey: target.storeSessionKey,
        storePath: target.storePath,
      });
      if (!persisted) {
        throw new Error("ACP initialization returned before its agent session row was readable");
      }
      expect(persisted.sessionId).toBe(initialized.sessionEntry.sessionId);
      expect(persisted.executionSelection).toEqual(initialized.sessionEntry.executionSelection);
      expect(requireAcpExecutionSelection(persisted)).toEqual({
        executor: { kind: "acp", backend: "acpx", agent: "codex" },
        model: "native-managed",
      });
      const sharedState = await vi.importActual<
        typeof import("../../state/openclaw-state-db-readonly.js")
      >("../../state/openclaw-state-db-readonly.js");
      const sessionKeys = await vi.importActual<
        typeof import("../../acp/runtime/session-meta-keys.js")
      >("../../acp/runtime/session-meta-keys.js");
      const lifecycle = sharedState.withExistingOpenClawStateDatabaseReadOnly(
        ({ db }) =>
          sessionKeys.selectAcpSessionRow(
            db,
            sessionKeys.buildAcpDatabaseSessionKey(target.storeSessionKey, target.agentId),
          ),
        { env: state.env },
      );
      expect(lifecycle?.runtime_session_name).toBe(initialized.meta.runtimeSessionName);
      expect(lifecycle?.session_id).toBe(persisted.lifecycleRevision ?? persisted.sessionId);
      expect(lifecycle?.updated_at).toBeGreaterThanOrEqual(persisted.sessionStartedAt ?? 0);
      const joined = deps.loadSessionEntry({
        cfg,
        agentId: target.agentId,
        sessionKey: target.storeSessionKey,
        clone: false,
      });
      expect(joined?.storeReadFailed).toBeUndefined();
      expect(joined?.entry).toEqual(persisted);
      expect(joined?.acp?.runtimeSessionName).toBe(initialized.meta.runtimeSessionName);
      expect(
        manager.resolveSession({ cfg, agentId: target.agentId, sessionKey: defaultAcpSessionKey }),
      ).toMatchObject({ kind: "ready" });
      hoisted.sessionBindingResolveByConversationMock.mockReturnValue(createBoundThreadSession());
      await run(cfg, manager);
    } finally {
      acpManagerTesting.resetAcpSessionManagerForTests();
    }
  });
}

function createThreadParams(commandBody: string, cfg: OpenClawConfig = baseCfg) {
  const params = createDiscordParams(commandBody, cfg);
  params.ctx.MessageThreadId = defaultThreadId;
  return params;
}

type ConversationCommandFixture = {
  accountId?: string;
  channel: string;
  originatingTo: string;
  senderId?: string;
  sessionKey?: string;
  threadId?: string;
  threadParentId?: string;
};

function createConversationParams(
  commandBody: string,
  fixture: ConversationCommandFixture,
  cfg: OpenClawConfig = baseCfg,
) {
  const params = buildCommandTestParams(commandBody, cfg, {
    Provider: fixture.channel,
    Surface: fixture.channel,
    OriginatingChannel: fixture.channel,
    OriginatingTo: fixture.originatingTo,
    AccountId: fixture.accountId ?? "default",
    ...(fixture.senderId ? { SenderId: fixture.senderId } : {}),
    ...(fixture.sessionKey ? { SessionKey: fixture.sessionKey } : {}),
    ...(fixture.threadId ? { MessageThreadId: fixture.threadId } : {}),
    ...(fixture.threadParentId ? { ThreadParentId: fixture.threadParentId } : {}),
  });
  params.command.senderId = fixture.senderId ?? "user-1";
  params.command.senderIsOwner = true;
  return params;
}

async function runDiscordAcpCommand(commandBody: string, cfg: OpenClawConfig = baseCfg) {
  return handleAcpCommand(createDiscordParams(commandBody, cfg), true);
}

async function runThreadAcpCommand(commandBody: string, cfg: OpenClawConfig = baseCfg) {
  return handleAcpCommand(createThreadParams(commandBody, cfg), true);
}

function createConversationCommandRunner(fixture: ConversationCommandFixture) {
  return (commandBody: string, cfg: OpenClawConfig = baseCfg) =>
    handleAcpCommand(createConversationParams(commandBody, fixture, cfg), true);
}

const runTelegramAcpCommand = createConversationCommandRunner({
  channel: "telegram",
  originatingTo: "telegram:-1003841603622",
  threadId: "498",
});
const runTelegramDmAcpCommand = createConversationCommandRunner({
  channel: "telegram",
  originatingTo: "telegram:123456789",
});
const runSlackDmAcpCommand = createConversationCommandRunner({
  channel: "slack",
  originatingTo: "user:U123",
  senderId: "U123",
});
const runMatrixAcpCommand = createConversationCommandRunner({
  channel: "matrix",
  originatingTo: "room:!room:example.org",
});
async function runMatrixThreadAcpCommand(commandBody: string, cfg: OpenClawConfig = baseCfg) {
  const params = createConversationParams(
    commandBody,
    { channel: "matrix", originatingTo: "room:!room:example.org" },
    cfg,
  );
  params.ctx.MessageThreadId = "$thread-root";
  return handleAcpCommand(params, true);
}
const runFeishuDmAcpCommand = createConversationCommandRunner({
  channel: "feishu",
  originatingTo: "user:ou_sender_1",
  senderId: "ou_sender_1",
});
const runLineDmAcpCommand = createConversationCommandRunner({
  channel: "line",
  originatingTo: "U1234567890abcdef1234567890abcdef",
  senderId: "U1234567890abcdef1234567890abcdef",
});
const runIMessageDmAcpCommand = createConversationCommandRunner({
  channel: "imessage",
  originatingTo: "imessage:+15555550123",
});

async function runInternalAcpCommand(params: {
  commandBody: string;
  scopes: string[];
  cfg?: OpenClawConfig;
}) {
  const commandParams = buildCommandTestParams(params.commandBody, params.cfg ?? baseCfg, {
    Provider: INTERNAL_MESSAGE_CHANNEL,
    Surface: INTERNAL_MESSAGE_CHANNEL,
    OriginatingChannel: INTERNAL_MESSAGE_CHANNEL,
    OriginatingTo: "webchat:conversation-1",
    GatewayClientScopes: params.scopes,
  });
  commandParams.command.channel = INTERNAL_MESSAGE_CHANNEL;
  commandParams.command.senderId = "user-1";
  return handleAcpCommand(commandParams, true);
}

describe("/acp command", () => {
  beforeEach(() => {
    setMinimalAcpCommandRegistryForTests();
    acpManagerTesting.resetAcpSessionManagerForTests();
    resetTaskRegistryForTests({ persist: false });
    configureInMemoryTaskRegistryStoreForTests();
    hoisted.listAcpSessionEntriesMock.mockReset().mockResolvedValue([]);
    hoisted.callGatewayMock.mockReset().mockResolvedValue({ ok: true });
    hoisted.cleanupFailedAcpSpawnMock.mockReset().mockResolvedValue(undefined);
    hoisted.closeRuntimeOnFailureMock.mockReset().mockResolvedValue(undefined);
    const entries = new Map<string, AcpSessionStoreEntry>();
    hoisted.readAcpSessionEntryMock
      .mockReset()
      .mockImplementation(({ sessionKey }: { sessionKey: string }) =>
        structuredClone(entries.get(sessionKey) ?? null),
      );
    hoisted.upsertAcpSessionMetaMock
      .mockReset()
      .mockImplementation(
        async (input: Parameters<AcpSessionManagerDeps["upsertSessionMeta"]>[0]) => {
          const current = entries.get(input.sessionKey);
          const entry: SessionEntry = structuredClone(
            current?.entry ?? {
              sessionId: "session-1",
              lifecycleRevision: "acp-command-generation",
              updatedAt: Date.now(),
            },
          );
          const changed = input.mutate(structuredClone(current?.acp), entry);
          const meta = changed === undefined ? current?.acp : changed;
          input.assertCommitAllowed?.();
          if (input.executionSelection) {
            commitSessionExecutionSelection(entry, input.executionSelection);
          }
          entries.set(input.sessionKey, {
            cfg: input.cfg ?? baseCfg,
            agentId: input.agentId,
            sessionKey: input.sessionKey,
            storeSessionKey: input.sessionKey,
            storePath: "/synthetic/agent.sqlite",
            entry,
            ...(meta ? { acp: meta } : {}),
          });
          return { ...entry, ...(meta ? { acp: meta } : {}) };
        },
      );
    hoisted.resolveSessionStorePathForAcpMock.mockReset().mockReturnValue({
      cfg: baseCfg,
      storePath: "/tmp/sessions-acp.json",
    });
    hoisted.loadSessionStoreMock.mockReset().mockReturnValue({});
    hoisted.updateSessionEntryMock.mockReset().mockResolvedValue(null);
    hoisted.sessionBindingCapabilitiesMock
      .mockReset()
      .mockReturnValue(createSessionBindingCapabilities());
    hoisted.sessionBindingBindMock
      .mockReset()
      .mockImplementation(async (input: AcpBindInput) => createAcpThreadBinding(input));
    hoisted.sessionBindingListBySessionMock.mockReset().mockReturnValue([]);
    hoisted.sessionBindingResolveByConversationMock.mockReset().mockReturnValue(null);
    hoisted.sessionBindingUnbindMock.mockReset().mockResolvedValue([]);

    hoisted.ensureSessionMock
      .mockReset()
      .mockImplementation(async (input: { sessionKey: string }) => ({
        sessionKey: input.sessionKey,
        backend: "acpx",
        runtimeSessionName: `${input.sessionKey}:runtime`,
      }));
    hoisted.runTurnMock.mockReset().mockImplementation(async function* () {
      yield { type: "done" };
    });
    hoisted.cancelMock.mockReset().mockResolvedValue(undefined);
    hoisted.closeMock.mockReset().mockResolvedValue(undefined);
    hoisted.getCapabilitiesMock.mockReset().mockResolvedValue({
      controls: ["session/set_mode", "session/set_config_option", "session/status"],
    });
    hoisted.getStatusMock.mockReset().mockResolvedValue({
      summary: "status=alive sessionId=sid-1 pid=1234",
      details: { status: "alive", sessionId: "sid-1", pid: 1234 },
    });
    hoisted.setModeMock.mockReset().mockResolvedValue(undefined);
    hoisted.setConfigOptionMock.mockReset().mockResolvedValue(undefined);
    hoisted.updateSessionRuntimeOptionsMock.mockReset().mockResolvedValue(undefined);
    hoisted.doctorMock.mockReset().mockResolvedValue({
      ok: true,
      message: "acpx command available",
    });

    const runtimeBackend = {
      id: "acpx",
      runtime: {
        ensureSession: hoisted.ensureSessionMock,
        runTurn: hoisted.runTurnMock,
        getCapabilities: hoisted.getCapabilitiesMock,
        getStatus: hoisted.getStatusMock,
        setMode: hoisted.setModeMock,
        setConfigOption: hoisted.setConfigOptionMock,
        doctor: hoisted.doctorMock,
        cancel: hoisted.cancelMock,
        close: hoisted.closeMock,
      },
    };
    hoisted.requireAcpRuntimeBackendMock.mockReset().mockReturnValue(runtimeBackend);
    hoisted.getAcpRuntimeBackendMock.mockReset().mockReturnValue(runtimeBackend);
    acpManagerTesting.setAcpSessionManagerForTests({
      initializeSession: async (input: {
        cfg: OpenClawConfig;
        agentId?: string;
        sessionKey: string;
        agent: string;
        mode: "persistent" | "oneshot";
        cwd?: string;
      }) => {
        const backend = hoisted.requireAcpRuntimeBackendMock("acpx") as {
          id?: string;
          runtime: typeof runtimeBackend.runtime;
        };
        const ensured = await hoisted.ensureSessionMock({
          sessionKey: input.sessionKey,
          agent: input.agent,
          mode: input.mode,
          cwd: input.cwd,
        });
        const now = Date.now();
        const meta = {
          backend: ensured.backend ?? "acpx",
          agent: input.agent,
          runtimeSessionName: ensured.runtimeSessionName ?? `${input.sessionKey}:runtime`,
          mode: input.mode,
          state: "idle" as const,
          lastActivityAt: now,
          ...(input.cwd ? { cwd: input.cwd, runtimeOptions: { cwd: input.cwd } } : {}),
          ...(typeof ensured.agentSessionId === "string" ||
          typeof ensured.backendSessionId === "string"
            ? {
                identity: {
                  state: "resolved" as const,
                  source: "status" as const,
                  acpxSessionId:
                    typeof ensured.backendSessionId === "string"
                      ? ensured.backendSessionId
                      : "acpx-1",
                  agentSessionId:
                    typeof ensured.agentSessionId === "string"
                      ? ensured.agentSessionId
                      : input.sessionKey,
                  lastUpdatedAt: now,
                },
              }
            : {}),
        };
        const { backend: backendId, agent, ...lifecycle } = meta;
        const sessionEntry = await hoisted.upsertAcpSessionMetaMock({
          cfg: input.cfg,
          agentId: input.agentId,
          sessionKey: input.sessionKey,
          executionSelection: {
            executor: { kind: "acp", backend: backendId, agent },
            model: "native-managed",
          },
          mutate: () => lifecycle,
        });
        return {
          sessionEntry,
          closeRuntimeOnFailure: hoisted.closeRuntimeOnFailureMock,
          runtime: backend.runtime,
          handle: {
            backend: meta.backend,
            runtimeSessionName: meta.runtimeSessionName,
          },
          meta,
        };
      },
      resolveSession: (input: { sessionKey: string; agentId?: string }) => {
        const stored: AcpSessionStoreEntry | null = hoisted.readAcpSessionEntryMock({
          sessionKey: input.sessionKey,
        });
        if (!stored?.entry || !stored.acp) {
          return {
            kind: "stale" as const,
            sessionKey: input.sessionKey,
            agentId: input.agentId ?? "codex",
            error: resolveMissingMetaError(input.sessionKey),
          };
        }
        return {
          kind: "ready" as const,
          sessionKey: input.sessionKey,
          agentId: input.agentId ?? "codex",
          entry: stored.entry,
          meta: stored.acp,
          selection: requireAcpExecutionSelection(stored.entry),
        };
      },
      cancelSession: async (input: unknown) => {
        await hoisted.cancelMock(input);
      },
      getSessionStatus: async (input: { sessionKey: string }) => {
        const status = await hoisted.getStatusMock(input);
        const entry = hoisted.readAcpSessionEntryMock({
          sessionKey: input.sessionKey,
        }) as { acp?: Record<string, unknown> } | null;
        const meta = entry?.acp ?? {};
        return {
          sessionKey: input.sessionKey,
          backend: typeof meta.backend === "string" ? meta.backend : "acpx",
          agent: typeof meta.agent === "string" ? meta.agent : "codex",
          identity: meta.identity,
          state: meta.state ?? "idle",
          mode: meta.mode ?? "persistent",
          runtimeOptions: meta.runtimeOptions ?? {},
          capabilities: {
            controls: ["session/set_mode", "session/set_config_option", "session/status"],
          },
          runtimeStatus: status,
          lastActivityAt:
            typeof meta.lastActivityAt === "number" ? meta.lastActivityAt : Date.now(),
          ...(typeof meta.lastError === "string" ? { lastError: meta.lastError } : {}),
        };
      },
      getObservabilitySnapshot: () => ({
        runtimeCache: { activeSessions: 0, idleTtlMs: 0, evictedTotal: 0 },
        turns: {
          active: 0,
          queueDepth: 0,
          completed: 0,
          failed: 0,
          averageLatencyMs: 0,
          maxLatencyMs: 0,
        },
        errorsByCode: {},
      }),
      runTurn: async (input: { onEvent?: (event: unknown) => Promise<void> | void }) => {
        for await (const event of hoisted.runTurnMock(input) as AsyncIterable<unknown>) {
          await input.onEvent?.(event);
        }
      },
      setSessionRuntimeMode: async (input: { sessionKey: string; runtimeMode: string }) => {
        const options = await hoisted.setModeMock(input);
        return options ?? { runtimeMode: input.runtimeMode };
      },
      setSessionConfigOption: async (input: { key: string; value: string }) => {
        const options = await hoisted.setConfigOptionMock(input);
        return options ?? { [input.key]: input.value };
      },
      updateSessionRuntimeOptions: async (input: { patch: Record<string, unknown> }) => {
        const options = await hoisted.updateSessionRuntimeOptionsMock(input);
        return options ?? input.patch;
      },
      closeSession: async (input: { clearMeta?: boolean; sessionKey: string }) => {
        await hoisted.closeMock(input);
        if (input.clearMeta === true) {
          await hoisted.upsertAcpSessionMetaMock({
            sessionKey: input.sessionKey,
            mutate: () => null,
          });
        }
        return {
          runtimeClosed: true,
          metaCleared: input.clearMeta === true,
        };
      },
    });
  });

  afterEach(() => {
    resetTaskRegistryForTests({ persist: false });
  });

  it("returns null when the message is not /acp", async () => {
    const result = await runDiscordAcpCommand("/status");
    expect(result).toBeNull();
  });

  it("shows help by default", async () => {
    const result = await runDiscordAcpCommand("/acp");
    expect(result?.reply?.text).toContain("ACP commands:");
    expect(result?.reply?.text).toContain("/acp spawn");
  });

  it.each([
    "spawn codex",
    "cancel",
    "steer continue",
    "close",
    "status",
    "set-mode plan",
    "set model gpt-5.5",
    "cwd /tmp",
    "permissions approve-all",
    "timeout 120",
    "model openai/gpt-5.5",
    "reset-options",
  ])("blocks authorized non-owners from /acp %s", async (action) => {
    const params = createDiscordParams(`/acp ${action}`);
    params.command.senderIsOwner = false;

    const result = await handleAcpCommand(params, true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: expect.stringContaining("commands.ownerAllowFrom") },
    });
  });

  it("keeps read-only /acp actions available to authorized non-owners", async () => {
    const params = createDiscordParams("/acp sessions");
    params.command.senderIsOwner = false;

    const result = await handleAcpCommand(params, true);

    expect(result?.reply?.text).toContain("ACP sessions:");
  });

  it("spawns an ACP session and binds a Discord thread", async () => {
    hoisted.ensureSessionMock.mockResolvedValueOnce({
      sessionKey: "agent:codex:acp:s1",
      backend: "acpx",
      runtimeSessionName: "agent:codex:acp:s1:runtime",
      agentSessionId: "codex-inner-1",
      backendSessionId: "acpx-1",
    });

    const result = await runDiscordAcpCommand("/acp spawn codex --cwd /home/bob/clawd");

    expect(result?.reply?.text).toContain("Spawned ACP session agent:codex:acp:");
    expect(result?.reply?.text).toContain("Created thread thread-created and bound it");
    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledWith("acpx");
    expectMockCallFields(hoisted.ensureSessionMock, {
      agent: "codex",
      mode: "persistent",
      cwd: "/home/bob/clawd",
    });
    const bindInput = expectBindingBindCall({
      targetKind: "session",
      placement: "child",
    });
    const introText = (bindInput.metadata as { introText?: unknown } | undefined)?.introText;
    expect(typeof introText).toBe("string");
    expect(introText).toContain("cwd: /home/bob/clawd");
    expectBoundIntroTextToExclude("session ids: pending (available after the first reply)");
    expectGatewayMethodNotCalled("sessions.patch");
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalledTimes(1);
    const upsertArgs = mockCallArg(hoisted.upsertAcpSessionMetaMock) as
      | {
          sessionKey: string;
          mutate: (
            current: unknown,
            entry: { sessionId: string; updatedAt: number } | undefined,
          ) => {
            backend?: string;
            runtimeSessionName?: string;
          };
        }
      | undefined;
    expect(upsertArgs?.sessionKey).toMatch(/^agent:codex:acp:/);
    const seededWithoutEntry = upsertArgs?.mutate(undefined, undefined);
    expect(mockCallArg(hoisted.upsertAcpSessionMetaMock)).toMatchObject({
      executionSelection: { executor: { kind: "acp", backend: "acpx", agent: "codex" } },
    });
    expect(seededWithoutEntry?.runtimeSessionName).toContain(":runtime");
  });

  it("inherits the target agent workspace when /acp spawn omits --cwd", async () => {
    hoisted.ensureSessionMock.mockResolvedValueOnce({
      sessionKey: "agent:codex:acp:s2",
      backend: "acpx",
      runtimeSessionName: "agent:codex:acp:s2:runtime",
      agentSessionId: "codex-inner-2",
      backendSessionId: "acpx-2",
    });

    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-"));
    try {
      const cfg = {
        ...baseCfg,
        agents: {
          list: [
            {
              id: "codex",
              workspace,
            },
          ],
        },
      } satisfies OpenClawConfig;

      const result = await runDiscordAcpCommand("/acp spawn codex", cfg);

      expect(result?.reply?.text).toContain("Spawned ACP session agent:codex:acp:");
      expectMockCallFields(hoisted.ensureSessionMock, {
        agent: "codex",
        mode: "persistent",
        cwd: workspace,
      });
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("falls back to the backend default cwd when the inherited target workspace is missing", async () => {
    hoisted.ensureSessionMock.mockResolvedValueOnce({
      sessionKey: "agent:codex:acp:s3",
      backend: "acpx",
      runtimeSessionName: "agent:codex:acp:s3:runtime",
      agentSessionId: "codex-inner-3",
      backendSessionId: "acpx-3",
    });

    const cfg = {
      ...baseCfg,
      agents: {
        list: [
          {
            id: "codex",
            workspace: "/home/bob/codex-workspace-missing",
          },
        ],
      },
    } satisfies OpenClawConfig;

    const result = await runDiscordAcpCommand("/acp spawn codex", cfg);

    expect(result?.reply?.text).toContain("Spawned ACP session agent:codex:acp:");
    expectMockCallFields(hoisted.ensureSessionMock, {
      agent: "codex",
      mode: "persistent",
      cwd: undefined,
    });
  });

  it("persists ACP spawn labels to the target store without a gateway self-call", async () => {
    const params = createDiscordParams("/acp spawn codex --bind here --label inbox");
    params.storePath = "/tmp/requester-sessions.json";
    hoisted.resolveSessionStorePathForAcpMock.mockReturnValue({
      cfg: baseCfg,
      storePath: "/tmp/codex-sessions.json",
    });

    const result = await handleAcpCommand(params, true);

    expect(result?.reply?.text).toContain("Bound this conversation to");
    expectGatewayMethodNotCalled("sessions.patch");
    const spawnedSessionKey = (
      hoisted.ensureSessionMock.mock.calls[0]?.[0] as { sessionKey?: string } | undefined
    )?.sessionKey;
    expect(spawnedSessionKey).toMatch(/^agent:codex:acp:/);
    const updateCall = hoisted.updateSessionEntryMock.mock.calls[0] as
      | [
          { storePath: string; sessionKey: string },
          (entry: Record<string, unknown>) => Record<string, unknown>,
        ]
      | undefined;
    expect(updateCall?.[0]).toEqual({
      storePath: "/tmp/codex-sessions.json",
      sessionKey: spawnedSessionKey,
    });
    expect(updateCall?.[1]({ sessionId: "target", updatedAt: 1 })).toEqual({
      label: "inbox",
      updatedAt: expect.any(Number),
    });
  });

  it("accepts unicode dash option prefixes in /acp spawn args", async () => {
    const result = await runThreadAcpCommand(
      "/acp spawn codex \u2014mode oneshot \u2014thread here \u2014cwd /home/bob/clawd \u2014label jeerreview",
    );

    expect(result?.reply?.text).toContain("Spawned ACP session agent:codex:acp:");
    expect(result?.reply?.text).toContain("Bound this thread to");
    expectMockCallFields(hoisted.ensureSessionMock, {
      agent: "codex",
      mode: "oneshot",
      cwd: "/home/bob/clawd",
    });
    expectBindingBindCall({
      placement: "current",
      metadata: { label: "jeerreview" },
    });
  });

  it("binds the current Discord channel with --bind here without creating a child thread", async () => {
    const cfg = {
      ...baseCfg,
      session: {
        threadBindings: {
          enabled: true,
          spawnSessions: false,
        },
      },
    } satisfies OpenClawConfig;

    const result = await runDiscordAcpCommand("/acp spawn codex --bind here", cfg);

    expect(result?.reply?.text).toContain("Bound this conversation to");
    expectBindingBindCall({
      placement: "current",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:parent-1",
      },
    });
  });

  it("binds iMessage DMs with --bind here", async () => {
    const result = await runIMessageDmAcpCommand("/acp spawn codex --bind here");

    expect(result?.reply?.text).toContain("Bound this conversation to");
    expectBindingBindCall({
      placement: "current",
      conversation: {
        channel: "imessage",
        accountId: "default",
        conversationId: "+15555550123",
      },
    });
  });

  it("binds Slack DMs with --bind here through the generic conversation path", async () => {
    const result = await runSlackDmAcpCommand("/acp spawn codex --bind here");

    expect(result?.reply?.text).toContain("Bound this conversation to");
    expectBindingBindCall({
      placement: "current",
      conversation: {
        channel: "slack",
        accountId: "default",
        conversationId: "user:U123",
      },
    });
  });

  it("keeps freshly spawned Slack-bound ACP metadata readable for the immediate follow-up", async () => {
    await withStoredAcpCommandSession(async (cfg, manager) => {
      hoisted.sessionBindingResolveByConversationMock.mockReturnValue(null);
      const result = await runSlackDmAcpCommand("/acp spawn codex --bind here", cfg);
      expect(result?.reply?.text).toContain("Bound this conversation to");
      const binding = expectBindingBindCall({
        placement: "current",
        conversation: {
          channel: "slack",
          accountId: "default",
          conversationId: "user:U123",
        },
        metadata: { boundBy: "U123" },
      });
      const requestId = "immediate-bound-followup";
      const sessionKey = binding.targetSessionKey;
      if (typeof sessionKey !== "string") {
        throw new Error("Expected the published binding to own an ACP session key");
      }

      await expect(
        manager.runTurn({
          admittedRunContext: createTestAdmittedRunContext(requestId),
          cfg,
          sessionKey,
          provenance: "human",
          text: "continue the bound ACP session",
          mode: "prompt",
          requestId,
        }),
      ).resolves.toBeUndefined();
      expect(hoisted.runTurnMock).toHaveBeenCalledTimes(1);
    });
  });

  it("binds Telegram topic ACP spawns to full conversation ids", async () => {
    const result = await runTelegramAcpCommand("/acp spawn codex --thread here");

    expect(result?.reply?.text).toContain("Spawned ACP session agent:codex:acp:");
    expect(result?.reply?.text).toContain("Bound this conversation to");
    expect(result?.reply?.delivery).toEqual({ pin: { enabled: true } });
    expectBindingBindCall({
      placement: "current",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "-1003841603622:topic:498",
      },
    });
  });

  it("binds Telegram DM ACP spawns to the DM conversation id", async () => {
    const result = await runTelegramDmAcpCommand("/acp spawn codex --thread here");

    expect(result?.reply?.text).toContain("Spawned ACP session agent:codex:acp:");
    expect(result?.reply?.text).toContain("Bound this conversation to");
    expect(result?.reply?.channelData).toBeUndefined();
    expectBindingBindCall({
      placement: "current",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123456789",
      },
    });
  });

  it("binds Matrix rooms with --bind here without requiring thread spawn", async () => {
    const cfg = createMatrixBindingConfig(false);

    const result = await runMatrixAcpCommand("/acp spawn codex --bind here", cfg);

    expect(result?.reply?.text).toContain("Bound this conversation to");
    expectBindingBindCall({
      placement: "current",
      conversation: {
        channel: "matrix",
        accountId: "default",
        conversationId: "!room:example.org",
      },
    });
  });

  it("creates Matrix thread-bound ACP spawns from top-level rooms when enabled", async () => {
    const cfg = createMatrixBindingConfig(true);

    const result = await runMatrixAcpCommand("/acp spawn codex", cfg);

    expect(result?.reply?.text).toContain("Created thread thread-created and bound it");
    expectBindingBindCall({
      placement: "child",
      conversation: {
        channel: "matrix",
        accountId: "default",
        conversationId: "!room:example.org",
      },
    });
  });

  it("binds Matrix thread ACP spawns to the current thread with the parent room id", async () => {
    const cfg = createMatrixBindingConfig(true);

    const result = await runMatrixThreadAcpCommand("/acp spawn codex --thread here", cfg);

    expect(result?.reply?.text).toContain("Bound this thread to");
    expectBindingBindCall({
      placement: "current",
      conversation: {
        channel: "matrix",
        accountId: "default",
        conversationId: "$thread-root",
        parentConversationId: "!room:example.org",
      },
    });
  });

  it("binds Feishu DM ACP spawns to the current DM conversation", async () => {
    const result = await runFeishuDmAcpCommand("/acp spawn codex --thread here");

    expect(result?.reply?.text).toContain("Spawned ACP session agent:codex:acp:");
    expect(result?.reply?.text).toContain("Bound this conversation to");
    expectBindingBindCall({
      placement: "current",
      conversation: {
        channel: "feishu",
        accountId: "default",
        conversationId: "user:ou_sender_1",
      },
    });
  });

  it("binds LINE DM ACP spawns to the current conversation", async () => {
    const result = await runLineDmAcpCommand("/acp spawn codex --thread here");

    expect(result?.reply?.text).toContain("Spawned ACP session agent:codex:acp:");
    expect(result?.reply?.text).toContain("Bound this conversation to");
    expectBindingBindCall({
      placement: "current",
      conversation: {
        channel: "line",
        accountId: "default",
        conversationId: "U1234567890abcdef1234567890abcdef",
      },
    });
  });

  it("requires explicit ACP target when acp.defaultAgent is not configured", async () => {
    const result = await runDiscordAcpCommand("/acp spawn");

    expect(result?.reply?.text).toContain("ACP target harness id is required");
    expect(hoisted.ensureSessionMock).not.toHaveBeenCalled();
  });

  it("rejects mixing --thread and --bind on the same /acp spawn", async () => {
    const result = await runDiscordAcpCommand("/acp spawn codex --thread here --bind here");

    expect(result?.reply?.text).toContain("Use either --thread or --bind");
    expect(hoisted.ensureSessionMock).not.toHaveBeenCalled();
    expect(hoisted.sessionBindingBindMock).not.toHaveBeenCalled();
  });

  it("rejects thread-bound ACP spawn when spawnSessions is disabled", async () => {
    const cfg = {
      ...baseCfg,
      session: {
        threadBindings: {
          enabled: true,
          spawnSessions: false,
        },
      },
    } satisfies OpenClawConfig;

    const result = await runDiscordAcpCommand("/acp spawn codex", cfg);

    expect(result?.reply?.text).toContain("spawnSessions=true");
    expect(hoisted.cleanupFailedAcpSpawnMock).toHaveBeenCalledExactlyOnceWith({
      cfg,
      sessionKey: expect.stringContaining("agent:codex:acp:"),
      agentId: "codex",
      sessionEntry: expect.objectContaining({ sessionId: "session-1" }),
      deleteTranscript: false,
      closeRuntimeOnFailure: hoisted.closeRuntimeOnFailureMock,
    });
    expectGatewayMethodNotCalled("sessions.patch");
  });

  it("rejects Matrix thread-bound ACP spawn when spawnSessions is disabled", async () => {
    const cfg = createMatrixBindingConfig(false);

    const result = await runMatrixAcpCommand("/acp spawn codex", cfg);

    expect(result?.reply?.text).toContain("spawnSessions=true");
    expect(hoisted.sessionBindingBindMock).not.toHaveBeenCalled();
  });

  it.each(["off", "all"] as const)(
    "uses the global requester sandbox mode %s for ACP commands",
    async (sandboxMode) => {
      const cfg = {
        ...baseCfg,
        session: { scope: "global" },
        agents: {
          ownership: "explicit",
          entries: { research: { sandbox: { mode: sandboxMode } }, ops: {} },
        },
      } satisfies OpenClawConfig;
      const params = createDiscordParams("/acp spawn codex --thread off", cfg);
      params.sessionKey = "global";
      params.agentId = "research";

      const result = await handleAcpCommand(params, true);

      if (sandboxMode === "all") {
        expect(result?.reply?.text).toContain("Sandboxed sessions cannot spawn ACP sessions");
        expect(hoisted.ensureSessionMock).not.toHaveBeenCalled();
      } else {
        expect(result?.reply?.text).toContain("Spawned ACP session");
        expect(hoisted.ensureSessionMock).toHaveBeenCalled();
      }
    },
  );

  it("forbids /acp spawn from sandboxed requester sessions", async () => {
    const cfg = {
      ...baseCfg,
      agents: {
        defaults: {
          sandbox: { mode: "all" },
        },
      },
    } satisfies OpenClawConfig;

    const result = await runDiscordAcpCommand("/acp spawn codex", cfg);

    expect(result?.reply?.text).toContain("Sandboxed sessions cannot spawn ACP sessions");
    expect(hoisted.requireAcpRuntimeBackendMock).not.toHaveBeenCalled();
    expect(hoisted.ensureSessionMock).not.toHaveBeenCalled();
    expect(hoisted.sessionBindingBindMock).not.toHaveBeenCalled();
    expect(hoisted.callGatewayMock).not.toHaveBeenCalled();
  });

  it("cancels the ACP session bound to the current thread", async () => {
    mockBoundThreadSession({ state: "running" });
    const result = await runThreadAcpCommand("/acp cancel", baseCfg);
    expect(result?.reply?.text).toContain(
      `Cancel requested for ACP session ${defaultAcpSessionKey}`,
    );
    expect(hoisted.cancelMock).toHaveBeenCalledWith({
      cfg: baseCfg,
      agentId: "codex",
      reason: "manual-cancel",
      sessionKey: defaultAcpSessionKey,
    });
  });

  it("sends steer instructions via ACP runtime", async () => {
    mockGatewaySessionResolution(defaultAcpSessionKey);
    hoisted.readAcpSessionEntryMock.mockReturnValue(createAcpSessionEntry());
    hoisted.runTurnMock.mockImplementation(async function* () {
      yield { type: "text_delta", text: "Applied steering." };
      yield { type: "done" };
    });

    const result = await runDiscordAcpCommand(
      `/acp steer --session ${defaultAcpSessionKey} tighten logging`,
    );

    expectMockCallFields(hoisted.runTurnMock, {
      mode: "steer",
      text: "tighten logging",
    });
    expect(result?.reply?.text).toContain("Applied steering.");
  });

  it("admits ACP steer with the original channel participant", async () => {
    const captured: unknown[] = [];
    const clearCollection = configureChannelAdmissionEvidenceCollection(true);
    const clearSink = configureExecutionIdentityAdmissionSink((work) => {
      captured.push(work);
      return true;
    });
    try {
      mockGatewaySessionResolution(defaultAcpSessionKey);
      hoisted.readAcpSessionEntryMock.mockReturnValue(createAcpSessionEntry());
      hoisted.runTurnMock.mockImplementation(async function* () {
        yield { type: "done" };
      });
      const cfg = {
        ...baseCfg,
        logging: { audit: { executionIdentity: true } },
      } satisfies OpenClawConfig;
      const params = createDiscordParams(
        `/acp steer --session ${defaultAcpSessionKey} tighten logging`,
        cfg,
      );
      bindTestChannelParticipantAdmissionEvidence({
        context: params.ctx,
        channelId: "discord",
        accountId: "default",
        participantId: "user-1",
      });

      await handleAcpCommand(params, true);

      expect(captured).toMatchObject([
        {
          kind: "capture",
          envelope: {
            ingress: { kind: "acp", state: "present" },
            invoker: { state: "present", kind: "person" },
          },
        },
      ]);
    } finally {
      clearSink();
      clearCollection();
    }
  });

  it("keeps bounded ACP steer output UTF-16 safe", async () => {
    const prefix = "a".repeat(799);
    mockGatewaySessionResolution(defaultAcpSessionKey);
    hoisted.readAcpSessionEntryMock.mockReturnValue(createAcpSessionEntry());
    hoisted.runTurnMock.mockImplementation(async function* () {
      yield { type: "text_delta", text: `${prefix}😀tail` };
      yield { type: "done" };
    });

    const result = await runDiscordAcpCommand(
      `/acp steer --session ${defaultAcpSessionKey} tighten logging`,
    );

    expect(result?.reply?.text).toContain(`\n${prefix}…`);
    expect(result?.reply?.text).not.toContain("😀");
  });

  it("resolves bound Telegram topic ACP sessions for /acp steer without explicit target", async () => {
    hoisted.sessionBindingResolveByConversationMock.mockImplementation(
      (ref: { channel?: string; accountId?: string; conversationId?: string }) =>
        ref.channel === "telegram" &&
        ref.accountId === "default" &&
        ref.conversationId === "-1003841603622:topic:498"
          ? createSessionBinding({
              targetSessionKey: defaultAcpSessionKey,
              conversation: {
                channel: "telegram",
                accountId: "default",
                conversationId: "-1003841603622:topic:498",
              },
            })
          : null,
    );
    hoisted.readAcpSessionEntryMock.mockReturnValue(createAcpSessionEntry());
    hoisted.runTurnMock.mockImplementation(async function* () {
      yield { type: "text_delta", text: "Viewed diver package." };
      yield { type: "done" };
    });

    const result = await runTelegramAcpCommand("/acp steer use npm to view package diver");

    expectMockCallFields(hoisted.runTurnMock, {
      cfg: baseCfg,
      mode: "steer",
      sessionKey: defaultAcpSessionKey,
      text: "use npm to view package diver",
    });
    expect(result?.reply?.text).toContain("Viewed diver package.");
  });

  it("resolves ACP reset targets through the configured default account when AccountId is omitted", () => {
    const cfg = {
      ...baseCfg,
      channels: {
        discord: {
          defaultAccount: "work",
        },
      },
    } satisfies OpenClawConfig;
    hoisted.sessionBindingResolveByConversationMock.mockImplementation(
      (ref: {
        channel?: string;
        accountId?: string;
        conversationId?: string;
        parentConversationId?: string;
      }) =>
        ref.channel === "discord" &&
        ref.accountId === "work" &&
        ref.conversationId === defaultThreadId &&
        ref.parentConversationId === "parent-1"
          ? createSessionBinding({
              targetSessionKey: defaultAcpSessionKey,
              conversation: {
                channel: "discord",
                accountId: "work",
                conversationId: defaultThreadId,
                parentConversationId: "parent-1",
              },
            })
          : null,
    );

    const result = resolveEffectiveResetTargetSessionKey({
      cfg,
      channel: "discord",
      conversationId: defaultThreadId,
      parentConversationId: "parent-1",
    });

    expectMockCallFields(hoisted.sessionBindingResolveByConversationMock, {
      channel: "discord",
      accountId: "work",
      conversationId: defaultThreadId,
      parentConversationId: "parent-1",
    });
    expect(result).toBe(defaultAcpSessionKey);
  });

  it("blocks /acp steer when ACP dispatch is disabled by policy", async () => {
    const cfg = {
      ...baseCfg,
      acp: {
        ...baseCfg.acp,
        dispatch: { enabled: false },
      },
    } satisfies OpenClawConfig;
    const result = await runDiscordAcpCommand("/acp steer tighten logging", cfg);
    expect(result?.reply?.text).toContain("ACP dispatch is disabled by policy");
    expect(hoisted.runTurnMock).not.toHaveBeenCalled();
  });

  it("falls through to thread-bound resolution when explicit session token is unresolvable", async () => {
    // callGateway returns null for sessions.resolve (unresolvable token)
    // but a thread-bound session exists — should use thread-bound, not error out
    mockGatewaySessionResolution(null);
    mockBoundThreadSession();
    hoisted.readAcpSessionEntryMock.mockReturnValue(createAcpSessionEntry());
    hoisted.runTurnMock.mockImplementation(async function* () {
      yield { type: "text_delta", text: "Steered." };
      yield { type: "done" };
    });

    const result = await runThreadAcpCommand(
      `/acp steer --session unresolvable-token-xyz tighten logging`,
    );

    expectMockCallFields(hoisted.runTurnMock, {
      mode: "steer",
      sessionKey: defaultAcpSessionKey,
    });
    expect(result?.reply?.text).toContain("Steered.");
  });

  it("closes an ACP session, unbinds thread targets, and clears metadata", async () => {
    mockBoundThreadSession();
    hoisted.sessionBindingUnbindMock.mockResolvedValue([
      createBoundThreadSession() as SessionBindingRecord,
    ]);

    const result = await runThreadAcpCommand("/acp close", baseCfg);

    expect(hoisted.closeMock).toHaveBeenCalledTimes(1);
    expectMockCallFields(hoisted.sessionBindingUnbindMock, {
      targetSessionKey: defaultAcpSessionKey,
      reason: "manual",
    });
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalledTimes(1);
    const clearMetaArgs = mockCallArg(hoisted.upsertAcpSessionMetaMock) as
      | {
          sessionKey: string;
          mutate: (current: unknown, entry: { sessionId: string; updatedAt: number }) => unknown;
        }
      | undefined;
    expect(clearMetaArgs?.sessionKey).toBe(defaultAcpSessionKey);
    expect(clearMetaArgs?.mutate(undefined, { sessionId: "session-1", updatedAt: 0 })).toBeNull();
    expect(result?.reply?.text).toContain("Removed 1 binding");
  });

  it("closes the bound thread ACP session when an explicit session token is unresolvable", async () => {
    mockGatewaySessionResolution(null);
    mockBoundThreadSession();
    hoisted.sessionBindingUnbindMock.mockResolvedValue([
      createBoundThreadSession() as SessionBindingRecord,
    ]);

    const result = await runThreadAcpCommand("/acp close not-a-session-target");

    expect(hoisted.closeMock).toHaveBeenCalledWith({
      cfg: baseCfg,
      agentId: "codex",
      sessionKey: defaultAcpSessionKey,
      reason: "manual-close",
      allowBackendUnavailable: true,
      clearMeta: true,
    });
    expectMockCallFields(hoisted.sessionBindingUnbindMock, {
      targetSessionKey: defaultAcpSessionKey,
      reason: "manual",
    });
    expect(result?.reply?.text).toContain(`Closed ACP session ${defaultAcpSessionKey}`);
  });

  it("reports an explicit bad ACP session token before requester fallback", async () => {
    mockGatewaySessionResolution(null);
    const params = createConversationParams("/acp close not-a-session-target", {
      channel: "discord",
      originatingTo: "channel:parent-1",
      sessionKey: "requester-session",
    });

    const result = await handleAcpCommand(params, true);

    expect(result?.reply?.text).toContain("Unable to resolve session target: not-a-session-target");
    expect(hoisted.closeMock).not.toHaveBeenCalled();
    expect(hoisted.readAcpSessionEntryMock).not.toHaveBeenCalled();
  });

  it("handles /acp close in a bound thread when text commands are disabled", async () => {
    mockBoundThreadSession();
    hoisted.sessionBindingUnbindMock.mockResolvedValue([
      createBoundThreadSession() as SessionBindingRecord,
    ]);

    const result = await handleAcpCommand(createThreadParams("/acp close", baseCfg), false);

    expect(hoisted.closeMock).toHaveBeenCalledTimes(1);
    expectMockCallFields(hoisted.sessionBindingUnbindMock, {
      targetSessionKey: defaultAcpSessionKey,
      reason: "manual",
    });
    expect(result?.reply?.text).toContain("Removed 1 binding");
  });

  it("lists ACP sessions from the session store", async () => {
    hoisted.sessionBindingListBySessionMock.mockImplementation((key: string) =>
      key === defaultAcpSessionKey ? [createBoundThreadSession(key) as SessionBindingRecord] : [],
    );
    hoisted.listAcpSessionEntriesMock.mockResolvedValue([createAcpSessionEntry()]);

    const result = await runDiscordAcpCommand("/acp sessions", baseCfg);

    expect(result?.reply?.text).toContain("ACP sessions:");
    expect(result?.reply?.text).toContain("codex-main");
    expect(result?.reply?.text).toContain(`thread:${defaultThreadId}`);
  });

  it("lists all stored ACP sessions for the owner", async () => {
    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(
      createBoundThreadSession("agent:codex:acp:own"),
    );
    hoisted.listAcpSessionEntriesMock.mockResolvedValue([
      createAcpSessionEntry({ sessionKey: "agent:codex:acp:own" }),
      createAcpSessionEntry({ sessionKey: "agent:claude:acp:foreign" }),
    ]);

    const result = await runDiscordAcpCommand("/acp sessions", baseCfg);

    expect(result?.reply?.text).toContain("agent:codex:acp:own");
    expect(result?.reply?.text).toContain("agent:claude:acp:foreign");
    expect(hoisted.readAcpSessionEntryMock).not.toHaveBeenCalled();
  });

  it("lists only the current raw ACP session for an authorized non-owner sender", async () => {
    const currentSessionKey = "agent:codex:acp:current";
    hoisted.readAcpSessionEntryMock.mockReturnValue(
      createAcpSessionEntry({ sessionKey: currentSessionKey }),
    );
    const params = createDiscordParams("/acp sessions");
    params.command.senderIsOwner = false;
    params.sessionKey = currentSessionKey;
    params.agentId = "codex";

    const result = await handleAcpCommand(params, true);

    expect(result?.reply?.text).toContain(currentSessionKey);
    expect(hoisted.readAcpSessionEntryMock).toHaveBeenCalledWith({
      cfg: baseCfg,
      agentId: "codex",
      sessionKey: currentSessionKey,
    });
    expect(hoisted.listAcpSessionEntriesMock).not.toHaveBeenCalled();
  });

  it("prefers the bound-thread ACP session over a non-owner sender's raw session key", async () => {
    const boundSessionKey = "agent:codex:acp:bound";
    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(
      createBoundThreadSession(boundSessionKey),
    );
    hoisted.readAcpSessionEntryMock.mockImplementation((params) => {
      const owner = resolveSessionStorePathForAcp(params);
      expect(owner.agentId).toBe("codex");
      return { ...createAcpSessionEntry({ sessionKey: boundSessionKey }), ...owner };
    });
    const params = createDiscordParams("/acp sessions");
    params.command.senderIsOwner = false;
    params.sessionKey = "agent:main:raw-requester";

    const result = await handleAcpCommand(params, true);

    expect(result?.reply?.text).toContain(boundSessionKey);
    expect(result?.reply?.text).not.toContain("agent:main:raw-requester");
    expect(hoisted.readAcpSessionEntryMock).toHaveBeenCalledWith({
      cfg: baseCfg,
      agentId: "codex",
      sessionKey: boundSessionKey,
    });
    expect(hoisted.listAcpSessionEntriesMock).not.toHaveBeenCalled();
  });

  it("returns an empty listing when a non-owner's raw session key is not an ACP session", async () => {
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      ...createAcpSessionEntry({ sessionKey: "agent:main:raw-requester" }),
      acp: undefined,
    });
    const params = createDiscordParams("/acp sessions");
    params.command.senderIsOwner = false;
    params.sessionKey = "agent:main:raw-requester";

    const result = await handleAcpCommand(params, true);

    expect(result?.reply?.text).toContain("(none)");
    expect(hoisted.readAcpSessionEntryMock).toHaveBeenCalledWith({
      cfg: baseCfg,
      agentId: "main",
      sessionKey: "agent:main:raw-requester",
    });
    expect(hoisted.listAcpSessionEntriesMock).not.toHaveBeenCalled();
  });

  it("warns when no session key resolves for /acp sessions", async () => {
    hoisted.listAcpSessionEntriesMock.mockResolvedValue([createAcpSessionEntry()]);
    const params = createDiscordParams("/acp sessions");
    params.command.senderIsOwner = false;
    params.sessionKey = "";

    const result = await handleAcpCommand(params, true);

    expect(result?.reply?.text).toContain("Missing session key");
  });

  it("rejects explicit target tokens for /acp sessions", async () => {
    const params = createDiscordParams("/acp sessions agent:claude:acp:foreign");
    params.command.senderIsOwner = false;

    const result = await handleAcpCommand(params, true);

    expect(result?.reply?.text).toBe("Usage: /acp sessions");
    expect(hoisted.readAcpSessionEntryMock).not.toHaveBeenCalled();
    expect(hoisted.listAcpSessionEntriesMock).not.toHaveBeenCalled();
  });

  it("shows ACP status for the thread-bound ACP session", async () => {
    mockBoundThreadSession({
      identity: {
        state: "resolved",
        source: "status",
        acpxSessionId: "acpx-sid-1",
        agentSessionId: "codex-sid-1",
        lastUpdatedAt: Date.now(),
      },
    });
    createTaskRecord({
      runtime: "acp",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: defaultAcpSessionKey,
      runId: "acp-run-1",
      task: "Inspect ACP backlog",
      status: "running",
      progressSummary: "Fetching the latest runtime state",
    });
    const result = await runThreadAcpCommand("/acp status", baseCfg);

    expect(result?.reply?.text).toContain("ACP status:");
    expect(result?.reply?.text).toContain(`session: ${defaultAcpSessionKey}`);
    expect(result?.reply?.text).toContain("agent session id: codex-sid-1");
    expect(result?.reply?.text).toContain("acpx session id: acpx-sid-1");
    expect(result?.reply?.text).toContain("taskStatus: running");
    expect(result?.reply?.text).toContain("taskProgress: Fetching the latest runtime state");
    expect(result?.reply?.text).toContain("capabilities:");
    expect(hoisted.getStatusMock).toHaveBeenCalledTimes(1);
  });

  it("tolerates Date-invalid ACP status timestamps", async () => {
    mockBoundThreadSession();
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      ...createAcpSessionEntry(),
      acp: {
        ...createAcpSessionEntry().acp,
        lastActivityAt: 8_700_000_000_000_000,
      },
    });
    createTaskRecord({
      runtime: "acp",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: defaultAcpSessionKey,
      runId: "acp-run-1",
      task: "Inspect ACP backlog",
      status: "running",
      lastEventAt: 8_700_000_000_000_000,
    });

    const result = await runThreadAcpCommand("/acp status", baseCfg);

    expect(result?.reply?.text).toContain("ACP status:");
    expect(result?.reply?.text).toContain("lastActivityAt: n/a");
    expect(result?.reply?.text).not.toContain("taskUpdatedAt:");
  });

  it("sanitizes leaked task and runtime details in ACP status output", async () => {
    const internalContext = [
      "OpenClaw runtime context (internal):",
      "This context is runtime-generated, not user-authored. Keep internal details private.",
      "",
      "[Internal task completion event]",
      "source: subagent",
    ].join("\n");
    mockBoundThreadSession({
      identity: {
        state: "resolved",
        source: "status",
        acpxSessionId: "acpx-sid-1",
        agentSessionId: "codex-sid-1",
        lastUpdatedAt: Date.now(),
      },
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      ...createAcpSessionEntry({
        identity: {
          state: "resolved",
          source: "status",
          acpxSessionId: "acpx-sid-1",
          agentSessionId: "codex-sid-1",
          lastUpdatedAt: Date.now(),
        },
      }),
      acp: {
        ...createAcpSessionEntry().acp,
        identity: {
          state: "resolved",
          source: "status",
          acpxSessionId: "acpx-sid-1",
          agentSessionId: "codex-sid-1",
          lastUpdatedAt: Date.now(),
        },
        lastError: internalContext,
      },
    });
    hoisted.getStatusMock.mockResolvedValue({
      summary: internalContext,
      details: {
        payload: internalContext,
      },
    });
    createTaskRecord({
      runtime: "acp",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: defaultAcpSessionKey,
      runId: "acp-run-1",
      task: "Inspect ACP backlog",
      status: "running",
    });
    failTaskRunByRunIdCore({
      runId: "acp-run-1",
      endedAt: Date.now(),
      error: internalContext,
      terminalSummary: "Needs approval to continue.",
    });

    const result = await runThreadAcpCommand("/acp status", baseCfg);

    expect(result?.reply?.text).toContain("ACP status:");
    expect(result?.reply?.text).toContain("taskSummary: Needs approval to continue.");
    expect(result?.reply?.text).not.toContain("OpenClaw runtime context (internal):");
    expect(result?.reply?.text).not.toContain("Internal task completion event");
  });

  it("updates ACP runtime mode via /acp set-mode", async () => {
    mockBoundThreadSession();
    const result = await runThreadAcpCommand("/acp set-mode plan", baseCfg);

    expectMockCallFields(hoisted.setModeMock, {
      cfg: baseCfg,
      runtimeMode: "plan",
      sessionKey: defaultAcpSessionKey,
    });
    expect(result?.reply?.text).toContain("Updated ACP runtime mode");
  });

  it("blocks mutating /acp actions for internal operator.write clients", async () => {
    const result = await runInternalAcpCommand({
      commandBody: "/acp set-mode plan",
      scopes: ["operator.write"],
    });

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("requires operator.admin");
  });

  it("blocks /acp status for internal operator.write clients", async () => {
    const result = await runInternalAcpCommand({
      commandBody: "/acp status",
      scopes: ["operator.write"],
    });

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("requires operator.admin");
  });

  it("keeps read-only /acp actions available to internal operator.write clients", async () => {
    hoisted.readAcpSessionEntryMock.mockReturnValue(createAcpSessionEntry());

    const result = await runInternalAcpCommand({
      commandBody: "/acp sessions",
      scopes: ["operator.write"],
    });

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain(defaultAcpSessionKey);
    expect(hoisted.listAcpSessionEntriesMock).not.toHaveBeenCalled();
  });

  it("lists all ACP sessions for internal operator.admin clients", async () => {
    hoisted.listAcpSessionEntriesMock.mockResolvedValue([
      createAcpSessionEntry({ sessionKey: "agent:codex:acp:own" }),
      createAcpSessionEntry({ sessionKey: "agent:claude:acp:foreign" }),
    ]);

    const result = await runInternalAcpCommand({
      commandBody: "/acp sessions",
      scopes: ["operator.admin"],
    });

    expect(result?.reply?.text).toContain("agent:codex:acp:own");
    expect(result?.reply?.text).toContain("agent:claude:acp:foreign");
    expect(hoisted.readAcpSessionEntryMock).not.toHaveBeenCalled();
  });

  it("allows mutating /acp actions for internal operator.admin clients", async () => {
    mockBoundThreadSession();

    const result = await runInternalAcpCommand({
      commandBody: "/acp set-mode plan",
      scopes: ["operator.admin"],
    });

    expectMockCallFields(hoisted.setModeMock, {
      cfg: baseCfg,
      runtimeMode: "plan",
    });
    expect(result?.reply?.text).toContain("Updated ACP runtime mode");
  });

  it("updates ACP config options and keeps cwd local when using /acp set", async () => {
    await withStoredAcpCommandSession(async (cfg, manager) => {
      const setModel = await runThreadAcpCommand("/acp set model qa-next", cfg);
      expect(setModel?.reply?.text).toBe(
        "Model changed to the selected model. Still using the selected app.",
      );
      expectMockCallFields(hoisted.setConfigOptionMock, { key: "model", value: "qa-next" });
      const selected = requireReadySession(
        manager.resolveSession({ cfg, sessionKey: defaultAcpSessionKey }),
      );
      expect(selected.selection.model).toEqual({ id: "qa-next" });
      hoisted.setConfigOptionMock.mockClear();
      const setCwd = await runThreadAcpCommand("/acp set cwd /tmp/worktree", cfg);
      expect(hoisted.setConfigOptionMock).not.toHaveBeenCalled();
      expect(setCwd?.reply?.text).toContain("Updated ACP cwd");
    });
  });

  it.each([
    {
      action: "set-mode",
      command: "/acp set-mode plan",
      effectiveOptions: { runtimeMode: "plan" },
      managerMock: hoisted.setModeMock,
      managerInput: { runtimeMode: "plan" },
      expectedText: `✅ Updated ACP runtime mode for ${defaultAcpSessionKey}: plan. Effective options: runtimeMode=plan`,
    },
    {
      action: "cwd",
      command: "/acp cwd /tmp/worktree",
      effectiveOptions: { cwd: "/tmp/worktree" },
      managerMock: hoisted.updateSessionRuntimeOptionsMock,
      managerInput: { patch: { cwd: "/tmp/worktree" } },
      expectedText: `✅ Updated ACP cwd for ${defaultAcpSessionKey}: /tmp/worktree. Effective options: cwd=/tmp/worktree`,
    },
    {
      action: "permissions",
      command: "/acp permissions approve-all",
      effectiveOptions: { permissionProfile: "approve-all" },
      managerMock: hoisted.setConfigOptionMock,
      managerInput: { key: "approval_policy", value: "approve-all" },
      expectedText: `✅ Updated ACP permissions profile for ${defaultAcpSessionKey}: approve-all. Effective options: permissionProfile=approve-all`,
    },
    {
      action: "timeout",
      command: "/acp timeout 120",
      effectiveOptions: { timeoutSeconds: 120 },
      managerMock: hoisted.setConfigOptionMock,
      managerInput: { key: "timeout", value: "120" },
      expectedText: `✅ Updated ACP timeout for ${defaultAcpSessionKey}: 120s. Effective options: timeoutSeconds=120`,
    },
  ])("updates ACP $action through the dedicated runtime-option action", async (testCase) => {
    mockBoundThreadSession();
    testCase.managerMock.mockResolvedValueOnce(testCase.effectiveOptions);

    const result = await runThreadAcpCommand(testCase.command, baseCfg);

    expect(result?.reply?.text).toBe(testCase.expectedText);
    expectMockCallFields(testCase.managerMock, {
      cfg: baseCfg,
      sessionKey: defaultAcpSessionKey,
      ...testCase.managerInput,
    });
    expect(
      hoisted.setModeMock.mock.calls.length +
        hoisted.setConfigOptionMock.mock.calls.length +
        hoisted.updateSessionRuntimeOptionsMock.mock.calls.length,
    ).toBe(1);
  });

  it("commits the backend-accepted model through /acp model", async () => {
    await withStoredAcpCommandSession(async (cfg, manager) => {
      hoisted.setConfigOptionMock.mockResolvedValueOnce({
        configOptions: [{ id: "model", category: "model", currentValue: "qa-accepted" }],
      });
      const result = await runThreadAcpCommand("/acp model qa-next", cfg);
      expect(result?.reply?.text).toBe(
        "Model changed to the selected model. Still using the selected app.",
      );
      expect(hoisted.setConfigOptionMock).toHaveBeenCalledOnce();
      expect(hoisted.setConfigOptionMock).toHaveBeenCalledWith({
        handle: expect.objectContaining({ sessionKey: defaultAcpSessionKey, agentId: "codex" }),
        key: "model",
        value: "qa-next",
      });
      const selected = requireReadySession(
        manager.resolveSession({ cfg, sessionKey: defaultAcpSessionKey }),
      );
      expect(selected.selection.model).toEqual({ id: "qa-accepted" });
    });
  });

  it("keeps the accepted model and pauses chat when the model control fails", async () => {
    await withStoredAcpCommandSession(async (cfg, manager) => {
      hoisted.setConfigOptionMock.mockRejectedValueOnce(
        new AcpRuntimeError("ACP_TURN_FAILED", "backend failure"),
      );
      const result = await runThreadAcpCommand("/acp model qa-next", cfg);
      expect(result?.reply?.text).toBe(
        "The model change could not be confirmed. Chat is paused while the app confirms the saved selection.",
      );
      const selected = manager.resolveSession({ cfg, sessionKey: defaultAcpSessionKey });
      expect(selected).toMatchObject({ kind: "ready", selection: { model: "native-managed" } });
      await expect(
        manager.runTurn({
          admittedRunContext: createTestAdmittedRunContext("after-rejected-model"),
          cfg,
          sessionKey: defaultAcpSessionKey,
          provenance: "human",
          text: "continue",
          mode: "prompt",
          requestId: "after-rejected-model",
        }),
      ).rejects.toThrow("app did not confirm the last change");
      expect(hoisted.runTurnMock).not.toHaveBeenCalled();
    });
  });

  it("preserves the runtime mode failure boundary", async () => {
    mockBoundThreadSession();
    hoisted.setModeMock.mockRejectedValueOnce("backend failure");
    const result = await runThreadAcpCommand("/acp set-mode plan", baseCfg);
    expect(result?.reply?.text).toBe(
      "ACP error (ACP_TURN_FAILED): Could not update ACP runtime mode.\nnext: Retry, or use `/acp cancel` and send the message again.",
    );
  });

  it("rejects non-absolute cwd values via ACP runtime option validation", async () => {
    mockBoundThreadSession();

    const result = await runThreadAcpCommand("/acp cwd relative/path", baseCfg);

    expect(result?.reply?.text).toContain("ACP error (ACP_INVALID_RUNTIME_OPTION)");
    expect(result?.reply?.text).toContain("absolute path");
  });

  it("rejects invalid timeout values before backend config writes", async () => {
    mockBoundThreadSession();

    const result = await runThreadAcpCommand("/acp timeout 10s", baseCfg);

    expect(result?.reply?.text).toContain("ACP error (ACP_INVALID_RUNTIME_OPTION)");
    expect(hoisted.setConfigOptionMock).not.toHaveBeenCalled();
  });

  it("returns actionable doctor output when backend is missing", async () => {
    hoisted.getAcpRuntimeBackendMock.mockReturnValue(null);
    hoisted.requireAcpRuntimeBackendMock.mockImplementation(() => {
      throw new AcpRuntimeError(
        "ACP_BACKEND_MISSING",
        "ACP runtime backend is not configured. Install and enable the acpx runtime plugin.",
      );
    });

    const result = await runDiscordAcpCommand("/acp doctor", baseCfg);

    expect(result?.reply?.text).toContain("ACP doctor:");
    expect(result?.reply?.text).toContain("healthy: no");
    expect(result?.reply?.text).toContain("next:");
  });

  it("explains when acpx is blocked by plugins.allow", async () => {
    hoisted.getAcpRuntimeBackendMock.mockReturnValue(null);
    hoisted.requireAcpRuntimeBackendMock.mockImplementation(() => {
      throw new AcpRuntimeError(
        "ACP_BACKEND_MISSING",
        "ACP runtime backend is not configured. Install and enable the acpx runtime plugin.",
      );
    });

    const result = await runDiscordAcpCommand("/acp doctor", {
      ...baseCfg,
      plugins: { allow: ["discord"] },
    });

    expect(result?.reply?.text).toContain("pluginActivation: blocked");
    expect(result?.reply?.text).toContain("acpx");
    expect(result?.reply?.text).toContain('add "acpx" to plugins.allow');
  });

  it("shows deterministic install instructions via /acp install", async () => {
    const result = await runDiscordAcpCommand("/acp install", baseCfg);

    expect(result?.reply?.text).toContain("ACP install:");
    expect(result?.reply?.text).toContain("run:");
    expect(result?.reply?.text).toContain("then: /acp doctor");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
