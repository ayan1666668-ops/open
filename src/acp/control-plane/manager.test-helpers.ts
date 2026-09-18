import { isDeepStrictEqual } from "node:util";
import type { AcpRuntime, AcpRuntimeCapabilities } from "@openclaw/acp-core/runtime/types";
/** Shared ACP manager test harness, mocks, fixtures, and assertion helpers. */
import type { SessionAcpMeta } from "@openclaw/acp-core/types";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { resetAcpManagerTaskStateForTests } from "../../../test/helpers/acp-manager-task-state.js";
import { createTestAdmittedRunContext } from "../../agents/admitted-run-context.test-support.js";
import type { OpenClawConfig } from "../../config/config.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import type {
  AcpSessionRuntimeOptions,
  SessionAcpLifecycle,
  SessionEntry,
} from "../../config/sessions/types.js";
import { commitSessionExecutionSelection } from "../../model-picker/apply-session-model-selection.js";
import type { AcpExecutionSelection } from "../../model-picker/execution-selection.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";
import type { AcpSessionStoreEntry } from "../runtime/session-meta.js";
import { resetAcpActiveTurnsForTests } from "./active-turns.test-support.js";
import type { AcpSessionManagerDeps } from "./manager.types.js";
import { requireAcpExecutionSelection } from "./manager.utils.js";
import { resolveRuntimeOptionsForSelection } from "./runtime-options.js";

export type {
  AcpRuntime,
  OpenClawConfig,
  SessionAcpMeta,
  SessionAcpLifecycle,
  AcpExecutionSelection,
};

const hoistedMocks = vi.hoisted(() => {
  const listAcpSessionEntriesMock = vi.fn();
  const readAcpSessionEntryMock = vi.fn();
  const upsertAcpSessionMetaMock = vi.fn<AcpSessionManagerDeps["upsertSessionMeta"]>();
  const getAcpRuntimeBackendMock = vi.fn();
  const requireAcpRuntimeBackendMock = vi.fn();
  const completedMetaWrites: Array<{
    entry: SessionEntry;
    options: Parameters<AcpSessionManagerDeps["upsertSessionMeta"]>[0];
  }> = [];
  return {
    completedMetaWrites,
    listAcpSessionEntriesMock,
    readAcpSessionEntryMock,
    upsertAcpSessionMetaMock,
    getAcpRuntimeBackendMock,
    requireAcpRuntimeBackendMock,
  };
});

vi.mock("../runtime/session-meta.js", () => ({
  listAcpSessionEntries: (params: unknown) => hoistedMocks.listAcpSessionEntriesMock(params),
  readAcpSessionEntryCore: (params: unknown) => hoistedMocks.readAcpSessionEntryMock(params),
  upsertAcpSessionMeta: async (
    params: Parameters<AcpSessionManagerDeps["upsertSessionMeta"]>[0],
  ) => {
    const entry = await hoistedMocks.upsertAcpSessionMetaMock(params);
    if (entry) {
      hoistedMocks.completedMetaWrites.push({ entry: structuredClone(entry), options: params });
    }
    return entry;
  },
}));

vi.mock("../runtime/registry.js", () => ({
  getAcpRuntimeBackend: (backendId?: string) => hoistedMocks.getAcpRuntimeBackendMock(backendId),
  requireAcpRuntimeBackend: (backendId?: string) =>
    hoistedMocks.requireAcpRuntimeBackendMock(backendId),
}));

export const hoisted = hoistedMocks;

// Shared ACP manager test harness with hoisted runtime/session-meta mocks.
const managerModule = await import("./manager.js");
type AcpRunTurnInput = import("./manager.types.js").AcpRunTurnInput;
type TestAcpRunTurnInput = Omit<AcpRunTurnInput, "admittedRunContext"> &
  Partial<Pick<AcpRunTurnInput, "admittedRunContext">>;

/** Keeps production ACP admission mandatory while centralizing legacy fixture setup. */
export class AcpSessionManager extends managerModule.AcpSessionManager {
  override async runTurn(input: TestAcpRunTurnInput): Promise<void> {
    return await super.runTurn({
      ...input,
      admittedRunContext: input.admittedRunContext ?? createTestAdmittedRunContext(input.requestId),
    });
  }
}
export const resetAcpSessionManagerForTests = () =>
  managerModule.testing.resetAcpSessionManagerForTests();
const managerLifecycleModule = await import("./manager.lifecycle.js");
export const disposeAcpSessionManagerInstance =
  managerLifecycleModule.disposeAcpSessionManagerInstance;
export const { AcpRuntimeError } = await import("../runtime/errors.js");

export const baseCfg = {
  acp: {
    enabled: true,
    backend: "acpx",
    dispatch: { enabled: true },
  },
} as const;
const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

export async function flushMicrotasks(rounds = 3): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
  }
}

export function expectRecordFields(record: unknown, expected: Record<string, unknown>) {
  if (!record || typeof record !== "object") {
    throw new Error("Expected record");
  }
  const actual = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
  return actual;
}

export async function expectRejectedRecord(
  promise: Promise<unknown>,
  expected: Record<string, unknown>,
) {
  await promise.then(
    () => {
      throw new Error("Expected promise to reject.");
    },
    (error: unknown) => {
      expectRecordFields(error, expected);
    },
  );
}

export function mockCallArg(
  mock: ReturnType<typeof vi.fn>,
  callIndex = 0,
): Record<string, unknown> {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call[0] as Record<string, unknown>;
}

function mockCallArgs(mock: ReturnType<typeof vi.fn>): Array<Record<string, unknown>> {
  return mock.mock.calls.map((call) => call[0] as Record<string, unknown>);
}

function findMockCallFields(mock: ReturnType<typeof vi.fn>, expected: Record<string, unknown>) {
  return mockCallArgs(mock).find((actual) =>
    Object.entries(expected).every(([key, value]) => Object.is(actual[key], value)),
  );
}

export function expectMockCallFields(
  mock: ReturnType<typeof vi.fn>,
  expected: Record<string, unknown>,
) {
  if (!findMockCallFields(mock, expected)) {
    throw new Error(`Expected mock call ${JSON.stringify(expected)}`);
  }
}

export function expectNoMockCallFields(
  mock: ReturnType<typeof vi.fn>,
  expected: Record<string, unknown>,
) {
  expect(findMockCallFields(mock, expected)).toBeUndefined();
}

export function createRuntime(): {
  runtime: AcpRuntime;
  ensureSession: ReturnType<typeof vi.fn<AcpRuntime["ensureSession"]>>;
  runTurn: ReturnType<typeof vi.fn<AcpRuntime["runTurn"]>>;
  prepareFreshSession: ReturnType<typeof vi.fn<NonNullable<AcpRuntime["prepareFreshSession"]>>>;
  cancel: ReturnType<typeof vi.fn<AcpRuntime["cancel"]>>;
  close: ReturnType<typeof vi.fn<AcpRuntime["close"]>>;
  getCapabilities: ReturnType<typeof vi.fn<NonNullable<AcpRuntime["getCapabilities"]>>>;
  getStatus: ReturnType<typeof vi.fn<NonNullable<AcpRuntime["getStatus"]>>>;
  setMode: ReturnType<typeof vi.fn<NonNullable<AcpRuntime["setMode"]>>>;
  setConfigOption: ReturnType<typeof vi.fn<NonNullable<AcpRuntime["setConfigOption"]>>>;
} {
  const ensureSession = vi.fn<AcpRuntime["ensureSession"]>(
    async (input: {
      sessionKey: string;
      agent: string;
      mode: "persistent" | "oneshot";
      model?: string;
      thinking?: string;
      cwd?: string;
      resumeSessionId?: string;
    }) => ({
      sessionKey: input.sessionKey,
      backend: "acpx",
      runtimeSessionName: `${input.sessionKey}:${input.mode}:runtime`,
    }),
  );
  const runTurn = vi.fn<AcpRuntime["runTurn"]>(async function* () {
    yield { type: "done" as const };
  });
  const prepareFreshSession = vi.fn<NonNullable<AcpRuntime["prepareFreshSession"]>>(async () => {});
  const cancel = vi.fn<AcpRuntime["cancel"]>(async () => {});
  const close = vi.fn<AcpRuntime["close"]>(async () => {});
  const getCapabilities = vi.fn<NonNullable<AcpRuntime["getCapabilities"]>>(
    async (): Promise<AcpRuntimeCapabilities> => ({
      controls: ["session/set_mode", "session/set_config_option", "session/status"],
    }),
  );
  const getStatus = vi.fn<NonNullable<AcpRuntime["getStatus"]>>(async () => ({
    summary: "status=alive",
    details: { status: "alive" },
  }));
  const setMode = vi.fn<NonNullable<AcpRuntime["setMode"]>>(async () => {});
  const setConfigOption = vi.fn<NonNullable<AcpRuntime["setConfigOption"]>>(async () => {});
  return {
    runtime: {
      ensureSession,
      runTurn,
      getCapabilities,
      getStatus,
      setMode,
      setConfigOption,
      prepareFreshSession,
      cancel,
      close,
    },
    ensureSession,
    runTurn,
    prepareFreshSession,
    cancel,
    close,
    getCapabilities,
    getStatus,
    setMode,
    setConfigOption,
  };
}

export function readySessionMeta(overrides: Partial<SessionAcpMeta> = {}): SessionAcpMeta {
  return {
    backend: "acpx",
    agent: "codex",
    runtimeSessionName: "runtime-1",
    mode: "persistent" as const,
    state: "idle" as const,
    lastActivityAt: Date.now(),
    ...overrides,
  };
}

export function mockParentedAcpSessionEntries(params: {
  childSessionKey: string;
  parentSessionKey: string;
  label?: string;
}): void {
  installReadyAcpSessionStoreFixture(params.childSessionKey, {
    sessionId: "child-1",
    updatedAt: Date.now(),
    spawnedBy: params.parentSessionKey,
    ...(params.label === undefined ? {} : { label: params.label }),
  });
  const readChild = expectDefined(
    hoisted.readAcpSessionEntryMock.getMockImplementation(),
    "child fixture reader",
  );
  hoisted.readAcpSessionEntryMock.mockImplementation((input: { sessionKey?: string }) => {
    if (input.sessionKey === params.childSessionKey) {
      return readChild(input);
    }
    if (input.sessionKey !== params.parentSessionKey) {
      return null;
    }
    return {
      cfg: baseCfg,
      agentId: resolveAgentIdFromSessionKey(params.parentSessionKey, "main"),
      storePath: "/synthetic/agent.sqlite",
      sessionKey: params.parentSessionKey,
      storeSessionKey: params.parentSessionKey,
      entry: { sessionId: "parent-1", updatedAt: Date.now() },
    };
  });
}

export function extractStatesFromUpserts(): SessionAcpLifecycle["state"][] {
  return hoisted.completedMetaWrites.flatMap(({ entry }) => (entry.acp ? [entry.acp.state] : []));
}

export function extractStateUpsertPersistenceOptions(): Array<{
  state: SessionAcpLifecycle["state"];
  skipMaintenance?: boolean;
  takeCacheOwnership?: boolean;
}> {
  return hoisted.completedMetaWrites.flatMap(({ entry, options }) =>
    entry.acp && options.skipMaintenance && options.takeCacheOwnership
      ? [{ state: entry.acp.state, skipMaintenance: true, takeCacheOwnership: true }]
      : [],
  );
}

export function extractRuntimeOptionsFromUpserts(): Array<AcpSessionRuntimeOptions | undefined> {
  return hoisted.completedMetaWrites.map(({ entry }) => entry.acp?.runtimeOptions);
}

export function installAcpSessionManagerTestLifecycle(): void {
  beforeEach(() => {
    resetAcpSessionManagerForTests();
    resetAcpActiveTurnsForTests();
    hoisted.completedMetaWrites.length = 0;
    vi.useRealTimers();
    hoisted.listAcpSessionEntriesMock.mockReset().mockResolvedValue([]);
    hoisted.readAcpSessionEntryMock.mockReset();
    hoisted.upsertAcpSessionMetaMock.mockReset().mockResolvedValue(null);
    hoisted.requireAcpRuntimeBackendMock.mockReset();
    hoisted.getAcpRuntimeBackendMock.mockReset().mockImplementation((backendId?: string) => {
      try {
        return hoisted.requireAcpRuntimeBackendMock(backendId);
      } catch {
        return null;
      }
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (ORIGINAL_STATE_DIR === undefined) {
      deleteTestEnvValue("OPENCLAW_STATE_DIR");
    } else {
      setTestEnvValue("OPENCLAW_STATE_DIR", ORIGINAL_STATE_DIR);
    }
    resetAcpManagerTaskStateForTests();
  });
}

/** Mutable canonical agent and lifecycle rows, with detached reads and guarded patch publication. */
export function installAcpSessionStoreFixture(params: {
  sessionKey: string;
  selection?: AcpExecutionSelection;
  meta?: SessionAcpLifecycle;
  entry?: SessionEntry;
  cfg?: OpenClawConfig;
  agentId?: string;
}) {
  const cfg = params.cfg ?? baseCfg;
  const agentId = params.agentId ?? "main";
  const sessionKey = params.sessionKey;
  let entry: SessionEntry = structuredClone(
    params.entry ?? { sessionId: "session-1", updatedAt: 1 },
  );
  let meta = params.meta ? structuredClone(params.meta) : undefined;
  if (params.selection) {
    commitSessionExecutionSelection(entry, params.selection);
  }
  hoisted.readAcpSessionEntryMock.mockImplementation((): AcpSessionStoreEntry => ({
    cfg,
    storePath: "/synthetic/agent.sqlite",
    agentId,
    sessionKey,
    storeSessionKey: sessionKey,
    entry: structuredClone(entry),
    acp: structuredClone(meta),
  }));
  hoisted.upsertAcpSessionMetaMock.mockImplementation(
    async (input: Parameters<AcpSessionManagerDeps["upsertSessionMeta"]>[0]) => {
      const next = input.mutate(structuredClone(meta), {
        ...structuredClone(entry),
        acp: structuredClone(meta),
      });
      input.assertCommitAllowed?.();
      if (!input.preserveActivity) {
        entry = { ...entry, updatedAt: Date.now() };
      }
      if (input.executionSelection) {
        commitSessionExecutionSelection(entry, input.executionSelection);
      }
      if (next !== undefined) {
        meta = next === null ? undefined : structuredClone(next);
      }
      return { ...structuredClone(entry), ...(meta ? { acp: structuredClone(meta) } : {}) };
    },
  );
  const patchEntry = vi
    .spyOn(sessionAccessor, "patchSessionEntryWithKey")
    .mockImplementation(async (_scope, update, options) => {
      const snapshot = structuredClone(entry);
      const patch = await update(structuredClone(entry), { existingEntry: structuredClone(entry) });
      options?.assertCommitAllowed?.();
      if (!isDeepStrictEqual(entry, snapshot)) {
        throw new Error("session snapshot changed");
      }
      if (patch) {
        entry = options?.replaceEntry
          ? {
              ...patch,
              sessionId: expectDefined(patch.sessionId, "replacement session id"),
              updatedAt: expectDefined(patch.updatedAt, "replacement update timestamp"),
            }
          : { ...entry, ...patch };
      }
      return { sessionKey, entry: structuredClone(entry) };
    });
  return {
    patchEntry,
    readEntry: () => structuredClone(entry),
    readMeta: () => (meta ? structuredClone(meta) : undefined),
    readSelection: () => requireAcpExecutionSelection(entry),
    readOptions: () =>
      resolveRuntimeOptionsForSelection(
        expectDefined(meta, "persisted lifecycle"),
        requireAcpExecutionSelection(entry),
      ),
  };
}

export function installReadyAcpSessionStoreFixture(sessionKey: string, entry?: SessionEntry) {
  return installAcpSessionStoreFixture({
    sessionKey,
    agentId: resolveAgentIdFromSessionKey(sessionKey, "main"),
    ...(entry ? { entry } : {}),
    selection: {
      executor: { kind: "acp", backend: "acpx", agent: "codex" },
      model: "native-managed",
    },
    meta: {
      runtimeSessionName: "runtime-1",
      mode: "persistent",
      state: "idle",
      lastActivityAt: Date.now(),
    },
  });
}

/** Seed canonical rows from a public ACP description; reads never reconstruct selection from metadata. */
export function installPublicAcpSessionFixture(
  sessionKey: string,
  meta: SessionAcpMeta | undefined,
  entry?: SessionEntry,
) {
  const { model, ...runtimeOptions } = meta?.runtimeOptions ?? {};
  const store = installAcpSessionStoreFixture({
    sessionKey,
    agentId: resolveAgentIdFromSessionKey(sessionKey, "main"),
    ...(entry ? { entry } : {}),
    ...(meta
      ? {
          selection: {
            executor: { kind: "acp", backend: meta.backend, agent: meta.agent },
            model: model ? { id: model } : "native-managed",
          },
          meta: {
            runtimeSessionName: meta.runtimeSessionName,
            identity: meta.identity,
            mode: meta.mode,
            state: meta.state,
            lastActivityAt: meta.lastActivityAt,
            lastError: meta.lastError,
            cwd: meta.cwd,
            ...(Object.keys(runtimeOptions).length ? { runtimeOptions } : {}),
          },
        }
      : {}),
  });
  return {
    ...store,
    get currentMeta() {
      return expectDefined(store.readMeta(), "persisted lifecycle");
    },
  };
}
