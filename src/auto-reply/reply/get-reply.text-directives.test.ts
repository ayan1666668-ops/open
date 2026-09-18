/** Exercises text directive policy and prompt handling through the complete reply pipeline. */
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createApiKeyCredential } from "../../agents/auth-profiles/credential-fixtures.test-support.js";
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
import type { OpenClawConfig } from "../../config/types.openclaw.js";
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
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import { finalizeInboundContext } from "./inbound-context.js";
import * as replyModelSelection from "./model-selection.js";
import { bindPreparedReplyDispatchRuntime } from "./prepared-reply-dispatch-context.js";
import { clearSessionQueues } from "./queue.js";
import { getExistingFollowupQueue } from "./queue/state.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import { createReplyOperation } from "./reply-run-registry.js";
import type { TypingController } from "./typing.js";

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

async function prepareFixtureReply(cfg: OpenClawConfig) {
  await refreshPreparedModelRuntimeSnapshots(cfg, {
    gatewayLifecycle: true,
    catalogMode: "static",
  });
  const runtime = await loadPublishedGatewayReplyDispatchRuntime({ agentId: "main" });
  if (!runtime) {
    throw new Error("Expected the published reply runtime");
  }
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
    if (!view) {
      throw new Error("Expected the released child view");
    }
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
          if (result.kind !== "ready") {
            throw new Error(`Expected ready fixture, got ${result.kind}`);
          }
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
      (error: unknown) => ({ kind: "failed" as const, error }),
    );
    try {
      const first = await Promise.race([
        evaluating.promise.then(() => ({ kind: "evaluating" as const })),
        reply,
      ]);
      if (first.kind === "failed") {
        throw first.error;
      }
      expect(first.kind).toBe("evaluating");
      if (changeParent) {
        const current = loadSessionEntryReadOnly(parentScope);
        if (!current) {
          throw new Error("Expected the actual parent row");
        }
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
          kind: "completed",
          value: { text: "The parent session selection changed. Retry the turn.", isError: true },
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
      const resolveAuth = sessionAuth.prepareSessionAuthSelection;
      vi.spyOn(sessionAuth, "prepareSessionAuthSelection").mockImplementation(async (params) => {
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
      (error: unknown) => ({ kind: "failed" as const, error }),
    );
    try {
      const first = await Promise.race([
        admitted.promise.then(() => ({ kind: "admitted" as const })),
        pending,
      ]);
      if (first.kind === "failed") {
        throw first.error;
      }
      expect(first.kind).toBe("admitted");
      const current = loadSessionEntryReadOnly(scope);
      if (!current) {
        throw new Error("Expected the admitted session");
      }
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
      if (result.kind === "failed") {
        throw result.error;
      }
      if (changeDuringAdmission) {
        expect([result.value].flat()).toContainEqual(
          expect.objectContaining({
            text:
              boundary === "auth"
                ? "The session changed during model preparation. Try again."
                : "Session settings changed while preparing this reply. Please try again.",
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
      if (!entry) {
        throw new Error("Expected the released session view");
      }
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
    expect(notices).toEqual([]);
  },
);

it.each(["abort", "replace", "queued-abort"] as const)(
  "does not commit selection or account when %s invalidates actual reply preparation",
  async (change) => {
    state = await createOpenClawTestState({
      label: "reply-preparation-lifetime",
      env: { OPENCLAW_TEST_FAST: "0" },
    });
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:preparation-lifetime",
      storePath: state.path("sessions.json"),
    };
    await upsertSessionEntry({
      ...scope,
      entry: { sessionId: "preparation-lifetime", updatedAt: Date.now() },
    });
    const view = getSessionEntry(scope);
    if (!view) {
      throw new Error("Expected the released session view");
    }
    applyModelOverrideToSessionEntry({
      entry: view,
      selection: { provider: "fixture", model: "parent", isDefault: false },
    });
    await upsertSessionEntry({ ...scope, entry: view });
    await state.writeAuthProfiles({
      version: 1,
      profiles: { "fixture:shared": createApiKeyCredential("fixture", "synthetic-shared-key") },
    });
    const cfg = {
      ...fixtureReplyConfig(state.workspaceDir, scope.storePath),
      messages: { queue: { mode: "interrupt" as const } },
    };
    await state.writeConfig(cfg);
    const resolveReply = await prepareFixtureReply(cfg);
    const before = loadSessionEntryReadOnly(scope);
    expect(before?.executionSelection?.state).toBe("deferred");
    expect(before?.authProfileOverride).toBeUndefined();
    const authSpy = vi.spyOn(sessionAuth, "prepareSessionAuthSelection");
    const waiting = createDeferred();
    const activeOperation =
      change === "queued-abort"
        ? createReplyOperation({
            agentId: "main",
            sessionKey: scope.sessionKey,
            sessionId: view.sessionId,
            resetTriggered: false,
          })
        : undefined;
    activeOperation?.setPhase("running");
    activeOperation?.abortSignal.addEventListener("abort", () => waiting.resolve(), { once: true });
    let preparationParams:
      | Parameters<typeof replyModelSelection.createModelSelectionState>[0]
      | undefined;
    const createModelState = replyModelSelection.createModelSelectionState;
    vi.spyOn(replyModelSelection, "createModelSelectionState").mockImplementation(
      async (params) => {
        preparationParams = params;
        return createModelState(params);
      },
    );
    let holdReadiness = change !== "queued-abort";
    const evaluating = createDeferred();
    const release = createDeferred();
    const evaluate = runtimeChoice.evaluatePublishedModelRuntimeChoice;
    vi.spyOn(runtimeChoice, "evaluatePublishedModelRuntimeChoice").mockImplementation(
      async (params) => {
        const result = await evaluate(params);
        if (holdReadiness && params.provider === "fixture" && params.model === "parent") {
          if (result.kind !== "ready") {
            throw new Error(`Expected ready fixture, got ${result.kind}`);
          }
          evaluating.resolve();
          await release.promise;
        }
        return result;
      },
    );
    const abort = new AbortController();
    const runState: ReplyOperationRunState = {};
    let typing: TypingController | undefined;
    const options: InternalGetReplyOptions = {
      abortSignal: abort.signal,
      [REPLY_OPERATION_RUN_STATE]: runState,
      onTypingController: (controller) => {
        typing = controller;
        vi.spyOn(controller, "cleanup");
      },
    };
    const pending = resolveReply(
      finalizeInboundContext({
        Body: "Continue this task.",
        CommandSource: "text",
        CommandAuthorized: true,
        Provider: "webchat",
        Surface: "webchat",
        ChatType: "direct",
        SessionKey: scope.sessionKey,
      }),
      options,
    ).then(
      (value) => ({ kind: "completed" as const, value }),
      (error: unknown) => ({ kind: "failed" as const, error }),
    );
    try {
      if (activeOperation) {
        const wait = await Promise.race([
          waiting.promise.then(() => ({ kind: "waiting" as const })),
          pending,
        ]);
        if (wait.kind === "failed") {
          throw wait.error;
        }
        expect(wait.kind).toBe("waiting");
        if (!preparationParams?.sessionEntry || !preparationParams.sessionStore) {
          throw new Error("Expected the actual reply session working set");
        }
        expect(preparationParams.sessionEntry.authProfileOverride).toBe("fixture:shared");
        await sessionAuth.clearSessionAuthProfileOverride({
          sessionEntry: preparationParams.sessionEntry,
          sessionStore: preparationParams.sessionStore,
          sessionKey: scope.sessionKey,
          storePath: scope.storePath,
        });
        holdReadiness = true;
        activeOperation.complete();
      }
      const first = await Promise.race([
        evaluating.promise.then(() => ({ kind: "evaluating" as const })),
        pending,
      ]);
      if (first.kind === "failed") {
        throw first.error;
      }
      expect(first.kind).toBe("evaluating");
      await expect(authSpy.mock.results.at(-1)?.value).resolves.toMatchObject({
        selection: { profileId: "fixture:shared", source: "auto" },
      });
      if (change !== "replace") {
        abort.abort(new Error("Canceled by the caller"));
      } else {
        await replaceSessionEntry(scope, {
          sessionId: "replacement-session",
          updatedAt: Date.now(),
        });
      }
      const unchanged = loadSessionEntryReadOnly(scope);
      release.resolve();
      const outcome = await pending;
      if (change !== "replace") {
        expect(outcome).toMatchObject({ kind: "failed", error: { name: "AbortError" } });
        if (change === "abort") {
          expect(unchanged?.executionSelection).toEqual(before?.executionSelection);
        } else {
          expect(unchanged?.executionSelection?.state).toBe("accepted");
        }
      } else {
        expect(outcome).toMatchObject({
          kind: "completed",
          value: {
            isError: true,
            text: "The session changed during model preparation. Try again.",
          },
        });
      }
      const after = loadSessionEntryReadOnly(scope);
      expect(after?.sessionId).toBe(unchanged?.sessionId);
      expect(after?.executionSelection).toEqual(unchanged?.executionSelection);
      expect(after?.authProfileOverride).toBeUndefined();
      expect(after?.authProfileOverrideSource).toBeUndefined();
      expect(after?.authProfileOverrideCompactionCount).toBeUndefined();
      expect(runEmbeddedAgent).not.toHaveBeenCalled();
      expect(typing?.cleanup).toHaveBeenCalled();
      expect(runState.preRunRejection).toBeUndefined();
    } finally {
      activeOperation?.complete();
      release.resolve();
      await pending;
    }
  },
);

it("returns a locked initialization refusal with typing cleanup and the existing rejection marker", async () => {
  state = await createOpenClawTestState({
    label: "reply-locked-initialization",
    env: { OPENCLAW_TEST_FAST: "0" },
  });
  const scope = {
    agentId: "main",
    sessionKey: "agent:main:locked-initialization",
    storePath: state.path("sessions.json"),
  };
  await replaceSessionEntry(scope, {
    sessionId: "locked-initialization",
    updatedAt: Date.now(),
    modelSelectionLocked: true,
  });
  const cfg = fixtureReplyConfig(state.workspaceDir, scope.storePath);
  await state.writeConfig(cfg);
  const resolveReply = await prepareFixtureReply(cfg);
  const runState: ReplyOperationRunState = {};
  let typing: TypingController | undefined;
  const options: InternalGetReplyOptions = {
    [REPLY_OPERATION_RUN_STATE]: runState,
    onTypingController: (controller) => {
      typing = controller;
      vi.spyOn(controller, "cleanup");
    },
  };
  const reply = await resolveReply(
    finalizeInboundContext({
      Body: "Continue this task.",
      CommandSource: "text",
      CommandAuthorized: true,
      Provider: "webchat",
      Surface: "webchat",
      ChatType: "direct",
      SessionKey: scope.sessionKey,
    }),
    options,
  );
  expect(reply).toEqual({ text: "Model selection is locked for this session.", isError: true });
  expect(runState.preRunRejection).toBe("model-selection-locked");
  expect(typing?.cleanup).toHaveBeenCalled();
  expect(runEmbeddedAgent).not.toHaveBeenCalled();
  const after = loadSessionEntryReadOnly(scope);
  expect(after?.modelSelectionLocked).toBe(true);
  expect(after?.executionSelection).toBeUndefined();
  expect(after?.authProfileOverride).toBeUndefined();
});

it.each(["default", "session", "option", "clear"] as const)(
  "uses the prepared deferred model's fast defaults with %s settings",
  async (setting) => {
    state = await createOpenClawTestState({
      label: "reply-prepared-fast-mode",
      env: { OPENCLAW_TEST_FAST: "0" },
    });
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:prepared-fast-mode",
      storePath: state.path("sessions.json"),
    };
    await upsertSessionEntry({
      ...scope,
      entry: {
        sessionId: "prepared-fast-mode",
        updatedAt: Date.now(),
        ...(setting === "session" || setting === "clear" ? { fastMode: false } : {}),
      },
    });
    const view = getSessionEntry(scope);
    if (!view) {
      throw new Error("Expected the released session view");
    }
    applyModelOverrideToSessionEntry({
      entry: view,
      selection: { provider: "fixture", model: "parent", isDefault: false },
    });
    await upsertSessionEntry({ ...scope, entry: view });
    const base = fixtureReplyConfig(state.workspaceDir, scope.storePath);
    const cfg = withFullRuntimeReplyConfig({
      ...base,
      agents: {
        ...base.agents,
        defaults: {
          ...base.agents.defaults,
          models: {
            ...base.agents.defaults.models,
            "fixture/default": {
              ...base.agents.defaults.models["fixture/default"],
              params: { fastMode: false, fastAutoOnSeconds: 11 },
            },
            "fixture/parent": {
              ...base.agents.defaults.models["fixture/parent"],
              params: { fastMode: "auto", fastAutoOnSeconds: 23 },
            },
          },
        },
      },
    });
    await state.writeConfig(cfg);
    const resolveReply = await prepareFixtureReply(cfg);
    const body = setting === "clear" ? "Continue this task.\n/fast default" : "Continue this task.";
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
        SessionKey: scope.sessionKey,
      }),
      setting === "option"
        ? { fastModeOverride: true, fastModeAutoOnSecondsOverride: 37 }
        : undefined,
    );
    expect(runEmbeddedAgent, JSON.stringify(reply)).toHaveBeenCalledOnce();
    expect(runEmbeddedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "fixture",
        model: "parent",
        fastMode: setting === "option" ? true : setting === "session" ? false : "auto",
        fastModeAutoOnSeconds: setting === "option" ? 37 : 23,
        prompt: expect.stringContaining("Continue this task."),
      }),
    );
    const after = loadSessionEntryReadOnly(scope);
    expect(after?.executionSelection).toMatchObject({
      state: "accepted",
      selection: { model: { provider: "fixture", id: "parent" } },
    });
    expect(after?.fastMode).toBe(setting === "session" || setting === "clear" ? false : undefined);
  },
);
