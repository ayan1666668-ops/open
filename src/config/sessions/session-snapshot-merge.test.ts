import { describe, expect, it } from "vitest";
import { SESSION_EXECUTION_SELECTION_TRANSACTION_FIELDS } from "../../model-picker/execution-selection.js";
import {
  mergeSessionSnapshotChanges,
  projectSessionSnapshotChanges,
  sessionSnapshotTouchedFieldsConflict,
} from "./session-snapshot-merge.js";
import { mergeSessionEntry, type InternalSessionEntry as SessionEntry } from "./types.js";

const initial: SessionEntry = {
  sessionId: "session-1",
  updatedAt: 1,
  modelProvider: "anthropic",
  model: "claude-opus-4-6",
};

const firstSelection = {
  state: "accepted",
  selection: {
    model: { provider: "openai", id: "gpt-5.4" },
    executor: { kind: "harness", id: "openclaw" },
  },
  fallbackPermission: "explicit",
} satisfies NonNullable<SessionEntry["executionSelection"]>;
const nextSelection = {
  state: "accepted",
  selection: {
    model: { provider: "openai", id: "gpt-5.5" },
    executor: { kind: "harness", id: "codex" },
  },
  fallbackPermission: "explicit",
} satisfies NonNullable<SessionEntry["executionSelection"]>;

describe("session snapshot merge", () => {
  it("projects same-provider model changes as an atomic pair", () => {
    const next = { ...initial, model: "claude-sonnet-4-6", updatedAt: 2 };
    const patch = projectSessionSnapshotChanges({ initial, next, current: initial });

    expect(patch).toMatchObject({
      modelProvider: "anthropic",
      model: "claude-sonnet-4-6",
    });
    expect(mergeSessionEntry(initial, patch)).toMatchObject({
      modelProvider: "anthropic",
      model: "claude-sonnet-4-6",
    });
  });

  it.each([undefined, "inherit"] as const)(
    "preserves a required creation sandbox against a %s patch",
    (sandbox) => {
      const existing: SessionEntry = {
        ...initial,
        sandbox: "required",
      };
      const patch: Partial<SessionEntry> = {};
      Object.assign(patch, { sandbox });

      expect(mergeSessionEntry(existing, patch)).toMatchObject({ sandbox: "required" });
    },
  );

  it("does not add a creation sandbox to an existing unstamped session", () => {
    expect(mergeSessionEntry(initial, { sandbox: "required" })).not.toHaveProperty("sandbox");
  });

  it("keeps a concurrently changed model pair", () => {
    const next = { ...initial, model: "claude-sonnet-4-6", updatedAt: 2 };
    const current = {
      ...initial,
      modelProvider: "openai",
      model: "gpt-5.5",
      updatedAt: 3,
    };

    expect(mergeSessionSnapshotChanges({ initial, next, current })).toMatchObject({
      modelProvider: "openai",
      model: "gpt-5.5",
    });
  });

  it("keeps a concurrent deferred execution and auth transaction atomically", () => {
    const initialOverride: SessionEntry = {
      ...initial,
      executionSelection: { ...firstSelection, fallbackPermission: "configured" },
      authProfileOverride: "openai:fallback",
      authProfileOverrideSource: "auto",
      authProfileOverrideCompactionCount: 1,
      fallbackNotice: {
        kind: "active",
        selectedModel: "openai/gpt-5.4",
        activeModel: "openai/gpt-fallback",
      },
    };
    const next = {
      ...initialOverride,
      updatedAt: 2,
      executionSelection: undefined,
      authProfileOverride: undefined,
      authProfileOverrideSource: undefined,
      authProfileOverrideCompactionCount: undefined,
      fallbackNotice: undefined,
      liveModelSwitchPending: true,
    };
    const current: SessionEntry = {
      ...initialOverride,
      updatedAt: 3,
      executionSelection: {
        state: "deferred",
        request: {
          model: { provider: "openai", id: "gpt-new" },
          executor: { kind: "harness", id: "codex" },
        },
        previous: firstSelection.selection,
        fallbackPermission: "explicit",
      },
      authProfileOverride: "openai:user",
      authProfileOverrideSource: "user",
      authProfileOverrideCompactionCount: 2,
      fallbackNotice: {
        kind: "active",
        selectedModel: "openai/gpt-new",
        activeModel: "openai/gpt-fallback",
      },
    };

    expect(mergeSessionSnapshotChanges({ initial: initialOverride, next, current })).toEqual(
      current,
    );
  });

  it("re-arms a winning explicit model switch after the prior signal clears", () => {
    const initialOverride: SessionEntry = {
      ...initial,
      executionSelection: firstSelection,
      liveModelSwitchPending: true,
    };
    const next: SessionEntry = {
      ...initialOverride,
      updatedAt: 2,
      executionSelection: nextSelection,
    };
    const current = { ...initialOverride, updatedAt: 3 };
    delete current.liveModelSwitchPending;

    expect(
      mergeSessionSnapshotChanges({
        initial: initialOverride,
        next,
        current,
        reassertLiveModelSwitchPending: true,
      }),
    ).toMatchObject({
      executionSelection: nextSelection,
      liveModelSwitchPending: true,
    });
  });

  it("preserves concurrently consumed unchanged model-dependent state", () => {
    const initialOverride: SessionEntry = {
      ...initial,
      executionSelection: firstSelection,
      liveModelSwitchPending: true,
      thinkingLevel: "high",
    };
    const next: SessionEntry = {
      ...initialOverride,
      updatedAt: 2,
      executionSelection: nextSelection,
    };
    const current: SessionEntry = {
      ...initialOverride,
      updatedAt: 3,
      thinkingLevel: "low",
    };
    delete current.liveModelSwitchPending;

    const merged = mergeSessionSnapshotChanges({ initial: initialOverride, next, current });

    expect(merged).toMatchObject({
      executionSelection: nextSelection,
      thinkingLevel: "low",
    });
    expect(merged.liveModelSwitchPending).toBeUndefined();
  });

  it("preserves observed output while clearing stale state for the winning selection", () => {
    const initialOverride: SessionEntry = {
      ...initial,
      executionSelection: firstSelection,
      modelProvider: "openai",
      model: "gpt-5.4",
      fallbackNotice: {
        kind: "active",
        selectedModel: "openai/gpt-5.4",
        activeModel: "openai/gpt-5.4-mini",
        reason: "rate_limit",
      },
      contextTokens: 100_000,
      contextTokensSource: "resolved",
      contextBudgetStatus: {
        schemaVersion: 1,
        source: "pre-prompt-estimate",
        updatedAt: 1,
        provider: "openai",
        model: "gpt-5.4",
        route: "fits",
        shouldCompact: false,
        estimatedPromptTokens: 10,
        contextTokenBudget: 100,
        promptBudgetBeforeReserve: 80,
        reserveTokens: 20,
        effectiveReserveTokens: 20,
        remainingPromptBudgetTokens: 70,
        overflowTokens: 0,
        toolResultReducibleChars: 0,
        messageCount: 1,
        unwindowedMessageCount: 1,
      },
    };
    const next: SessionEntry = {
      ...initialOverride,
      updatedAt: 2,
      executionSelection: nextSelection,
      fallbackNotice: undefined,
      contextTokens: undefined,
      contextTokensSource: undefined,
      contextBudgetStatus: undefined,
    };
    const current: SessionEntry = {
      ...initialOverride,
      updatedAt: 3,
      modelProvider: "openai",
      model: "gpt-5.4-mini",
      fallbackNotice: {
        kind: "active",
        selectedModel: "openai/gpt-5.4",
        activeModel: "openai/gpt-5.4-nano",
      },
      contextTokens: 80_000,
      contextTokensSource: "runtime",
    };

    const merged = mergeSessionSnapshotChanges({ initial: initialOverride, next, current });

    expect(merged).toMatchObject({
      executionSelection: nextSelection,
    });
    expect(merged.modelProvider).toBe("openai");
    expect(merged.model).toBe("gpt-5.4-mini");
    expect(merged.fallbackNotice).toBeUndefined();
    expect(merged.contextTokens).toBeUndefined();
    expect(merged.contextTokensSource).toBeUndefined();
    expect(merged.contextBudgetStatus).toBeUndefined();
  });

  it("keeps concurrent observed output but clears context added for the previous selection", () => {
    const initialOverride: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
      executionSelection: firstSelection,
    };
    const next: SessionEntry = {
      ...initialOverride,
      updatedAt: 2,
      executionSelection: nextSelection,
    };
    const current: SessionEntry = {
      ...initialOverride,
      updatedAt: 3,
      modelProvider: "openai",
      model: "gpt-5.4",
      fallbackNotice: {
        kind: "active",
        selectedModel: "openai/gpt-5.4",
        activeModel: "openai/gpt-5.4-mini",
      },
      contextTokens: 80_000,
    };

    const merged = mergeSessionSnapshotChanges({ initial: initialOverride, next, current });

    expect(merged).toMatchObject({
      executionSelection: nextSelection,
    });
    expect(merged.modelProvider).toBe("openai");
    expect(merged.model).toBe("gpt-5.4");
    expect(merged.fallbackNotice).toBeUndefined();
    expect(merged.contextTokens).toBeUndefined();
  });

  it("does not reject a model switch after concurrent runtime metadata refresh", () => {
    const initialOverride: SessionEntry = {
      ...initial,
      executionSelection: firstSelection,
      contextTokens: 100_000,
    };
    const next: SessionEntry = {
      ...initialOverride,
      executionSelection: nextSelection,
      contextTokens: undefined,
    };
    const current: SessionEntry = {
      ...initialOverride,
      updatedAt: 3,
      model: "gpt-5.4-mini",
      contextTokens: 80_000,
    };

    expect(
      sessionSnapshotTouchedFieldsConflict({
        initial: initialOverride,
        next,
        current,
        touchedFields: SESSION_EXECUTION_SELECTION_TRANSACTION_FIELDS,
      }),
    ).toBe(false);
  });

  it("rejects a model switch after a concurrent thinking override", () => {
    const initialOverride: SessionEntry = {
      ...initial,
      executionSelection: firstSelection,
      thinkingLevel: "xhigh",
    };
    const next: SessionEntry = {
      ...initialOverride,
      executionSelection: nextSelection,
      thinkingLevel: "high",
    };
    const current: SessionEntry = {
      ...initialOverride,
      updatedAt: 3,
      thinkingLevel: "low",
    };

    expect(
      sessionSnapshotTouchedFieldsConflict({
        initial: initialOverride,
        next,
        current,
        touchedFields: SESSION_EXECUTION_SELECTION_TRANSACTION_FIELDS,
      }),
    ).toBe(true);
  });

  it("blocks stale model-dependent state after a concurrent selection", () => {
    const next: SessionEntry = {
      ...initial,
      updatedAt: 2,
      modelProvider: "openai",
      model: "gpt-5.4",
      fallbackNotice: {
        kind: "active",
        selectedModel: "openai/gpt-5.4",
        activeModel: "openai/gpt-5.4-mini",
      },
      contextTokens: 100_000,
      thinkingLevel: "medium",
    };
    const current: SessionEntry = {
      ...initial,
      updatedAt: 3,
      executionSelection: nextSelection,
    };

    expect(mergeSessionSnapshotChanges({ initial, next, current })).toEqual(current);
  });

  it("does not project a stale snapshot across a session rotation", () => {
    const next = { ...initial, thinkingLevel: "high", updatedAt: 2 };
    const current: SessionEntry = {
      sessionId: "session-2",
      updatedAt: 3,
      thinkingLevel: "low",
    };

    expect(mergeSessionSnapshotChanges({ initial, next, current })).toEqual(current);
  });

  it("projects a runtime admission without losing its refreshed recovery budget", () => {
    const initialRecovery: SessionEntry = {
      ...initial,
      mainRestartRecovery: { cycleId: "cycle-1", revision: 4, chargedAttempts: 3 },
    };
    const next: SessionEntry = {
      ...initialRecovery,
      mainRestartRecovery: {
        ...initialRecovery.mainRestartRecovery!,
        revision: 5,
        startedAttempt: 3,
      },
    };

    const merged = mergeSessionSnapshotChanges({
      initial: initialRecovery,
      next,
      current: initialRecovery,
    });

    expect(merged.mainRestartRecovery).toEqual(next.mainRestartRecovery);
  });

  it("preserves the recovery aggregate when a restart marker wins a stale healthy clear", () => {
    const initialRecovery: SessionEntry = {
      ...initial,
      abortedLastRun: true,
      restartRecoveryRuns: [{ runId: "run-1", lifecycleGeneration: "generation-1" }],
      mainRestartRecovery: {
        cycleId: "cycle-1",
        revision: 2,
        chargedAttempts: 0,
        foregroundClaims: {
          lifecycleGeneration: "generation-1",
          tokens: ["owner-1"],
        },
      },
    };
    const next: SessionEntry = {
      ...initialRecovery,
      updatedAt: 2,
      abortedLastRun: false,
      restartRecoveryRuns: undefined,
      mainRestartRecovery: undefined,
    };
    const current: SessionEntry = {
      ...initialRecovery,
      updatedAt: 3,
      restartRecoveryRuns: [
        ...(initialRecovery.restartRecoveryRuns ?? []),
        { runId: "run-1", lifecycleGeneration: "generation-2" },
      ],
    };

    const merged = mergeSessionSnapshotChanges({ initial: initialRecovery, next, current });

    expect(merged.abortedLastRun).toBe(true);
    expect(merged.restartRecoveryRuns).toEqual(current.restartRecoveryRuns);
    expect(merged.mainRestartRecovery).toEqual(current.mainRestartRecovery);
  });

  it("keeps a claimed recovery interrupted until its lifecycle owner settles", () => {
    const initialRecovery: SessionEntry = {
      ...initial,
      abortedLastRun: true,
      mainRestartRecovery: {
        cycleId: "cycle-1",
        revision: 1,
        chargedAttempts: 1,
      },
    };
    const next: SessionEntry = {
      ...initialRecovery,
      updatedAt: 2,
      abortedLastRun: false,
      mainRestartRecovery: undefined,
    };
    const current: SessionEntry = {
      ...initialRecovery,
      updatedAt: 3,
      mainRestartRecovery: {
        ...initialRecovery.mainRestartRecovery!,
        revision: 2,
        foregroundClaims: {
          lifecycleGeneration: "generation-1",
          tokens: ["owner-1"],
        },
      },
    };

    const merged = mergeSessionSnapshotChanges({ initial: initialRecovery, next, current });

    expect(merged.abortedLastRun).toBe(true);
    expect(merged.restartRecoveryRuns).toBeUndefined();
    expect(merged.mainRestartRecovery).toEqual(current.mainRestartRecovery);
  });

  it("clears recovery after lifecycle settlement consumes its run fence", () => {
    const initialRecovery: SessionEntry = {
      ...initial,
      abortedLastRun: true,
      restartRecoveryRuns: [
        { runId: "interrupted-run", lifecycleGeneration: "generation-1" },
        { runId: "recovery-run", lifecycleGeneration: "generation-1" },
      ],
      mainRestartRecovery: {
        cycleId: "cycle-1",
        revision: 3,
        chargedAttempts: 1,
      },
    };
    const next: SessionEntry = {
      ...initialRecovery,
      updatedAt: 2,
      abortedLastRun: false,
      restartRecoveryRuns: undefined,
      mainRestartRecovery: undefined,
    };
    const current: SessionEntry = {
      ...structuredClone(initialRecovery),
      updatedAt: 3,
      abortedLastRun: false,
      restartRecoveryRuns: [{ runId: "interrupted-run", lifecycleGeneration: "generation-1" }],
    };

    const merged = mergeSessionSnapshotChanges({ initial: initialRecovery, next, current });

    expect(merged.abortedLastRun).toBe(false);
    expect(merged.restartRecoveryRuns).toBeUndefined();
    expect(merged.mainRestartRecovery).toBeUndefined();
  });

  it("preserves every concurrent owner and interruption until lifecycle settlement", () => {
    const initialRecovery: SessionEntry = {
      ...initial,
      abortedLastRun: true,
      mainRestartRecovery: {
        cycleId: "cycle-1",
        revision: 1,
        chargedAttempts: 1,
      },
    };
    const next: SessionEntry = {
      ...initialRecovery,
      updatedAt: 2,
      abortedLastRun: false,
      mainRestartRecovery: undefined,
    };
    const current: SessionEntry = {
      ...initialRecovery,
      updatedAt: 3,
      mainRestartRecovery: {
        ...initialRecovery.mainRestartRecovery!,
        revision: 3,
        foregroundClaims: {
          lifecycleGeneration: "generation-1",
          tokens: ["owner-1", "owner-2"],
        },
      },
    };

    const merged = mergeSessionSnapshotChanges({ initial: initialRecovery, next, current });

    expect(merged.abortedLastRun).toBe(true);
    expect(merged.mainRestartRecovery?.foregroundClaims?.tokens).toEqual(["owner-1", "owner-2"]);
  });

  it("reasserts a terminal abort after another owner marks the session healthy", () => {
    const initialRecovery: SessionEntry = {
      ...initial,
      abortedLastRun: true,
      mainRestartRecovery: {
        cycleId: "cycle-1",
        revision: 3,
        chargedAttempts: 1,
        foregroundClaims: {
          lifecycleGeneration: "generation-1",
          tokens: ["owner-1", "owner-2"],
        },
      },
    };
    const next: SessionEntry = {
      ...structuredClone(initialRecovery),
      updatedAt: 2,
    };
    const current: SessionEntry = {
      ...structuredClone(initialRecovery),
      updatedAt: 3,
      abortedLastRun: false,
      mainRestartRecovery: {
        ...initialRecovery.mainRestartRecovery!,
        revision: 4,
        foregroundClaims: {
          lifecycleGeneration: "generation-1",
          tokens: ["owner-2"],
        },
      },
    };

    const merged = mergeSessionSnapshotChanges({
      initial: initialRecovery,
      next,
      current,
      reassertAbortedLastRun: true,
    });

    expect(merged.abortedLastRun).toBe(true);
    expect(merged.mainRestartRecovery).toEqual(current.mainRestartRecovery);
  });

  it("does not attach a stale terminal abort to a replacement recovery cycle", () => {
    const initialRecovery: SessionEntry = {
      ...initial,
      abortedLastRun: true,
      mainRestartRecovery: {
        cycleId: "cycle-old",
        revision: 2,
        chargedAttempts: 1,
        foregroundClaims: {
          lifecycleGeneration: "generation-old",
          tokens: ["old-owner"],
        },
      },
    };
    const current: SessionEntry = {
      ...structuredClone(initialRecovery),
      updatedAt: 3,
      abortedLastRun: false,
      mainRestartRecovery: {
        cycleId: "cycle-new",
        revision: 1,
        chargedAttempts: 0,
        foregroundClaims: {
          lifecycleGeneration: "generation-new",
          tokens: ["new-owner"],
        },
      },
    };

    const merged = mergeSessionSnapshotChanges({
      initial: initialRecovery,
      next: { ...structuredClone(initialRecovery), updatedAt: 2 },
      current,
      reassertAbortedLastRun: true,
    });

    expect(merged.abortedLastRun).toBe(false);
    expect(merged.mainRestartRecovery).toEqual(current.mainRestartRecovery);
  });

  it("preserves a concurrent foreground claim over a partial recovery update", () => {
    const initialRecovery: SessionEntry = {
      ...initial,
      abortedLastRun: true,
      mainRestartRecovery: {
        cycleId: "cycle-1",
        revision: 1,
        chargedAttempts: 0,
      },
    };
    const next: SessionEntry = {
      ...initialRecovery,
      updatedAt: 2,
      mainRestartRecovery: {
        ...initialRecovery.mainRestartRecovery!,
        revision: 2,
        chargedAttempts: 1,
        reservation: {
          runId: "recovery-1",
          attempt: 1,
          lifecycleGeneration: "generation-1",
        },
      },
    };
    const current: SessionEntry = {
      ...initialRecovery,
      updatedAt: 3,
      mainRestartRecovery: {
        ...initialRecovery.mainRestartRecovery!,
        revision: 2,
        foregroundClaims: {
          lifecycleGeneration: "generation-1",
          tokens: ["owner-1"],
        },
      },
    };

    const merged = mergeSessionSnapshotChanges({ initial: initialRecovery, next, current });

    expect(merged.mainRestartRecovery).toEqual(current.mainRestartRecovery);
    expect(merged.mainRestartRecovery?.reservation).toBeUndefined();
  });
});
