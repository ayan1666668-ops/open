import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { controlGatewayProfile } from "../../scripts/lib/gateway-bench-profile.js";

const workload = `
const { Worker } = require('node:worker_threads');
const keepAlive = setInterval(() => {}, 1000);
process.once('disconnect', () => clearInterval(keepAlive));
let worker;
process.on('message', (message) => {
  if (message.run) {
    worker = new Worker(\`
      const { parentPort } = require('node:worker_threads');
      let total = 0;
      function allocateForProfile() {
        const until = Date.now() + 500;
        while (Date.now() < until) {
          const rows = Array.from({length: 10000}, (_, i) => ({i, values: [i, i + 1]}));
          total += rows[rows.length - 1].values[1];
        }
        parentPort.postMessage(total);
      }
      parentPort.on('message', allocateForProfile);
    \`, {eval: true, execArgv: []});
    worker.once('online', () => worker.postMessage('run'));
    worker.once('message', () => process.send({complete: true}));
  }
  if (message.retire) worker.terminate().then(() => process.send({retired: true}));
});
process.send({ready: true});
`;

async function waitMessage(child: ChildProcess, field: string) {
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", finish);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const onMessage = (message: Record<string, unknown>) => {
      if (message[field]) {
        finish();
      }
    };
    const onExit = () => finish(new Error(`Profile fixture exited before ${field}`));
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("error", finish);
  });
}

it.each(["cpu", "heap"] as const)(
  "profiles workers created after %s sampling starts and records terminated isolates",
  async (kind) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "gateway-worker-profile-"));
    const profilePath = path.join(directory, kind);
    const child = spawn(
      process.execPath,
      [
        "--import",
        new URL("../../scripts/lib/gateway-bench-profile-preload.ts", import.meta.url).href,
        "-e",
        workload,
      ],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    try {
      await waitMessage(child, "ready");
      await controlGatewayProfile(child, kind, "start", profilePath, { includeWorkers: true });
      const complete = waitMessage(child, "complete");
      child.send({ run: true });
      await complete;
      await controlGatewayProfile(child, kind, "stop", profilePath, { includeWorkers: true });
      const manifest = JSON.parse(await readFile(`${profilePath}.workers.json`, "utf8"));
      expect(manifest.workers).toHaveLength(1);
      expect(manifest.workers[0]).toMatchObject({ completed: true });
      expect(
        manifest.samples.some((sample: { workers: unknown[] }) => sample.workers.length === 1),
      ).toBe(true);
      const workerProfile = JSON.parse(await readFile(manifest.workers[0].profilePath, "utf8"));
      expect(JSON.stringify(workerProfile)).toContain("allocateForProfile");
      expect(await readFile(profilePath, "utf8")).not.toBe("");

      const retiredPath = path.join(directory, `${kind}-retired`);
      await controlGatewayProfile(child, kind, "start", retiredPath, { includeWorkers: true });
      const retired = waitMessage(child, "retired");
      child.send({ retire: true });
      await retired;
      await controlGatewayProfile(child, kind, "stop", retiredPath, { includeWorkers: true });
      const incomplete = JSON.parse(await readFile(`${retiredPath}.workers.json`, "utf8"));
      expect(incomplete.workers[0].completed).not.toBe(true);
      expect(incomplete.workers[0].error).toBeTruthy();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
