import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { projectPublicSessionEntry } from "../../config/sessions/session-entry-projection.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isAgentSessionModelPatchOrigin } from "../../gateway/session-model-patch-origin.js";
import {
  applySessionExecutionSelection,
  commitStoredSessionExecutionSelection,
  commitSessionExecutionSelection,
  createAgentPatchedSessionModelFallback,
} from "../../model-picker/apply-session-model-selection.js";
import type { ExecutionFallbackPermission } from "../../model-picker/execution-selection.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { acceptedModelSelection } from "../../test-utils/session-execution-selection.js";
import * as failoverErrors from "../failover-error.js";
import { evaluatePublishedModelRuntimeChoice } from "../model-runtime-choice.js";
import { createAgentPatchedSessionModelRunGuard } from "../session-model-auto-revert.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";
import { createSessionsTool } from "./sessions-tool.js";

type AgentToolGatewayRequest = Parameters<AgentToolGatewayRequestCaller>[0];

const gatewayMocks = vi.hoisted(() => ({ callGateway: vi.fn(), generation: 0 }));
vi.mock("../model-runtime-choice.js", () => ({ evaluatePublishedModelRuntimeChoice: vi.fn() }));
vi.mock("../../gateway/call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../gateway/call.js")>()),
  callGateway: gatewayMocks.callGateway,
}));

beforeEach(() => {
  gatewayMocks.callGateway.mockReset();
  gatewayMocks.generation++;
  vi.mocked(evaluatePublishedModelRuntimeChoice).mockImplementation(async ({ provider, model }) => {
    const generation = gatewayMocks.generation;
    return {
      kind: "ready",
      entry: { provider, id: model, name: "Restored model" },
      validate: () =>
        generation === gatewayMocks.generation
          ? undefined
          : "The model catalog changed. Try again.",
    };
  });
});

describe("sessions tool model recovery", () => {
  it("patches its session, then reverts a failed agent-selected model", async () => {
    await withTestDir({ prefix: "openclaw-sessions-tool-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const sessionKey = "agent:main:main";
      const cfg: OpenClawConfig = {
        session: { store: storePath },
        agents: { defaults: { model: { primary: "openai/good" } } },
      };
      const sessionScope = { agentId: "main", sessionKey, storePath };
      await upsertSessionEntryCore(sessionScope, {
        sessionId: "session-main",
        updatedAt: 1,
        model: "good",
        modelProvider: "openai",
        executionSelection: acceptedModelSelection("openai", "good", {
          fallbackPermission: "configured",
        }),
        authProfileOverride: "good-profile",
        authProfileOverrideSource: "user",
        thinkingLevel: "high",
      });
      const callGateway = vi.fn(
        async (request: { method: string; params: Record<string, unknown> }) => {
          expect(request.method).toBe("sessions.patch");
          expect(isAgentSessionModelPatchOrigin()).toBe(true);
          await patchSessionEntryCore(sessionScope, () => ({
            label: request.params.label as string,
            model: "bad",
            modelProvider: "broken",
            executionSelection: acceptedModelSelection("broken", "bad"),
            authProfileOverride: "bad-profile",
            authProfileOverrideSource: "user",
            thinkingLevel: "low",
            modelFallback: {
              previous: acceptedModelSelection("openai", "good", {
                fallbackPermission: "configured",
              }),
              prevModel: "good",
              prevProvider: "openai",
              prevAuthProfileOverride: "good-profile",
              prevAuthProfileOverrideSource: "user",
              prevThinkingLevel: "high",
              ts: Date.now(),
              source: "agent-patch",
            },
          }));
          return { ok: true };
        },
      );
      const tool = createSessionsTool({
        agentSessionKey: sessionKey,
        config: cfg,
        callGateway: callGateway as never,
      });
      const guardParams = { cfg, ...sessionScope };
      const currentRunGuard = createAgentPatchedSessionModelRunGuard(guardParams);
      const failedCurrentRunGuard = createAgentPatchedSessionModelRunGuard(guardParams);

      await tool.execute("patch-model", {
        action: "patch",
        label: "Research",
        model: "broken/bad",
      });

      expect(callGateway).toHaveBeenCalledWith({
        method: "sessions.patch",
        params: {
          key: sessionKey,
          label: "Research",
          model: "broken/bad",
        },
      });
      expect(loadSessionEntry(sessionScope)).toMatchObject({
        label: "Research",
        modelFallback: {
          previous: acceptedModelSelection("openai", "good", { fallbackPermission: "configured" }),
          prevModel: "good",
          prevProvider: "openai",
          prevAuthProfileOverride: "good-profile",
          prevThinkingLevel: "high",
          source: "agent-patch",
        },
      });
      await currentRunGuard.finish(true);
      expect(loadSessionEntry(sessionScope)).toHaveProperty("modelFallback");

      const failure = { status: 404, message: "No endpoints found for broken/bad." };
      const entryBeforeFailure = loadSessionEntry(sessionScope);
      const transcriptScope = { ...sessionScope, sessionId: "session-main" };
      const transcriptBeforeFailure = await loadTranscriptEvents(transcriptScope);
      const classifyFailure = vi
        .spyOn(failoverErrors, "resolveFailoverReasonFromError")
        .mockImplementation(() => {
          throw new Error("An unarmed model-patch guard must not classify failures");
        });
      try {
        expect(failedCurrentRunGuard.captureFallbackFailure([])).toBeUndefined();
        expect(failedCurrentRunGuard.captureFailure(failure)).toBe(false);
        expect(
          failedCurrentRunGuard.captureFallbackFailure([
            { error: failure.message, reason: "model_not_found" },
          ]),
        ).toBe(false);
        await failedCurrentRunGuard.fail(failure);
        expect(classifyFailure).not.toHaveBeenCalled();
      } finally {
        classifyFailure.mockRestore();
      }
      expect(loadSessionEntry(sessionScope)).toEqual(entryBeforeFailure);
      expect(await loadTranscriptEvents(transcriptScope)).toEqual(transcriptBeforeFailure);

      const runGuard = createAgentPatchedSessionModelRunGuard(guardParams);
      await runGuard.fail(failure);
      expect(loadSessionEntry(sessionScope)).toMatchObject({
        executionSelection: acceptedModelSelection("openai", "good", {
          fallbackPermission: "configured",
        }),
        authProfileOverride: "good-profile",
        thinkingLevel: "high",
      });
      expect(loadSessionEntry(sessionScope)).not.toHaveProperty("modelFallback");
      const events = await loadTranscriptEvents(transcriptScope);
      expect(events).toContainEqual(
        expect.objectContaining({
          message: expect.objectContaining({
            customType: "openclaw.system-note",
            content:
              "The requested model could not be used. Restored the previous selection. Now using Restored model in OpenClaw.",
          }),
        }),
      );
      expect(events).not.toContainEqual(
        expect.objectContaining({
          message: expect.objectContaining({
            customType: "openclaw.system-note",
            excludeFromContext: expect.anything(),
          }),
        }),
      );
    });
  });

  it.each<{
    name: string;
    explicitDefault?: boolean;
    legacySource?: "user" | "auto";
    parentPermission: ExecutionFallbackPermission;
    initialize?: boolean;
  }>([
    { name: "absent child", parentPermission: "explicit" },
    { name: "explicit Default", explicitDefault: true, parentPermission: "explicit" },
    { name: "unfinished user request", legacySource: "user", parentPermission: "configured" },
    { name: "unfinished automatic request", legacySource: "auto", parentPermission: "explicit" },
    {
      name: "initialized unfinished user request",
      legacySource: "user",
      parentPermission: "configured",
      initialize: true,
    },
    {
      name: "initialized unfinished automatic request",
      legacySource: "auto",
      parentPermission: "explicit",
      initialize: true,
    },
  ])(
    "restores $name after a failed tool patch",
    async ({ explicitDefault, legacySource, parentPermission, initialize }) => {
      await withTestDir({ prefix: "openclaw-session-parent-rollback-" }, async (dir) => {
        const storePath = path.join(dir, "selected.sqlite");
        const sessionKey = "agent:main:child";
        const parentKey = "agent:main:parent";
        const cfg: OpenClawConfig = {
          agents: { defaults: { model: { primary: "fixture/default" } } },
        };
        const scope = { agentId: "main", sessionKey, storePath };
        await upsertSessionEntryCore(
          { ...scope, sessionKey: parentKey },
          {
            sessionId: "parent",
            updatedAt: 1,
            executionSelection: acceptedModelSelection("fixture", "inherited", {
              fallbackPermission: parentPermission,
            }),
          },
        );
        const child: SessionEntry = {
          sessionId: "child",
          updatedAt: 1,
          parentSessionKey: parentKey,
        };
        if (explicitDefault) {
          commitStoredSessionExecutionSelection(child, {
            state: "deferred",
            request: { defaultSelection: "configured" },
            fallbackPermission: "configured",
          });
        }
        const legacyRequest = legacySource
          ? { provider: "provider-later", source: legacySource }
          : undefined;
        const fallbackPermission =
          explicitDefault || legacySource === "auto"
            ? "configured"
            : legacySource === "user"
              ? "explicit"
              : parentPermission;
        if (legacyRequest) {
          commitStoredSessionExecutionSelection(child, {
            state: "deferred",
            request: { defaultSelection: "inherit" },
            fallbackPermission,
            legacyRequest,
          });
        }
        await upsertSessionEntryCore(scope, child);
        if (initialize) {
          const initialized = await applySessionExecutionSelection({
            cfg,
            ...scope,
            request: { kind: "initialize" },
            modelCatalog: [{ provider: "fixture", id: "inherited", name: "Inherited model" }],
          });
          expect(initialized.status).toBe("applied");
          expect(loadSessionEntry(scope)?.executionSelection).toEqual({
            ...acceptedModelSelection("fixture", "inherited", {
              fallbackPermission,
            }),
            legacyRequest,
          });
        }
        const saved = loadSessionEntry(scope);
        if (!saved) {
          throw new Error("Expected the saved child");
        }
        const before = projectPublicSessionEntry(saved);
        expect(before.providerOverride).toBe(legacyRequest?.provider);
        expect(before.modelOverrideSource).toBe(explicitDefault ? "default" : legacySource);
        const callGateway = vi.fn().mockImplementation(async (request: AgentToolGatewayRequest) => {
          expect(request).toEqual({
            method: "sessions.patch",
            params: { key: sessionKey, model: "fixture/unavailable" },
          });
          await patchSessionEntryCore(scope, (entry) => {
            const snapshot = createAgentPatchedSessionModelFallback({
              entry,
              provider: "observed",
              model: "output",
              ts: 1,
            });
            const next = { ...entry };
            commitSessionExecutionSelection(next, {
              model: { provider: "fixture", id: "unavailable" },
              executor: { kind: "harness", id: "openclaw" },
            });
            next.modelFallback = snapshot;
            return next;
          });
          return { ok: true };
        });
        const tool = createSessionsTool({ agentSessionKey: sessionKey, config: cfg, callGateway });
        await tool.execute("patch-for-rollback", { action: "patch", model: "fixture/unavailable" });
        const patched = loadSessionEntry(scope);
        if (!patched) {
          throw new Error("Expected the patched child");
        }
        expect(projectPublicSessionEntry(patched).modelFallback?.prevModelOverrideSource).toBe(
          explicitDefault ? "default" : legacySource,
        );
        await createAgentPatchedSessionModelRunGuard({ cfg, ...scope }).fail({
          status: 404,
          message: "Model not found",
        });
        const restored = loadSessionEntry(scope);
        expect(restored?.executionSelection).toEqual({
          ...acceptedModelSelection("fixture", explicitDefault ? "default" : "inherited", {
            fallbackPermission,
          }),
          ...(legacyRequest ? { legacyRequest } : {}),
        });
        if (!restored) {
          throw new Error("Expected the restored child");
        }
        if (legacyRequest) {
          expect(projectPublicSessionEntry(restored).providerOverride).toBe(legacyRequest.provider);
          expect(projectPublicSessionEntry(restored).modelOverrideSource).toBe(
            legacyRequest.source,
          );
        }
        expect(restored.modelFallback).toBeUndefined();
        expect(loadSessionEntry({ ...scope, sessionKey: parentKey })?.executionSelection).toEqual(
          acceptedModelSelection("fixture", "inherited", { fallbackPermission: parentPermission }),
        );
      });
    },
  );

  it("clears the model fallback marker after a successful run", async () => {
    await withTestDir({ prefix: "openclaw-sessions-tool-success-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const sessionKey = "agent:main:main";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey, storePath },
        {
          sessionId: "session-main",
          updatedAt: 1,
          modelFallback: {
            previous: acceptedModelSelection("openai", "good", {
              fallbackPermission: "configured",
            }),
            prevModel: "good",
            prevProvider: "openai",
            ts: 1,
            source: "agent-patch",
          },
        },
      );

      await createAgentPatchedSessionModelRunGuard({
        cfg: {},
        agentId: "main",
        sessionKey,
        storePath,
      }).finish(true);
      expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).not.toHaveProperty(
        "modelFallback",
      );
    });
  });
  it("reverts when the patched model fails but a fallback completes the run", async () => {
    await withTestDir({ prefix: "openclaw-sessions-tool-fallback-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const sessionKey = "agent:main:main";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey, storePath },
        {
          sessionId: "session-main",
          updatedAt: 1,
          model: "bad",
          modelProvider: "broken",
          executionSelection: acceptedModelSelection("broken", "bad"),
          modelFallback: {
            previous: acceptedModelSelection("openai", "good", {
              fallbackPermission: "configured",
            }),
            prevModel: "good",
            prevProvider: "openai",
            ts: 1,
            source: "agent-patch",
          },
        },
      );
      const runGuard = createAgentPatchedSessionModelRunGuard({
        cfg: {},
        agentId: "main",
        sessionKey,
        storePath,
      });

      const needsRevert = runGuard.captureFallbackFailure([
        {
          error: "No endpoints found for broken/bad.",
          reason: "model_not_found",
        },
        { error: "Fallback context overflow.", reason: "context_overflow" },
      ]);
      await runGuard.finish(!needsRevert);

      expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).toMatchObject({
        executionSelection: acceptedModelSelection("openai", "good", {
          fallbackPermission: "configured",
        }),
      });
      expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).not.toHaveProperty(
        "modelFallback",
      );
    });
  });

  it("promotes the newest validated model across overlapping patches", async () => {
    await withTestDir({ prefix: "openclaw-sessions-tool-overlap-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const sessionKey = "agent:main:main";
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "openai/a" } } },
      };
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey, storePath },
        {
          sessionId: "session-main",
          updatedAt: 1,
          model: "b",
          modelProvider: "openai",
          executionSelection: acceptedModelSelection("openai", "b"),
          modelFallback: {
            previous: acceptedModelSelection("openai", "a", { fallbackPermission: "configured" }),
            prevModel: "a",
            prevProvider: "openai",
            ts: 10,
            source: "agent-patch",
          },
        },
      );
      const runB = createAgentPatchedSessionModelRunGuard({
        cfg,
        agentId: "main",
        sessionKey,
        storePath,
      });
      await patchSessionEntryCore({ agentId: "main", sessionKey, storePath }, () => ({
        model: "c",
        executionSelection: acceptedModelSelection("openai", "c"),
        modelFallback: {
          previous: acceptedModelSelection("openai", "a", { fallbackPermission: "configured" }),
          prevModel: "a",
          prevProvider: "openai",
          ts: 20,
          source: "agent-patch",
        },
      }));
      const runC = createAgentPatchedSessionModelRunGuard({
        cfg,
        agentId: "main",
        sessionKey,
        storePath,
      });
      await patchSessionEntryCore({ agentId: "main", sessionKey, storePath }, () => ({
        model: "d",
        executionSelection: acceptedModelSelection("openai", "d"),
        modelFallback: {
          previous: acceptedModelSelection("openai", "a", { fallbackPermission: "configured" }),
          prevModel: "a",
          prevProvider: "openai",
          ts: 30,
          source: "agent-patch",
        },
      }));
      const runD = createAgentPatchedSessionModelRunGuard({
        cfg,
        agentId: "main",
        sessionKey,
        storePath,
      });

      await runC.finish(true);
      await runB.finish(true);
      expect(
        loadSessionEntry({ agentId: "main", sessionKey, storePath })?.modelFallback,
      ).toMatchObject({
        previous: acceptedModelSelection("openai", "c"),
        lastValidatedPatchTs: 20,
        ts: 30,
      });

      await runD.fail({ status: 404, message: "No endpoints found for openai/d." });
      expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).toMatchObject({
        executionSelection: acceptedModelSelection("openai", "c"),
      });
    });
  });
});
