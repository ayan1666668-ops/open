import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  loadSessionEntry as loadInternalSessionEntry,
  replaceSessionEntry as replaceInternalSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry as ConfigSessionEntry } from "../config/sessions/types.js";
import {
  getSessionEntry,
  listSessionEntries,
  patchSessionEntry,
  updateSessionStoreEntry,
  upsertSessionEntry,
  type SessionEntry,
} from "./session-store-runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const publicPendingProjectIsPrivate: "pendingProjectGitUrl" extends keyof SessionEntry
  ? false
  : true = true;
const configPendingProjectIsPrivate: "pendingProjectGitUrl" extends keyof ConfigSessionEntry
  ? false
  : true = true;
void publicPendingProjectIsPrivate;
void configPendingProjectIsPrivate;

describe("session-store-runtime recovery boundary", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = tempDirs.make("openclaw-sdk-session-recovery-");
    storePath = path.join(tempDir, "sessions.json");
  });
  it("hides core recovery state and preserves it across public mutations", async () => {
    const sessionKey = "agent:main:recovery-owned";
    const mainRestartRecovery = {
      chargedAttempts: 1,
      cycleId: "cycle-1",
      reservation: {
        attempt: 1,
        lifecycleGeneration: "generation-1",
        runId: "run-1",
      },
      revision: 1,
    };
    await replaceInternalSessionEntry(
      { sessionKey, storePath },
      {
        abortedLastRun: true,
        mainRestartRecovery,
        model: "gpt-5.5",
        restartRecoveryRuns: [{ lifecycleGeneration: "generation-1", runId: "run-1" }],
        sessionId: "session-recovery",
        updatedAt: 10,
      },
    );

    expect(getSessionEntry({ sessionKey, storePath })).not.toHaveProperty("mainRestartRecovery");
    expect(listSessionEntries({ storePath })[0]?.entry).not.toHaveProperty("mainRestartRecovery");

    await patchSessionEntry({
      sessionKey,
      storePath,
      update: (entry) => {
        entry.restartRecoveryRuns?.splice(0);
        return {
          abortedLastRun: false,
          mainRestartRecovery: undefined,
          model: "gpt-5.6",
          restartRecoveryRuns: undefined,
        };
      },
    });
    expect(loadInternalSessionEntry({ sessionKey, storePath })).toMatchObject({
      abortedLastRun: true,
      mainRestartRecovery,
      model: "gpt-5.6",
      restartRecoveryRuns: [{ lifecycleGeneration: "generation-1", runId: "run-1" }],
    });

    await updateSessionStoreEntry({
      sessionKey,
      storePath,
      update: () => ({ abortedLastRun: false, restartRecoveryRuns: undefined }),
    });
    expect(loadInternalSessionEntry({ sessionKey, storePath })).toMatchObject({
      abortedLastRun: true,
      mainRestartRecovery,
      restartRecoveryRuns: [{ lifecycleGeneration: "generation-1", runId: "run-1" }],
    });

    await upsertSessionEntry({
      sessionKey,
      storePath,
      entry: {
        sessionId: "session-recovery",
        updatedAt: 20,
      },
    });
    expect(loadInternalSessionEntry({ sessionKey, storePath })).toMatchObject({
      abortedLastRun: true,
      mainRestartRecovery,
      restartRecoveryRuns: [{ lifecycleGeneration: "generation-1", runId: "run-1" }],
      sessionId: "session-recovery",
      updatedAt: 20,
    });
    expect(loadInternalSessionEntry({ sessionKey, storePath })?.model).toBeUndefined();
  });

  it("allows public recovery fields to change without an active core transaction", async () => {
    const sessionKey = "agent:main:healthy-public-recovery";
    await upsertSessionEntry({
      agentId: "main",
      sessionKey,
      storePath,
      entry: {
        sessionId: "healthy-session",
        updatedAt: 10,
      },
    });

    await patchSessionEntry({
      sessionKey,
      storePath,
      update: () => ({
        abortedLastRun: true,
        restartRecoveryRuns: [{ lifecycleGeneration: "generation-1", runId: "run-1" }],
      }),
    });

    expect(loadInternalSessionEntry({ sessionKey, storePath })).toMatchObject({
      abortedLastRun: true,
      restartRecoveryRuns: [{ lifecycleGeneration: "generation-1", runId: "run-1" }],
      sessionId: "healthy-session",
    });
  });

  it("keeps pending remote-project recovery private across public session mutations", async () => {
    const sessionKey = "agent:main:pending-project";
    const pendingProjectGitUrl = "https://github.com/openclaw/openclaw.git";
    await replaceInternalSessionEntry(
      { sessionKey, storePath },
      { pendingProjectGitUrl, sessionId: "project-session", updatedAt: 10 },
    );

    expect(getSessionEntry({ sessionKey, storePath })).not.toHaveProperty("pendingProjectGitUrl");
    expect(listSessionEntries({ storePath })[0]?.entry).not.toHaveProperty("pendingProjectGitUrl");

    await patchSessionEntry({
      sessionKey,
      storePath,
      update: () => ({ model: "gpt-5.5" }),
    });
    expect(loadInternalSessionEntry({ sessionKey, storePath })).toMatchObject({
      model: "gpt-5.5",
      pendingProjectGitUrl,
    });

    await updateSessionStoreEntry({
      sessionKey,
      storePath,
      update: () => ({ model: "gpt-5.6" }),
    });
    expect(loadInternalSessionEntry({ sessionKey, storePath })).toMatchObject({
      model: "gpt-5.6",
      pendingProjectGitUrl,
    });

    await upsertSessionEntry({
      entry: { sessionId: "project-session", updatedAt: 20 },
      sessionKey,
      storePath,
    });
    expect(loadInternalSessionEntry({ sessionKey, storePath })?.pendingProjectGitUrl).toBe(
      pendingProjectGitUrl,
    );

    await patchSessionEntry({
      replaceEntry: true,
      sessionKey,
      storePath,
      update: () => ({ sessionId: "replacement-session", updatedAt: 30 }),
    });
    expect(loadInternalSessionEntry({ sessionKey, storePath })).not.toHaveProperty(
      "pendingProjectGitUrl",
    );
  });

  it("rejects core recovery state from runtime-escaped creation inputs", async () => {
    const mainRestartRecovery = {
      chargedAttempts: 1,
      cycleId: "cycle-injected",
      revision: 1,
    };
    const patchSessionKey = "agent:main:patch-created";
    await patchSessionEntry({
      fallbackEntry: {
        mainRestartRecovery,
        pendingProjectGitUrl: "https://github.com/openclaw/injected.git",
        sessionId: "patch-created",
        updatedAt: 10,
      } as unknown as SessionEntry,
      sessionKey: patchSessionKey,
      storePath,
      update: () => ({ updatedAt: 20 }),
    });
    expect(loadInternalSessionEntry({ sessionKey: patchSessionKey, storePath })).not.toHaveProperty(
      "mainRestartRecovery",
    );
    expect(loadInternalSessionEntry({ sessionKey: patchSessionKey, storePath })).not.toHaveProperty(
      "pendingProjectGitUrl",
    );

    const upsertSessionKey = "agent:main:upsert-created";
    await upsertSessionEntry({
      entry: {
        mainRestartRecovery,
        pendingProjectGitUrl: "https://github.com/openclaw/injected.git",
        sessionId: "upsert-created",
        updatedAt: 10,
      } as unknown as SessionEntry,
      sessionKey: upsertSessionKey,
      storePath,
    });
    expect(
      loadInternalSessionEntry({ sessionKey: upsertSessionKey, storePath }),
    ).not.toHaveProperty("mainRestartRecovery");
    expect(
      loadInternalSessionEntry({ sessionKey: upsertSessionKey, storePath }),
    ).not.toHaveProperty("pendingProjectGitUrl");
  });

  it.each(["replace", "upsert", "patch", "update"] as const)(
    "clears core recovery when public %s changes session identity",
    async (operation) => {
      const scope = { sessionKey: `agent:main:${operation}-rotation`, storePath };
      const recovery = {
        abortedLastRun: true,
        restartRecoveryRuns: [{ lifecycleGeneration: "generation", runId: "run" }],
      };
      await replaceInternalSessionEntry(scope, {
        ...recovery,
        mainRestartRecovery: { chargedAttempts: 1, cycleId: "rotation-cycle", revision: 1 },
        sessionId: "before",
        updatedAt: 10,
      });
      const replacement = { sessionId: "after", updatedAt: 20 };
      if (operation === "upsert") {
        await upsertSessionEntry({ ...scope, entry: { ...recovery, ...replacement } });
      } else if (operation === "update") {
        await updateSessionStoreEntry({
          ...scope,
          skipMaintenance: true,
          update: () => replacement,
        });
      } else {
        await patchSessionEntry({
          ...scope,
          replaceEntry: operation === "replace",
          skipMaintenance: true,
          update: () => replacement,
        });
      }
      const entry = loadInternalSessionEntry(scope);
      expect(entry).toMatchObject({ sessionId: "after" });
      expect(entry?.abortedLastRun).not.toBe(true);
      expect(entry?.restartRecoveryRuns).toBeUndefined();
      expect(entry).not.toHaveProperty("mainRestartRecovery");
    },
  );
});
