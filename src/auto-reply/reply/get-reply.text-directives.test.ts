/** Exercises text directive policy and prompt handling through the complete reply pipeline. */
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as sessionAuth from "../../agents/auth-profiles/session-override.js";
import { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import * as questionInput from "../../agents/harness/gateway-question.js";
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
import {
  applySessionExecutionSelection,
  commitSessionExecutionSelection,
} from "../../model-picker/apply-session-model-selection.js";
import { applyModelOverrideToSessionEntry } from "../../plugin-sdk/model-session-runtime.js";
import {
  getSessionEntry,
  patchSessionEntry,
  upsertSessionEntry,
} from "../../plugin-sdk/session-store-runtime.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import type { ReplyPayload } from "../types.js";
import { withFullRuntimeReplyConfig } from "./get-reply-fast-path.js";
import { getReplyFromConfig } from "./get-reply.js";
import { finalizeInboundContext } from "./inbound-context.js";
import { bindPreparedReplyDispatchRuntime } from "./prepared-reply-dispatch-context.js";
import { clearSessionQueues } from "./queue.js";
import { getExistingFollowupQueue } from "./queue/state.js";
import { createReplyOperation } from "./reply-run-registry.js";

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

it("dispatches a configured channel model when the reply has no session selection", async () => {
  state = await createOpenClawTestState({
    label: "reply-channel-selection",
    env: { OPENCLAW_TEST_FAST: "0" },
  });
  const storePath = state.path("alternate", "sessions.json");
  const cfg = withFullRuntimeReplyConfig({
    ...fixtureReplyConfig(state.workspaceDir, storePath),
    channels: { modelByChannel: { webchat: { "*": "fixture/decoy" } } },
  });
  await state.writeConfig(cfg);
  const resolveReply = await prepareFixtureReply(cfg);
  const sessionKey = "agent:main:webchat:channel-control";

  await resolveReply(
    finalizeInboundContext({
      Body: "Continue",
      RawBody: "Continue",
      BodyForAgent: "Continue",
      CommandBody: "Continue",
      CommandSource: "text",
      CommandAuthorized: true,
      Provider: "webchat",
      Surface: "webchat",
      ChatType: "direct",
      SessionKey: sessionKey,
    }),
  );

  expect(runEmbeddedAgent).toHaveBeenCalledWith(
    expect.objectContaining({ provider: "fixture", model: "decoy" }),
  );
  expect(
    loadSessionEntryReadOnly({ agentId: "main", sessionKey, storePath })?.executionSelection,
  ).toMatchObject({
    state: "accepted",
    selection: { model: { provider: "fixture", id: "decoy" } },
  });
});

it.each(["complete", "clear", "replace"] as const)(
  "retains an incomplete public request through a reply before %s",
  async (finish) => {
    state = await createOpenClawTestState({
      label: "reply-partial-selection",
      env: { OPENCLAW_TEST_FAST: "0" },
    });
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:webchat:partial-selection",
      storePath: state.path("alternate", "sessions.json"),
    };
    const base = fixtureReplyConfig(state.workspaceDir, scope.storePath);
    const cfg = withFullRuntimeReplyConfig({
      ...base,
      agents: {
        ...base.agents,
        defaults: {
          ...base.agents.defaults,
          models: {
            ...base.agents.defaults.models,
            "pending/replacement": { agentRuntime: { id: "openclaw" } },
          },
        },
      },
      models: {
        ...base.models,
        providers: { ...base.models.providers, pending: base.models.providers.fixture },
      },
      channels: { modelByChannel: { webchat: { "*": "fixture/decoy" } } },
    });
    await state.writeConfig(cfg);
    const resolveReply = await prepareFixtureReply(cfg);
    await upsertSessionEntry({
      ...scope,
      entry: { sessionId: "reply-partial", updatedAt: Date.now() },
    });
    await patchSessionEntry({ ...scope, update: () => ({ providerOverride: "pending" }) });
    const reply = () =>
      resolveReply(
        finalizeInboundContext({
          Body: "Continue",
          RawBody: "Continue",
          BodyForAgent: "Continue",
          CommandBody: "Continue",
          CommandSource: "text",
          CommandAuthorized: true,
          Provider: "webchat",
          Surface: "webchat",
          ChatType: "direct",
          SessionKey: scope.sessionKey,
        }),
      );

    await reply();

    expect(runEmbeddedAgent).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "fixture", model: "default" }),
    );
    await patchSessionEntry({
      ...scope,
      update: () => ({ modelProvider: "observation", model: "observed" }),
    });
    const pending = getSessionEntry(scope);
    expect(pending?.providerOverride).toBe("pending");
    expect(pending?.modelOverride).toBeUndefined();
    expect(loadSessionEntryReadOnly(scope)?.executionSelection).toMatchObject({
      state: "accepted",
      selection: {
        model: { provider: "fixture", id: "default" },
        executor: { kind: "harness", id: "openclaw" },
      },
    });
    if (finish === "complete") {
      await patchSessionEntry({ ...scope, update: () => ({ modelOverride: "replacement" }) });
    } else if (finish === "clear") {
      await patchSessionEntry({ ...scope, update: () => ({ providerOverride: undefined }) });
    } else {
      await patchSessionEntry({
        ...scope,
        replaceEntry: true,
        update: (entry) => ({
          sessionId: entry.sessionId,
          updatedAt: entry.updatedAt,
          providerOverride: "fixture",
          modelOverride: "parent",
        }),
      });
    }
    vi.mocked(runEmbeddedAgent).mockClear();

    await reply();

    const provider = finish === "complete" ? "pending" : "fixture";
    const model = finish === "complete" ? "replacement" : finish === "clear" ? "default" : "parent";
    expect(runEmbeddedAgent).toHaveBeenCalledWith(expect.objectContaining({ provider, model }));
    const completed = getSessionEntry(scope);
    expect(completed?.executionSelection).toMatchObject({
      state: "accepted",
      selection: { model: { provider, id: model } },
    });
    expect(completed?.executionSelection?.legacyRequest).toBeUndefined();
    if (finish === "clear") {
      expect(completed?.providerOverride).toBeUndefined();
      expect(completed?.modelOverride).toBeUndefined();
    } else {
      expect(completed).toMatchObject({ providerOverride: provider, modelOverride: model });
    }
  },
);

it.each(
  ["auth", "question", "question-queue"].flatMap((boundary) =>
    [false, true].flatMap((mixedDirective) =>
      [false, true].map((changeDuringAdmission) => ({
        boundary,
        mixedDirective,
        changeDuringAdmission,
      })),
    ),
  ),
)(
  "keeps a prepared selection intact across $boundary; mixed=$mixedDirective changed=$changeDuringAdmission",
  async ({ boundary, mixedDirective, changeDuringAdmission }) => {
    state = await createOpenClawTestState({
      label: "reply-selection-admission",
      env: { OPENCLAW_TEST_FAST: "0" },
    });
    const storePath = state.path("sessions.json");
    const sessionKey = "agent:main:selection-admission";
    const scope = { agentId: "main", sessionKey, storePath };
    const entry: SessionEntry = { sessionId: "selection-admission", updatedAt: Date.now() };
    commitSessionExecutionSelection(entry, {
      model: { provider: "fixture", id: "default" },
      executor: { kind: "harness", id: "openclaw" },
    });
    await replaceSessionEntry(scope, entry);
    const cfg = {
      ...fixtureReplyConfig(state.workspaceDir, storePath),
      messages: { queue: { mode: "collect" as const } },
    };
    await state.writeConfig(cfg);
    const resolveReply = await prepareFixtureReply(cfg);
    const admitted = createDeferred();
    const release = createDeferred();
    let paused = false;
    const pause = async (key: string | undefined) => {
      if (key === sessionKey && !paused) {
        paused = true;
        admitted.resolve();
        await release.promise;
      }
    };
    if (boundary === "auth") {
      const resolveAuth = sessionAuth.resolveSessionAuthSelection;
      vi.spyOn(sessionAuth, "resolveSessionAuthSelection").mockImplementation(async (params) => {
        const result = await resolveAuth(params);
        await pause(params.sessionKey);
        return result;
      });
    } else {
      const claimAnswer = questionInput.claimPendingAgentQuestionAnswerFromCaller;
      vi.spyOn(questionInput, "claimPendingAgentQuestionAnswerFromCaller").mockImplementation(
        async (params) => {
          const result = await claimAnswer(params);
          await pause(params.sessionKey);
          return result;
        },
      );
    }
    const activeOperation =
      boundary === "question-queue"
        ? createReplyOperation({
            agentId: "main",
            sessionKey,
            sessionId: entry.sessionId,
            resetTriggered: false,
          })
        : undefined;
    const body = mixedDirective
      ? "/model fixture/parent\nContinue this task."
      : "Continue this task.";
    const pending = resolveReply(
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
        admitted.promise.then(() => ({ kind: "admitted" as const })),
        pending,
      ]);
      if (first.kind === "failed") throw first.error;
      expect(first.kind).toBe("admitted");
      const current = loadSessionEntryReadOnly(scope);
      if (!current) throw new Error("Expected the admitted session");
      expect(current.executionSelection).toMatchObject({
        state: "accepted",
        selection: { model: { provider: "fixture", id: mixedDirective ? "parent" : "default" } },
      });
      if (changeDuringAdmission) {
        const changed = await applySessionExecutionSelection({
          ...scope,
          cfg,
          sessionEntry: current,
          sessionStore: { [sessionKey]: current },
          modelCatalog: [{ provider: "fixture", id: "replacement", name: "Replacement" }],
          request: { kind: "model", model: { provider: "fixture", id: "replacement" } },
        });
        expect(changed.status).toBe("applied");
      }
      const committed = loadSessionEntryReadOnly(scope)?.executionSelection;
      release.resolve();
      const result = await pending;
      if (result.kind === "failed") throw result.error;
      if (changeDuringAdmission) {
        expect([result.value].flat()).toContainEqual(
          expect.objectContaining({
            text: "Session settings changed while preparing this reply. Please try again.",
            isError: true,
          }),
        );
        expect(runEmbeddedAgent).not.toHaveBeenCalled();
        expect(getExistingFollowupQueue(sessionKey)?.items ?? []).toHaveLength(0);
      } else if (activeOperation) {
        expect(runEmbeddedAgent).not.toHaveBeenCalled();
        expect(getExistingFollowupQueue(sessionKey)?.items).toHaveLength(1);
        expect(
          getExistingFollowupQueue(sessionKey)?.items[0]?.run.executionSelection,
        ).toMatchObject({
          model: { provider: "fixture", id: mixedDirective ? "parent" : "default" },
        });
      } else {
        expect(runEmbeddedAgent).toHaveBeenCalledOnce();
        expect(runEmbeddedAgent).toHaveBeenCalledWith(
          expect.objectContaining({
            provider: "fixture",
            model: mixedDirective ? "parent" : "default",
          }),
        );
      }
      expect(loadSessionEntryReadOnly(scope)?.executionSelection).toEqual(committed);
    } finally {
      release.resolve();
      await pending;
      clearSessionQueues([sessionKey]);
      activeOperation?.complete();
    }
  },
);

it.each(["new", "deferred", "accepted"])(
  "continues an informational model directive with a task from a %s session",
  async (initialState) => {
    state = await createOpenClawTestState({
      label: "reply-model-info-continuation",
      env: { OPENCLAW_TEST_FAST: "0" },
    });
    const storePath = state.path("sessions.json");
    const sessionKey = "agent:main:model-info-continuation";
    const scope = { agentId: "main", sessionKey, storePath };
    const cfg = fixtureReplyConfig(state.workspaceDir, storePath);
    await state.writeConfig(cfg);
    const resolveReply = await prepareFixtureReply(cfg);
    if (initialState === "deferred") {
      await upsertSessionEntry({
        ...scope,
        entry: { sessionId: "model-info-continuation", updatedAt: Date.now() },
      });
      const entry = getSessionEntry(scope);
      if (!entry) throw new Error("Expected the released session view");
      applyModelOverrideToSessionEntry({
        entry,
        selection: { provider: "fixture", model: "parent", isDefault: false },
      });
      await upsertSessionEntry({ ...scope, entry });
      expect(loadSessionEntryReadOnly(scope)?.executionSelection?.state).toBe("deferred");
    } else if (initialState === "accepted") {
      const entry: SessionEntry = { sessionId: "model-info-continuation", updatedAt: Date.now() };
      commitSessionExecutionSelection(entry, {
        model: { provider: "fixture", id: "parent" },
        executor: { kind: "harness", id: "openclaw" },
      });
      await replaceSessionEntry(scope, entry);
    }
    const before = loadSessionEntryReadOnly(scope)?.executionSelection;
    const notices: ReplyPayload[] = [];
    const body = "/model status\nContinue this task.";
    await resolveReply(
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
      {
        onBlockReply: async (payload) => {
          notices.push(payload);
        },
      },
    );
    const model = initialState === "new" ? "default" : "parent";
    expect(runEmbeddedAgent).toHaveBeenCalledOnce();
    expect(runEmbeddedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "fixture",
        model,
        prompt: expect.stringContaining("Continue this task."),
      }),
    );
    expect(loadSessionEntryReadOnly(scope)?.executionSelection).toMatchObject({
      state: "accepted",
      selection: { model: { provider: "fixture", id: model } },
    });
    if (initialState === "accepted") {
      expect(loadSessionEntryReadOnly(scope)?.executionSelection).toEqual(before);
    }
    expect(notices).toContainEqual(
      expect.objectContaining({ isStatusNotice: true, text: expect.stringContaining("Current:") }),
    );
  },
);
