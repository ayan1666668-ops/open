import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { createServiceChildRelayAdapter } from "../../src/process/supervisor/service-child-relay-host.js";
import type { OpenClawTestProcess } from "./openclaw-test-instance.js";

export async function spawnWindowsGatewayProcess(params: {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  startupDeadline: number;
  stopTimeoutMs: number;
  onSpawnCleanup: (completion: Promise<void>) => void;
  onError: (error: unknown) => void;
}): Promise<OpenClawTestProcess> {
  const startupAbort = new AbortController();
  const timeout = setTimeout(
    () => startupAbort.abort(new Error("Windows Gateway startup deadline exceeded")),
    Math.max(0, params.startupDeadline - Date.now()),
  );
  let adapter: Awaited<ReturnType<typeof createServiceChildRelayAdapter>>;
  try {
    adapter = await createServiceChildRelayAdapter({
      command: process.execPath,
      args: params.args,
      cwd: params.cwd,
      env: params.env,
      abortSignal: params.signal
        ? AbortSignal.any([params.signal, startupAbort.signal])
        : startupAbort.signal,
      onSpawnCleanup: params.onSpawnCleanup,
      stdinMode: "pipe-closed",
      oomScoreWrapperSelected: false,
      windowsJob: true,
      cleanupTimeoutMs: params.stopTimeoutMs,
    });
  } finally {
    clearTimeout(timeout);
  }
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    pid: adapter.pid,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    killed: false,
    stdout,
    stderr,
    kill(signal: NodeJS.Signals = "SIGTERM") {
      adapter.kill(signal);
      child.killed = true;
      return true;
    },
  });
  let exited = false;
  const recordExit = (code: number | null, signal: NodeJS.Signals | null) => {
    if (!exited) {
      exited = true;
      child.exitCode = code;
      child.signalCode = signal;
      child.emit("exit", code, signal);
    }
  };
  adapter.onExit(recordExit);
  adapter.onError(params.onError);
  adapter.onStdout((chunk) => stdout.write(chunk));
  adapter.onStderr((chunk) => stderr.write(chunk));
  const result = adapter.wait().then((outcome) => {
    recordExit(outcome.code, outcome.signal);
    return outcome;
  });
  // Output closure certifies the existing supervisor's native Job extinction,
  // including descendants that inherited neither output pipe.
  void Promise.all([result, adapter.waitForExtinction()])
    .then(async ([outcome]) => {
      const closed = Promise.all([once(stdout, "close"), once(stderr, "close")]);
      stdout.end();
      stderr.end();
      await closed;
      adapter.dispose();
      child.emit("close", outcome.code, outcome.signal);
    })
    .catch(params.onError);
  return child;
}
