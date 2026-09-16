import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { SessionAcpMeta, SessionEntry } from "../config/sessions/types.js";
import {
  decodeSessionExecutionSelection,
  admitSessionExecutionFallback,
  admitSessionExecutionFallbacks,
  encodeAcpExecutionSelection,
  encodeSessionExecutionSelection,
  readAcpExecutionSelection,
} from "./execution-selection-codec.js";
import type { ModelExecutionSelection } from "./execution-selection.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const metadata = {
  defaultProvider: "qa-route",
  classifyExecutor: (id: string) =>
    id === "qa-cli" ? ("cli" as const) : id === "openclaw" ? ("harness" as const) : undefined,
};
const pair: ModelExecutionSelection = {
  model: { provider: "qa-route", id: "qa-route/family/qa-selected" },
  executor: { kind: "harness", id: "openclaw" },
};
function entry(fields: Partial<SessionEntry> = {}): SessionEntry {
  return { sessionId: "qa-session", updatedAt: 1, delivery: { kind: "none" }, ...fields };
}
function acpMeta(): SessionAcpMeta {
  return {
    backend: "qa-backend",
    agent: "qa-agent",
    runtimeSessionName: "qa-native-session",
    mode: "persistent",
    state: "idle",
    lastActivityAt: 1,
    runtimeOptions: { thinking: "high", cwd: "/qa-workspace" },
  };
}

describe("session-store execution selection codec", () => {
  it("round-trips an exact accepted pair through the session store without fallback provenance or account loss", async () => {
    const scope = {
      storePath: path.join(tempDirs.make("execution-codec-"), "sessions.json"),
      sessionKey: "agent:main:codec",
    };
    const selected = entry({
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: "qa-origin",
      modelOverrideFallbackOriginModel: "qa-original",
      authProfileOverride: "qa-account",
      authProfileOverrideSource: "user",
      agentHarnessId: "qa-observed-executor",
      model: "qa-observed-model",
    });
    encodeSessionExecutionSelection(selected, pair, { kind: "user" });
    await replaceSessionEntry(scope, selected);
    const loaded = loadSessionEntryReadOnly(scope);
    expect(decodeSessionExecutionSelection(loaded, metadata)).toEqual({
      kind: "initialized",
      selection: pair,
    });
    expect(loaded).toMatchObject({
      authProfileOverride: "qa-account",
      authProfileOverrideSource: "user",
      agentHarnessId: "qa-observed-executor",
      model: "qa-observed-model",
      modelOverrideRouteResolution: "resolved",
    });
    expect(loaded?.modelOverrideSource).toBe("user");
    expect(loaded).not.toHaveProperty("modelOverrideFallbackOriginModel");
    expect(loaded).not.toHaveProperty("modelOverrideFallbackOriginProvider");
  });

  it("initializes partial and foreign triples from policy while retaining their model seed", () => {
    for (const agentRuntimeOverride of [undefined, "qa-foreign"]) {
      expect(
        decodeSessionExecutionSelection(
          entry({
            modelOverride: "qa-selected",
            providerOverride: "qa-route",
            agentRuntimeOverride,
          }),
          metadata,
        ),
      ).toEqual({ kind: "uninitialized", model: { provider: "qa-route", id: "qa-selected" } });
    }
    expect(
      decodeSessionExecutionSelection(entry({ modelOverride: "qa-selected" }), metadata),
    ).toEqual({ kind: "uninitialized", model: { provider: "qa-route", id: "qa-selected" } });
  });

  it("restores fallback origin instead of accepting a temporary fallback", () => {
    expect(
      decodeSessionExecutionSelection(
        entry({
          providerOverride: "qa-fallback",
          modelOverride: "qa-temporary",
          agentRuntimeOverride: "openclaw",
          modelOverrideSource: "auto",
          modelOverrideFallbackOriginProvider: "qa-route",
          modelOverrideFallbackOriginModel: "qa-original",
        }),
        metadata,
      ),
    ).toEqual({
      kind: "uninitialized",
      model: { provider: "qa-route", id: "qa-original" },
      discardAutomaticAuth: true,
    });
  });

  it("does not turn observed history or missing CLI readiness into selection intent", () => {
    expect(
      decodeSessionExecutionSelection(
        entry({ agentHarnessId: "openclaw", modelProvider: "qa-route", model: "qa-observed" }),
        metadata,
      ),
    ).toEqual({ kind: "uninitialized" });
    const selected = entry();
    const cliPair: ModelExecutionSelection = { ...pair, executor: { kind: "cli", id: "qa-cli" } };
    encodeSessionExecutionSelection(selected, cliPair, { kind: "user" });
    expect(decodeSessionExecutionSelection(selected, metadata)).toEqual({
      kind: "initialized",
      selection: cliPair,
    });
  });

  it("retains ACP lifecycle controls while selecting a model or an agent-managed default", () => {
    const original = acpMeta();
    for (const model of [null, { id: "qa-selected" }]) {
      const selection = {
        executor: { kind: "acp" as const, backend: "qa-backend", agent: "qa-agent" },
        model,
      };
      const encoded = encodeAcpExecutionSelection(original, selection);
      expect(readAcpExecutionSelection(encoded)).toEqual(selection);
      expect(encoded).toMatchObject({
        runtimeSessionName: original.runtimeSessionName,
        runtimeOptions: { thinking: "high", cwd: "/qa-workspace" },
      });
      expect(decodeSessionExecutionSelection(entry({ acp: encoded }), metadata)).toEqual({
        kind: "initialized",
        selection,
      });
    }
  });

  it("requires ACP lifecycle settlement before an ordinary pair can replace it", () => {
    const original = entry({ acp: acpMeta() });
    const snapshot = structuredClone(original);
    expect(() => encodeSessionExecutionSelection(original, pair, { kind: "user" })).toThrow(
      "ACP lifecycle must settle",
    );
    expect(original).toEqual(snapshot);
  });
  it.each(["initialize", "reset"] as const)(
    "keeps configured fallback permission after %s and inheritance",
    (kind) => {
      const selected = entry();
      encodeSessionExecutionSelection(selected, pair, { kind });
      expect(decodeSessionExecutionSelection(selected, metadata)).toEqual({
        kind: "initialized",
        selection: pair,
      });
      const inherited = entry();
      encodeSessionExecutionSelection(inherited, pair, { kind: "inherit", entry: selected });
      const candidate: ModelExecutionSelection = {
        ...pair,
        model: { provider: "qa-other", id: "qa-fallback" },
      };
      expect(admitSessionExecutionFallback({ entry: inherited, candidate, metadata })).toEqual({
        status: "admitted",
        selection: candidate,
      });
    },
  );

  it.each(["user", "legacy"] as const)(
    "retains %s pin fallback protection through initialization and inheritance",
    (source) => {
      const selected = entry({
        providerOverride: pair.model.provider,
        modelOverride: pair.model.id,
        modelOverrideRouteResolution: "resolved",
        ...(source === "user" ? { modelOverrideSource: "user" } : {}),
      });
      encodeSessionExecutionSelection(selected, pair, { kind: "initialize" });
      const inherited = entry();
      encodeSessionExecutionSelection(inherited, pair, { kind: "inherit", entry: selected });
      const candidate: ModelExecutionSelection = {
        ...pair,
        model: { provider: "qa-other", id: "qa-fallback" },
      };
      expect(admitSessionExecutionFallback({ entry: inherited, candidate, metadata })).toEqual({
        status: "rejected",
        reason: "user-model-selection",
      });
      expect(
        admitSessionExecutionFallback({
          entry: inherited,
          candidate,
          metadata,
          explicitModels: [candidate.model],
        }),
      ).toEqual({ status: "admitted", selection: candidate });
      expect(
        admitSessionExecutionFallback({
          entry: { ...inherited, modelSelectionLocked: true },
          candidate,
          metadata,
          explicitModels: [candidate.model],
        }),
      ).toEqual({ status: "rejected", reason: "model-selection-locked" });
    },
  );
  it("keeps a strict primary runnable without authorizing an empty or same-primary fallback plan", () => {
    const selected = entry();
    encodeSessionExecutionSelection(selected, pair, { kind: "user" });
    expect(admitSessionExecutionFallback({ entry: selected, candidate: pair, metadata })).toEqual({
      status: "admitted",
      selection: pair,
    });
    for (const candidates of [[], [pair]]) {
      expect(admitSessionExecutionFallbacks({ entry: selected, candidates, metadata })).toEqual({
        status: "rejected",
        reason: "user-model-selection",
      });
    }
    expect(
      admitSessionExecutionFallbacks({
        entry: selected,
        candidates: [],
        metadata,
        explicitModels: [],
      }),
    ).toEqual({ status: "admitted", selections: [] });
  });
});
