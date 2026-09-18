import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, test, vi } from "vitest";
import { registerAgentHarness } from "../agents/harness/registry.js";
import type { AgentHarnessSessionRuntimeOwnership } from "../agents/harness/types.js";
import * as modelCatalog from "../agents/prepared-model-catalog.js";
import { createSessionModelCatalogFixture } from "../agents/test-helpers/session-model-catalog.test-support.js";
import {
  appendTranscriptMessage,
  loadSessionEntryReadOnly,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { embeddedRunMock } from "./test-helpers.runtime-state.js";
import {
  acpManagerMocks,
  directSessionReq,
  getGatewayConfigModule,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
const bindings = new Map<string, AgentHarnessSessionRuntimeOwnership>();
let originalRegistry: ReturnType<typeof getActivePluginRegistry>;
afterEach(() => {
  bindings.clear();
  vi.restoreAllMocks();
  if (originalRegistry) {
    setActivePluginRegistry(originalRegistry);
  }
});

async function createCompactionFixture(entry: SessionEntry, ready = true) {
  const { storePath } = await createSessionStoreDir();
  originalRegistry = getActivePluginRegistry();
  setActivePluginRegistry(createEmptyPluginRegistry());
  registerAgentHarness({
    id: "compact-app",
    label: "Compact app",
    supports: () => ({ supported: true }),
    resolveSessionRuntimeOwnership: (params) => {
      params.assertCurrent();
      return bindings.get(params.sessionId);
    },
    runAttempt: async () => {
      throw new Error("Compaction must use its registered control boundary.");
    },
  });
  const configModule = await getGatewayConfigModule();
  const cfg: OpenClawConfig = {
    ...configModule.getRuntimeConfig(),
    agents: {
      defaults: {
        model: "compaction-provider/original",
      },
    },
    models: {
      providers: {
        "compaction-provider": {
          api: "openai-completions",
          auth: "api-key",
          baseUrl: "https://compaction.fixture.invalid/v1",
          models: [],
        },
      },
    },
  };
  configModule.setRuntimeConfigSnapshot(cfg);
  const rows = ["original", "requested"].map((id) => ({
    provider: "compaction-provider",
    id,
    name: id,
    api: "openai-completions" as const,
    baseUrl: "https://compaction.fixture.invalid/v1",
  }));
  createSessionModelCatalogFixture().publish({
    config: cfg,
    agentId: "main",
    catalog: { entries: rows, routeVariants: rows },
    profiles: ready
      ? {
          "compaction-provider:fixture": {
            type: "api_key",
            provider: "compaction-provider",
            key: "synthetic-compaction-credential",
          },
        }
      : {},
  });
  const target = {
    agentId: "main",
    sessionId: entry.sessionId,
    sessionKey: "agent:main:main",
    storePath,
  };
  await replaceSessionEntry(target, entry);
  for (const content of ["first", "second"]) {
    await appendTranscriptMessage(target, {
      cwd: "/tmp",
      message: { role: "user", content, timestamp: 1 },
    });
  }
  const compact = embeddedRunMock.compactEmbeddedAgentSession.mockResolvedValue({
    ok: true,
    compacted: false,
    reason: "Nothing to compact (session too small)",
  });
  return {
    target,
    compact,
    read: () => loadSessionEntryReadOnly({ ...target, readConsistency: "latest" }),
    run: () =>
      directSessionReq<{ ok: boolean; compacted: boolean; reason?: string }>(
        "sessions.compact",
        { key: target.sessionKey },
        { context: { getRuntimeConfig: () => cfg } },
      ),
  };
}

function deferredEntry(): SessionEntry {
  return {
    sessionId: "compact-deferred",
    updatedAt: 1,
    executionSelection: {
      state: "deferred",
      request: {
        model: { provider: "compaction-provider", id: "requested" },
        executor: { kind: "harness", id: "compact-app" },
      },
      fallbackPermission: "explicit",
      legacyRequest: { provider: "unfinished-provider", source: "user" },
    },
    cliSessionBindings: {
      "compact-app": { sessionId: "accepted-handle" },
      "old-app": { sessionId: "historical-handle" },
    },
    agentHarnessId: "old-app",
  };
}

test.each([true, false])(
  "sessions.compact initializes a deferred pair before dispatch (selected handle: %s)",
  async (hasBinding) => {
    const entry = deferredEntry();
    if (!hasBinding) {
      entry.cliSessionBindings = { "old-app": { sessionId: "historical-handle" } };
    }
    const fixture = await createCompactionFixture(entry);
    fixture.compact.mockImplementationOnce(async (params, host) => {
      expect(fixture.read()?.executionSelection).toMatchObject({
        state: "accepted",
        selection: {
          model: { provider: "compaction-provider", id: "requested" },
          executor: { kind: "harness", id: "compact-app" },
        },
        legacyRequest: { provider: "unfinished-provider", source: "user" },
      });
      expect(params).toMatchObject({
        provider: "compaction-provider",
        model: "requested",
        agentHarnessId: "compact-app",
        cliSessionId: hasBinding ? "accepted-handle" : undefined,
      });
      const stored = fixture.read()?.executionSelection;
      if (stored?.state !== "accepted") {
        throw new Error("Selection was not committed before dispatch.");
      }
      expect(host?.preparedSelection?.selection).toEqual(stored.selection);
      expect(host?.preparedSelection?.auth?.selection?.profileId).toBe(
        "compaction-provider:fixture",
      );
      expect(() => host?.assertActive?.()).not.toThrow();
      return { ok: true, compacted: false, reason: "Nothing to compact (session too small)" };
    });
    const response = await fixture.run();
    expect(response).toMatchObject({ ok: true, payload: { ok: true, compacted: false } });
    expect(fixture.compact).toHaveBeenCalledTimes(1);
  },
);

test("sessions.compact leaves a deferred request and transcript unchanged when its account is unavailable", async () => {
  const fixture = await createCompactionFixture(deferredEntry(), false);
  const before = fixture.read();
  const transcript = await loadTranscriptEvents(fixture.target);
  const response = await fixture.run();
  expect(response).toMatchObject({ ok: true, payload: { ok: false, compacted: false } });
  expect(response.payload?.reason).toContain("Sign in");
  expect(fixture.read()?.executionSelection).toEqual(before?.executionSelection);
  expect(fixture.read()?.authProfileOverride).toEqual(before?.authProfileOverride);
  expect(await loadTranscriptEvents(fixture.target)).toEqual(transcript);
  expect(fixture.compact).not.toHaveBeenCalled();
});

test.each(["accepted", "deferred"])(
  "sessions.compact preserves a %s native-managed selection without generic model preparation",
  async (state) => {
    const fixture = await createCompactionFixture(
      {
        sessionId: "compact-native",
        updatedAt: 1,
        agentHarnessId: "compact-app",
        modelSelectionLocked: true,
        executionSelection:
          state === "accepted"
            ? {
                state: "accepted",
                selection: {
                  model: "native-managed",
                  executor: { kind: "harness", id: "compact-app" },
                },
                fallbackPermission: "explicit",
              }
            : {
                state: "deferred",
                request: {
                  model: "native-managed",
                  executor: { kind: "harness", id: "compact-app" },
                },
                fallbackPermission: "explicit",
              },
      },
      false,
    );
    bindings.set(fixture.target.sessionId, { model: "native", auth: "native" });
    const catalogRead = vi.spyOn(modelCatalog, "loadPublishedPreparedModelCatalog");
    const response = await fixture.run();
    expect(catalogRead).not.toHaveBeenCalled();
    expect(response).toMatchObject({ ok: true, payload: { ok: true } });
    const [params, host] = expectDefined(fixture.compact.mock.calls[0], "native compaction call");
    expect(params.provider).toBeUndefined();
    expect(params.model).toBeUndefined();
    expect(host?.preparedSelection).toMatchObject({
      selection: { model: "native-managed", executor: { id: "compact-app" } },
    });
    expect(host?.preparedSelection?.auth).toBeUndefined();
    expect(fixture.read()?.executionSelection).toMatchObject({
      state: "accepted",
      selection: { model: "native-managed" },
    });
  },
);

test("sessions.compact refuses an app-managed request before model control or selection writes", async () => {
  const fixture = await createCompactionFixture({
    sessionId: "compact-app-managed",
    updatedAt: 1,
    executionSelection: {
      state: "accepted",
      selection: {
        model: "native-managed",
        executor: { kind: "acp", backend: "fixture-backend", agent: "fixture-agent" },
      },
      fallbackPermission: "explicit",
    },
  });
  const before = fixture.read();
  const response = await fixture.run();
  expect(response).toMatchObject({
    ok: true,
    payload: {
      ok: false,
      compacted: false,
      reason: "This session requires its bound app to run this operation.",
    },
  });
  expect(fixture.read()?.executionSelection).toEqual(before?.executionSelection);
  expect(acpManagerMocks.getManager).not.toHaveBeenCalled();
  expect(fixture.compact).not.toHaveBeenCalled();
});
