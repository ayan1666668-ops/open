import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { afterEach, expect, it, vi } from "vitest";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
} from "../../process/exec-result.js";
import {
  resolveCommandProcessSignal,
  retainCommandProcessCleanup,
} from "../../process/exec-spawn.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { UpdatePreMutationError } from "./shared.js";
import { resolveMutableUpdateFailure } from "./update-command-result.js";
import { withUpdateCommandRecoveryUnwind } from "./update-command-unwind.js";

const boundary = vi.hoisted(() => ({ admission: vi.fn(), fail: vi.fn() }));
vi.mock("../../infra/update-run-recovery-admission.js", () => ({
  assertUpdateRecoveryAdmission: boundary.admission,
}));
vi.mock("./update-command-run.js", () => ({
  completeUpdateCommandRun: vi.fn(),
  failUpdateCommandRun: boundary.fail,
}));
vi.mock("./update-command-terminal.js", () => ({
  hasDeferredUpdateCommandTerminalResult: () => false,
}));
afterEach(() => vi.clearAllMocks());

it.each(["forced", "uncertain"] as const)(
  "joins command cleanup before updater compensation (%s)",
  async (cleanupResult) => {
    const cleanup = createDeferredCore<"forced" | "uncertain">();
    const joining = createDeferredCore();
    const original = new Error("mutation cancelled");
    const restore = vi.fn(async () => {});
    const complete = vi.fn(async () => {});
    const work = withUpdateCommandRecoveryUnwind(
      { run: { runId: "synthetic", env: {}, executorFence: { assertCurrent: () => {} } } },
      {
        triageTarget: { root: "/synthetic", env: {} },
        windowsTaskAutoStartRecovery: {
          restore,
          complete,
          suspended: Promise.resolve(true),
          beginMutation: () => {},
          handoff: () => {},
          interrupted: () => false,
        },
      },
      async () => {
        retainCommandProcessCleanup(cleanup.promise);
        resolveCommandProcessSignal()?.addEventListener("abort", () => joining.resolve(), {
          once: true,
        });
        throw original;
      },
    ).catch((error: unknown) => error);
    try {
      await Promise.race([
        joining.promise,
        work.then(() => {
          throw new Error("compensation escaped cleanup ownership");
        }),
      ]);
      expect(boundary.admission).not.toHaveBeenCalled();
      expect(restore).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
    } finally {
      cleanup.resolve(cleanupResult);
      await work;
    }
    const error = await work;
    expect(hasCommandProcessCleanupError(error)).toBe(cleanupResult === "uncertain");
    if (cleanupResult === "uncertain") {
      expect(collectNestedErrorCandidates(error)).toContain(original);
      expect(boundary.admission).not.toHaveBeenCalled();
      expect(restore).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
      expect(boundary.fail).not.toHaveBeenCalled();
    } else {
      expect(error).toBe(original);
      expect(restore).toHaveBeenCalledOnce();
      expect(complete).toHaveBeenCalledOnce();
      expect(boundary.fail).toHaveBeenCalledOnce();
    }
  },
);

it("rejects uncertain pre-mutation failures before inspecting recovery", async () => {
  const error = new UpdatePreMutationError("inspection-failed", "Inspection failed", {
    cause: new CommandProcessCleanupError(),
  });
  const originalRecovery = vi.fn(async () => ({
    serviceRestartSafe: true as const,
    version: "2026.9.4",
  }));
  await expect(
    resolveMutableUpdateFailure({
      cause: error,
      durationMs: 1,
      mode: "npm",
      root: "/synthetic",
      originalRecovery,
    }),
  ).rejects.toBe(error);
  expect(originalRecovery).not.toHaveBeenCalled();
});
