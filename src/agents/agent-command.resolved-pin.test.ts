import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { migrateSessionExecutionSelection } from "../commands/doctor/shared/session-execution-selection.js";
import { normalizePersistedSessionEntryShape } from "../config/sessions/store-entry-shape.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { commitSessionExecutionSelection } from "../model-picker/apply-session-model-selection.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { resolveEmbeddedModelSelection } from "./command/model-selection.js";
import { ensureSelectedAgentHarnessPlugin } from "./harness/runtime-plugin.js";
import { createSessionModelCatalogFixture } from "./test-helpers/session-model-catalog.test-support.js";

vi.mock("./harness/runtime-plugin.js", () => ({
  ensureSelectedAgentHarnessPlugin: vi.fn(async () => undefined),
}));
vi.mock("./command/runtime-loaders.js", () => ({
  loadTranscriptResolveRuntime: async () => ({
    resolveSessionTranscriptFile: async ({ sessionEntry }: { sessionEntry?: SessionEntry }) => ({
      sessionEntry,
      sessionFile: "synthetic-transcript",
    }),
  }),
}));
vi.mock("./command/attempt-execution.shared.js", () => ({
  persistAgentSession: async ({ entry }: { entry: SessionEntry }) => entry,
}));

afterEach(() => resetPluginRuntimeStateForTest());

const metadataSnapshot = createPluginMetadataSnapshotFixture({
  plugins: [
    {
      id: "fixture",
      providers: ["custom"],
      modelIdNormalization: {
        providers: { custom: { aliases: { latest: "middle", middle: "final" } } },
      },
    },
  ],
});

it.each([
  { name: "resolved provider-prefixed model", pin: "custom/model", expected: "custom/model" },
  { name: "resolved alias-like model", pin: "middle", expected: "middle" },
  { name: "legacy raw alias once", pin: "latest", expected: "middle", raw: true },
  { name: "configured default alias once", pin: "latest", expected: "middle", use: "default" },
  {
    name: "configured default retained by an exact-only policy",
    pin: "latest",
    expected: "middle",
    use: "default",
    allow: ["custom/other"],
  },
  { name: "explicit alias once", pin: "latest", expected: "middle", use: "explicit" },
  {
    name: "resolved prefix rejected by colliding policy",
    pin: "custom/model",
    expected: "custom/model",
    rejects: true,
    allow: ["custom/default", "custom/model"],
  },
  {
    name: "resolved prefix allowed by namespace wildcard",
    pin: "custom/model",
    expected: "custom/model",
    allow: ["custom/default", "custom/custom/*"],
  },
  {
    name: "locked resolved prefix",
    pin: "custom/model",
    expected: "custom/model",
    allow: ["custom/default", "custom/model"],
    locked: true,
  },
])("preserves $name through command selection", async (fixture) => {
  await withStateDirEnv("command-resolved-pin-", async ({ stateDir }) => {
    const cfg: OpenClawConfig = {
      plugins: { enabled: false },
      models: {
        providers: {
          custom: {
            api: "openai-completions",
            baseUrl: "https://command-selection.fixture.invalid/v1",
            auth: "api-key",
            models: [],
          },
        },
      },
      agents: {
        entries: { main: { workspace: stateDir } },
        defaults: {
          model: fixture.use === "default" ? "custom/latest" : "custom/default",
          thinkingDefault: "off",
          ...(fixture.allow ? { modelPolicy: { allow: fixture.allow } } : {}),
        },
      },
    };
    let sessionEntry: SessionEntry = { sessionId: "resolved-pin", updatedAt: 1 };
    const sessionKey = "agent:main:resolved-pin";
    await withPluginRuntimeGenerationScope(
      { metadataSnapshot, pluginRegistry: createEmptyPluginRegistry() },
      async () => {
        if (fixture.raw) {
          sessionEntry = expectDefined(
            normalizePersistedSessionEntryShape(
              migrateSessionExecutionSelection({
                entry: {
                  ...sessionEntry,
                  providerOverride: "custom",
                  modelOverride: fixture.pin,
                  modelOverrideSource: "user",
                },
                defaultProvider: "custom",
                classifyExecutor: (id) => (id === "openclaw" ? "harness" : undefined),
              }).entry,
            ),
            "migrated legacy selection",
          );
        } else if (!fixture.use) {
          commitSessionExecutionSelection(
            sessionEntry,
            {
              model: { provider: "custom", id: fixture.pin },
              executor: { kind: "harness", id: "openclaw" },
            },
            { cause: { kind: "user" } },
          );
        }
        if (fixture.locked) {
          sessionEntry.modelSelectionLocked = true;
        }
        const rows = ["default", "middle", "final", "custom/model"].map((id) => ({
          provider: "custom",
          id,
          name: id,
          api: "openai-completions" as const,
          baseUrl: "https://command-selection.fixture.invalid/v1",
        }));
        createSessionModelCatalogFixture().publish({
          config: cfg,
          agentId: "main",
          catalog: { entries: rows, routeVariants: rows },
          profiles: {
            "custom:fixture": { type: "api_key", provider: "custom", key: "synthetic-credential" },
          },
          plugins: metadataSnapshot.plugins,
        });
        const savedSelection = structuredClone(sessionEntry.executionSelection);
        vi.mocked(ensureSelectedAgentHarnessPlugin).mockClear();
        const selection = resolveEmbeddedModelSelection({
          cfg,
          opts: {
            message: "hello",
            ...(fixture.use === "explicit"
              ? { model: "custom/latest", allowModelOverride: true }
              : {}),
          },
          sessionEntry,
          sessionStore: { [sessionKey]: sessionEntry },
          sessionKey,
          sessionId: sessionEntry.sessionId,
          storePath: path.join(stateDir, "sessions.json"),
          sessionAgentId: "main",
          workspaceDir: stateDir,
          pluginsEnabled: false,
          modelManifestContext: { manifestPlugins: metadataSnapshot.plugins },
          configuredThinkingCatalog: [],
          isSubagentLane: false,
          suppressVisibleSessionEffects: false,
          runContext: { messageChannel: "internal" },
        });
        if (fixture.rejects) {
          await expect(selection).rejects.toThrow("This model is not available for this agent");
          expect(ensureSelectedAgentHarnessPlugin).not.toHaveBeenCalled();
          expect(sessionEntry.executionSelection).toEqual(savedSelection);
        } else {
          expect(await selection).toMatchObject({ provider: "custom", model: fixture.expected });
        }
      },
    );
  });
});
