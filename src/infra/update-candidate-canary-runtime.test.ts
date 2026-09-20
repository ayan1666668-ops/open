import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { validateUpdateCandidateCanary } from "./update-candidate-canary.js";
import {
  completeCanaryCommand,
  createCanarySnapshotResult,
  FakeChild,
  serializeCanaryPackage,
  stubHealthyGateway,
} from "./update-candidate-canary.test-support.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), snapshot: vi.fn(), signal: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) =>
  (await import("./update-candidate-canary-mocks.test-support.js")).mockCanaryChildProcesses(
    await importOriginal<typeof import("node:child_process")>(),
    mocks.spawn,
  ),
);
vi.mock("../process/exec.js", async (importOriginal) => {
  const { mockCanarySnapshotCommands } =
    await import("./update-candidate-canary-mocks.test-support.js");
  return mockCanarySnapshotCommands(
    await importOriginal<typeof import("../process/exec.js")>(),
    mocks.snapshot,
  );
});
vi.mock("../process/kill-tree.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/kill-tree.js")>()),
  signalProcessTree: mocks.signal,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("runs copied migration preflight with the exact candidate runtime and schema 17 support", async () => {
  const root = path.join(await fs.realpath(tempDirs.make("canary-runtime-")), "candidate");
  const candidateNode = path.join(root, "candidate-node");
  const children = new Map<number, FakeChild>();
  await fs.mkdir(path.join(root, "dist", "infra"), { recursive: true });
  await fs.writeFile(path.join(root, "dist", "index.js"), "");
  await fs.writeFile(path.join(root, "dist", "infra", "update-migrated-finalize.worker.js"), "");
  await fs.writeFile(path.join(root, "package.json"), serializeCanaryPackage("2026.9.19", 17, 21));
  await fs.symlink(process.execPath, candidateNode);
  mocks.snapshot.mockImplementation(async (_command, options: { input: string }) =>
    createCanarySnapshotResult(options.input),
  );
  mocks.spawn.mockImplementation((_command: string, args: string[]) => {
    const child = new FakeChild(42_000 + children.size);
    children.set(child.pid, child);
    if (!args.includes("gateway")) {
      completeCanaryCommand(child, args, () => ({
        pluginInventory: undefined,
        pluginErrors: false,
        runtimeContract: { state: 17, agent: 21 },
        runtimeError: false,
        lintReport: { ok: true, checksRun: 1, findings: [], warnings: [] },
      }));
    }
    return child;
  });
  mocks.signal.mockImplementation(
    (pid: number, _signal: string, options: { onComplete?: () => void }) => {
      children.get(pid)?.emit("close", 0);
      options.onComplete?.();
    },
  );
  stubHealthyGateway();

  const result = await validateUpdateCandidateCanary({
    root,
    stateDir: root,
    config: {},
    env: {},
    timeoutMs: 3_000,
    nodeRunner: candidateNode,
  });

  expect(result).toMatchObject({
    status: "ok",
    candidateSchemaVersions: { state: 17, agent: 21 },
    candidateRuntimeIdentity: {
      version: "2026.9.19",
      schemaVersions: { state: 17, agent: 21 },
      nodeRunner: await fs.realpath(process.execPath),
    },
  });
  const doctorCall = mocks.spawn.mock.calls.find(([, args]) => args.includes("doctor"));
  expect(doctorCall?.[0]).toBe(candidateNode);
  expect(doctorCall?.[1]).toEqual(expect.arrayContaining(["doctor", "--fix"]));
  expect(doctorCall?.[2].env.OPENCLAW_STATE_DIR).not.toBe(root);
});
