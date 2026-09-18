import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getActivePluginRegistryVersion } from "../../plugins/runtime.js";
import {
  TURN_MODEL_DEFAULT_REF,
  TURN_MODEL_DIFFERENTIAL_FIXTURES,
  TURN_MODEL_OVERRIDE_REF,
  turnModelRefLabel,
  turnModelVerdict,
  type TurnModelDifferentialFixture,
} from "../../test-utils/turn-model-selection-differential.js";
import type { AgentCommandOpts, AgentRunContext } from "./types.js";

vi.mock("../../auto-reply/thinking.js", () => ({
  formatThinkingLevels: () => "",
  normalizeThinkLevel: (value: string | undefined) => value,
}));

vi.mock("../auth-profiles/order.js", () => ({
  isStoredCredentialCompatibleWithAuthProvider: () => true,
}));
vi.mock("../auth-profiles/session-override.js", () => ({
  clearSessionAuthProfileOverride: vi.fn(async () => undefined),
}));
vi.mock("../harness/runtime-plugin.js", () => ({
  ensureSelectedAgentHarnessPlugin: vi.fn(async () => undefined),
}));
vi.mock("../model-catalog.js", () => ({ loadManifestModelCatalog: () => [] }));
vi.mock("../model-runtime-choice.js", () => ({
  evaluatePublishedModelRuntimeChoice: async ({
    provider,
    model,
    runtimeId,
  }: {
    provider: string;
    model: string;
    runtimeId: string;
  }) => {
    const declared = TURN_MODEL_DIFFERENTIAL_FIXTURES.some((fixture) =>
      Object.values(fixture.expected).some(
        (ref) => ref.provider === provider && ref.model === model,
      ),
    );
    if (!declared || runtimeId !== "openclaw") {
      return { kind: "unknown", message: "Undeclared fixture selection." };
    }
    const generation = getActivePluginRegistryVersion();
    return {
      kind: "ready",
      entry: { provider, id: model, name: model },
      validate: () =>
        generation === getActivePluginRegistryVersion() ? undefined : "Fixture catalog changed.",
    };
  },
}));
vi.mock("../model-selection.js", () => ({
  modelKey: (provider: string, model: string) => `${provider}/${model}`,
  resolveDefaultModelForAgent: ({ cfg }: { cfg: OpenClawConfig }) => {
    const configured = cfg.agents?.defaults?.model;
    const raw =
      typeof configured === "string"
        ? configured
        : (configured?.primary ?? turnModelRefLabel(TURN_MODEL_DEFAULT_REF));
    const slash = raw.indexOf("/");
    return slash > 0
      ? { provider: raw.slice(0, slash), model: raw.slice(slash + 1) }
      : { provider: TURN_MODEL_DEFAULT_REF.provider, model: raw };
  },
  resolveModelAliasFromPair: () => null,
}));
vi.mock("../model-thinking-default.js", () => ({
  resolveConfiguredThinkingDefault: () => undefined,
  resolveThinkingSelection: () => ({ requestedLevel: "off", level: "off", supported: true }),
}));
vi.mock("../openai-routing.js", () => ({
  listOpenAIAuthProfileProvidersForAgentRuntime: ({ provider }: { provider: string }) => [provider],
}));
vi.mock("../provider-auth-aliases.js", () => ({
  resolveProviderIdForAuth: (provider: string) => provider,
}));
vi.mock("../thinking-runtime.js", () => ({
  needsThinkHydration: () => false,
  normalizeThinkingCatalogProviders: (catalog: unknown) => catalog,
}));
vi.mock("./attempt-execution.shared.js", () => ({
  persistAgentSession: async ({ entry }: { entry?: SessionEntry }) => entry,
}));
vi.mock("./model-ref.js", () => ({
  normalizeAgentCommandModelRef: (_cfg: OpenClawConfig, provider: string, model: string) => ({
    provider,
    model,
  }),
  parseAgentCommandModelRef: (
    _cfg: OpenClawConfig,
    _agentId: string,
    raw: string,
    defaultProvider: string,
  ) => {
    const slash = raw.indexOf("/");
    return slash > 0
      ? { provider: raw.slice(0, slash), model: raw.slice(slash + 1) }
      : { provider: defaultProvider, model: raw };
  },
}));
vi.mock("./prepare.js", () => ({
  normalizeExplicitOverrideInput: (value: string) => value.trim() || undefined,
}));
vi.mock("./runtime-loaders.js", () => ({
  loadTranscriptResolveRuntime: async () => ({
    resolveSessionTranscriptFile: async (params: { sessionEntry?: SessionEntry }) => ({
      sessionEntry: params.sessionEntry,
      sessionFile: "/tmp/turn-model-session.jsonl",
    }),
  }),
}));

const { resolveEmbeddedModelSelection } = await import("./model-selection.js");

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
let suiteTempRoot = "";

beforeAll(() => {
  suiteTempRoot = tempDirs.make("turn-model-command-");
});

function createConfig(fixture: TurnModelDifferentialFixture): OpenClawConfig {
  return {
    agents: { defaults: { model: { primary: turnModelRefLabel(TURN_MODEL_DEFAULT_REF) } } },
    channels: fixture.modelByChannel ? { modelByChannel: fixture.modelByChannel } : undefined,
  } as OpenClawConfig;
}

async function observeCommandSelection(fixture: TurnModelDifferentialFixture) {
  const fixtureIndex = TURN_MODEL_DIFFERENTIAL_FIXTURES.indexOf(fixture);
  const sessionKey = "agent:main:telegram:group:selection";
  const sessionStore: Record<string, SessionEntry> = { [sessionKey]: fixture.child };
  if (fixture.parent) {
    sessionStore[fixture.parent.key] = fixture.parent.entry;
  }
  const opts: AgentCommandOpts = {
    message: "hello",
    to: "target",
    channel: fixture.ctx.Provider,
    messageChannel: fixture.ctx.Provider,
    groupId: fixture.child.groupId,
    groupChannel: fixture.child.groupChannel,
    ...(fixture.heartbeat
      ? {
          provider: TURN_MODEL_OVERRIDE_REF.provider,
          model: TURN_MODEL_OVERRIDE_REF.model,
          allowModelOverride: true,
        }
      : {}),
  };
  const runContext: AgentRunContext = {
    messageChannel: fixture.ctx.Provider,
    groupId: fixture.child.groupId,
    groupChannel: fixture.child.groupChannel,
    currentChannelId: "target",
  };
  const selection = await resolveEmbeddedModelSelection({
    cfg: createConfig(fixture),
    opts,
    sessionEntry: fixture.child,
    sessionStore,
    sessionKey,
    sessionId: fixture.child.sessionId,
    storePath: path.join(suiteTempRoot, `sessions-${fixtureIndex}.json`),
    sessionAgentId: "main",
    workspaceDir: suiteTempRoot,
    pluginsEnabled: false,
    modelManifestContext: { manifestPlugins: [] },
    configuredThinkingCatalog: [],
    isSubagentLane: false,
    suppressVisibleSessionEffects: true,
    runContext,
  });
  return turnModelVerdict(
    { provider: selection.provider, model: selection.model },
    fixture.locked ? "locked" : fixture.heartbeat ? "explicit" : undefined,
  );
}

describe("turn model selection command-path differential", () => {
  it.each(TURN_MODEL_DIFFERENTIAL_FIXTURES)("pins observed $name behavior", async (fixture) => {
    await expect(observeCommandSelection(fixture)).resolves.toEqual(fixture.expected.command);
  });
});
