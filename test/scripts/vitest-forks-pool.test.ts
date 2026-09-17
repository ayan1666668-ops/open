import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { runVitestShutdownCommand } from "../helpers/vitest-shutdown-command.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const repoRoot = path.resolve(import.meta.dirname, "../..");
const posixNodeIt = it.skipIf(process.platform === "win32" || Boolean(process.versions.bun));

posixNodeIt.for(["normal", "missing-ack", "after-ack", "blocked-after-ack"] as const)(
  "retains native fork cleanup and captures only stalled teardown (%s)",
  { timeout: 180_000 },
  async (mode, { signal }) => {
    const root = tempDirs.make("openclaw-pool-diagnostics-");
    const home = path.join(root, "home");
    const tmp = path.join(root, "tmp");
    fs.mkdirSync(home);
    fs.mkdirSync(tmp);
    fs.symlinkSync(
      path.join(repoRoot, "node_modules"),
      path.join(root, "node_modules"),
      "junction",
    );
    fs.writeFileSync(path.join(root, "package.json"), '{"type":"module","private":true}');
    const receipt = path.join(root, "deadline.json");
    const preload = path.join(root, "hold-teardown.cjs");
    fs.writeFileSync(
      preload,
      `
const { subscribe } = require("node:diagnostics_channel");
const fs = require("node:fs");
const mode = ${JSON.stringify(mode)};
const schedule = globalThis.setTimeout;
const cancel = globalThis.clearTimeout;
const deadlines = new Map();
globalThis.setTimeout = (callback, delay, ...args) => {
  if (delay !== 60000) return schedule(callback, delay, ...args);
  const invoke = () => callback(...args);
  const timer = schedule(() => { deadlines.delete(timer); invoke(); }, delay);
  deadlines.set(timer, invoke);
  return timer;
};
globalThis.clearTimeout = timer => { deadlines.delete(timer); return cancel(timer); };
const isFork = arg => typeof arg === "string" && arg.replaceAll("\\\\", "/").endsWith("/vitest/dist/workers/forks.js");
if (isFork(process.argv[1]) && process.send) {
  const send = process.send;
  const held = () => send.call(process, { fixtureTeardownHeld: true }, () => {
    if (mode === "blocked-after-ack") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  });
  if (mode === "missing-ack") {
    const emit = process.emit;
    process.emit = function(event, message, ...args) {
      if (event === "message" && message?.__vitest_worker_request__ === true && message.type === "stop") {
        held();
        return true;
      }
      return emit.call(this, event, message, ...args);
    };
  } else if (mode === "after-ack" || mode === "blocked-after-ack") {
    process.send = function(message, ...args) {
      if (message?.__vitest_worker_response__ === true && message.type === "stopped" && message.willExit === true) {
        // Hold the transport's explicit process.exit callback after its acknowledgement flushes.
        args[args.length - 1] = error => { if (error) throw error; held(); };
      }
      return send.call(this, message, ...args);
    };
  }
}
subscribe("child_process", ({ process: child }) => {
  let selected = false;
  child.once("spawn", () => { selected = child.spawnargs.some(isFork); });
  child.on("message", message => {
    if (!selected || message?.fixtureTeardownHeld !== true) return;
    setImmediate(() => {
      fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ liveDeadlines: deadlines.size, delay: 60000 }));
      if (deadlines.size !== 1) throw new Error("expected one live Vitest stop deadline");
      const [timer, invoke] = deadlines.entries().next().value;
      cancel(timer);
      deadlines.delete(timer);
      invoke();
    });
  });
});
`,
    );
    const workerReceipts = path.join(root, "workers.jsonl");
    for (const filename of ["first.test.ts", "second.test.ts"]) {
      fs.writeFileSync(
        path.join(root, filename),
        `
import fs from "node:fs";
import { once } from "node:events";
import { createServer } from "node:net";
import { Worker, isMainThread } from "node:worker_threads";
import { expect, it } from "vitest";
it("runs on the fork main thread with ready native handles", async () => {
  expect(isMainThread).toBe(true);
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const worker = new Worker("require('node:worker_threads').parentPort.postMessage('ready'); setInterval(() => {}, 1000)", { eval: true });
  await once(worker, "message");
  fs.appendFileSync(${JSON.stringify(workerReceipts)}, JSON.stringify({ pid: process.pid, reportDirectory: process.report.directory }) + "\\n");
  if (${JSON.stringify(mode)} === "normal") {
    await worker.terminate();
    await new Promise(resolve => server.close(resolve));
  }
});
`,
      );
    }
    const config = path.join(root, "vitest.config.ts");
    fs.writeFileSync(
      config,
      `
import { createExtensionDatabaseWorkersVitestConfig } from ${JSON.stringify(path.join(repoRoot, "test/vitest/vitest.extension-database-workers.config.ts"))};
const extension = createExtensionDatabaseWorkersVitestConfig({});
export default {
  root: ${JSON.stringify(root)},
  test: {
    pool: extension.test.pool,
    include: ["*.test.ts"],
    isolate: false,
    maxWorkers: 1,
    fileParallelism: false,
    fsModuleCache: false,
    reporters: ["default"],
  },
};
`,
    );
    const result = await runVitestShutdownCommand({
      args: [
        path.join(repoRoot, "scripts/run-vitest.mjs"),
        "run",
        "--config",
        config,
        "--root",
        root,
        "--configLoader",
        "native",
      ],
      cwd: root,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        TMPDIR: tmp,
        TMP: tmp,
        TEMP: tmp,
        CI: "1",
        NODE_OPTIONS: `--require=${preload}`,
        OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: path.join(root, "cache"),
        POOL_DIAGNOSTIC_FIXTURE_SECRET: "fixture-env-value-do-not-print",
      },
      signal,
    });
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toMatch(/2 passed/u);
    const workers = fs
      .readFileSync(workerReceipts, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { pid: number; reportDirectory: string });
    expect(new Set(workers.map(({ pid }) => pid)).size).toBe(1);
    for (const { reportDirectory } of workers) {
      if (reportDirectory) {
        expect(fs.existsSync(reportDirectory)).toBe(false);
      }
    }
    if (mode === "normal") {
      expect(result.code, output).toBe(0);
      expect(output).not.toContain("vitest-pool-diagnostics");
      expect(output).not.toContain("Writing Node.js report");
      return;
    }
    expect(result.code, output).toBe(1);
    expect(JSON.parse(fs.readFileSync(receipt, "utf8"))).toEqual({
      liveDeadlines: 1,
      delay: 60_000,
    });
    expect(output).toContain("Timeout waiting for worker to respond");
    const report = output.match(
      /\[vitest-pool-diagnostics\][^\n]*\n([\s\S]*?)\n\[\/vitest-pool-diagnostics\]/u,
    )?.[1];
    expect(report, output).toBeDefined();
    expect(output).toContain(`stopAcknowledged=${mode !== "missing-ack"}`);
    expect(output).not.toMatch(
      /fixture-env-value-do-not-print|127\.0\.0\.1|localEndpoint|remoteEndpoint/u,
    );
    if (mode === "blocked-after-ack") {
      expect(report).toBe("No complete Node diagnostic report captured within 2000ms.");
      return;
    }
    expect(JSON.parse(report!)).toMatchObject({
      nativeStack: expect.any(Array),
      libuv: expect.arrayContaining([
        expect.objectContaining({ type: "tcp", is_active: true, is_referenced: true }),
      ]),
      workers: expect.arrayContaining([
        expect.objectContaining({
          threadId: expect.any(Number),
          libuv: expect.arrayContaining([expect.objectContaining({ type: "timer" })]),
        }),
      ]),
    });
  },
);
