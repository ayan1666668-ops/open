import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizePreparedModelRuntimeInput, ownerKey } from "./prepared-model-runtime.owner.js";

// Reproduces #153313: the system agent pins a runtime for the shared model while the
// requesting agent inherits the default without a pin. Resolving the selection under
// the wrong scope flips the runtime between normalizations.
const config = {
  agents: {
    ownership: "explicit",
    defaults: {
      model: "xai/grok-4.6",
      models: { "xai/grok-4.6": {} },
      systemAgent: { agentId: "main" },
    },
    entries: {
      main: { models: { "xai/grok-4.6": { agentRuntime: { id: "openclaw" } } } },
      pilot: {},
    },
  },
} satisfies OpenClawConfig;

describe("normalizePreparedModelRuntimeInput", () => {
  it("resolves the selection runtime under the input agent's scope", () => {
    const normalized = normalizePreparedModelRuntimeInput({
      agentId: "pilot",
      agentDir: "/tmp/agents/pilot",
      config,
      runtimePluginSelections: [
        { provider: "xai", modelId: "grok-4.6", runtime: "auto", agentId: "pilot" },
      ],
    });

    // `pilot` has no pin, so its selection stays unresolved instead of borrowing `main`'s.
    expect(normalized.runtimePluginSelections).toEqual([
      { provider: "xai", modelId: "grok-4.6", runtime: "auto" },
    ]);
  });

  it("is idempotent once the stored selection has dropped its agentId", () => {
    const once = normalizePreparedModelRuntimeInput({
      agentId: "pilot",
      agentDir: "/tmp/agents/pilot",
      config,
      runtimePluginSelections: [
        { provider: "xai", modelId: "grok-4.6", runtime: "auto", agentId: "pilot" },
      ],
    });
    const twice = normalizePreparedModelRuntimeInput(once);

    expect(twice.runtimePluginSelections).toEqual(once.runtimePluginSelections);
    expect(ownerKey(twice)).toBe(ownerKey(once));
  });

  it("keeps a pinned agent's resolved runtime stable across normalizations", () => {
    const once = normalizePreparedModelRuntimeInput({
      agentId: "main",
      agentDir: "/tmp/agents/main",
      config,
      runtimePluginSelections: [
        { provider: "xai", modelId: "grok-4.6", runtime: "auto", agentId: "main" },
      ],
    });

    expect(once.runtimePluginSelections).toEqual([
      { provider: "xai", modelId: "grok-4.6", runtime: "openclaw" },
    ]);
    expect(ownerKey(normalizePreparedModelRuntimeInput(once))).toBe(ownerKey(once));
  });
});
