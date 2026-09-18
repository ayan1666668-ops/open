import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSessionEntry, replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { projectPublicSessionEntry } from "../config/sessions/session-entry-projection.js";
import { ensureProfileForEmail, linkEmail } from "../state/user-profiles.js";
import {
  SESSION_KEY,
  SESSION_ID,
  withMentionInbox as withInbox,
  readMentionInbox as read,
} from "./mention-inbox.test-support.js";
import { identifiedClient } from "./server-methods/sessions-sharing.test-support.js";
import { listSessionFixture } from "./session-list.test-support.js";

afterEach(() => vi.useRealTimers());

describe("personal session involvement", () => {
  it("includes a mentioned recipient without recording an authored contribution", async () => {
    await withInbox(async (f) => {
      const scope = { agentId: "main", sessionKey: SESSION_KEY };
      const list = async (profileId = f.bob.id, involving = true) => {
        const entry = loadSessionEntry(scope)!;
        expect(projectPublicSessionEntry(entry)).not.toHaveProperty("profileInvolvement");
        expect(entry.participants).toBeUndefined();
        return await listSessionFixture({
          cfg: { agents: { entries: { main: {} } } },
          storePath: "",
          store: { [SESSION_KEY]: entry },
          // Inbox expiry is independent of the session archive-age policy.
          opts: { archived: "all" },
          ...(involving ? { involvingActorId: profileId } : { ownerFirstActorId: profileId }),
        });
      };
      expect((await list()).sessions).toEqual([]);
      f.post();
      expect((await list()).sessions.map((row) => row.key)).toEqual([SESSION_KEY]);
      const items = read(f.inbox, f.bobClient).items;
      f.inbox.dismiss(
        f.bobClient,
        items.map((item) => item.id),
      );
      expect((await list()).sessions.map((row) => row.key)).toEqual([SESSION_KEY]);
      const setHidden = (hidden: boolean) =>
        f.call("sessions.setInvolvement", {
          key: SESSION_KEY,
          expectedSessionId: SESSION_ID,
          hidden,
        });
      expect((await setHidden(true)).ok).toBe(true);
      expect((await list()).sessions).toEqual([]);
      expect((await list(f.bob.id, false)).sessions[0]?.hiddenFromInvolvingMe).toBe(true);
      expect((await list(f.alice.id)).sessions).toHaveLength(1);
      f.post();
      expect((await list()).sessions).toEqual([]);
      // A stale generic metadata replacement must not erase the personal choice.
      replaceSessionEntrySync(scope, {
        sessionId: SESSION_ID,
        updatedAt: Date.now(),
        displayName: "Renamed",
      });
      expect((await list()).sessions).toEqual([]);
      vi.useFakeTimers();
      await vi.advanceTimersByTimeAsync(8 * 24 * 60 * 60_000);
      f.inbox.dispose();
      const restarted = f.openInbox("after-retention");
      f.post("source-one", {}, restarted);
      expect((await list()).sessions).toEqual([]);
      f.post("fresh-mention", {}, restarted);
      expect((await list()).sessions.map((row) => row.key)).toEqual([SESSION_KEY]);
      expect((await setHidden(true)).ok).toBe(true);
      expect((await setHidden(false)).ok).toBe(true);
      expect((await list()).sessions).toHaveLength(1);
      // Reset retains the logical node; a fork must not inherit anyone's list choices.
      const previous = loadSessionEntry(scope)!;
      replaceSessionEntrySync(scope, { ...previous, sessionId: "reset-generation" });
      expect((await list()).sessions).toHaveLength(1);
      const forkScope = { ...scope, sessionKey: "agent:main:fork" };
      replaceSessionEntrySync(forkScope, { ...previous, sessionId: "fork-generation" });
      expect(loadSessionEntry(forkScope)).not.toHaveProperty("profileInvolvement");
    });
  });

  it("rejects personal hide requests for another identity or stale/inaccessible sessions", async () => {
    await withInbox(async (f) => {
      const params = { key: SESSION_KEY, expectedSessionId: SESSION_ID, hidden: true };
      expect(
        (await f.call("sessions.setInvolvement", { ...params, profileId: f.alice.id })).ok,
      ).toBe(false);
      expect(
        (await f.call("sessions.setInvolvement", { ...params, expectedSessionId: "stale" })).ok,
      ).toBe(false);
      expect(
        (
          await f.call("sessions.setInvolvement", params, {
            ...f.bobClient,
            internal: { syntheticClient: true },
          })
        ).ok,
      ).toBe(false);
      await f.setSession({ visibility: "draft" });
      expect((await f.call("sessions.setInvolvement", params)).ok).toBe(false);
      await f.setSession({ incognito: true });
      expect((await f.call("sessions.setInvolvement", params)).ok).toBe(false);
      expect(loadSessionEntry({ agentId: "main", sessionKey: SESSION_KEY })).not.toHaveProperty(
        "profileInvolvement",
      );
    });
  });

  it("does not let a personal show choice change another viewer's involvement query", async () => {
    await withInbox(async (f) => {
      const list = async (personal: boolean) =>
        listSessionFixture({
          cfg: { agents: { entries: { main: {} } } },
          storePath: "",
          store: { [SESSION_KEY]: loadSessionEntry({ agentId: "main", sessionKey: SESSION_KEY })! },
          opts: personal
            ? {}
            : { profileRelation: { profileId: f.bob.id, relationship: "involving" } },
          ...(personal ? { involvingActorId: f.bob.id } : { ownerFirstActorId: f.alice.id }),
        });
      for (const hidden of [true, false, true]) {
        expect(
          (
            await f.call("sessions.setInvolvement", {
              key: SESSION_KEY,
              expectedSessionId: SESSION_ID,
              hidden,
            })
          ).ok,
        ).toBe(true);
        expect((await list(true)).sessions).toHaveLength(hidden ? 0 : 1);
        expect((await list(false)).sessions).toEqual([]);
      }
    });
  });

  it.each([true, false])(
    "keeps merged visibility separate from mention evidence (both mentioned: %s)",
    async (bothMentioned) => {
      await withInbox(async (f) => {
        const old = ensureProfileForEmail("previous@mentions.example.test");
        const oldClient = { ...identifiedClient(old.id, "Previous"), connId: "previous" };
        f.post("old-mention", { recipientProfileIds: [old.id] });
        if (bothMentioned) {
          f.post("existing-current-profile-mention");
        }
        expect(
          (
            await f.call(
              "sessions.setInvolvement",
              { key: SESSION_KEY, expectedSessionId: SESSION_ID, hidden: true },
              bothMentioned ? oldClient : f.bobClient,
            )
          ).ok,
        ).toBe(true);
        linkEmail("previous@mentions.example.test", f.bob.id);
        const list = async (personal = true) =>
          listSessionFixture({
            cfg: { agents: { entries: { main: {} } } },
            storePath: "",
            store: {
              [SESSION_KEY]: loadSessionEntry({ agentId: "main", sessionKey: SESSION_KEY })!,
            },
            opts: personal
              ? {}
              : { profileRelation: { profileId: f.bob.id, relationship: "involving" } },
            ...(personal ? { involvingActorId: f.bob.id } : { ownerFirstActorId: f.alice.id }),
          });
        expect((await list()).sessions).toEqual([]);
        expect((await list(false)).sessions).toHaveLength(1);
        if (bothMentioned) {
          f.post("existing-current-profile-mention");
        }
        expect((await list()).sessions).toEqual([]);
        f.post("new-mention");
        expect((await list()).sessions).toHaveLength(1);
      });
    },
  );
});
