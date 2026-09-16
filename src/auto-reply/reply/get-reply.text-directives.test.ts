/** Exercises text directive policy and prompt handling through the complete reply pipeline. */
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import * as runtimeChoice from "../../agents/model-runtime-choice.js";
import {
  loadPublishedGatewayReplyDispatchRuntime,
  refreshPreparedModelRuntimeSnapshots,
} from "../../agents/prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../../agents/prepared-model-runtime.test-support.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { ModelDefinitionConfig } from "../../config/types.models.js";
import { commitSessionExecutionSelection } from "../../model-picker/apply-session-model-selection.js";
import { applyModelOverrideToSessionEntry } from "../../plugin-sdk/model-session-runtime.js";
import { getSessionEntry, upsertSessionEntry } from "../../plugin-sdk/session-store-runtime.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { withFullRuntimeReplyConfig } from "./get-reply-fast-path.js";
import { getReplyFromConfig } from "./get-reply.js";
import { finalizeInboundContext } from "./inbound-context.js";
import { bindPreparedReplyDispatchRuntime } from "./prepared-reply-dispatch-context.js";

vi.mock("../../agents/embedded-agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/embedded-agent.js")>()),
  runEmbeddedAgent: vi.fn(async () => ({
    payloads: [{ text: "The output is ready." }],
    meta: { durationMs: 1 },
  })),
}));

function fixtureReplyConfig(workspace: string, storePath?: string) {
  return withFullRuntimeReplyConfig({
    ...(storePath ? { session: { store: storePath } } : {}),
    agents: {
      ownership: "explicit",
      entries: { main: {} },
      defaults: {
        workspace,
        skipBootstrap: true,
        model: { primary: "fixture/default" },
        models: Object.fromEntries(
          ["default", "parent", "decoy", "replacement"].map((id) => [
            "fixture/" + id,
            { agentRuntime: { id: "openclaw" } },
          ]),
        ),
      },
    },
    models: {
      mode: "replace",
      providers: {
        fixture: {
          baseUrl: "http://127.0.0.1:1/v1",
          api: "openai-responses",
          apiKey: "synthetic-local-fixture",
          request: { allowPrivateNetwork: true },
          models: ["default", "parent", "decoy", "replacement"].map(
            (id): ModelDefinitionConfig => ({
              id,
              name: id,
              api: "openai-responses",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 4096,
            }),
          ),
        },
      },
    },
    plugins: { enabled: false },
    commands: { text: true },
  });
}

async function prepareFixtureReply(cfg: ReturnType<typeof fixtureReplyConfig>) {
  await refreshPreparedModelRuntimeSnapshots(cfg, {
    gatewayLifecycle: true,
    catalogMode: "static",
  });
  const runtime = await loadPublishedGatewayReplyDispatchRuntime({ agentId: "main" });
  if (!runtime) throw new Error("Expected the published reply runtime");
  return bindPreparedReplyDispatchRuntime(runtime, getReplyFromConfig);
}

let state: OpenClawTestState | undefined;
afterEach(async () => {
  await resetPreparedModelRuntimeSnapshotsForTest();
  await state?.cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it.each([" ", "\n"])("runs a task after text exec policy separated by %j", async (separator) => {
  state = await createOpenClawTestState({
    label: "text-directive-reply",
    env: { OPENCLAW_TEST_FAST: "0" },
  });
  const cfg = fixtureReplyConfig(state.workspaceDir);
  await state.writeConfig(cfg);
  const resolveReply = await prepareFixtureReply(cfg);
  const body = `/exec security=deny ask=always${separator}Explain the output.`;
  const reply = await resolveReply(
    finalizeInboundContext({
      Body: body,
      RawBody: body,
      BodyForAgent: body,
      CommandBody: body,
      CommandSource: "text",
      CommandAuthorized: true,
      Provider: "webchat",
      Surface: "webchat",
      ChatType: "direct",
      SessionKey: "agent:main:text-directive-proof",
    }),
  );

  expect([reply].flat()).toEqual([expect.objectContaining({ text: "The output is ready." })]);
  expect(runEmbeddedAgent).toHaveBeenCalledOnce();
  const input = vi.mocked(runEmbeddedAgent).mock.calls[0]![0];
  expect(input.prompt).toContain("Explain the output.");
  expect(input.prompt).not.toContain("/exec");
  expect(input.execOverrides).toMatchObject({ security: "deny", ask: "always" });
});

it.each([false, true])(
  "initializes an SDK default from the actual parent store; parent changes while awaiting=%s",
  async (changeParent) => {
    state = await createOpenClawTestState({
      label: "reply-sdk-parent-scope",
      env: { OPENCLAW_TEST_FAST: "0" },
    });
    const storePath = state.path("alternate", "sessions.json");
    const parentKey = "agent:main:webchat:channel:parent";
    const sessionKey = parentKey + ":thread:child";
    const parentScope = { agentId: "main", sessionKey: parentKey, storePath };
    const childScope = { agentId: "main", sessionKey, storePath };
    const parent: SessionEntry = { sessionId: "reply-parent", updatedAt: 1 };
    commitSessionExecutionSelection(
      parent,
      {
        model: { provider: "fixture", id: "parent" },
        executor: { kind: "harness", id: "openclaw" },
      },
      { cause: { kind: "user" } },
    );
    await replaceSessionEntry(parentScope, parent);
    const decoy: SessionEntry = { sessionId: "other-store-parent", updatedAt: 1 };
    commitSessionExecutionSelection(
      decoy,
      {
        model: { provider: "fixture", id: "decoy" },
        executor: { kind: "harness", id: "openclaw" },
      },
      { cause: { kind: "reset" } },
    );
    await replaceSessionEntry({ agentId: "main", sessionKey: parentKey }, decoy);
    await upsertSessionEntry({
      ...childScope,
      entry: { sessionId: "reply-child", updatedAt: Date.now() },
    });
    const view = getSessionEntry(childScope);
    if (!view) throw new Error("Expected the released child view");
    applyModelOverrideToSessionEntry({
      entry: view,
      selection: { provider: "fixture", model: "default", isDefault: true },
    });
    await upsertSessionEntry({ ...childScope, entry: view });
    const staged = loadSessionEntryReadOnly(childScope);
    expect(staged?.parentSessionKey).toBeUndefined();
    expect(staged?.executionSelection).toMatchObject({
      state: "deferred",
      request: { defaultSelection: "inherit" },
    });
    const cfg = fixtureReplyConfig(state.workspaceDir, storePath);
    await state.writeConfig(cfg);
    const resolveReply = await prepareFixtureReply(cfg);
    const evaluating = createDeferred();
    const release = createDeferred();
    const evaluate = runtimeChoice.evaluatePublishedModelRuntimeChoice;
    vi.spyOn(runtimeChoice, "evaluatePublishedModelRuntimeChoice").mockImplementation(
      async (params) => {
        const result = await evaluate(params);
        if (params.provider === "fixture" && params.model === "parent") {
          if (result.kind !== "ready") throw new Error(result.message);
          evaluating.resolve();
          await release.promise;
        }
        return result;
      },
    );
    const body = "Continue this thread.";
    const reply = resolveReply(
      finalizeInboundContext({
        Body: body,
        RawBody: body,
        BodyForAgent: body,
        CommandBody: body,
        CommandSource: "text",
        CommandAuthorized: true,
        Provider: "webchat",
        Surface: "webchat",
        ChatType: "direct",
        SessionKey: sessionKey,
      }),
    ).then(
      (value) => ({ kind: "completed" as const, value }),
      (error) => ({ kind: "failed" as const, error }),
    );
    try {
      const first = await Promise.race([
        evaluating.promise.then(() => ({ kind: "evaluating" as const })),
        reply,
      ]);
      if (first.kind === "failed") throw first.error;
      expect(first.kind).toBe("evaluating");
      if (changeParent) {
        const current = loadSessionEntryReadOnly(parentScope);
        if (!current) throw new Error("Expected the actual parent row");
        commitSessionExecutionSelection(
          current,
          {
            model: { provider: "fixture", id: "replacement" },
            executor: { kind: "harness", id: "openclaw" },
          },
          { cause: { kind: "user" } },
        );
        await replaceSessionEntry(parentScope, current);
      }
      release.resolve();
      const outcome = await reply;
      if (changeParent) {
        expect(outcome).toMatchObject({
          kind: "failed",
          error: new Error("The parent session selection changed. Retry the turn."),
        });
        expect(runEmbeddedAgent).not.toHaveBeenCalled();
        expect(loadSessionEntryReadOnly(childScope)?.executionSelection).toEqual(
          staged?.executionSelection,
        );
      } else {
        expect(outcome.kind).toBe("completed");
        expect(runEmbeddedAgent).toHaveBeenCalledWith(
          expect.objectContaining({ provider: "fixture", model: "parent" }),
        );
        expect(loadSessionEntryReadOnly(childScope)?.executionSelection).toEqual({
          state: "accepted",
          selection: {
            model: { provider: "fixture", id: "parent" },
            executor: { kind: "harness", id: "openclaw" },
          },
          fallbackPermission: "explicit",
        });
      }
      expect(
        loadSessionEntryReadOnly({ agentId: "main", sessionKey: parentKey })?.executionSelection,
      ).toEqual(decoy.executionSelection);
    } finally {
      release.resolve();
      await reply;
    }
  },
);
