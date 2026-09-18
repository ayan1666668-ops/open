// Temporary child-suite attribution; remove before landing.
const { channel } = require("node:diagnostics_channel");
const { errorMonitor } = require("node:events");
const { closeSync, openSync, writeSync } = require("node:fs");
const path = require("node:path");
const { setTimeout: nativeSetTimeout } = require("node:timers");

const directory = process.env.OPENCLAW_SKILL_CI_TRACE_DIR;
const files = JSON.parse(process.env.OPENCLAW_SKILL_CI_TRACE_FILES ?? "[]");
const startedAt = Number(process.env.OPENCLAW_SKILL_CI_TRACE_STARTED);
const coordinator =
  process.execArgv.includes("--test") && process.env.NODE_TEST_CONTEXT === undefined;
const fileIndex = coordinator
  ? -1
  : files.indexOf(process.argv[1] ? path.resolve(process.argv[1]) : "");
if (
  directory &&
  files.length === 13 &&
  Number.isFinite(startedAt) &&
  (coordinator || fileIndex >= 0)
) {
  const fd = openSync(
    path.join(directory, `${coordinator ? "coordinator" : fileIndex}-${process.pid}.jsonl`),
    "wx",
    0o600,
  );
  const now = Date.now.bind(Date);
  const resources = process.getActiveResourcesInfo.bind(process);
  const cpuUsage = process.cpuUsage.bind(process);
  const memoryUsage = process.memoryUsage.bind(process);
  const children = new Map();
  let ordinal = 0;
  let bytes = 0;
  let historyBytes = 0;
  let dropped = 0;
  const emit = (event, values = {}, final = false) => {
    const line =
      JSON.stringify({
        event,
        fileIndex,
        pid: process.pid,
        ppid: process.ppid,
        elapsedMs: now() - startedAt,
        ...values,
      }) + "\n";
    const size = Buffer.byteLength(line);
    if (size > 3072 || bytes + size > 16 * 1024 || (!final && historyBytes + size > 7 * 1024)) {
      dropped += 1;
      return;
    }
    try {
      writeSync(fd, line);
      bytes += size;
      if (!final) {
        historyBytes += size;
      }
    } catch {
      dropped += 1;
    }
  };
  const snapshot = (event) => {
    const histogram = {};
    for (const type of resources()) {
      if (/^[A-Za-z0-9_]{1,64}$/u.test(type)) {
        histogram[type] = (histogram[type] ?? 0) + 1;
      }
    }
    const unresolved = [...children.values()].filter((child) => !child.closed);
    emit(
      event,
      {
        resources: Object.fromEntries(Object.entries(histogram).slice(0, 24)),
        childrenObserved: children.size,
        unresolved: unresolved.slice(0, 16),
        omittedChildren: Math.max(0, unresolved.length - 16),
        cpu: cpuUsage(),
        rss: memoryUsage().rss,
        dropped,
      },
      true,
    );
  };
  // File workers retain complete child state for snapshots; only the coordinator
  // streams the 13-file lifecycle so routine fixture children cannot exhaust history.
  channel("child_process").subscribe(({ process: child }) => {
    const state = { ordinal: ++ordinal, pid: null, fileIndex: -1, exited: false, closed: false };
    if (ordinal > 64) {
      dropped += 1;
      return;
    }
    children.set(state.ordinal, state);
    child.once("spawn", () => {
      state.pid = child.pid;
      state.fileIndex = files.findIndex((file) => child.spawnargs.includes(file));
      if (coordinator) {
        emit("child-spawn", { child: state });
      }
    });
    child.once("exit", (code, signal) => {
      state.exited = true;
      if (coordinator) {
        emit("child-exit", { child: { ...state, code, signal } });
      }
    });
    child.once("close", (code, signal) => {
      state.closed = true;
      if (coordinator) {
        emit("child-close", { child: { ...state, code, signal } });
      }
    });
    child.once(errorMonitor, () => emit("child-error", { child: state }));
  });
  emit("start", { file: fileIndex >= 0 ? path.basename(files[fileIndex]) : "coordinator" });
  for (const atMs of [100_000, 115_000]) {
    nativeSetTimeout(
      () => snapshot(`deadline-${atMs}`),
      Math.max(0, startedAt + atMs - now()),
    ).unref();
  }
  process.once("exit", (code) => {
    snapshot("process-exit");
    emit("exit-code", { code }, true);
    closeSync(fd);
  });
}
