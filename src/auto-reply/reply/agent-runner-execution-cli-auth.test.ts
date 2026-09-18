import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { saveAuthProfileStore } from "../../agents/auth-profiles/store-runtime.js";
import type { AuthProfileCredential } from "../../agents/auth-profiles/types.js";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import { closeOpenClawAgentDatabaseByPath } from "../../state/openclaw-agent-db.js";
import {
  configureTestCliModel,
  createFollowupRun,
  configureTestExecution,
  testModel,
  createMinimalRunAgentTurnParams,
  expectMockCallArgFields,
  fallbackAttemptOptions,
  getExecuteAgentTurnForTest,
  setupAgentRunnerExecutionTestState,
  type FallbackRunnerParams,
} from "./agent-runner-execution.test-support.js";
import { createAgentTurnPresentation } from "./agent-runner-presentation.js";
import { createAgentTurnTimingTracker } from "./agent-runner-turn-timing.js";
import { createReplyMediaContext } from "./reply-media-paths.runtime.js";

const state = await setupAgentRunnerExecutionTestState();
const { runCliFallbackCandidate } = await import("./agent-runner-cli-candidate.js");
const { prepareSystemAgentRunAdmission } = await import("../../agents/admitted-run-context.js");
const { createDeferredEmbeddedRunLifecycleManager } =
  await import("../../agents/embedded-agent-runner/run/deferred-lifecycle-owner.js");
const { captureAgentRunLifecycleGeneration } = await import("../../infra/agent-events.js");
const managedProfile = "claude-cli:managed";
const canonicalProfile = "anthropic:managed";
const primaryProfile = "openai:primary";
const googleProfile = "google:managed";
const nativeProfile = "anthropic:claude-cli";
const customProfile = "custom-cli:managed";
const credentials = {
  [managedProfile]: { type: "token", provider: "claude-cli", token: "synthetic-managed-token" },
  [canonicalProfile]: { type: "token", provider: "anthropic", token: "synthetic-canonical-token" },
  [primaryProfile]: { type: "api_key", provider: "openai", key: "synthetic-primary-key" },
  [googleProfile]: { type: "api_key", provider: "google", key: "synthetic-google-key" },
  [nativeProfile]: { type: "token", provider: "claude-cli", token: "synthetic-native-token" },
  [customProfile]: { type: "token", provider: "custom-cli", token: "synthetic-custom-token" },
} satisfies Record<string, AuthProfileCredential>;

describe("executeAgentTurn: CLI credential selection", () => {
  it.each([
    {
      name: "selects ordered CLI credentials after an automatic cross-provider fallback",
      selected: primaryProfile,
      source: "auto",
      primary: "openai",
      provider: "claude-cli",
      backend: "claude-cli",
      profiles: [primaryProfile, managedProfile],
      expected: managedProfile,
    },
    {
      name: "rejects an incompatible explicit account before CLI execution",
      selected: primaryProfile,
      source: "user",
      primary: "openai",
      provider: "claude-cli",
      backend: "claude-cli",
      profiles: [primaryProfile, managedProfile],
      error: 'cannot use auth profile "openai:primary"',
    },
    {
      name: "forwards explicitly selected canonical credentials",
      selected: canonicalProfile,
      source: "user",
      primary: "anthropic",
      provider: "claude-cli",
      backend: "claude-cli",
      profiles: [canonicalProfile, managedProfile],
      expected: canonicalProfile,
    },
    {
      name: "preserves a selected native login even when a managed account exists",
      selected: nativeProfile,
      source: "user",
      primary: "claude-cli",
      provider: "claude-cli",
      backend: "claude-cli",
      profiles: [nativeProfile, managedProfile],
      expected: undefined,
    },
    {
      name: "uses the executing Google candidate for canonical API-key fallback",
      selected: primaryProfile,
      source: "auto",
      primary: "openai",
      provider: "google",
      backend: "google-gemini-cli",
      profiles: [primaryProfile, googleProfile],
      expected: googleProfile,
    },
    {
      name: "retains existing scoped forwarding for a custom CLI backend",
      selected: customProfile,
      source: "user",
      primary: "custom-cli",
      provider: "custom-cli",
      backend: "custom-cli",
      profiles: [customProfile],
      expected: customProfile,
    },
  ] as const)("$name", async (testCase) => {
    const followupRun = createFollowupRun();
    onTestFinished(() => {
      closeOpenClawAgentDatabaseByPath(
        path.join(followupRun.run.agentDir, "openclaw-agent.sqlite"),
      );
    });
    const model = "test-model";
    followupRun.run.executionSelection = {
      model: { provider: testCase.primary, id: model },
      executor: { kind: "harness", id: "openclaw" },
    };
    followupRun.run.authProfileId = testCase.selected;
    followupRun.run.authProfileIdSource = testCase.source;
    followupRun.run.thinkingCatalog = [{ provider: testCase.provider, id: model, input: ["text"] }];
    const profiles = Object.fromEntries(testCase.profiles.map((id) => [id, credentials[id]]));
    followupRun.run.config = {
      auth: {
        order: Object.fromEntries(testCase.profiles.map((id) => [credentials[id].provider, [id]])),
      },
      agents: {
        defaults: {
          models: { [`${testCase.provider}/${model}`]: { agentRuntime: { id: testCase.backend } } },
        },
      },
    };
    saveAuthProfileStore({ version: 1, profiles }, followupRun.run.agentDir, {
      filterExternalAuthProfiles: false,
      syncExternalCli: false,
    });
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [
        {
          id: "claude-cli",
          modelProvider: "anthropic",
          pluginId: "anthropic",
          config: { command: "claude" },
        },
        {
          id: "google-gemini-cli",
          modelProvider: "google",
          pluginId: "google",
          config: { command: "gemini" },
        },
        {
          id: "custom-cli",
          modelProvider: "custom-cli",
          pluginId: "custom",
          config: { command: "custom" },
        },
      ],
      resolvePluginSetupCliBackend: () => undefined,
    });
    const cliSelection = configureTestCliModel(
      followupRun,
      testCase.provider,
      model,
      testCase.backend,
      testCase.backend === "claude-cli" ? "anthropic" : testCase.provider,
    );
    if (testCase.primary === testCase.provider || testCase.primary === "anthropic") {
      followupRun.run.executionSelection = cliSelection;
    }
    configureTestExecution(followupRun, {
      catalog: [testModel(testCase.primary, model), testModel(testCase.provider, model)],
      profiles,
      runtimeAuthModes: {
        [testCase.backend]: testCase.backend === "google-gemini-cli" ? "api_key" : "token",
      },
    });
    state.isCliProviderMock.mockImplementation((provider) => provider === testCase.backend);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      outcome: "completed",
      result: await params.run(
        testCase.provider,
        model,
        fallbackAttemptOptions(params, "rate_limit"),
      ),
      provider: testCase.provider,
      model,
      attempts: [],
    }));
    state.runCliAgentMock.mockResolvedValueOnce({ payloads: [{ text: "done" }], meta: {} });
    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const turn = createMinimalRunAgentTurnParams({ followupRun });
    if (testCase.primary !== testCase.provider && testCase.primary !== "anthropic") {
      // These account protections apply after selection, regardless of how the CLI was chosen.
      const runId = "cli-account-dispatch";
      const admission = prepareSystemAgentRunAdmission(
        followupRun.run.config,
        runId,
        "main",
        "cli-account-fixture",
      );
      const deferredLifecycle = createDeferredEmbeddedRunLifecycleManager({
        runId,
        agentId: "main",
        sessionId: followupRun.run.sessionId,
        sessionKey: followupRun.run.sessionKey,
        sessionFile: followupRun.run.sessionFile,
      });
      try {
        const dispatch = runCliFallbackCandidate({
          preparedRunAdmission: admission,
          turn,
          candidateRun: { ...followupRun.run, executionSelection: cliSelection },
          runtimeConfig: followupRun.run.config,
          candidateFastMode: {},
          runId,
          runLane: "main",
          isFallbackRetry: true,
          suppressQueuedUserPersistenceForCandidate: false,
          userTurnTranscriptRecorder: undefined,
          onContextEngineTurnCandidate: undefined,
          assistantErrorTranscript: undefined,
          authProfileFailurePolicy: undefined,
          notifyUserMessagePersisted: () => {},
          fastModeStartedAtMs: Date.now(),
          fastModeAutoProgressState: { offAnnounced: false, resetAnnounced: false },
          bootstrapContextRunKind: "default",
          bootstrapPromptWarningSignaturesSeen: [],
          currentTurnImages: {},
          signalExecutionPhaseForTyping: () => {},
          notifyAgentRunStart: () => {},
          preserveProgressCallbackStartOrder: false,
          presentation: createAgentTurnPresentation({
            turn,
            replyMediaContext: createReplyMediaContext({
              cfg: followupRun.run.config,
              agentId: "main",
              workspaceDir: followupRun.run.workspaceDir,
            }),
            directBlockDeliveries: [],
            heartbeatState: { didLogStrip: false },
          }),
          timing: createAgentTurnTimingTracker({}),
          onLifecycleBackstop: () => {},
          deferredLifecycle,
          cliExecutionProvider: testCase.backend,
          classifyResult: () => undefined,
          lifecycleGeneration: captureAgentRunLifecycleGeneration(runId),
        });
        if ("error" in testCase) {
          await expect(dispatch).rejects.toThrow(testCase.error);
          expect(state.runCliAgentMock).not.toHaveBeenCalled();
          return;
        }
        expect(await dispatch).toMatchObject({ result: { payloads: [{ text: "done" }] } });
      } finally {
        await deferredLifecycle.complete();
        admission.close();
      }
    } else {
      expect(await executeAgentTurn(turn)).toMatchObject({ kind: "success" });
    }
    expect(state.runCliAgentMock).toHaveBeenCalledOnce();
    expectMockCallArgFields(state.runCliAgentMock, 0, "CLI credential handoff", {
      provider: testCase.backend,
      authProfileId: testCase.expected,
    });
  });
});
