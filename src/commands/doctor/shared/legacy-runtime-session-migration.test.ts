import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { acceptedModelSelection } from "../../../test-utils/session-execution-selection.js";
import { legacyCodexProviderIdentityKey } from "./codex-route-model-ref.js";
import { maybeRepairCodexSessionRoutes } from "./codex-route-session-repair.js";
import { collectBlockedLegacyOpenAICodexProviderPlan } from "./legacy-config-migrations.runtime.models.js";

const states: OpenClawTestState[] = [];
afterEach(async () => {
  for (const state of states.splice(0)) {
    await state.cleanup();
  }
});

async function legacyFixture(store: Record<string, unknown>) {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "runtime-migration-",
  });
  states.push(state);
  state.applyEnv();
  const storePath = path.join(state.sessionsDir(), "sessions.json");
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(store));
  const cfg: OpenClawConfig = {
    plugins: { enabled: false },
    agents: { entries: { main: {} }, defaults: { model: "openai/current-model" } },
  };
  const params = { cfg, env: state.env };
  return {
    ...params,
    storePath,
    read: (): Record<string, Record<string, unknown>> =>
      JSON.parse(fs.readFileSync(storePath, "utf8")),
    async repair(
      options: Pick<
        Parameters<typeof maybeRepairCodexSessionRoutes>[0],
        "blockedModelIdentities"
      > = {},
    ) {
      const before = fs.readFileSync(storePath, "utf8");
      await maybeRepairCodexSessionRoutes({ ...params, ...options, shouldRepair: false });
      expect(fs.readFileSync(storePath, "utf8")).toBe(before);
      const result = await maybeRepairCodexSessionRoutes({
        ...params,
        ...options,
        shouldRepair: true,
      });
      const repaired = fs.readFileSync(storePath, "utf8");
      expect(
        (await maybeRepairCodexSessionRoutes({ ...params, ...options, shouldRepair: true }))
          .repairedSessions,
      ).toBe(0);
      expect(fs.readFileSync(storePath, "utf8")).toBe(repaired);
      return result;
    },
  };
}

const sessionKey = "agent:main:telegram:default:direct:5550100999";

describe("legacy runtime session model migration", () => {
  it.each([
    {
      provider: "openai-codex",
      model: "openai-codex/current-model",
      providerAfter: "openai",
      runtime: undefined,
      executor: { kind: "harness", id: "codex" },
    },
    {
      provider: "codex",
      model: "codex/current-model",
      providerAfter: "openai",
      runtime: "codex-cli",
      executor: { kind: "harness", id: "codex" },
    },
    {
      provider: "openai-codex",
      model: "current-model",
      providerAfter: "openai",
      runtime: "pi",
      executor: { kind: "harness", id: "openclaw" },
    },
    {
      provider: "claude-cli",
      model: "current-model",
      providerAfter: "anthropic",
      runtime: undefined,
      executor: { kind: "cli", id: "claude-cli" },
    },
    {
      provider: "google-gemini-cli",
      model: "current-model",
      providerAfter: "google",
      runtime: "openclaw",
      executor: { kind: "harness", id: "openclaw" },
    },
  ])(
    "imports $provider with explicit runtime $runtime without losing account or CLI binding",
    async (row) => {
      const fixture = await legacyFixture({
        [sessionKey]: {
          sessionId: "legacy-selection",
          updatedAt: 1,
          modelProvider: row.provider,
          model: row.model,
          providerOverride: row.provider,
          modelOverride: row.model,
          modelOverrideSource: "user",
          agentRuntimeOverride: row.runtime,
          agentHarnessId:
            row.runtime === "codex-cli" ? "codex-cli" : row.runtime === "pi" ? "pi" : undefined,
          authProfileOverride: "authored:account",
          authProfileOverrideSource: "user",
          claudeCliSessionId: "retained-binding",
        },
      });

      expect((await fixture.repair()).repairedSessions).toBe(1);
      const entry = fixture.read()[sessionKey];
      expect(entry).toMatchObject({
        modelProvider: row.providerAfter,
        model: "current-model",
        executionSelection: {
          state: "deferred",
          request: {
            model: { provider: row.providerAfter, id: "current-model" },
            executor: row.executor,
          },
          fallbackPermission: "explicit",
        },
        authProfileOverride: "authored:account",
        authProfileOverrideSource: "user",
        cliSessionBindings: { "claude-cli": { sessionId: "retained-binding" } },
      });
      for (const field of [
        "providerOverride",
        "modelOverride",
        "modelOverrideSource",
        "agentRuntimeOverride",
        "claudeCliSessionId",
      ]) {
        expect(entry).not.toHaveProperty(field);
      }
      expect(entry?.agentHarnessId).toBe(
        row.runtime === "codex-cli" ? "codex" : row.runtime === "pi" ? "pi" : undefined,
      );
    },
  );

  it.each([
    {
      provider: "google-gemini-cli",
      model: "assistant-b",
      providerAfter: "google",
      runtime: undefined,
      request: { executor: { kind: "cli", id: "google-gemini-cli" } },
    },
    {
      provider: "google-gemini-cli",
      model: "assistant-b",
      providerAfter: "google",
      runtime: "openclaw",
      request: { executor: { kind: "harness", id: "openclaw" } },
    },
    {
      provider: "openai",
      model: "claude-cli/team/model",
      providerAfter: "openai",
      runtime: undefined,
      request: {},
    },
  ])("uses selected $provider intent rather than the last observed runtime", async (row) => {
    const fixture = await legacyFixture({
      [sessionKey]: {
        sessionId: "mixed-runtimes",
        updatedAt: 1,
        modelProvider: "claude-cli",
        model: "assistant-a",
        providerOverride: row.provider,
        modelOverride: row.model,
        modelOverrideSource: "user",
        agentRuntimeOverride: row.runtime,
        authProfileOverride: "authored:account",
      },
    });

    await fixture.repair();
    expect(fixture.read()[sessionKey]).toMatchObject({
      modelProvider: "anthropic",
      model: "assistant-a",
      executionSelection: {
        state: "deferred",
        request: { model: { provider: row.providerAfter, id: row.model }, ...row.request },
        fallbackPermission: "explicit",
      },
      authProfileOverride: "authored:account",
    });
  });

  it.each([
    { provider: "openai", model: "codex/team/custom-model" },
    { provider: "custom", model: "openai-codex/team/model" },
    { provider: "google", model: "claude-cli/team/model" },
    { provider: "anthropic", model: "google-gemini-cli/team/model" },
  ])(
    "retains the namespaced model $model under explicit $provider",
    async ({ provider, model }) => {
      const fixture = await legacyFixture({
        [sessionKey]: {
          sessionId: "custom-pair",
          updatedAt: 1,
          modelProvider: provider,
          model,
          providerOverride: provider,
          modelOverride: model,
          modelOverrideSource: "user",
          authProfileOverride: "authored:account",
        },
      });

      await fixture.repair();
      expect(fixture.read()[sessionKey]).toMatchObject({
        modelProvider: provider,
        model,
        executionSelection: {
          state: "deferred",
          request: { model: { provider, id: model } },
          fallbackPermission: "explicit",
        },
        authProfileOverride: "authored:account",
      });
    },
  );

  it("migrates a retired runtime without treating observed output as selected intent", async () => {
    const fixture = await legacyFixture({
      [sessionKey]: {
        sessionId: "runtime-only",
        updatedAt: 1,
        modelProvider: "openai-codex",
        model: "observed-model",
        agentRuntimeOverride: "codex-cli",
        authProfileOverride: "authored:account",
        claudeCliSessionId: "retained-binding",
      },
    });

    await fixture.repair();
    expect(fixture.read()[sessionKey]).toMatchObject({
      modelProvider: "openai",
      model: "observed-model",
      executionSelection: {
        state: "deferred",
        request: {
          model: { provider: "openai", id: "current-model" },
          executor: { kind: "harness", id: "codex" },
        },
      },
      authProfileOverride: "authored:account",
      cliSessionBindings: { "claude-cli": { sessionId: "retained-binding" } },
    });
    expect(fixture.read()[sessionKey]?.agentHarnessId).toBeUndefined();
  });

  it("retains an unavailable explicit runtime while repairing the provider alias", async () => {
    const fixture = await legacyFixture({
      [sessionKey]: {
        sessionId: "unknown-runtime",
        updatedAt: 1,
        providerOverride: "openai-codex",
        modelOverride: "current-model",
        agentRuntimeOverride: "unavailable-runner",
      },
    });

    await fixture.repair();
    expect(fixture.read()[sessionKey]?.executionSelection).toEqual({
      state: "deferred",
      request: {
        model: { provider: "openai", id: "current-model" },
        runtime: "unavailable-runner",
      },
      fallbackPermission: "explicit",
    });
  });

  it("retains blocked namespaces and fallback notices while converting their selection representation", async () => {
    const blocked = legacyCodexProviderIdentityKey("codex");
    if (!blocked) {
      throw new Error("expected a legacy Codex namespace");
    }
    const fallbackNotice = {
      kind: "active",
      selectedModel: "codex/current-model",
      activeModel: "openai/current-model",
      reason: "rate-limit",
    };
    const fixture = await legacyFixture({
      [sessionKey]: {
        sessionId: "blocked-namespace",
        updatedAt: 1,
        modelProvider: "codex",
        model: "current-model",
        providerOverride: "codex",
        modelOverride: "codex/current-model",
        fallbackNotice,
      },
      "agent:main:provider-only": {
        sessionId: "provider-only",
        updatedAt: 2,
        modelProvider: "codex",
      },
    });

    await fixture.repair({ blockedModelIdentities: new Set([blocked]) });
    expect(fixture.read()[sessionKey]).toMatchObject({
      modelProvider: "codex",
      model: "current-model",
      executionSelection: {
        state: "deferred",
        request: { model: { provider: "codex", id: "current-model" } },
      },
      fallbackNotice,
    });
    expect(fixture.read()["agent:main:provider-only"]?.modelProvider).toBe("codex");
  });

  it("cleans only an unblocked fallback notice without changing canonical runtime intent", async () => {
    const executionSelection = {
      state: "deferred",
      request: { runtime: "unavailable-runner", defaultSelection: "inherit" },
      fallbackPermission: "explicit",
    };
    const entry = {
      sessionId: "fallback-notice",
      updatedAt: 1,
      modelProvider: "openai",
      model: "current-model",
      executionSelection,
      fallbackNotice: {
        kind: "active",
        selectedModel: "codex/current-model",
        activeModel: "openai/current-model",
      },
    };
    const blocked = collectBlockedLegacyOpenAICodexProviderPlan({
      models: {
        providers: {
          codex: { models: [{ id: "current-model", api: "openai-responses" }] },
          openai: { models: [{ id: "current-model", api: "openai-chatgpt-responses" }] },
        },
      },
    }).blockedModelIdentities;
    expect(blocked).not.toEqual([]);
    const fixture = await legacyFixture({ [sessionKey]: entry });
    const before = fs.readFileSync(fixture.storePath, "utf8");
    expect(
      (await fixture.repair({ blockedModelIdentities: new Set(blocked) })).repairedSessions,
    ).toBe(0);
    expect(fs.readFileSync(fixture.storePath, "utf8")).toBe(before);
    expect((await fixture.repair()).repairedSessions).toBe(1);
    expect(fixture.read()[sessionKey]?.executionSelection).toEqual(executionSelection);
    expect(fixture.read()[sessionKey]?.fallbackNotice).toBeUndefined();
  });

  it("preserves locked native rows and canonical OpenClaw selections beside a legacy route", async () => {
    const locked = {
      sessionId: "native",
      sessionFile: "native-session.jsonl",
      updatedAt: 1,
      modelSelectionLocked: true,
      agentHarnessId: "codex",
      agentRuntimeOverride: "codex",
      modelProvider: "openai-codex",
      model: "current-model",
      providerOverride: "openai-codex",
      modelOverride: "current-model",
    };
    const canonical = {
      sessionId: "canonical",
      updatedAt: 2,
      modelProvider: "openai",
      model: "current-model",
      agentHarnessId: "openclaw",
      executionSelection: acceptedModelSelection("openai", "current-model"),
      authProfileOverride: "openai:work",
      contextTokens: 128_000,
      contextTokensSource: "runtime",
    };
    const lockedKey = "agent:main:harness:codex:supervision:abc123";
    const ordinaryLockedKey = "agent:main:ordinary-locked";
    const fixture = await legacyFixture({
      [lockedKey]: locked,
      [ordinaryLockedKey]: { ...locked, sessionId: "ordinary-native" },
      "agent:main:canonical": canonical,
      [sessionKey]: {
        sessionId: "legacy",
        updatedAt: 3,
        providerOverride: "codex",
        modelOverride: "current-model",
      },
    });
    const before = fixture.read();

    expect((await fixture.repair()).repairedSessions).toBe(1);
    const after = fixture.read();
    for (const key of [lockedKey, ordinaryLockedKey, "agent:main:canonical"]) {
      expect(after[key]).toEqual(before[key]);
    }
    expect(after[sessionKey]?.executionSelection).toMatchObject({
      state: "deferred",
      request: {
        model: { provider: "openai", id: "current-model" },
        executor: { kind: "harness", id: "codex" },
      },
    });
  });

  it.each(["auto", "user", undefined])(
    "uses the Codex account hint only for a providerless automatic override (%s)",
    async (source) => {
      const contextBudgetStatus = {
        schemaVersion: 1,
        source: "pre-prompt-estimate",
        updatedAt: 1,
        provider: "ollama",
        model: "current-model",
        route: "fits",
        shouldCompact: false,
        estimatedPromptTokens: 1_000,
        contextTokenBudget: 64_000,
        promptBudgetBeforeReserve: 62_000,
        reserveTokens: 2_000,
        effectiveReserveTokens: 2_000,
        remainingPromptBudgetTokens: 61_000,
        overflowTokens: 0,
        toolResultReducibleChars: 0,
        messageCount: 1,
        unwindowedMessageCount: 1,
      };
      const fixture = await legacyFixture({
        [sessionKey]: {
          sessionId: "providerless",
          updatedAt: 1,
          modelProvider: "ollama",
          model: "current-model",
          modelOverride: "current-model",
          modelOverrideSource: source,
          authProfileOverride: "openai-codex:default",
          authProfileOverrideSource: "auto",
          contextTokens: 64_000,
          contextTokensSource: "runtime",
          contextBudgetStatus,
        },
      });

      await fixture.repair();
      const entry = fixture.read()[sessionKey];
      expect(entry?.executionSelection).toEqual({
        state: "deferred",
        request:
          source === "auto"
            ? {
                model: { provider: "openai", id: "current-model" },
                executor: { kind: "harness", id: "codex" },
              }
            : { model: { id: "current-model" } },
        fallbackPermission: source === "auto" ? "configured" : "explicit",
      });
      expect(entry?.authProfileOverride).toBe("openai-codex:default");
      if (source === "auto") {
        for (const field of [
          "modelProvider",
          "model",
          "contextTokens",
          "contextTokensSource",
          "contextBudgetStatus",
        ]) {
          expect(entry).not.toHaveProperty(field);
        }
      } else {
        expect(entry).toMatchObject({
          modelProvider: "ollama",
          model: "current-model",
          contextTokens: 64_000,
          contextTokensSource: "runtime",
          contextBudgetStatus,
        });
      }
    },
  );

  it.each([false, true])(
    "retains malformed selection input while a neighboring repair is %s",
    async (repairNeighbor) => {
      const malformed = {
        sessionId: "malformed-selection",
        sessionFile: "malformed-session.jsonl",
        updatedAt: 1,
        executionSelection: { state: "accepted" },
        providerOverride: "openai-codex",
        modelOverride: "current-model",
        claudeCliSessionId: "retained-binding",
      };
      const fixture = await legacyFixture({
        [sessionKey]: malformed,
        ...(repairNeighbor
          ? {
              "agent:main:repairable": {
                sessionId: "repairable",
                updatedAt: 2,
                providerOverride: "codex",
                modelOverride: "current-model",
              },
            }
          : {}),
      });
      const before = fs.readFileSync(fixture.storePath, "utf8");
      const result = await fixture.repair();
      expect(result.repairedSessions).toBe(repairNeighbor ? 1 : 0);
      expect(result.warnings).toContainEqual(expect.stringContaining(sessionKey));
      expect(fixture.read()[sessionKey]).toEqual(malformed);
      if (!repairNeighbor) {
        expect(fs.readFileSync(fixture.storePath, "utf8")).toBe(before);
      }
    },
  );
});
