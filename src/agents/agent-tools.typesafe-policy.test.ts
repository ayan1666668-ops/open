import { afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareDecisionProviderReload } from "../decisions/runtime.js";
import type { DecisionProviderV1, ProviderDecisionOutcome } from "../decisions/types.js";
import { DecisionContractError } from "../decisions/validation.js";
import { createPluginRuntimeMock } from "../plugin-sdk/test-helpers/plugin-runtime-mock.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { runPluginRegisterSyncInRegistry } from "../plugins/loader-module-runtime.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { createTestPluginRegistry } from "../plugins/registry-runtime.test-helpers.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import type { OpenClawPluginDefinition } from "../plugins/types.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import {
  runBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "./agent-tools.before-tool-call.js";

let typesafe: OpenClawPluginDefinition;
beforeAll(async () => {
  ({ default: typesafe } = await loadBundledPluginFacade<{ default: OpenClawPluginDefinition }>({
    pluginId: "typesafe",
    artifactBasename: "index.js",
  }));
});

const selectedAgents: OpenClawConfig["agents"] = {
  defaults: { decisionModel: "fixture/default" },
};
const args = { command: "show synthetic fixture" };
const lowRisk = {
  status: "ok",
  result: {
    model: "default",
    answers: {
      exfiltration: { type: "boolean", probabilityTrue: 0.01 },
      destruction: { type: "boolean", probabilityTrue: 0.01 },
      security_bypass: { type: "boolean", probabilityTrue: 0.01 },
      needs_review: { type: "boolean", probabilityTrue: 0.01 },
    },
  },
} satisfies ProviderDecisionOutcome;

function fixture(options: {
  enabled?: boolean;
  agents?: OpenClawConfig["agents"];
  evaluate?: DecisionProviderV1["evaluate"];
}) {
  const pluginConfig =
    options.enabled === undefined ? {} : { toolSafety: { enabled: options.enabled } };
  const config: OpenClawConfig = {
    agents: options.agents,
    plugins: { entries: { typesafe: { enabled: true, config: pluginConfig } } },
  };
  setRuntimeConfigSnapshot(config);
  // Only unrelated runtime surfaces are doubles. createApi supplies the real,
  // lifecycle-bound Decision runtime; the registered provider controls outcomes.
  const builder = createTestPluginRegistry(
    createPluginRuntimeMock({ config: { current: () => config } }),
  );
  const records = [
    createPluginRecord({
      id: "typesafe",
      source: "/synthetic/typesafe/index.ts",
      origin: "global",
      enabled: true,
      activationState: {
        enabled: true,
        activated: true,
        explicitlyEnabled: true,
        source: "explicit",
      },
      configSchema: true,
      contracts: { decisionProviders: ["typesafe"], trustedToolPolicies: ["tool-safety"] },
    }),
    createPluginRecord({
      id: "fixture",
      source: "/synthetic/fixture/index.ts",
      origin: "global",
      enabled: true,
      configSchema: false,
      contracts: { decisionProviders: ["fixture"] },
    }),
  ];
  const [policyOwner, providerOwner] = records;
  const api = builder.createApi(policyOwner!, { config, pluginConfig });
  runPluginRegisterSyncInRegistry(typesafe.register!, api, builder.registry, policyOwner!.id);
  const provider = vi.fn<DecisionProviderV1["evaluate"]>(options.evaluate ?? (async () => lowRisk));
  const providerApi = builder.createApi(providerOwner!, { config });
  runPluginRegisterSyncInRegistry(
    (registration) =>
      registration.registerDecisionProvider({
        id: "fixture",
        contractVersion: 1,
        evaluate: provider,
      }),
    providerApi,
    builder.registry,
    providerOwner!.id,
  );
  builder.registry.plugins.push(...records);
  setActivePluginRegistry(builder.registry);
  initializeGlobalHookRunner(builder.registry);
  onTestFinished(async () => {
    prepareDecisionProviderReload(builder.registry, new Set(records.map((record) => record.id)));
    for (const record of records) {
      await getPluginInstance(record)?.dispose();
    }
  });
  const execute = vi.fn(async () => ({
    content: [{ type: "text" as const, text: "executed" }],
    details: {},
  }));
  const ctx = { agentId: "research", config };
  const wrapped = wrapToolWithBeforeToolCallHook(
    {
      name: "fixture_tool",
      label: "Fixture",
      description: "In-memory counter only",
      parameters: { type: "object", properties: { command: { type: "string" } } },
      execute,
    },
    ctx,
    { emitDiagnostics: false, approvalMode: "report" },
  );
  return {
    registry: builder.registry,
    provider,
    execute,
    run: (params = args, signal = new AbortController().signal) =>
      wrapped.execute("fixture-call", params, signal),
    // Inspect the actual deferred payload without dispatching an approval or
    // waiting on a Gateway. The wrapper above independently prevents execution.
    prepare: (params = args) =>
      runBeforeToolCallHook({
        toolName: "fixture_tool",
        params,
        ctx,
        signal: new AbortController().signal,
        approvalMode: "defer",
      }),
  };
}

afterEach(() => {
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
  clearRuntimeConfigSnapshot();
});

describe("TypeSafe registered policy with the host Decision runtime", () => {
  it.each([undefined, false])(
    "keeps toolSafety.enabled=%s network- and approval-free",
    async (enabled) => {
      const host = fixture({ enabled, agents: selectedAgents });
      expect(host.registry.trustedToolPolicies).toHaveLength(0);
      expect(await host.prepare()).toEqual({ blocked: false, params: args });
      await expect(host.run()).resolves.toMatchObject({ content: [{ text: "executed" }] });
      expect(host.provider).not.toHaveBeenCalled();
      expect(host.execute).toHaveBeenCalledOnce();
    },
  );

  it("dispatches a selected provider and continues a low-risk call", async () => {
    const host = fixture({ enabled: true, agents: selectedAgents });
    await expect(host.run()).resolves.toMatchObject({ content: [{ text: "executed" }] });
    expect(host.provider).toHaveBeenCalledOnce();
    expect(host.provider.mock.calls[0]?.[1]).toMatchObject({
      model: "default",
      agentId: "research",
    });
    expect(host.execute).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "absent default", agents: undefined },
    { name: "empty default", agents: { defaults: { decisionModel: "" } } },
    {
      name: "empty owning-agent override",
      agents: { ...selectedAgents, entries: { research: { decisionModel: "" } } },
    },
  ])("requires review for $name without contacting a provider", async ({ agents }) => {
    const host = fixture({ enabled: true, agents });
    const prepared = await host.prepare();
    expect(prepared).toMatchObject({
      blocked: false,
      deferredApproval: {
        approval: { pluginId: "typesafe", allowedDecisions: ["allow-once", "deny"] },
      },
    });
    if (prepared.blocked || !prepared.deferredApproval) {
      throw new Error("Expected review before tool execution");
    }
    expect(prepared.deferredApproval.approval.description).toContain("unavailable (disabled)");
    expect(prepared.deferredApproval.approval.description).toContain(JSON.stringify(args));
    await expect(host.run()).rejects.toThrow("unavailable (disabled)");
    expect(host.provider).not.toHaveBeenCalled();
    expect(host.execute).not.toHaveBeenCalled();
  });

  it("blocks unreviewable evidence instead of deferring a truncated approval", async () => {
    const host = fixture({ enabled: true });
    const oversized = { command: "x".repeat(512) };
    expect(await host.prepare(oversized)).toMatchObject({
      blocked: true,
      reason: expect.stringContaining("approval display limit"),
    });
    await expect(host.run(oversized)).resolves.toMatchObject({
      details: { status: "blocked", reason: expect.stringContaining("approval display limit") },
    });
    expect(host.provider).not.toHaveBeenCalled();
    expect(host.execute).not.toHaveBeenCalled();
  });

  it("turns typed provider unavailability into review", async () => {
    const host = fixture({
      enabled: true,
      agents: selectedAgents,
      evaluate: async () => ({ status: "unavailable", reason: "transport" }),
    });
    expect(await host.prepare()).toMatchObject({
      deferredApproval: {
        approval: { description: expect.stringContaining("unavailable (transport)") },
      },
    });
    await expect(host.run()).rejects.toThrow("unavailable (transport)");
    expect(host.provider).toHaveBeenCalledTimes(2);
    expect(host.execute).not.toHaveBeenCalled();
  });

  it.each(["throw", "abort"] as const)(
    "preserves %s rejection and the host vetoes without review",
    async (failure) => {
      let controller = new AbortController();
      const abortReason = new Error("fixture caller cancelled");
      const host = fixture({
        enabled: true,
        agents: selectedAgents,
        evaluate: async () => {
          if (failure === "abort") {
            controller.abort(abortReason);
            return lowRisk;
          }
          throw new Error("unexpected provider failure");
        },
      });
      const policy = host.registry.trustedToolPolicies[0]!.policy;
      const evaluation = policy.evaluate(
        { toolName: "fixture_tool", params: args },
        { toolName: "fixture_tool", agentId: "research", abortSignal: controller.signal },
      );
      if (failure === "abort") {
        await expect(evaluation).rejects.toBe(abortReason);
      } else {
        await expect(evaluation).rejects.toBeInstanceOf(DecisionContractError);
      }
      controller = new AbortController();
      await expect(host.run(args, controller.signal)).resolves.toMatchObject({
        details: {
          status: "blocked",
          deniedReason: "plugin-before-tool-call",
          reason: expect.stringContaining("policy evaluation failed"),
        },
      });
      expect(host.provider).toHaveBeenCalledTimes(2);
      expect(host.execute).not.toHaveBeenCalled();
    },
  );
});
