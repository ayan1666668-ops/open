import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CliBackendPlugin } from "../../plugins/cli-backend.types.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import {
  createCliRunnerPrepareFixture,
  createTestMcpLoopbackClientGrant,
  createTestMcpLoopbackServerConfig,
} from "../cli-runner.test-helpers.js";
import { prepareCliRunContext } from "./prepare.js";
import {
  resetCliRunnerPrepareTestDeps,
  setCliRunnerPrepareTestDeps,
} from "./prepare.test-support.js";

const { buildAnthropicCliBackend } = await loadBundledPluginFacade<{
  buildAnthropicCliBackend: () => CliBackendPlugin;
}>({ pluginId: "anthropic", artifactBasename: "api.js" });

const searchTool = {
  name: "web_search",
  label: "Search",
  description: "Search",
  parameters: { type: "object", properties: {} },
  execute: vi.fn(),
};
const messageTool = { ...searchTool, name: "message", label: "Message" };
let fixture: ReturnType<typeof createCliRunnerPrepareFixture>;
const captureNativeToolAuthority = vi.fn((_tools: readonly string[] | null) => true);
const mintMcpLoopbackClientGrant = vi.fn(createTestMcpLoopbackClientGrant);

beforeEach(() => {
  vi.clearAllMocks();
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupCliBackend: () => undefined,
    resolveRuntimeCliBackends: () => [{ ...buildAnthropicCliBackend(), pluginId: "anthropic" }],
  });
  setCliRunnerPrepareTestDeps({
    isWorkspaceBootstrapPending: async () => false,
    makeBootstrapWarn: () => () => undefined,
    resolveBootstrapContextForRun: async () => ({ bootstrapFiles: [], contextFiles: [] }),
    getActiveMcpLoopbackRuntime: () => ({
      port: 31783,
      ownerToken: "fixture-owner",
      nonOwnerToken: "fixture-reader",
    }),
    createMcpLoopbackServerConfig: createTestMcpLoopbackServerConfig,
    mintMcpLoopbackClientGrant,
    bindMcpLoopbackClientGrantAdmission: () => true,
    revokeMcpLoopbackClientGrant: () => true,
    activateMcpLoopbackClientGrantCapture: () => ({ captureNativeToolAuthority }),
    resolveMcpLoopbackPolicyTools: () => ({ agentId: "main", tools: [searchTool, messageTool] }),
    resolveMcpLoopbackScopedTools: ({ cfg }: { cfg: OpenClawConfig }) => ({
      agentId: "main",
      tools: cfg.tools?.web?.search?.enabled === false ? [messageTool] : [searchTool, messageTool],
    }),
    resolveOpenClawReferencePaths: async () => ({ docsPath: null, sourcePath: null }),
    prepareClaudeCliSkillsPlugin: async () => ({ args: [], cleanup: async () => {} }),
    getCliLiveSessionGeneration: () => undefined,
    loadManifestModelCatalog: () => [],
  });
  fixture = createCliRunnerPrepareFixture((params) =>
    prepareCliRunContext({ skillsSnapshot: { prompt: "", skills: [] }, ...params }),
  );
});
afterEach(async () => {
  resetCliRunnerPrepareTestDeps();
  cliBackendsTesting.resetDepsForTest();
  await fixture.cleanup();
});

describe("registered Claude CLI search preparation", () => {
  it.each([
    { name: "automatic", config: {}, native: true, sessionSearch: true, managed: true },
    {
      name: "pinned provider",
      config: { tools: { web: { search: { provider: "brave" } } } },
      native: false,
      sessionSearch: true,
      managed: true,
    },
    {
      name: "global off with stale session enable",
      config: { tools: { web: { search: { enabled: false } } } },
      native: false,
      sessionSearch: true,
      managed: false,
    },
    { name: "session off", config: {}, native: false, sessionSearch: false, managed: false },
    {
      name: "session off overrides an explicit tool allowlist",
      config: {},
      native: false,
      sessionSearch: false,
      managed: false,
      openClaw: ["web_search", "message"],
    },
  ] satisfies Array<{
    name: string;
    config: OpenClawConfig;
    native: boolean;
    sessionSearch: boolean;
    managed: boolean;
    openClaw?: string[];
  }>)(
    "keeps native authority consistent with $name",
    async ({ config, native, sessionSearch, managed, openClaw }) => {
      const context = await fixture.prepare({
        provider: "claude-cli",
        config,
        toolOverrides: { webSearch: sessionSearch },
        model: "fixture-model",
        ...(openClaw ? { cliToolAvailability: { native: ["Read", "WebSearch"], openClaw } } : {}),
      });
      try {
        const capture = context.preparedBackend.mcpClientGrantCapture;
        expect(capture).toBeDefined();
        capture!.activate("fixture-capture", () => {});
        capture!.captureNativeTools?.(["Read", "WebSearch"]);
        expect(captureNativeToolAuthority).toHaveBeenLastCalledWith(
          native ? ["read", "web_search"] : ["read"],
        );
        const argv = context.preparedBackend.backend.args ?? [];
        const denied = argv[argv.indexOf("--disallowedTools") + 1] ?? "";
        expect(denied.split(",").includes("WebSearch")).toBe(!native);
        expect
          .soft(context.systemPromptReport.tools.entries.some((tool) => tool.name === "web_search"))
          .toBe(managed);
        expect(
          context.systemPromptReport.tools.entries.some((tool) => tool.name === "message"),
        ).toBe(true);
        if (!sessionSearch) {
          expect(mintMcpLoopbackClientGrant.mock.calls[0]?.[0]?.context.toolsAllow).toEqual([
            "message",
          ]);
        }
      } finally {
        await context.preparedBackend.cleanup?.();
      }
    },
  );
});
