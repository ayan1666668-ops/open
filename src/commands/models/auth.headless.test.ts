import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { ProviderPlugin } from "../../plugins/types.js";
import type { RuntimeEnv } from "../../runtime.js";

const mocks = vi.hoisted(() => ({
  resolvePluginProvidersCore: vi.fn(),
  loadValidConfigSnapshotOrThrow: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
  resolveDefaultAgentWorkspaceDir: vi.fn(),
  resolveAgentDir: vi.fn(),
  resolveDefaultAgentId: vi.fn(),
  isCliProvider: vi.fn(),
  normalizeAgentModelRefForConfig: vi.fn(),
  createClackPrompter: vi.fn(),
  tryImportProviderCredential: vi.fn(),
  updateConfig: vi.fn(),
  persistProviderAuthProfilesAfterLogin: vi.fn(),
  promoteAuthProfileInOrder: vi.fn(),
  refreshRunningGatewayAuthState: vi.fn(),
}));

vi.mock("../../plugins/providers.runtime.js", () => ({
  resolvePluginProvidersCore: mocks.resolvePluginProvidersCore,
}));
vi.mock("../../config/logging.js", () => ({ logConfigUpdated: vi.fn() }));
vi.mock("../../config/model-input.js", () => ({
  normalizeAgentModelRefForConfig: mocks.normalizeAgentModelRefForConfig,
}));
vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
  resolveDefaultAgentId: mocks.resolveDefaultAgentId,
  resolveAgentDir: mocks.resolveAgentDir,
}));
vi.mock("../../agents/workspace.js", () => ({
  resolveDefaultAgentWorkspaceDir: mocks.resolveDefaultAgentWorkspaceDir,
}));
vi.mock("../../agents/model-selection-cli.js", () => ({ isCliProvider: mocks.isCliProvider }));
vi.mock("../../agents/auth-profiles/profiles.js", () => ({
  promoteAuthProfileInOrder: mocks.promoteAuthProfileInOrder,
  upsertAuthProfileWithLockOrThrow: vi.fn(),
  removeProviderAuthProfilesWithLock: vi.fn(),
}));
vi.mock("../../plugins/provider-auth-persistence.js", () => ({
  persistProviderAuthProfilesAfterLogin: mocks.persistProviderAuthProfilesAfterLogin,
}));
vi.mock("../../plugins/provider-auth-helpers.js", () => ({
  applyAuthProfileConfig: (config: OpenClawConfig) => config,
}));
vi.mock("../../plugins/setup-registry.js", () => ({
  resolvePluginSetupProviderCore: vi.fn(),
  resolvePluginSetupRegistry: vi.fn(() => ({
    providers: [],
    cliBackends: [],
    configMigrations: [],
    autoEnableProbes: [],
    diagnostics: [],
  })),
}));
vi.mock("../../wizard/clack-prompter.js", () => ({
  createClackPrompter: mocks.createClackPrompter,
}));
vi.mock("../auth-token.js", () => ({ validateAnthropicSetupToken: vi.fn() }));
vi.mock("./auth-credential-import.js", () => ({
  tryImportProviderCredential: mocks.tryImportProviderCredential,
}));
vi.mock("./shared.js", () => ({
  loadValidConfigSnapshotOrThrow: mocks.loadValidConfigSnapshotOrThrow,
  resolveModelsTargetAgent: vi.fn(() => ({
    agentId: "main",
    agentDir: "/tmp/openclaw/agents/main",
  })),
  updateConfig: mocks.updateConfig,
}));
vi.mock("./auth-refresh.js", () => ({
  refreshRunningGatewayAuthState: mocks.refreshRunningGatewayAuthState,
}));
vi.mock("../../infra/browser-open.js", () => ({ openUrl: vi.fn() }));
vi.mock("../../infra/remote-env.js", () => ({ isRemoteEnvironment: vi.fn(() => false) }));
vi.mock("../../gateway/call.js", () => ({
  callGateway: vi.fn(),
  isImplicitLocalGatewayTarget: vi.fn(() => Promise.resolve(true)),
  GatewayLocalBackendSharedAuthUnavailableError: class extends Error {},
  isGatewayClientRequestError: vi.fn(() => false),
}));
vi.mock("@clack/prompts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@clack/prompts")>()),
  cancel: vi.fn(),
  confirm: vi.fn(),
  password: vi.fn(),
  select: vi.fn(),
  text: vi.fn(),
}));

const { modelsAuthLoginCommand, runModelsAuthLoginFlowCore, runModelsAuthLoginFlowForGateway } =
  await import("./auth.js");

function createRuntime(): RuntimeEnv {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
}

function withPipedStdin(input: string) {
  const stdin = process.stdin as NodeJS.ReadStream & { isTTY?: boolean };
  const previousTTY = Object.getOwnPropertyDescriptor(stdin, "isTTY");
  const previousIterator = Object.getOwnPropertyDescriptor(stdin, Symbol.asyncIterator);
  Object.defineProperty(stdin, "isTTY", { configurable: true, get: () => false });
  Object.defineProperty(stdin, Symbol.asyncIterator, {
    configurable: true,
    async *value() {
      yield input;
    },
  });
  return () => {
    if (previousTTY) {
      Object.defineProperty(stdin, "isTTY", previousTTY);
    } else {
      Reflect.deleteProperty(stdin, "isTTY");
    }
    if (previousIterator) {
      Object.defineProperty(stdin, Symbol.asyncIterator, previousIterator);
    } else {
      Reflect.deleteProperty(stdin, Symbol.asyncIterator);
    }
  };
}

function createProvider(params: { auth: ProviderPlugin["auth"] }): ProviderPlugin {
  return { id: "openai", label: "OpenAI", auth: params.auth };
}

function createAuthResult() {
  return {
    profiles: [
      {
        profileId: "openai:test",
        credential: {
          type: "oauth" as const,
          provider: "openai",
          access: "synthetic-access",
          refresh: "synthetic-refresh",
          expires: Date.now() + 60_000,
        },
      },
    ],
  };
}

describe("headless model auth admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveAgentWorkspaceDir.mockReturnValue("/tmp/openclaw/workspace");
    mocks.resolveDefaultAgentWorkspaceDir.mockReturnValue("/tmp/openclaw/workspace");
    mocks.resolveAgentDir.mockReturnValue("/tmp/openclaw/agents/main");
    mocks.resolveDefaultAgentId.mockReturnValue("main");
    mocks.isCliProvider.mockReturnValue(false);
    mocks.normalizeAgentModelRefForConfig.mockImplementation((value) => value);
    mocks.loadValidConfigSnapshotOrThrow.mockResolvedValue({ sourceConfig: {}, runtimeConfig: {} });
    mocks.createClackPrompter.mockReturnValue({ note: vi.fn(), select: vi.fn() });
    mocks.promoteAuthProfileInOrder.mockResolvedValue({ ok: true, value: {} });
    mocks.persistProviderAuthProfilesAfterLogin.mockImplementation(
      async (params) => params.profiles ?? [],
    );
    mocks.refreshRunningGatewayAuthState.mockResolvedValue({ refreshed: true });
    mocks.tryImportProviderCredential.mockResolvedValue(undefined);
  });

  it("allows an explicitly selected provider-owned headless auth method without a TTY", async () => {
    const restore = withPipedStdin("");
    try {
      const run = vi.fn().mockResolvedValue(createAuthResult());
      mocks.resolvePluginProvidersCore.mockReturnValue([
        createProvider({
          auth: [
            { id: "device-code", label: "Device code", kind: "device_code", headless: true, run },
          ],
        }),
      ]);
      await modelsAuthLoginCommand({ provider: "openai", method: "device-code" }, createRuntime());
      expect(run).toHaveBeenCalledOnce();
    } finally {
      restore();
    }
  });

  it("keeps non-headless auth methods gated when stdin is piped", async () => {
    const restore = withPipedStdin("");
    try {
      const run = vi.fn().mockResolvedValue(createAuthResult());
      mocks.resolvePluginProvidersCore.mockReturnValue([
        createProvider({
          auth: [{ id: "device-code", label: "Device code", kind: "device_code", run }],
        }),
      ]);
      await expect(
        modelsAuthLoginCommand({ provider: "openai", method: "device-code" }, createRuntime()),
      ).rejects.toThrow("requires an interactive TTY");
      expect(run).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("rejects a provider selection before opening a picker without a TTY", async () => {
    const restore = withPipedStdin("");
    try {
      const select = vi.fn();
      mocks.createClackPrompter.mockReturnValue({ note: vi.fn(), select });
      mocks.resolvePluginProvidersCore.mockReturnValue([
        createProvider({
          auth: [
            {
              id: "device-code",
              label: "Device code",
              kind: "device_code",
              headless: true,
              run: vi.fn(),
            },
          ],
        }),
      ]);
      await expect(modelsAuthLoginCommand({}, createRuntime())).rejects.toThrow(
        "--provider is missing",
      );
      expect(select).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("rejects an ambiguous method selection before opening a picker without a TTY", async () => {
    const restore = withPipedStdin("");
    try {
      const select = vi.fn();
      mocks.createClackPrompter.mockReturnValue({ note: vi.fn(), select });
      mocks.resolvePluginProvidersCore.mockReturnValue([
        createProvider({
          auth: [
            { id: "first", label: "First", kind: "custom", headless: true, run: vi.fn() },
            { id: "second", label: "Second", kind: "custom", headless: true, run: vi.fn() },
          ],
        }),
      ]);
      await expect(modelsAuthLoginCommand({ provider: "openai" }, createRuntime())).rejects.toThrow(
        "requires --method",
      );
      expect(select).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it.each(["fresh", "imported"])(
    "keeps existing model restrictions without prompting after %s credentials",
    async (credentialSource) => {
      const restore = withPipedStdin("");
      try {
        const select = vi.fn();
        const runtime = createRuntime();
        const run = vi.fn().mockResolvedValue(createAuthResult());
        mocks.createClackPrompter.mockReturnValue({ note: vi.fn(), select });
        mocks.loadValidConfigSnapshotOrThrow.mockResolvedValue({
          sourceConfig: {},
          runtimeConfig: {
            agents: { defaults: { modelPolicy: { allow: ["other/current"] } } },
          },
        });
        const credentialImport = {
          migrationProviderId: "codex",
          itemId: "auth:openai",
          credentialKind: "oauth" as const,
        };
        mocks.resolvePluginProvidersCore.mockReturnValue([
          createProvider({
            auth: [
              {
                id: "device-code",
                label: "Device code",
                kind: "device_code",
                headless: true,
                credentialImport,
                run,
              },
            ],
          }),
        ]);
        if (credentialSource === "imported") {
          mocks.tryImportProviderCredential.mockResolvedValue({
            profileId: "openai:imported",
            provider: "openai",
            mode: "oauth",
            configUpdated: false,
          });
        }

        await modelsAuthLoginCommand({ provider: "openai", method: "device-code" }, runtime);

        expect(select).not.toHaveBeenCalled();
        expect(mocks.updateConfig).not.toHaveBeenCalled();
        expect(runtime.log).toHaveBeenCalledWith("Current model restrictions kept.");
        expect(run).toHaveBeenCalledTimes(credentialSource === "fresh" ? 1 : 0);
      } finally {
        restore();
      }
    },
  );

  it.each([
    ["core", runModelsAuthLoginFlowCore],
    ["Gateway", runModelsAuthLoginFlowForGateway],
  ])("keeps %s-hosted auth available without a TTY", async (_name, runHostedFlow) => {
    const restore = withPipedStdin("");
    try {
      const run = vi.fn().mockResolvedValue(createAuthResult());
      mocks.resolvePluginProvidersCore.mockReturnValue([
        createProvider({
          auth: [{ id: "oauth", label: "OAuth", kind: "oauth", run }],
        }),
      ]);
      await runHostedFlow({
        provider: "openai",
        method: "oauth",
        config: {},
        runtime: createRuntime(),
        prompter: mocks.createClackPrompter(),
      });
      expect(run).toHaveBeenCalledOnce();
    } finally {
      restore();
    }
  });
});
