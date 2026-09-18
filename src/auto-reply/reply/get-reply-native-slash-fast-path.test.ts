import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as runtimeChoice from "../../agents/model-runtime-choice.js";
import * as preparedModelCatalog from "../../agents/prepared-model-catalog.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  loadExactSessionEntry,
  loadSessionEntry,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import * as compactRuntime from "./commands-compact.runtime.js";
import { markCompleteReplyConfig } from "./get-reply-fast-path.test-support.js";
import {
  buildNativeCommandCtx,
  createTypingController,
  handleCommandsMock,
  runTestNativeSlashFastReply,
  selectedSessionEntry,
  useNativeSlashFastReplyFixture,
} from "./get-reply-native-slash-fast-path.test-support.js";
import * as sessionPersistence from "./session-entry-persistence.js";
import { buildTestCtx } from "./test-ctx.js";

describe("maybeResolveNativeSlashCommandFastReply", () => {
  const { tempDirs, resolveNativeDirectiveCommand } = useNativeSlashFastReplyFixture();

  it.each([false, true])(
    "persists native exec defaults before model dispatch with catalog=%s",
    async (publishCatalog) => {
      const evaluate = vi.spyOn(runtimeChoice, "evaluatePublishedModelRuntimeChoice");
      if (!publishCatalog) {
        vi.spyOn(
          preparedModelCatalog,
          "getPublishedPreparedModelCatalogOwnerSnapshot",
        ).mockReturnValue(undefined);
      }
      const { result, storePath } = await resolveNativeDirectiveCommand(
        "/exec host=node node=worker-1",
        undefined,
        { shouldContinue: true },
        undefined,
        publishCatalog,
      );

      expect(result).toMatchObject({
        handled: true,
        reply: { text: expect.stringContaining("Exec defaults set (host=node, node=worker-1).") },
      });
      expect(
        loadExactSessionEntry({
          sessionKey: "agent:main:telegram:123",
          storePath: storePath ?? "",
        })?.entry,
      ).toMatchObject({ execHost: "node", execNode: "worker-1" });
      expect(evaluate).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["/queue Can you diagnose this?", 'Unrecognized queue mode "Can".'],
    ["/queue /think high", 'Unrecognized queue mode "/think"'],
    ["/think about my deployment plan", 'Unrecognized thinking level "about".'],
    ["/verbose explain quantum computing", 'Unrecognized verbose level "explain".'],
    ["/trace banana please", 'Unrecognized trace level "banana".'],
    ["/fast bananas please", 'Unrecognized fast mode "bananas".'],
    ["/reasoning nonsense please", 'Unrecognized reasoning level "nonsense".'],
  ])("validates every native directive argument: %s", async (command, expected) => {
    const evaluate = vi.spyOn(runtimeChoice, "evaluatePublishedModelRuntimeChoice");
    vi.spyOn(preparedModelCatalog, "getPublishedPreparedModelCatalogOwnerSnapshot").mockReturnValue(
      undefined,
    );
    const { result } = await resolveNativeDirectiveCommand(
      command,
      undefined,
      { shouldContinue: true },
      undefined,
      false,
    );

    expect(result).toEqual({
      handled: true,
      reply: expect.objectContaining({ text: expect.stringContaining(expected) }),
    });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it.each([
    ["/queue collect please help", 'Unexpected argument "please" for /queue.'],
    ["/think high please", 'Unexpected argument "please" for /think.'],
    ["/verbose on please", 'Unexpected argument "please" for /verbose.'],
    ["/fast on please", 'Unexpected argument "please" for /fast.'],
    ["/reasoning on please", 'Unexpected argument "please" for /reasoning.'],
    ["/exec host=node please", 'Unexpected argument "please" for /exec.'],
    [
      "/model openai/gpt-5.5 --runtime codex --runtime acp",
      'Unexpected argument "--runtime" for /model.',
    ],
    ["/model openai/gpt-5.5 -slow", 'Unexpected argument "-slow" for /model.'],
  ])("rejects trailing prose instead of dropping native command %s", async (command, expected) => {
    const evaluate = vi.spyOn(runtimeChoice, "evaluatePublishedModelRuntimeChoice");
    vi.spyOn(preparedModelCatalog, "getPublishedPreparedModelCatalogOwnerSnapshot").mockReturnValue(
      undefined,
    );
    const { result } = await resolveNativeDirectiveCommand(
      command,
      undefined,
      { shouldContinue: true },
      undefined,
      false,
    );

    expect(result).toEqual({
      handled: true,
      reply: expect.objectContaining({ text: expected }),
    });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("preserves selection and a mismatched automatic account when terminal syntax is invalid", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-native-invalid-account-" },
      async (state) => {
        const storePath = path.join(state.sessionsDir("main"), "sessions.json");
        const sessionKey = "agent:main:telegram:123";
        const auth = {
          authProfileOverride: "anthropic:automatic",
          authProfileOverrideSource: "auto" as const,
          authProfileOverrideCompactionCount: 0,
        };
        await state.writeAuthProfiles({
          version: 1,
          profiles: {
            [auth.authProfileOverride]: {
              type: "api_key",
              provider: "anthropic",
              key: "synthetic-test-key",
            },
          },
        });
        await replaceSessionEntry(
          { agentId: "main", sessionKey, storePath },
          selectedSessionEntry(
            {
              sessionId: "invalid-with-account",
              updatedAt: 1,
              ...auth,
            },
            "openai",
            "gpt-5.5",
          ),
        );
        const before = loadExactSessionEntry({ agentId: "main", sessionKey, storePath })?.entry;
        expect(before?.executionSelection?.state).toBe("accepted");
        vi.spyOn(
          preparedModelCatalog,
          "getPublishedPreparedModelCatalogOwnerSnapshot",
        ).mockReturnValue(undefined);
        const evaluate = vi.spyOn(runtimeChoice, "evaluatePublishedModelRuntimeChoice");
        const { result } = await resolveNativeDirectiveCommand(
          "/think high please",
          { session: { store: storePath } },
          { shouldContinue: true },
          undefined,
          false,
        );
        expect(result).toMatchObject({
          handled: true,
          reply: { text: 'Unexpected argument "please" for /think.' },
        });
        expect(evaluate).not.toHaveBeenCalled();
        expect(handleCommandsMock).toHaveBeenCalledOnce();
        expect(
          loadExactSessionEntry({ agentId: "main", sessionKey, storePath })?.entry,
        ).toMatchObject({
          executionSelection: before?.executionSelection,
          ...auth,
        });
      },
    );
  });

  it("refuses compact without a published owner before abort or backend work", async () => {
    const storePath = path.join(
      tempDirs.make("openclaw-native-compact-unavailable-"),
      "sessions.json",
    );
    const sessionKey = "agent:main:telegram:123";
    await replaceSessionEntry(
      { agentId: "main", sessionKey, storePath },
      selectedSessionEntry(
        {
          sessionId: "unavailable-compact",
          updatedAt: 1,
        },
        "openai",
        "gpt-5.5",
      ),
    );
    const before = loadExactSessionEntry({ agentId: "main", sessionKey, storePath })?.entry;
    expect(before?.executionSelection?.state).toBe("accepted");
    vi.spyOn(preparedModelCatalog, "getPublishedPreparedModelCatalogOwnerSnapshot").mockReturnValue(
      undefined,
    );
    const evaluate = vi.spyOn(runtimeChoice, "evaluatePublishedModelRuntimeChoice");
    const abort = vi.spyOn(compactRuntime, "abortEmbeddedAgentRun");
    const wait = vi.spyOn(compactRuntime, "waitForEmbeddedAgentRunEnd");
    const compact = vi.spyOn(compactRuntime, "compactEmbeddedAgentSession");
    const { handleCommands } = await import("./commands-core.js");
    handleCommandsMock.mockImplementation(handleCommands);
    await expect(
      runTestNativeSlashFastReply(
        {
          ctx: buildNativeCommandCtx("/compact", {
            Provider: "telegram",
            Surface: "telegram",
            GatewayClientScopes: ["operator.admin"],
            SessionKey: "telegram:slash:123",
            CommandTargetSessionKey: sessionKey,
          }),
          cfg: markCompleteReplyConfig({ session: { store: storePath } }),
          agentId: "main",
          commandAuthorized: true,
          typing: createTypingController(),
        },
        false,
      ),
    ).resolves.toMatchObject({
      handled: true,
      reply: { isStatusNotice: true },
    });
    expect(evaluate).toHaveBeenCalledOnce();
    expect(handleCommandsMock).toHaveBeenCalledOnce();
    expect(abort).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
    expect(compact).not.toHaveBeenCalled();
    expect(
      loadExactSessionEntry({ agentId: "main", sessionKey, storePath })?.entry.executionSelection,
    ).toEqual(before?.executionSelection);
  });

  it("keeps model-independent /status plugins available under an invalid model policy", async () => {
    const { result } = await resolveNativeDirectiveCommand(
      "/status plugins",
      { agents: { defaults: { modelPolicy: { allow: ["anthropic/*"] } } } } as OpenClawConfig,
      { shouldContinue: false, reply: { text: "plugin status" } },
    );

    expect(result).toMatchObject({ handled: true, reply: { text: "plugin status" } });
    expect(handleCommandsMock).toHaveBeenCalledOnce();
  });

  it.each(["model", "models", "help", "stop"])(
    "keeps /%s available to recover from an invalid default model policy",
    async (commandName) => {
      const { result } = await resolveNativeDirectiveCommand(
        `/${commandName}`,
        {
          session: {
            store: path.join(tempDirs.make("openclaw-native-recovery-"), "sessions.json"),
          },
          agents: {
            defaults: {
              modelPolicy: { allow: ["anthropic/*"] },
            },
          },
        } as OpenClawConfig,
        { shouldContinue: false, reply: { text: "recovery available" } },
      );

      expect(result).toMatchObject({ handled: true, reply: { text: "recovery available" } });
      expect(handleCommandsMock).toHaveBeenCalledOnce();
    },
  );

  it("handles authorized text slash commands before model dispatch", async () => {
    handleCommandsMock.mockResolvedValueOnce({
      shouldContinue: false,
      reply: { text: "Trajectory exports can include prompts." },
    });

    const typing = createTypingController();
    const ctx = buildTestCtx({
      Body: "/export-trajectory bundle",
      BodyForCommands: "/export-trajectory bundle",
      CommandBody: "/export-trajectory bundle",
      CommandSource: "text",
      CommandAuthorized: true,
      SessionKey: "agent:dev:webchat",
      Provider: "webchat",
      Surface: "webchat",
      OriginatingChannel: "webchat",
      ChatType: "direct",
      CommandTurn: {
        kind: "text-slash",
        source: "text",
        authorized: true,
        commandName: "export-trajectory",
        body: "/export-trajectory bundle",
      },
    });

    const result = await runTestNativeSlashFastReply({
      ctx,
      cfg: markCompleteReplyConfig({
        session: {
          store: path.join(tempDirs.make("openclaw-text-slash-"), "sessions.json"),
        },
      } as OpenClawConfig),
      agentId: "dev",
      commandAuthorized: true,
      typing,
    });

    expect(handleCommandsMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      handled: true,
      reply: expect.objectContaining({
        text: "Trajectory exports can include prompts.",
      }),
    });
    if (!result.handled || !result.reply || Array.isArray(result.reply)) {
      throw new Error("expected single handled reply");
    }
    expect(getReplyPayloadMetadata(result.reply)?.deliverDespiteSourceReplySuppression).toBe(true);
    expect(typing.cleanup).toHaveBeenCalledTimes(1);
  });

  it("leaves external text slash commands on the canonical session path", async () => {
    const typing = createTypingController();
    const ctx = buildTestCtx({
      Body: "/export-trajectory bundle",
      BodyForCommands: "/export-trajectory bundle",
      CommandBody: "/export-trajectory bundle",
      CommandSource: "text",
      CommandAuthorized: true,
      SessionKey: "agent:dev:telegram:group:123",
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "group",
      CommandTurn: {
        kind: "text-slash",
        source: "text",
        authorized: true,
        commandName: "export-trajectory",
        body: "/export-trajectory bundle",
      },
    });

    const result = await runTestNativeSlashFastReply({
      ctx,
      cfg: markCompleteReplyConfig({
        session: {
          store: path.join(tempDirs.make("openclaw-external-text-slash-"), "sessions.json"),
        },
      } as OpenClawConfig),
      agentId: "dev",
      commandAuthorized: true,
      typing,
    });

    expect(result).toEqual({ handled: false });
    expect(handleCommandsMock).not.toHaveBeenCalled();
    expect(typing.cleanup).not.toHaveBeenCalled();
  });

  it.each([
    { commandName: "config show", authorized: false },
    { commandName: "compact", authorized: false },
    { commandName: "compact", authorized: true, deniedByPolicy: true },
  ])("rejects unauthorized native /$commandName before model selection", async (testCase) => {
    const { commandName, authorized } = testCase;
    const storePath = path.join(
      tempDirs.make("openclaw-native-slash-unauthorized-"),
      "sessions.json",
    );
    const sessionKey = "agent:main:telegram:slash:unauthorized";
    handleCommandsMock.mockResolvedValueOnce({
      shouldContinue: false,
      reply: { text: "You are not authorized to use this command." },
    });

    const result = await runTestNativeSlashFastReply({
      ctx: buildNativeCommandCtx(`/${commandName}`, {
        CommandAuthorized: authorized,
        Provider: "telegram",
        Surface: "telegram",
        From: "telegram:denied-sender",
        SenderId: "denied-sender",
        CommandTargetSessionKey: sessionKey,
      }),
      cfg: markCompleteReplyConfig({
        session: { store: storePath },
        ...("deniedByPolicy" in testCase
          ? { commands: { allowFrom: { "*": ["approved-sender"] } } }
          : {}),
      } as OpenClawConfig),
      agentId: "main",
      commandAuthorized: authorized,
      typing: createTypingController(),
    });

    expect(result).toEqual({
      handled: true,
      reply: expect.objectContaining({ text: "You are not authorized to use this command." }),
    });
    expect(handleCommandsMock).toHaveBeenCalledOnce();
    expect(handleCommandsMock.mock.calls[0]?.[0]).toMatchObject({
      provider: "openai",
      model: "gpt-5.5",
      command: { isAuthorizedSender: false },
    });
    if (!authorized) {
      expect(loadExactSessionEntry({ sessionKey, storePath })).toBeUndefined();
    }
  });

  it.each([
    { failure: "was deleted", deliver: true },
    { failure: "changed", deliver: false },
  ])(
    "rejects session initialization when it $failure during persistence",
    async ({ failure, deliver }) => {
      vi.spyOn(sessionPersistence, "persistReplySessionEntry").mockResolvedValueOnce({
        status: "lifecycle-invalidated",
        error: `Session "agent:main:main" ${failure} while starting work. Retry.`,
      });
      const { result } = await resolveNativeDirectiveCommand("/compact");

      expect(result).toEqual({
        handled: true,
        reply: expect.objectContaining({ text: expect.stringContaining(failure) }),
      });
      if (deliver) {
        if (!result.handled || !result.reply || Array.isArray(result.reply)) {
          throw new Error("expected single handled reply");
        }
        expect(getReplyPayloadMetadata(result.reply)?.deliverDespiteSourceReplySuppression).toBe(
          true,
        );
      }
      expect(handleCommandsMock).not.toHaveBeenCalled();
    },
  );

  it("adopts a supported legacy alias before native command initialization", async () => {
    const storePath = path.join(tempDirs.make("openclaw-native-slash-alias-"), "sessions.json");
    const sessionKey = "agent:main:main";
    await replaceSessionEntry({ sessionKey: "Agent:main:main", storePath }, {
      sessionId: "legacy-session",
      updatedAt: 1,
    } as SessionEntry);
    handleCommandsMock.mockImplementationOnce(async (params: { sessionEntry?: unknown }) => {
      expect(params.sessionEntry).toMatchObject({ sessionId: "legacy-session" });
      return { shouldContinue: false, reply: { text: "ok" } };
    });

    const result = await runTestNativeSlashFastReply({
      ctx: buildNativeCommandCtx("/compact", {
        CommandTargetSessionKey: sessionKey,
      }),
      cfg: markCompleteReplyConfig({ session: { store: storePath } } as OpenClawConfig),
      agentId: "main",
      commandAuthorized: true,
      typing: createTypingController(),
    });

    expect(result).toEqual({
      handled: true,
      reply: expect.objectContaining({ text: "ok" }),
    });
    expect(handleCommandsMock).toHaveBeenCalledOnce();
  });

  it("does not mutate an archived session during native command initialization", async () => {
    const storePath = path.join(tempDirs.make("openclaw-native-slash-archived-"), "sessions.json");
    const sessionKey = "agent:main:main";
    const archivedEntry = {
      sessionId: "archived-session",
      updatedAt: 1,
      lastInteractionAt: 1,
      archivedAt: 2,
      channel: "telegram",
    };
    await replaceSessionEntry({ sessionKey, storePath }, archivedEntry as SessionEntry);
    const persistedArchivedEntry = loadExactSessionEntry({ sessionKey, storePath })?.entry;

    const result = await runTestNativeSlashFastReply({
      ctx: buildNativeCommandCtx("/compact", {
        Provider: "telegram",
        CommandTargetSessionKey: sessionKey,
      }),
      cfg: markCompleteReplyConfig({ session: { store: storePath } } as OpenClawConfig),
      agentId: "main",
      commandAuthorized: true,
      typing: createTypingController(),
    });

    expect(result).toEqual({
      handled: true,
      reply: expect.objectContaining({ text: expect.stringContaining("is archived") }),
    });
    expect(handleCommandsMock).not.toHaveBeenCalled();
    expect(loadExactSessionEntry({ sessionKey, storePath })?.entry).toEqual(persistedArchivedEntry);
  });

  it("persists fast-path session initialization before command mutation", async () => {
    const storePath = path.join(tempDirs.make("openclaw-native-slash-init-"), "sessions.json");
    const sessionKey = "agent:main:main";
    await replaceSessionEntry({ sessionKey, storePath }, {
      sessionId: "session-1",
      updatedAt: 1,
      lastInteractionAt: 1,
      channel: "old-channel",
    } as SessionEntry);
    handleCommandsMock.mockImplementationOnce(async (params: { sessionEntry?: unknown }) => {
      const persisted = loadSessionEntry({ sessionKey, storePath });
      const initialized = {
        sessionId: "session-1",
        sessionStartedAt: 100,
        updatedAt: 100,
        lastInteractionAt: 100,
        channel: "telegram",
      };
      expect(params.sessionEntry).toMatchObject(initialized);
      expect(persisted).toMatchObject(initialized);
      return { shouldContinue: false, reply: { text: "ok" } };
    });
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(100);

    try {
      await runTestNativeSlashFastReply({
        ctx: buildNativeCommandCtx("/compact", {
          Provider: "telegram",
          CommandTargetSessionKey: sessionKey,
        }),
        cfg: markCompleteReplyConfig({ session: { store: storePath } } as OpenClawConfig),
        agentId: "main",
        commandAuthorized: true,
        typing: createTypingController(),
      });
    } finally {
      nowSpy.mockRestore();
    }

    expect(handleCommandsMock).toHaveBeenCalledTimes(1);
  });
});
