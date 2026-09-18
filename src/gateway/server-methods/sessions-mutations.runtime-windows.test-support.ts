import { describe, expect, it, vi } from "vitest";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import type { createSessionModelCatalogFixture } from "../../agents/test-helpers/session-model-catalog.test-support.js";
import { getFollowupQueue } from "../../auto-reply/reply/queue/state.js";
import type { FollowupRun } from "../../auto-reply/reply/queue/types.js";
import {
  loadSessionEntry,
  appendTranscriptMessageSync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { commitSessionExecutionSelection } from "../../model-picker/apply-session-model-selection.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createGatewaySession } from "../session-create-service.js";
import { projectSessionPatchResult } from "../session-utils-model.js";
import { buildGatewaySessionRow } from "../session-utils-row.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

type PublishedCatalog = ReturnType<ReturnType<typeof createSessionModelCatalogFixture>["publish"]>;

export function registerSessionRuntimeWindowTests(harness: {
  getConfig: () => OpenClawConfig;
  getState: () => OpenClawTestState;
  publishCatalog: (
    entries: ModelCatalogEntry[],
    routeVariants: ModelCatalogEntry[],
  ) => PublishedCatalog;
  publishDefaultCatalog: () => PublishedCatalog;
  patchSession: (
    request: Record<string, unknown>,
    scopes: string[],
    requestContext: Pick<GatewayRequestContext, "loadGatewayModelCatalogSnapshot">,
  ) => Promise<Parameters<RespondFn>>;
}): void {
  const { patchSession } = harness;
  describe("runtime-specific session context windows", () => {
    function runtimeWindowFixture() {
      const base: ModelCatalogEntry = {
        provider: "openai",
        id: "gpt-5.6-sol",
        name: "Sol",
        reasoning: true,
        contextWindows: [{ id: "32k", label: "32K", contextWindow: 32_000 }],
        contextWindowDefault: "32k",
      };
      const native: ModelCatalogEntry = {
        ...base,
        nativeRuntime: "codex",
        contextWindows: [{ id: "64k", label: "64K", contextWindow: 64_000 }],
        contextWindowDefault: "64k",
      };
      const snapshot = harness.publishCatalog([base], [base, native]);
      const requestContext = {
        loadGatewayModelCatalogSnapshot: vi.fn(async () => snapshot),
      };
      return { base, native, snapshot, requestContext };
    }

    it.each(["create", "patch"])(
      "accepts the selected runtime window through %s and projects it after persistence",
      async (operation) => {
        const cfg = harness.getConfig();
        const openClawTestState = harness.getState();
        const sessionKey = `agent:main:runtime-window-${operation}`;
        const { base, native, snapshot, requestContext } = runtimeWindowFixture();
        if (operation === "create") {
          const options = {
            cfg,
            key: sessionKey,
            model: "openai/gpt-5.6-sol",
            agentRuntime: "codex",
            contextWindow: "64k",
            commandSource: "test",
            operatorRoleActor: { kind: "system" as const },
            loadGatewayModelCatalogSnapshot: requestContext.loadGatewayModelCatalogSnapshot,
          };
          expect(await createGatewaySession(options)).toMatchObject({
            ok: true,
            entry: { contextWindow: "64k", agentRuntimeOverride: "codex" },
          });
        } else {
          const entry: InternalSessionEntry = { sessionId: sessionKey, updatedAt: 1 };
          commitSessionExecutionSelection(entry, {
            model: { provider: base.provider, id: base.id },
            executor: { kind: "harness", id: "openclaw" },
          });
          await upsertSessionEntryCore({ agentId: "main", sessionKey }, entry);
          expect(
            (
              await patchSession(
                {
                  key: sessionKey,
                  model: "openai/gpt-5.6-sol",
                  agentRuntime: "codex",
                  contextWindow: "64k",
                },
                ["operator.admin"],
                requestContext,
              )
            )[0],
          ).toBe(true);
        }
        const stored = loadSessionEntry({ agentId: "main", sessionKey });
        expect(stored).toMatchObject({
          contextWindow: "64k",
          executionSelection: {
            state: "accepted",
            selection: {
              model: { provider: base.provider, id: base.id },
              executor: { kind: "harness", id: "codex" },
            },
            fallbackPermission: "explicit",
          },
        });
        if (!stored) {
          throw new Error("Session was not persisted");
        }
        expect(
          projectSessionPatchResult({
            cfg,
            canonicalKey: sessionKey,
            entry: stored,
            modelCatalog: snapshot.entries,
            modelCatalogRouteVariants: snapshot.routeVariants,
            targetAgentId: "main",
            storePath: openClawTestState.statePath("agents", "main", "sessions", "sessions.json"),
          }).resolved,
        ).toMatchObject({ contextWindow: "64k", contextWindows: native.contextWindows });
        const row = buildGatewaySessionRow({
          cfg,
          agentId: "main",
          key: sessionKey,
          entry: stored,
          store: { [sessionKey]: stored },
          storePath: openClawTestState.statePath("agents", "main", "sessions", "sessions.json"),
          modelCatalog: new Map([
            ["main", { entries: snapshot.entries, routeVariants: snapshot.routeVariants }],
          ]),
          lightweightListRow: true,
          skipTranscriptUsageFallback: true,
        });
        expect(row).toMatchObject({
          contextWindow: "64k",
          contextWindows: native.contextWindows,
          contextTokens: 64_000,
        });
        const contextOnly = await patchSession(
          { key: sessionKey, contextWindow: "64k" },
          ["operator.admin"],
          requestContext,
        );
        expect(contextOnly[0]).toBe(true);
        expect(contextOnly[1]).toMatchObject({
          resolved: { contextWindow: "64k", contextWindows: native.contextWindows },
        });
        const invalid = await patchSession(
          { key: sessionKey, contextWindow: "32k" },
          ["operator.admin"],
          requestContext,
        );
        expect(invalid[0]).toBe(false);
        expect(invalid[2]?.message).toContain("use 64k");
        expect(loadSessionEntry({ agentId: "main", sessionKey })?.contextWindow).toBe("64k");
        Object.assign(
          snapshot,
          harness.publishCatalog(snapshot.entries, [
            base,
            { ...native, contextWindows: undefined, contextWindowDefault: undefined },
          ]),
        );
        const missing = await patchSession(
          { key: sessionKey, contextWindow: "32k" },
          ["operator.admin"],
          requestContext,
        );
        expect(missing[0]).toBe(false);
        expect(missing[2]?.message).not.toContain("use 32k");
        const withoutNativeWindows = projectSessionPatchResult({
          cfg,
          canonicalKey: sessionKey,
          entry: stored,
          modelCatalog: snapshot.entries,
          modelCatalogRouteVariants: snapshot.routeVariants,
          targetAgentId: "main",
          storePath: openClawTestState.statePath("agents", "main", "sessions", "sessions.json"),
        });
        expect(withoutNativeWindows.resolved?.contextWindows).toBeUndefined();
        expect(
          (
            await patchSession(
              { key: sessionKey, model: "openai/gpt-5.6-sol", agentRuntime: "openclaw" },
              ["operator.admin"],
              requestContext,
            )
          )[0],
        ).toBe(true);
        expect(loadSessionEntry({ agentId: "main", sessionKey })).not.toHaveProperty(
          "contextWindow",
        );
      },
    );
    it.each([50_000, 70_000])(
      "bounds native alternative forks at 64k for a %s-token parent",
      async (parentTokens) => {
        const cfg = harness.getConfig();
        const { snapshot } = runtimeWindowFixture();
        const parentKey = `agent:main:window-parent-${parentTokens}`;
        const childKey = `agent:main:window-child-${parentTokens}`;
        const parentSnapshot = harness.publishDefaultCatalog();
        const parent = await createGatewaySession({
          cfg,
          key: parentKey,
          loadGatewayModelCatalogSnapshot: async () => parentSnapshot,
          commandSource: "test",
          operatorRoleActor: { kind: "system" },
        });
        expect(parent.ok).toBe(true);
        const scope = { agentId: "main", sessionKey: parentKey };
        const stored = loadSessionEntry(scope);
        if (!stored) {
          throw new Error("Parent was not persisted");
        }
        appendTranscriptMessageSync(
          { ...scope, sessionId: stored.sessionId },
          { message: { role: "user", content: "Context-window fork fixture", timestamp: 1 } },
        );
        await upsertSessionEntryCore(scope, {
          ...stored,
          totalTokens: parentTokens,
          totalTokensFresh: true,
          totalTokensVersion: 1,
        });
        const childSnapshot = harness.publishCatalog(snapshot.entries, snapshot.routeVariants);
        const child = await createGatewaySession({
          cfg,
          key: childKey,
          parentSessionKey: parentKey,
          fork: true,
          model: "openai/gpt-5.6-sol",
          agentRuntime: "codex",
          contextWindow: "64k",
          loadGatewayModelCatalogSnapshot: async () => childSnapshot,
          commandSource: "test",
          operatorRoleActor: { kind: "system" },
        });
        if (parentTokens < 64_000) {
          expect(child).toMatchObject({
            ok: true,
            entry: {
              contextWindow: "64k",
              agentRuntimeOverride: "codex",
              forkSource: { sessionKey: parentKey },
            },
          });
        } else {
          expect(child).toMatchObject({
            ok: false,
            error: { message: expect.stringContaining("70000/64000 tokens") },
          });
          expect(loadSessionEntry({ agentId: "main", sessionKey: childKey })).toBeUndefined();
        }
      },
    );
  });
}

export function queueRuntimeSelection(
  sessionKey: string,
  cfg: OpenClawConfig,
  openClawTestState: OpenClawTestState,
) {
  const queue = getFollowupQueue(sessionKey, { mode: "followup" });
  const queued: FollowupRun["run"] = {
    agentId: "main",
    agentDir: openClawTestState.agentDir("main"),
    sessionId: sessionKey,
    sessionKey,
    sessionFile: openClawTestState.statePath("queued-session.jsonl"),
    workspaceDir: openClawTestState.workspaceDir,
    config: cfg,
    executionSelection: {
      model: { provider: "anthropic", id: "claude-opus-4-6" },
      executor: { kind: "harness", id: "openclaw" },
    },
    timeoutMs: 30_000,
    blockReplyBreak: "message_end" as const,
  };
  queue.items.push({ prompt: "Queued work", enqueuedAt: 1, run: queued });
  return queued;
}
