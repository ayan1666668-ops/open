import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

export class FakeChild extends EventEmitter {
  pid: number;
  stdout = new PassThrough();
  stderr = new PassThrough();
  constructor(pid: number) {
    super();
    this.pid = pid;
  }
}

export function createCanarySnapshotResult(input: string, databasePath?: string) {
  const request: unknown = JSON.parse(input);
  return {
    code: 0,
    stdout: Buffer.from(
      JSON.stringify(
        isRecord(request) && request.mode === "inventory"
          ? {
              databases: databasePath ? [[databasePath, { spellings: [databasePath] }]] : [],
              pluginBytes: 0,
              pluginPlan: "plugin-copy-plan.json",
            }
          : { versions: [], pluginPaths: {} },
      ),
    ),
    stderr: Buffer.alloc(0),
    termination: "exit",
  };
}

type CanaryCommandFixture = {
  pluginInventory: unknown;
  pluginErrors: boolean;
  runtimeContract: unknown;
  runtimeError: boolean;
  lintReport: { ok: boolean; checksRun: number; findings: unknown[]; warnings: unknown[] };
};

export function completeCanaryCommand(
  child: FakeChild,
  args: string[],
  readFixture: () => CanaryCommandFixture,
) {
  queueMicrotask(() => {
    const { pluginInventory, pluginErrors, runtimeContract, runtimeError, lintReport } =
      readFixture();
    if (args.includes("plugins")) {
      child.stdout.write(
        JSON.stringify(
          pluginInventory ?? {
            plugins: [],
            diagnostics: pluginErrors ? [{ level: "error", message: "incompatible plugin" }] : [],
          },
        ),
      );
    }
    if (args.includes("--check")) {
      child.stdout.write(JSON.stringify(runtimeContract));
    }
    if (args.includes("--lint")) {
      child.stdout.write(JSON.stringify(lintReport));
    }
    child.emit(
      "close",
      (runtimeError && args.includes("--check")) || (!lintReport.ok && args.includes("--lint"))
        ? 1
        : 0,
    );
  });
}

export function stubHealthyGateway() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ status: "started", ready: true })),
  );
}

type CanaryFixtureState = {
  databasePath: string | undefined;
  root: string;
  nextPid: number;
  children: Map<number, FakeChild>;
  candidateConfig: Record<string, unknown>;
  childEnv: NodeJS.ProcessEnv;
  pluginErrors: boolean;
  pluginInventory: unknown;
  runtimeError: boolean;
  runtimeContract: unknown;
  lintReport: { ok: boolean; checksRun: number; findings: unknown[]; warnings: unknown[] };
  tempDirs: ReturnType<typeof useAutoCleanupTempDirTracker>;
};

export function useCanaryFixture(
  mocks: Record<"spawn" | "signal" | "reap", ReturnType<typeof vi.fn>> & {
    snapshot: ReturnType<
      typeof vi.fn<(command: unknown, options: { input: string }) => Promise<unknown>>
    >;
  },
) {
  const fixture: CanaryFixtureState = {
    databasePath: undefined,
    root: "",
    nextPid: 41_000,
    children: new Map(),
    candidateConfig: {},
    childEnv: {},
    pluginErrors: false,
    pluginInventory: undefined,
    runtimeError: false,
    runtimeContract: undefined,
    lintReport: { ok: true, checksRun: 1, findings: [], warnings: [] },
    tempDirs: useAutoCleanupTempDirTracker(afterEach),
  };
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("No such process"), { code: "ESRCH" });
    });
    fixture.databasePath = undefined;
    fixture.pluginErrors = false;
    fixture.pluginInventory = undefined;
    fixture.runtimeError = false;
    fixture.runtimeContract = { state: 2, agent: 3 };
    fixture.lintReport = { ok: true, checksRun: 1, findings: [], warnings: [] };
    fixture.root = path.join(await fs.realpath(fixture.tempDirs.make("canary-unit-")), "candidate");
    await fs.mkdir(fixture.root);
    await fs.mkdir(path.join(fixture.root, "dist"));
    await fs.writeFile(path.join(fixture.root, "dist", "index.js"), "");
    await fs.mkdir(path.join(fixture.root, "dist", "infra"));
    await fs.writeFile(
      path.join(fixture.root, "dist", "infra", "update-migrated-finalize.worker.js"),
      "",
    );
    await fs.writeFile(
      path.join(fixture.root, "package.json"),
      JSON.stringify({ version: "2026.9.1" }),
    );
    mocks.snapshot.mockImplementation(async (_command, options: { input: string }) =>
      createCanarySnapshotResult(options.input, fixture.databasePath),
    );
    mocks.spawn.mockImplementation(
      (_command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
        const child = new FakeChild(fixture.nextPid++);
        fixture.children.set(child.pid, child);
        fixture.childEnv = options.env;
        if (args.includes("gateway")) {
          void fs.readFile(options.env.OPENCLAW_CONFIG_PATH!, "utf8").then((raw) => {
            fixture.candidateConfig = JSON.parse(raw) as Record<string, unknown>;
          });
        } else {
          completeCanaryCommand(child, args, () => fixture);
        }
        return child;
      },
    );
    mocks.signal.mockImplementation(
      (pid: number, _signal: string, options: { onComplete?: () => void }) => {
        fixture.children.get(pid)?.emit("close", 0);
        options.onComplete?.();
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fixture.children.clear();
  });

  return fixture;
}
