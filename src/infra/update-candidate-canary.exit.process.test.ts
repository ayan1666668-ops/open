import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { tryListenOnPort } from "./ports-probe.js";
import { validateUpdateCandidateCanary } from "./update-candidate-canary.js";
import { buildUpdateRehearsalPathEnv } from "./update-rehearsal-paths.js";
import { renderUpdateRunReport, updateRunReportInputFromResult } from "./update-run-report.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

it.each(["doctor", "lint", "missing", "failed", "failed-exit", "signalled-exit"] as const)(
  "preserves completed checks across a real child exit stall (%s)",
  async (mode) => {
    const root = await fs.realpath(dirs.make("canary-exit-"));
    const stateDir = path.join(root, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.mkdir(stateDir);
    await fs.writeFile(configPath, "{}");
    await fs.mkdir(path.join(root, "dist", "infra"), { recursive: true });
    await fs.writeFile(path.join(root, "package.json"), '{"version":"2026.9.5","type":"module"}');
    await fs.writeFile(
      path.join(root, "dist", "infra", "update-migrated-finalize.worker.js"),
      "console.log(JSON.stringify({state: 2, agent: 3}));",
    );
    await fs.writeFile(
      path.join(root, "dist", "index.js"),
      `import { createServer } from "node:http";
import { spawn } from "node:child_process";
const mode = ${JSON.stringify(mode)};
const args = process.argv.slice(2);
if (args.includes("--fix")) {
  console.error("└  Doctor complete.");
  if (mode === "doctor") setInterval(() => {}, 1000);
} else if (args.includes("--lint")) {
  if (mode !== "missing") console.log(JSON.stringify({
    ok: mode !== "failed", checksRun: 1,
    findings: mode === "failed" ? [{ checkId: "core/config", message: "Invalid configuration" }] : [],
  }));
  if (mode === "failed-exit" || mode === "signalled-exit") {
    spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: ["ignore", "inherit", "inherit"],
    }).unref();
    process.stdout.write("", () => {
      if (mode === "signalled-exit") process.kill(process.pid, "SIGTERM");
      else process.exit(7);
    });
  }
  if (mode !== "doctor") setInterval(() => {}, 1000);
} else if (args.includes("plugins")) {
  console.log(JSON.stringify({plugins: [], diagnostics: []}));
} else if (args.includes("gateway")) {
  createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({status: "started", ready: true}));
  }).listen(Number(args.at(-1)), "127.0.0.1");
}
`,
    );
    const result = await validateUpdateCandidateCanary({
      root,
      config: {},
      stateDir,
      timeoutMs: 2_000,
      rehearsal: {
        sourceConfig: {},
        sourceConfigHash: null,
        stateDir,
        configPath,
        workspaceDir: stateDir,
        port: await tryListenOnPort({ port: 0, host: "127.0.0.1" }),
        env: buildUpdateRehearsalPathEnv(stateDir),
        snapshotCapacity: {
          reason: "explicit-tmpdir",
          sqliteBytes: 0,
          pluginBytes: 0,
          requiredBytes: 0,
          candidates: [],
          selection: { kind: "explicit-tmpdir", directory: stateDir },
        },
        cleanupDirectories: [],
        cleanup: async () => {},
      },
    });
    const failedExit = mode === "failed-exit" || mode === "signalled-exit";
    const step = result.steps.find((candidate) =>
      failedExit
        ? candidate.name === "Checking update health"
        : candidate.termination === "timeout",
    )!;
    expect(step).toBeDefined();
    const report = renderUpdateRunReport(
      updateRunReportInputFromResult({ ...result, mode: "npm", root }),
    ).markdown;
    if (failedExit) {
      expect(result, report).toMatchObject({ status: "error", phase: "lint" });
      expect(step.exitCode).toBe(mode === "failed-exit" ? 7 : 1);
      expect(step.failureFacts).toMatchObject([{ check: "lint", code: "doctor-failed" }]);
      expect(step.warnings).toBeUndefined();
    } else if (mode === "missing" || mode === "failed") {
      expect(result).toMatchObject({ status: "error", phase: "lint" });
      expect(step.failureFacts).toMatchObject([
        mode === "failed"
          ? { check: "core/config", message: "Invalid configuration" }
          : { check: "lint", code: "candidate-checks-timeout" },
      ]);
      expect(report).toContain(mode === "failed" ? "Invalid configuration" : "checks phase");
    } else {
      expect(result, report).toMatchObject({ status: "ok", phase: "readiness" });
      expect(step.failureFacts).toBeUndefined();
      expect(step.warnings?.join("\n")).toMatch(/exit phase.*\d+ms/u);
      expect(report).toContain("exit phase");
      expect(result.steps.at(-1)).toMatchObject({ name: "candidate-gateway-startup", exitCode: 0 });
    }
  },
  15_000,
);
