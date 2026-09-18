import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { applyMixedDirectives } from "../../auto-reply/reply/directive-handling.mixed-inline.test-helpers.js";
import { createModelSelectionState } from "../../auto-reply/reply/model-selection.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { prepareSessionParticipantInput } from "../../sessions/session-participant-input.js";
import {
  clearUserProfileAuthLink,
  connectUserModelAccount,
  setUserProfileAuthLink,
  updateUserModelAuthProfile,
} from "../../state/user-model-accounts.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import {
  type OpenClawTestState,
  withOpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import * as runtimeChoice from "../model-runtime-choice.js";
import { createSessionModelCatalogFixture } from "../test-helpers/session-model-catalog.test-support.js";
import { createApiKeyCredential } from "./credential-fixtures.test-support.js";
import {
  clearSessionAuthProfileOverride,
  resolveSessionAuthSelection,
} from "./session-override.js";
import { ensureAuthProfileStore } from "./store-runtime.js";

const DEFAULT_PROFILE_ID = "openai:shared";
const SESSION_KEY = "agent:main:main";
const catalogFixture = createSessionModelCatalogFixture();

function connectAccount(profileId: string, label: string): string {
  return connectUserModelAccount({
    ownerProfileId: profileId,
    credential: {
      type: "oauth",
      provider: "openai",
      access: `synthetic-${label}-access`,
      refresh: `synthetic-${label}-refresh`,
      expires: Date.now() + 600_000,
    },
    assertCurrent() {},
  }).authProfileId;
}

async function prepareForRequester(
  state: OpenClawTestState,
  sessionEntry: SessionEntry,
  requesterProfileId?: string,
  isNewSession = true,
  configuredProfileId?: string,
) {
  const cfg: OpenClawConfig = {
    agents: {
      defaults: {
        model: { primary: "openai/gpt-5.6-luna" },
        models: { "openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } } },
      },
    },
  };
  catalogFixture.publish({
    config: cfg,
    agentId: "main",
    catalog: {
      entries: [
        {
          provider: "openai",
          id: "gpt-5.6-luna",
          name: "Account selection fixture",
          api: "openai-responses",
        },
      ],
      routeVariants: [],
    },
    profiles: ensureAuthProfileStore(state.agentDir(), { allowKeychainPrompt: false }).profiles,
  });
  return createModelSelectionState({
    cfg,
    agentId: "main",
    agentCfg: cfg.agents?.defaults,
    sessionEntry,
    sessionStore: { [SESSION_KEY]: sessionEntry },
    sessionKey: SESSION_KEY,
    defaultProvider: "openai",
    defaultModel: "gpt-5.6-luna",
    provider: "openai",
    model: "gpt-5.6-luna",
    hasModelDirective: false,
    prepareExecution: true,
    replyAuth: { isNewSession, requesterProfileId, configuredProfileId },
  });
}

async function selectForRequester(...params: Parameters<typeof prepareForRequester>) {
  return (await prepareForRequester(...params)).auth?.selection;
}

function inspectForRequester(
  state: OpenClawTestState,
  sessionEntry: SessionEntry,
  requesterProfileId?: string,
) {
  return resolveSessionAuthSelection({
    cfg: {},
    provider: "openai",
    modelId: "gpt-5.6-luna",
    agentDir: state.agentDir(),
    sessionEntry,
    sessionStore: { [SESSION_KEY]: sessionEntry },
    sessionKey: SESSION_KEY,
    isNewSession: false,
    requesterProfileId,
  });
}

function withAuthState(run: (state: OpenClawTestState) => Promise<void>) {
  return withOpenClawTestState({ layout: "state-only", prefix: "personal-session-auth-" }, run);
}

describe("person-linked session auth", () => {
  it.each(
    ["owner", "another person", "unidentified"].flatMap((requester) => [
      { requester, form: "model-only", prefix: "" },
      { requester, form: "mixed", prefix: "hello " },
    ]),
  )(
    "checks credential ownership for a fresh $form personal account directive from $requester",
    async ({ requester, prefix }) => {
      await withAuthState(async (state) => {
        const alice = ensureProfileForEmail("alice@example.test");
        const bob = ensureProfileForEmail("bob@example.test");
        const personalId = connectAccount(alice.id, "alice");
        clearUserProfileAuthLink({ profileId: alice.id, provider: "openai" });
        const requesterProfileId =
          requester === "owner" ? alice.id : requester === "another person" ? bob.id : undefined;
        const ctx: MsgContext = {};
        if (requesterProfileId) {
          prepareSessionParticipantInput(ctx, { type: "profile", id: requesterProfileId });
        }

        const { result, sessionEntry } = await applyMixedDirectives({
          body: `${prefix}/model openai/gpt-5.6-luna@${personalId}`,
          ctx,
          agentDir: state.agentDir(),
          channel: "webchat",
          provider: "openai",
          model: "gpt-5.6-luna",
          allowedModels: [
            { provider: "openai", id: "gpt-5.6-luna", name: "Luna", reasoning: true },
          ],
        });

        if (requester === "owner") {
          expect(sessionEntry.authProfileOverride).toBe(personalId);
          expect(sessionEntry.authProfileOverrideSource).toBe("user");
        } else {
          expect(sessionEntry.authProfileOverride).toBeUndefined();
          expect(result).toMatchObject({ kind: "reply", reply: { isError: true } });
        }
      });
    },
  );

  it("applies a personal default only to new sessions when no shared auth store exists", async () => {
    await withAuthState(async (state) => {
      const alice = ensureProfileForEmail("alice@example.test");
      const existing: SessionEntry = { sessionId: "existing-session", updatedAt: 1 };
      await expect(inspectForRequester(state, existing, alice.id)).resolves.toBeUndefined();

      const personalId = connectAccount(alice.id, "alice");
      await expect(inspectForRequester(state, existing, alice.id)).resolves.toBeUndefined();
      expect(existing.authProfileOverride).toBeUndefined();
      await expect(selectForRequester(state, existing, alice.id, false)).rejects.toThrow("Sign in");
      expect(existing.executionSelection).toBeUndefined();
      const sessionEntry: SessionEntry = { sessionId: "alice-session", updatedAt: 1 };

      await expect(selectForRequester(state, sessionEntry, alice.id)).resolves.toEqual({
        profileId: personalId,
        source: "user",
        routeRequirement: "subscription",
      });
      expect(sessionEntry.authProfileOverrideSource).toBe("user-link");
    });
  });

  it.each([
    { label: "configured default", source: undefined },
    { label: "explicit session pin", source: "user" },
    { label: "person-linked session pin", source: "user-link" },
  ] as const)("selects the $label over other personal accounts", async ({ source }) => {
    await withAuthState(async (state) => {
      const configuredOwner = ensureProfileForEmail("configured@example.test");
      const sessionOwner = ensureProfileForEmail("session@example.test");
      const configuredId = connectAccount(configuredOwner.id, "configured");
      const pinnedId = connectAccount(sessionOwner.id, "session");
      const sessionEntry: SessionEntry = {
        sessionId: "configured-personal-session",
        updatedAt: 1,
        ...(source ? { authProfileOverride: pinnedId, authProfileOverrideSource: source } : {}),
      };

      await expect(
        resolveSessionAuthSelection({
          cfg: {},
          provider: "openai",
          modelId: "gpt-5.6-luna",
          configuredProfileId: configuredId,
          agentDir: state.agentDir(),
          sessionEntry,
          sessionStore: { [SESSION_KEY]: sessionEntry },
          sessionKey: SESSION_KEY,
          isNewSession: false,
        }),
      ).resolves.toEqual({
        profileId: source ? pinnedId : configuredId,
        source: "user",
        routeRequirement: "subscription",
      });
    });
  });

  it("keeps personal accounts out of unrelated defaults and retains pins after unlinking", async () => {
    await withAuthState(async (state) => {
      await state.writeAuthProfiles({
        version: 1,
        profiles: {
          [DEFAULT_PROFILE_ID]: createApiKeyCredential("openai", "synthetic-shared-key"),
        },
      });
      const alice = ensureProfileForEmail("alice@example.test");
      const bob = ensureProfileForEmail("bob@example.test");
      const unlinked = ensureProfileForEmail("unlinked@example.test");
      const aliceId = connectAccount(alice.id, "alice");
      connectAccount(bob.id, "bob");

      for (const requester of [undefined, unlinked.id]) {
        await expect(
          selectForRequester(state, { sessionId: randomUUID(), updatedAt: 1 }, requester),
        ).resolves.toMatchObject({ profileId: DEFAULT_PROFILE_ID, source: "auto" });
      }

      const sessionEntry: SessionEntry = { sessionId: "alice-session", updatedAt: 1 };
      await selectForRequester(state, sessionEntry, alice.id);
      clearUserProfileAuthLink({ profileId: alice.id, provider: "openai" });

      await expect(selectForRequester(state, sessionEntry, bob.id, false)).resolves.toMatchObject({
        profileId: aliceId,
        source: "user",
      });
      await expect(
        selectForRequester(state, { sessionId: "new-session", updatedAt: 1 }, alice.id),
      ).resolves.toMatchObject({ profileId: DEFAULT_PROFILE_ID, source: "auto" });
    });
  });

  it("preserves explicit shared pins and ignores invalid shared account links", async () => {
    await withAuthState(async (state) => {
      await state.writeAuthProfiles({
        version: 1,
        profiles: {
          [DEFAULT_PROFILE_ID]: createApiKeyCredential("openai", "synthetic-shared-key"),
        },
      });
      const alice = ensureProfileForEmail("alice@example.test");
      connectAccount(alice.id, "alice");
      const sessionEntry: SessionEntry = {
        sessionId: "explicit-session",
        updatedAt: 1,
        authProfileOverride: DEFAULT_PROFILE_ID,
        authProfileOverrideSource: "user",
      };
      await expect(selectForRequester(state, sessionEntry, alice.id, false)).resolves.toMatchObject(
        {
          profileId: DEFAULT_PROFILE_ID,
          source: "user",
        },
      );

      setUserProfileAuthLink({
        profileId: alice.id,
        provider: "openai",
        authProfileId: "openai:missing",
      });
      await expect(
        selectForRequester(state, { sessionId: "invalid-link-session", updatedAt: 1 }, alice.id),
      ).resolves.toMatchObject({ profileId: DEFAULT_PROFILE_ID, source: "auto" });
    });
  });

  it("does not replace a missing personal pin with the next participant's account", async () => {
    await withAuthState(async (state) => {
      const alice = ensureProfileForEmail("alice@example.test");
      const bob = ensureProfileForEmail("bob@example.test");
      connectAccount(bob.id, "bob");
      const missingId = `personal:${alice.id}:${randomUUID()}`;
      const sessionEntry: SessionEntry = {
        sessionId: "missing-owner-session",
        updatedAt: 1,
        authProfileOverride: missingId,
        authProfileOverrideSource: "user-link",
      };

      await expect(selectForRequester(state, sessionEntry, bob.id, false)).rejects.toThrow(
        "personal model account is unavailable",
      );
      expect(sessionEntry.authProfileOverride).toBe(missingId);
    });
  });
  it.each(["account", "link", "pin", "clear", "replacement"] as const)(
    "does not commit a prepared selection after concurrent %s changes",
    async (change) => {
      await withAuthState(async (state) => {
        const alice = ensureProfileForEmail("alice@example.test");
        const personalId = connectAccount(alice.id, "alice");
        const sessionEntry: SessionEntry = {
          sessionId: "prepared-account-session",
          updatedAt: 1,
          ...(change === "clear"
            ? {
                authProfileOverride: personalId,
                authProfileOverrideSource: "user" as const,
              }
            : {}),
        };
        const evaluate = runtimeChoice.evaluatePublishedModelRuntimeChoice;
        const spy = vi
          .spyOn(runtimeChoice, "evaluatePublishedModelRuntimeChoice")
          .mockImplementationOnce(async (params) => {
            const result = await evaluate(params);
            expect(result.kind).toBe("ready");
            if (change === "account") {
              updateUserModelAuthProfile(personalId, (profile) => {
                if (profile.credential.type !== "oauth") {
                  throw new Error("Expected the connected account");
                }
                profile.credential.access = "synthetic-rotated-access";
                return true;
              });
            } else if (change === "link") {
              clearUserProfileAuthLink({ profileId: alice.id, provider: "openai" });
            } else if (change === "pin") {
              sessionEntry.authProfileOverride = "explicit-new-pin";
              sessionEntry.authProfileOverrideSource = "user";
            } else if (change === "clear") {
              delete sessionEntry.authProfileOverride;
              delete sessionEntry.authProfileOverrideSource;
            } else {
              sessionEntry.sessionId = "replacement-session";
            }
            return result;
          });
        try {
          await expect(selectForRequester(state, sessionEntry, alice.id)).rejects.toThrow(
            change === "replacement" ? "session changed" : "account changed",
          );
          expect(sessionEntry.executionSelection).toBeUndefined();
          if (change === "pin") {
            expect(sessionEntry.authProfileOverride).toBe("explicit-new-pin");
          }
          if (change === "clear") {
            expect(sessionEntry.authProfileOverride).toBeUndefined();
          }
        } finally {
          spy.mockRestore();
        }
      });
    },
  );
  it("prepares a turn-local configured account without changing the human session pin", async () => {
    await withAuthState(async (state) => {
      await state.writeAuthProfiles({
        version: 1,
        profiles: {
          [DEFAULT_PROFILE_ID]: createApiKeyCredential("openai", "synthetic-shared-key"),
          "openai:turn-local": createApiKeyCredential("openai", "synthetic-turn-local-key"),
        },
      });
      const sessionEntry: SessionEntry = {
        sessionId: "turn-local-account",
        updatedAt: 1,
        authProfileOverride: DEFAULT_PROFILE_ID,
        authProfileOverrideSource: "auto",
      };
      await expect(
        selectForRequester(state, sessionEntry, undefined, false, "openai:turn-local"),
      ).resolves.toMatchObject({ profileId: "openai:turn-local", source: "user" });
      expect(sessionEntry.authProfileOverride).toBe(DEFAULT_PROFILE_ID);
      expect(sessionEntry.executionSelection).toBeUndefined();
      await expect(
        selectForRequester(state, sessionEntry, undefined, false, "openai:missing"),
      ).rejects.toThrow('Selected auth profile "openai:missing" is unavailable.');
      expect(sessionEntry.authProfileOverride).toBe(DEFAULT_PROFILE_ID);
    });
  });
  it.each(["selection", "metadata"] as const)(
    "keeps concurrent %s authoritative for an already accepted session",
    async (change) => {
      await withAuthState(async (state) => {
        const alice = ensureProfileForEmail("alice@example.test");
        const personalId = connectAccount(alice.id, "alice");
        const sessionEntry: SessionEntry = {
          sessionId: "accepted-account-session",
          updatedAt: 1,
          authProfileOverride: personalId,
          authProfileOverrideSource: "user",
          executionSelection: {
            state: "accepted",
            fallbackPermission: "explicit",
            selection: {
              model: { provider: "openai", id: "gpt-5.6-luna" },
              executor: { kind: "harness", id: "openclaw" },
            },
          },
        };
        const evaluate = runtimeChoice.evaluatePublishedModelRuntimeChoice;
        const spy = vi
          .spyOn(runtimeChoice, "evaluatePublishedModelRuntimeChoice")
          .mockImplementationOnce(async (params) => {
            const result = await evaluate(params);
            expect(result.kind).toBe("ready");
            if (change === "selection") {
              sessionEntry.executionSelection = {
                state: "accepted",
                fallbackPermission: "explicit",
                selection: {
                  model: { provider: "openai", id: "replacement-model" },
                  executor: { kind: "harness", id: "openclaw" },
                },
              };
            } else {
              sessionEntry.label = "Concurrent label";
            }
            return result;
          });
        try {
          const pending = selectForRequester(state, sessionEntry, alice.id, false);
          if (change === "selection") {
            await expect(pending).rejects.toThrow("session changed");
            expect(sessionEntry.executionSelection).toMatchObject({
              selection: { model: { id: "replacement-model" } },
            });
          } else {
            await expect(pending).resolves.toMatchObject({ profileId: personalId });
            expect(sessionEntry.label).toBe("Concurrent label");
          }
          expect(sessionEntry.authProfileOverride).toBe(personalId);
        } finally {
          spy.mockRestore();
        }
      });
    },
  );
  it.each([false, true])(
    "does not reapply a new-session personal default after its committed pin is cleared (shared account: %s)",
    async (hasSharedAccount) => {
      await withAuthState(async (state) => {
        if (hasSharedAccount) {
          await state.writeAuthProfiles({
            version: 1,
            profiles: {
              [DEFAULT_PROFILE_ID]: createApiKeyCredential("openai", "synthetic-shared-key"),
            },
          });
        }
        const alice = ensureProfileForEmail("alice@example.test");
        const personalId = connectAccount(alice.id, "alice");
        const sessionEntry: SessionEntry = { sessionId: "new-personal-wait", updatedAt: 1 };
        const sessionStore = { [SESSION_KEY]: sessionEntry };
        const prepared = await prepareForRequester(state, sessionEntry, alice.id);
        expect(prepared.auth?.selection).toMatchObject({ profileId: personalId, source: "user" });
        expect(sessionEntry.authProfileOverrideSource).toBe("user-link");
        const acceptedPair = structuredClone(sessionEntry.executionSelection);

        await clearSessionAuthProfileOverride({
          sessionEntry,
          sessionStore,
          sessionKey: SESSION_KEY,
        });
        expect(prepared.auth?.validate(sessionEntry)).toBe(
          "The selected account changed. Try again.",
        );
        const pending = prepared.refreshExecution(sessionEntry);
        if (hasSharedAccount) {
          const refreshed = await pending;
          expect(refreshed.auth?.selection).toMatchObject({
            profileId: DEFAULT_PROFILE_ID,
            source: "auto",
          });
          expect(refreshed.auth?.validate(sessionEntry)).toBeUndefined();
          expect(sessionEntry.authProfileOverride).toBe(DEFAULT_PROFILE_ID);
          expect(sessionEntry.authProfileOverrideSource).toBe("auto");
        } else {
          await expect(pending).rejects.toThrow("Sign in");
          expect(sessionEntry.authProfileOverride).toBeUndefined();
          expect(sessionEntry.authProfileOverrideSource).toBeUndefined();
        }
        expect(sessionEntry.executionSelection).toEqual(acceptedPair);
        expect(sessionEntry.authProfileOverride).not.toBe(personalId);
      });
    },
  );
});
