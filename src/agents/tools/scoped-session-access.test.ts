import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { runWithScopedSessionAccess } from "./scoped-session-access.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
async function createScope() {
  const storePath = path.join(temporary.make("scoped-session-selection-"), "sessions.sqlite");
  const key = "agent:main:qa-status";
  await replaceSessionEntry(
    { agentId: "main", sessionKey: key, storePath },
    {
      sessionId: "qa-session",
      updatedAt: 1,
    },
  );
  return {
    cfg: { session: { store: storePath } },
    agentId: "main",
    expectedSessionId: "qa-session",
    targetSessionKey: key,
  };
}

describe("scoped session mutation authority", () => {
  it("revokes the assertion when its scope completes", async () => {
    const scope = await createScope();
    const assertCurrent = await runWithScopedSessionAccess({
      ...scope,
      run: async (assert) => {
        assert();
        return assert;
      },
    });
    expect(assertCurrent).toThrow("no longer active");
  });

  it("rejects a mutation after cancellation during asynchronous preparation", async () => {
    const scope = await createScope();
    const controller = new AbortController();
    const entered = createDeferred();
    const resume = createDeferred();
    let mutated = false;
    const operation = runWithScopedSessionAccess({
      ...scope,
      signal: controller.signal,
      run: async (assertCurrent) => {
        entered.resolve();
        await resume.promise;
        assertCurrent();
        mutated = true;
      },
    });
    await Promise.race([
      entered.promise,
      operation.then(() => {
        throw new Error("Scope ended before preparation.");
      }),
    ]);
    controller.abort(new Error("selection cancelled"));
    resume.resolve();
    await expect(operation).rejects.toThrow("selection cancelled");
    expect(mutated).toBe(false);
  });
});
