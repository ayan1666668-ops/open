import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ModelCatalogEntry } from "../agents/model-catalog.types.js";
import { createSessionModelCatalogFixture } from "../agents/test-helpers/session-model-catalog.test-support.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { PublicSessionEntry } from "../model-picker/execution-selection-projection.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import {
  createColdPluginFixture,
  isColdPluginRuntimeLoaded,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import type { PrepareGatewaySessionLifecycle } from "./session-lifecycle-preparation.js";
import { writeSessionStore } from "./test-helpers.js";
import { testState } from "./test-helpers.runtime-state.js";
import {
  directSessionReq,
  getGatewayConfigModule,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSelectedGlobalSessionStore } = setupGatewaySessionsHandlerTestHarness();

const mainModel = {
  id: "main-only",
  name: "Main Model",
  provider: "main-provider",
  api: "openai-completions",
  baseUrl: "https://main.example.test/v1",
} satisfies ModelCatalogEntry;
const workModel = {
  id: "work-only",
  name: "Work Model",
  provider: "work-provider",
  api: "openai-completions",
  baseUrl: "https://work.example.test/v1",
} satisfies ModelCatalogEntry;

async function createAgentModelCatalogLoader() {
  const configModule = await getGatewayConfigModule();
  const current = configModule.getRuntimeConfig();
  const providers: Record<string, ModelProviderConfig> = { ...current.models?.providers };
  for (const model of [mainModel, workModel]) {
    providers[model.provider] = {
      api: model.api,
      baseUrl: model.baseUrl,
      models: [
        {
          id: model.id,
          name: model.name,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192,
          maxTokens: 1024,
        },
      ],
    };
  }
  await configModule.writeConfigFile({
    ...current,
    models: { ...current.models, providers },
  });
  const config = configModule.getRuntimeConfig();
  const metadata = loadPluginMetadataSnapshot({
    config,
    allowCurrent: false,
    preferPersisted: false,
  });
  const fixture = createSessionModelCatalogFixture();
  const publish = (agentId: string) => {
    const entries = agentId === "work" ? [workModel] : [mainModel];
    return fixture.publish({
      config,
      agentId,
      catalog: { entries, routeVariants: entries },
      profiles: {
        "main-provider:fixture": {
          type: "api_key",
          provider: "main-provider",
          key: "synthetic-main-key",
        },
        "work-provider:fixture": {
          type: "api_key",
          provider: "work-provider",
          key: "synthetic-work-key",
        },
      },
      plugins: metadata.plugins,
    });
  };
  // Lifecycle naming prepares before the request asks for its selected agent's catalog.
  const main = publish("main");
  const work = publish("work");
  return vi.fn(async (params?: { agentId?: string }) => (params?.agentId === "work" ? work : main));
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

const mainRef = "main-provider/main-only";
const workRef = "work-provider/work-only";

type ModelSelectionCase = {
  label: string;
  explicitAgent?: boolean;
  globalAllow: string[];
  agentAllow?: string[];
  globalAlias?: string;
  agentAlias?: string;
  agentRuntime?: string;
  harness?: "enabled" | "disabled" | "denied";
  codexDenied?: boolean;
  model: string;
  expectedModel: string;
  denied?: boolean;
};

function configureAgentModels(
  scenario: Pick<
    ModelSelectionCase,
    "globalAllow" | "agentAllow" | "globalAlias" | "agentAlias" | "agentRuntime"
  > & { subagentModel?: string },
  runtimeModel = workRef,
) {
  testState.agentConfig = {
    model: { primary: "synthetic/base" },
    modelPolicy: { allow: scenario.globalAllow },
    models: scenario.globalAlias ? { [workRef]: { alias: scenario.globalAlias } } : {},
  };
  testState.agentsConfig = {
    list: [
      {
        id: "main",
        default: true,
        modelPolicy: { allow: [mainRef] },
        models: { [mainRef]: { alias: "agent-choice" } },
      },
      {
        id: "work",
        subagents: scenario.subagentModel ? { model: scenario.subagentModel } : undefined,
        ...(scenario.agentAllow ? { modelPolicy: { allow: scenario.agentAllow } } : {}),
        models: {
          [workRef]: scenario.agentAlias ? { alias: scenario.agentAlias } : {},
          ...(scenario.agentRuntime
            ? { [runtimeModel]: { agentRuntime: { id: scenario.agentRuntime } } }
            : {}),
        },
      },
    ],
  };
}

const cases: ModelSelectionCase[] = [
  {
    label: "rejects configured Codex selection when its harness is denied",
    globalAllow: [],
    agentRuntime: "codex",
    codexDenied: true,
    model: "openai/gpt-5.4",
    expectedModel: "openai/gpt-5.4",
    denied: true,
  },
  {
    label: "preserves the session when the selected model requires an unavailable harness",
    globalAllow: [],
    agentRuntime: "missing-harness",
    model: workRef,
    expectedModel: workRef,
    denied: true,
  },
  ...(["enabled", "disabled", "denied"] as const).map((harness) => ({
    label: `refuses an installed ${harness} harness without readiness or runtime loading`,
    globalAllow: [],
    agentRuntime: "fixture-harness",
    harness,
    model: workRef,
    expectedModel: workRef,
    denied: true,
  })),
  {
    label: "loads the explicit agent model catalog",
    explicitAgent: true,
    globalAllow: [],
    model: workRef,
    expectedModel: workRef,
  },
  {
    label: "loads the agent-qualified session model catalog",
    globalAllow: [],
    model: workRef,
    expectedModel: workRef,
  },
  {
    label: "rejects outside agent policy despite unrestricted global policy",
    explicitAgent: true,
    globalAllow: [],
    agentAllow: [workRef],
    model: mainRef,
    expectedModel: mainRef,
    denied: true,
  },
  {
    label: "accepts an uncataloged model under explicit empty agent policy",
    globalAllow: [mainRef],
    agentAllow: [],
    model: "work-provider/uncataloged",
    expectedModel: "work-provider/uncataloged",
  },
  {
    label: "accepts the agent list instead of the opposing global list",
    explicitAgent: true,
    globalAllow: [mainRef],
    agentAllow: [workRef],
    model: workRef,
    expectedModel: workRef,
  },
  {
    label: "rejects the global list when the agent list replaces it",
    globalAllow: [mainRef],
    agentAllow: [workRef],
    model: mainRef,
    expectedModel: mainRef,
    denied: true,
  },
  {
    label: "resolves an agent-only alias under the target agent policy",
    globalAllow: [mainRef],
    agentAllow: [workRef],
    agentAlias: "agent-choice",
    model: "agent-choice",
    expectedModel: workRef,
  },
  {
    label: "uses the per-agent alias override for the same model key",
    explicitAgent: true,
    globalAllow: [mainRef],
    agentAllow: [workRef],
    globalAlias: "shared-choice",
    agentAlias: "agent-choice",
    model: "agent-choice",
    expectedModel: workRef,
  },
  {
    label: "rejects a displaced global alias",
    globalAllow: [workRef],
    agentAllow: [workRef],
    globalAlias: "shared-choice",
    agentAlias: "agent-choice",
    model: "shared-choice",
    expectedModel: "synthetic/shared-choice",
    denied: true,
  },
  {
    label: "checks the resolved agent alias against agent policy",
    globalAllow: [],
    agentAllow: [mainRef],
    agentAlias: "agent-choice",
    model: "agent-choice",
    expectedModel: workRef,
    denied: true,
  },
];

describe.each(["sessions.create", "sessions.patch"] as const)("%s", (method) => {
  test.each(cases)("$label", async (scenario) => {
    const { dir, workStorePath } = await createSelectedGlobalSessionStore();
    configureAgentModels(scenario, scenario.expectedModel);
    let fixture: ReturnType<typeof createColdPluginFixture> | undefined;
    if (scenario.harness) {
      const rootDir = await fs.mkdtemp(path.join(dir, "harness-"));
      fixture = createColdPluginFixture({
        rootDir,
        pluginId: "fixture-harness",
        manifest: { activation: { onAgentHarnesses: ["fixture-harness"] } },
      });
      const { writeConfigFile } = await getGatewayConfigModule();
      await writeConfigFile({
        plugins: {
          load: { paths: [rootDir] },
          ...(scenario.harness === "denied"
            ? {}
            : { entries: { "fixture-harness": { enabled: scenario.harness !== "disabled" } } }),
          ...(scenario.harness === "denied" ? { deny: ["fixture-harness"] } : {}),
        },
      });
    } else if (scenario.codexDenied) {
      const { writeConfigFile } = await getGatewayConfigModule();
      await writeConfigFile({ plugins: { deny: ["codex"] } });
    }
    const key = "agent:work:dashboard:catalog-owner";
    const access = { agentId: "work", sessionKey: key, storePath: workStorePath };
    if (method === "sessions.patch") {
      await writeSessionStore({
        agentId: "work",
        storePath: workStorePath,
        entries: {
          [key]: sessionStoreEntry("work-catalog-patch", {
            label: "Original label",
            executionSelection: {
              state: "deferred",
              request: { model: { provider: "synthetic", id: "previous" } },
              fallbackPermission: "explicit",
            },
          }),
        },
      });
    }
    const before = loadSessionEntry(access);
    const configModule = await getGatewayConfigModule();
    const { readConfigFileSnapshot } = configModule;
    const loadGatewayModelCatalogSnapshot = await createAgentModelCatalogLoader();
    const beforeConfig = await readConfigFileSnapshot();
    const configMutations = vi.spyOn(configModule, "mutateConfigFileWithRetry");
    let result: Awaited<ReturnType<typeof directSessionReq<{ entry?: PublicSessionEntry }>>>;
    try {
      result = await directSessionReq<{ entry?: PublicSessionEntry }>(
        method,
        {
          key,
          ...(scenario.explicitAgent ? { agentId: "work" } : {}),
          model: scenario.model,
          label: "Updated label",
        },
        {
          context: { loadGatewayModelCatalogSnapshot },
          ...(scenario.agentRuntime
            ? { client: { connect: { scopes: ["operator.admin"] } } as never }
            : {}),
        },
      );
    } finally {
      // Admin patches persist defaults in the background; join their writes before
      // the shared config fixture resets for the next case.
      await Promise.allSettled(
        configMutations.mock.results
          .filter((mutation) => mutation.type === "return")
          .map((mutation) => mutation.value),
      );
      configMutations.mockRestore();
    }

    expect(loadGatewayModelCatalogSnapshot).toHaveBeenCalledWith({ agentId: "work" });
    if (fixture) {
      expect(isColdPluginRuntimeLoaded(fixture)).toBe(false);
    }
    if (scenario.denied) {
      expect.soft(result.ok).toBe(false);
      expect.soft(result.error?.code).toBe("INVALID_REQUEST");
      expect(loadSessionEntry(access)).toEqual(before);
      expect((await readConfigFileSnapshot()).config).toEqual(beforeConfig.config);
      return;
    }
    expect(result.ok, result.error?.message).toBe(true);
    const [providerOverride, modelOverride] = scenario.expectedModel.split("/");
    const selection = { providerOverride, modelOverride, modelOverrideSource: "user" };
    expect(result.payload?.entry).toMatchObject(selection);
    expect(loadSessionEntry(access)).toMatchObject({
      executionSelection: {
        state: "accepted",
        selection: { model: { provider: providerOverride, id: modelOverride } },
        fallbackPermission: "explicit",
      },
      label: "Updated label",
    });
  });
});

test.each([
  {
    name: "target agent alias",
    globalAllow: [mainRef],
    agentAllow: [workRef],
    model: "agent-choice",
    expected: { providerOverride: "work-provider", modelOverride: "work-only" },
  },
  {
    name: "target agent denial despite unrestricted defaults",
    globalAllow: [],
    agentAllow: [workRef],
    model: mainRef,
    expected: null,
  },
  {
    name: "uncataloged model under an explicit empty agent policy",
    globalAllow: [mainRef],
    agentAllow: [],
    model: "work-provider/uncataloged",
    expected: { providerOverride: "work-provider", modelOverride: "uncataloged" },
  },
])("prepares session lifecycle selection for $name", async (scenario) => {
  await createSelectedGlobalSessionStore();
  configureAgentModels({ ...scenario, agentAlias: "agent-choice" });
  const { getRuntimeConfig } = await getGatewayConfigModule();
  const { createGatewaySession } = await import("./session-create-service.js");
  const prepareLifecycle = vi.fn<PrepareGatewaySessionLifecycle>(async () => ({
    ok: true,
    value: {},
  }));

  const loadGatewayModelCatalogSnapshot = await createAgentModelCatalogLoader();
  const result = await createGatewaySession({
    cfg: getRuntimeConfig(),
    key: "agent:work:dashboard:prepared-selection",
    agentId: "work",
    model: scenario.model,
    commandSource: "test",
    prepareLifecycle,
    loadGatewayModelCatalogSnapshot: () => loadGatewayModelCatalogSnapshot({ agentId: "work" }),
  });

  expect(result.ok).toBe(scenario.expected !== null);
  expect(prepareLifecycle).toHaveBeenCalledWith(
    expect.objectContaining({
      agentId: "work",
      titleModelSelection: scenario.expected
        ? expect.objectContaining({
            executionSelection: {
              model: {
                provider: scenario.expected.providerOverride,
                id: scenario.expected.modelOverride,
              },
              executor: { kind: "harness", id: "openclaw" },
            },
            validate: expect.any(Function),
          })
        : null,
    }),
  );
});

test.each([
  { name: "pinned model requested by agent alias", subagent: false },
  { name: "configured subagent default alias requested by canonical model", subagent: true },
  { name: "accepted model with unfinished legacy intent", subagent: false, acceptedLegacy: true },
])(
  "sessions.create preserves write-scoped adoption of $name",
  async ({ subagent, acceptedLegacy }) => {
    const { workStorePath } = await createSelectedGlobalSessionStore();
    const otherRef = "work-provider/other";
    configureAgentModels({
      // The subagent request is globally allowed so only its default-alias comparison loses scope.
      globalAllow: subagent ? [workRef, otherRef] : [mainRef],
      agentAllow: [workRef, otherRef],
      agentAlias: "agent-choice",
      subagentModel: subagent ? "agent-choice" : undefined,
    });
    const key = `agent:work:${subagent ? "subagent" : "dashboard"}:adopt-selection`;
    const access = { agentId: "work", sessionKey: key, storePath: workStorePath };
    const acceptedIntent = {
      executionSelection: {
        state: "accepted",
        selection: {
          model: { provider: "work-provider", id: "work-only" },
          executor: { kind: "harness", id: "openclaw" },
        },
        fallbackPermission: "configured",
        legacyRequest: { provider: "unfinished-provider", source: "auto" },
      },
      authProfileOverride: "work-provider:fixture",
      authProfileOverrideSource: "auto",
      authProfileOverrideCompactionCount: 2,
    } as const;
    await writeSessionStore({
      agentId: "work",
      storePath: workStorePath,
      entries: {
        [key]: sessionStoreEntry("existing-selection", {
          label: "Original label",
          ...(acceptedLegacy
            ? acceptedIntent
            : subagent
              ? {}
              : {
                  executionSelection: {
                    state: "deferred" as const,
                    request: { model: { provider: "work-provider", id: "work-only" } },
                    fallbackPermission: "explicit" as const,
                  },
                }),
        }),
      },
    });
    const context = { loadGatewayModelCatalogSnapshot: await createAgentModelCatalogLoader() };
    const writeClient = { connect: { scopes: ["operator.write"] } } as never;
    const sameSelection = await directSessionReq<{ entry?: PublicSessionEntry }>(
      "sessions.create",
      { key, model: subagent ? workRef : "agent-choice" },
      { client: writeClient, context },
    );

    expect(sameSelection.ok, sameSelection.error?.message).toBe(true);
    expect(loadSessionEntry(access)).toMatchObject({
      sessionId: "existing-selection",
      executionSelection: {
        state: "accepted",
        selection: { model: { provider: "work-provider", id: "work-only" } },
        fallbackPermission: acceptedLegacy ? "configured" : "explicit",
      },
    });
    if (acceptedLegacy) {
      expect(loadSessionEntry(access)?.executionSelection).toEqual(
        acceptedIntent.executionSelection,
      );
      expect(loadSessionEntry(access)).toMatchObject(acceptedIntent);
    }
    const beforeChange = loadSessionEntry(access);
    const denied = await directSessionReq(
      "sessions.create",
      { key, model: otherRef, label: "Must not change" },
      { client: writeClient, context },
    );
    expect(denied).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN", message: "missing scope: operator.admin" },
    });
    expect(loadSessionEntry(access)).toEqual(beforeChange);
    if (acceptedLegacy) {
      for (const selection of [
        { model: workRef, agentRuntime: "different-app" },
        { model: `${workRef}@work-provider:other` },
      ]) {
        const changedIntent = await directSessionReq(
          "sessions.create",
          { key, ...selection },
          { client: writeClient, context },
        );
        expect(changedIntent).toMatchObject({
          ok: false,
          error: { code: "FORBIDDEN", message: "missing scope: operator.admin" },
        });
        expect(loadSessionEntry(access)).toEqual(beforeChange);
      }
    }

    const changed = await directSessionReq(
      "sessions.create",
      { key, model: otherRef },
      { client: { connect: { scopes: ["operator.admin"] } } as never, context },
    );
    expect(changed.ok, changed.error?.message).toBe(true);
    expect(loadSessionEntry(access)).toMatchObject({
      sessionId: "existing-selection",
      executionSelection: {
        state: "accepted",
        selection: { model: { provider: "work-provider", id: "other" } },
        fallbackPermission: "explicit",
      },
    });
  },
);
