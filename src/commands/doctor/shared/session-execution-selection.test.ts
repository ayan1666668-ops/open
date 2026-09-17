import { describe, expect, it } from "vitest";
import { migrateSessionExecutionSelection } from "./session-execution-selection.js";

const classifyExecutor = (id: string) => (id === "app-a" ? ("harness" as const) : undefined);

describe("Doctor execution selection conversion", () => {
  it("keeps an exact pinned model and account without using observed output", () => {
    const entry = {
      modelOverride: "provider-a/model-a",
      providerOverride: "provider-a",
      agentRuntimeOverride: "app-a",
      modelOverrideRouteResolution: "resolved",
      authProfileOverride: "account-a",
      authProfileOverrideSource: "user",
      model: "observed-model",
      agentHarnessId: "observed-app",
    };
    const result = migrateSessionExecutionSelection({ entry, classifyExecutor });
    expect(result.entry).toEqual({
      authProfileOverride: "account-a",
      authProfileOverrideSource: "user",
      model: "observed-model",
      agentHarnessId: "observed-app",
      executionSelection: {
        state: "accepted",
        fallbackPermission: "explicit",
        selection: {
          model: { provider: "provider-a", id: "provider-a/model-a" },
          executor: { kind: "harness", id: "app-a" },
        },
      },
    });
    expect(entry.modelOverride).toBe("provider-a/model-a");
  });

  it("preserves an unpinned override as a deferred request instead of replaying history", () => {
    const result = migrateSessionExecutionSelection({
      entry: { modelOverride: "model-a", providerOverride: "provider-a", agentHarnessId: "app-a" },
      classifyExecutor,
    });
    expect(result.entry.executionSelection).toEqual({
      state: "deferred",
      request: { model: { provider: "provider-a", id: "model-a" } },
      fallbackPermission: "explicit",
    });
  });

  it.each([undefined, "auto", "user", "default"])(
    "retains provider-only input and its %s source without choosing a model",
    (source) => {
      const result = migrateSessionExecutionSelection({
        entry: {
          providerOverride: "provider-later",
          modelOverrideSource: source,
          modelProvider: "observed-provider",
          model: "observed-model",
        },
        defaultProvider: "configured-provider",
        classifyExecutor,
      });
      expect(result.entry).toEqual({
        modelProvider: "observed-provider",
        model: "observed-model",
        executionSelection: {
          state: "deferred",
          request: {},
          fallbackPermission: source === "auto" || source === "default" ? "configured" : "explicit",
          legacyRequest: {
            provider: "provider-later",
            ...(source ? { source } : {}),
          },
        },
      });
      expect(migrateSessionExecutionSelection({ entry: result.entry, classifyExecutor })).toEqual({
        entry: result.entry,
        changed: false,
      });
    },
  );

  it.each([
    { entry: { agentRuntimeOverride: "app-a" }, runtime: "app-a" },
    { entry: { agentRuntimeOverride: "missing-app" }, runtime: "missing-app" },
    { entry: { modelSelectionLocked: true, agentHarnessId: "app-a" }, runtime: "app-a" },
  ])(
    "keeps provider-only intent separate from the $runtime executor request",
    ({ entry, runtime }) => {
      const result = migrateSessionExecutionSelection({
        entry: { ...entry, providerOverride: "provider-later" },
        defaultProvider: "configured-provider",
        classifyExecutor,
      });
      expect(result.entry.executionSelection).toEqual({
        state: "deferred",
        request: { runtime },
        fallbackPermission: "explicit",
        legacyRequest: { provider: "provider-later" },
      });
    },
  );

  it("retains the accepted ACP pair beside provider-only legacy input", () => {
    const result = migrateSessionExecutionSelection({
      entry: { providerOverride: "provider-later", modelOverrideSource: "user" },
      acp: { backend: "backend-a", agent: "agent-a", model: "accepted-model" },
      classifyExecutor,
    });
    expect(result.entry.executionSelection).toEqual({
      state: "accepted",
      selection: {
        model: { id: "accepted-model" },
        executor: { kind: "acp", backend: "backend-a", agent: "agent-a" },
      },
      fallbackPermission: "explicit",
      legacyRequest: { provider: "provider-later", source: "user" },
    });
  });

  it("recovers complete fallback-origin intent before classifying partial input", () => {
    const result = migrateSessionExecutionSelection({
      entry: {
        providerOverride: "provider-temporary",
        modelOverrideSource: "auto",
        modelOverrideFallbackOriginProvider: "provider-original",
        modelOverrideFallbackOriginModel: "model-original",
      },
      classifyExecutor,
    });
    expect(result.entry.executionSelection).toEqual({
      state: "deferred",
      request: { model: { provider: "provider-original", id: "model-original" } },
      fallbackPermission: "configured",
    });
  });

  it.each([
    { provider: undefined, model: "provider-a/model-a", expected: "model-a" },
    { provider: "provider-a", model: "provider-a/model-a", expected: "model-a" },
    { provider: "provider-a", model: "nested/model-a", expected: "nested/model-a" },
  ])("migrates raw model input $model under $provider", ({ provider, model, expected }) => {
    const result = migrateSessionExecutionSelection({
      entry: { modelOverride: model, providerOverride: provider },
      defaultProvider: "provider-default",
      classifyExecutor,
    });
    expect(result.entry.executionSelection).toEqual({
      state: "deferred",
      request: { model: { provider: "provider-a", id: expected } },
      fallbackPermission: "explicit",
    });
    expect(result.entry).not.toHaveProperty("modelOverride");
    expect(result.entry).not.toHaveProperty("providerOverride");
  });

  it("restores pre-fallback intent and drops only an automatic account pin", () => {
    for (const source of ["auto", "user-link"] as const) {
      const result = migrateSessionExecutionSelection({
        entry: {
          modelOverride: "fallback-model",
          providerOverride: "provider-b",
          modelOverrideSource: "auto",
          modelOverrideFallbackOriginProvider: "provider-a",
          modelOverrideFallbackOriginModel: "model-a",
          authProfileOverride: "account-b",
          authProfileOverrideSource: source,
        },
        classifyExecutor,
      });
      expect(result.entry.executionSelection).toEqual({
        state: "deferred",
        request: { model: { provider: "provider-a", id: "model-a" } },
        fallbackPermission: "configured",
      });
      expect(result.entry.authProfileOverride).toBe(source === "auto" ? undefined : "account-b");
    }
  });

  it("retains an unknown pin until its plugin can classify and prepare it", () => {
    const result = migrateSessionExecutionSelection({
      entry: {
        providerOverride: "provider-a",
        modelOverride: "model-a",
        agentRuntimeOverride: "missing-app",
      },
      classifyExecutor,
    });
    expect(result.entry.executionSelection).toEqual({
      state: "deferred",
      request: { model: { provider: "provider-a", id: "model-a" }, runtime: "missing-app" },
      fallbackPermission: "explicit",
    });
  });

  it("preserves the committed ACP pair while an older plugin's model change is pending", () => {
    const result = migrateSessionExecutionSelection({
      entry: { modelOverride: "next-model" },
      acp: { backend: "backend-a", agent: "agent-a", model: "old-model" },
      classifyExecutor,
    });
    expect(result.entry.executionSelection).toEqual({
      state: "deferred",
      fallbackPermission: "explicit",
      previous: {
        model: { id: "old-model" },
        executor: { kind: "acp", backend: "backend-a", agent: "agent-a" },
      },
      request: {
        model: { id: "next-model" },
        executor: { kind: "acp", backend: "backend-a", agent: "agent-a" },
      },
    });
  });

  it("does not replace a committed pair when retrying retained legacy sources", () => {
    const first = migrateSessionExecutionSelection({
      entry: {
        providerOverride: "provider-a",
        modelOverride: "model-a",
        agentRuntimeOverride: "app-a",
      },
      classifyExecutor,
    });
    const retry = migrateSessionExecutionSelection({ entry: first.entry, classifyExecutor });
    expect(retry).toEqual({ entry: first.entry, changed: false });
    expect(() =>
      migrateSessionExecutionSelection({
        entry: { executionSelection: { state: "accepted" }, modelOverride: "retained" },
        classifyExecutor,
      }),
    ).toThrow();
  });

  it("defers a locked native binding to its existing ownership reader", () => {
    const result = migrateSessionExecutionSelection({
      entry: {
        modelSelectionLocked: true,
        agentHarnessId: "app-a",
        modelOverride: "observed-model",
        providerOverride: "provider-a",
      },
      classifyExecutor,
    });
    expect(result.entry.executionSelection).toEqual({
      state: "deferred",
      request: { model: { provider: "provider-a", id: "observed-model" }, runtime: "app-a" },
      fallbackPermission: "explicit",
    });
    expect(result.entry.agentHarnessId).toBe("app-a");
  });

  it("preserves a provider-only rollback request instead of completing it from observations", () => {
    const result = migrateSessionExecutionSelection({
      entry: {
        modelOverride: "temporary",
        providerOverride: "provider-current",
        modelFallback: {
          source: "agent-patch",
          ts: 1,
          prevModel: "observed-model",
          prevProvider: "observed-provider",
          prevProviderOverride: "provider-later",
          prevModelOverrideSource: "user",
        },
      },
      classifyExecutor,
    });
    expect(result.entry.modelFallback).toEqual({
      source: "agent-patch",
      ts: 1,
      prevModel: "observed-model",
      prevProvider: "observed-provider",
      previous: {
        state: "deferred",
        request: {},
        fallbackPermission: "explicit",
        legacyRequest: { provider: "provider-later", source: "user" },
      },
    });
  });

  it("retains rollback observations without making them selection intent", () => {
    const result = migrateSessionExecutionSelection({
      entry: {
        providerOverride: "provider-b",
        modelOverride: "temporary",
        agentRuntimeOverride: "app-a",
        modelFallback: {
          source: "agent-patch",
          ts: 1,
          prevModel: "previous",
          prevProvider: "provider-a",
          prevAuthProfileOverride: "account-a",
          prevAuthProfileOverrideSource: "user",
          prevContextWindow: "64k",
          prevThinkingLevel: "high",
        },
      },
      classifyExecutor,
    });
    expect(result.entry.modelFallback).toEqual({
      source: "agent-patch",
      ts: 1,
      prevModel: "previous",
      prevProvider: "provider-a",
      prevAuthProfileOverride: "account-a",
      prevAuthProfileOverrideSource: "user",
      prevContextWindow: "64k",
      prevThinkingLevel: "high",
      previous: {
        state: "deferred",
        request: {},
        fallbackPermission: "configured",
      },
    });
  });
});
