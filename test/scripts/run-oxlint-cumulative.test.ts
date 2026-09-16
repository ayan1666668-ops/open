import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const runner = join(process.cwd(), "scripts/run-oxlint.mjs");

function runCumulativeFixture(severity: string | undefined, otherError = false) {
  const cwd = tempDirs.make("openclaw-oxlint-cumulative-");
  symlinkSync(join(process.cwd(), "node_modules"), join(cwd, "node_modules"), "junction");
  mkdirSync(join(cwd, "src"));
  mkdirSync(join(cwd, "ui"));
  const source = [
    "// Comments and blank lines do not consume the cap.",
    "",
    "export const one = 1;",
    "export const two = 2;",
    "export const three = 3;",
    ...(otherError ? ["debugger;"] : []),
    "",
  ].join("\n");
  for (const file of ["src/fixture.ts", "ui/fixture.ts", "src/excluded.ts"]) {
    writeFileSync(join(cwd, file), source);
  }
  const config = JSON.stringify({
    categories: { correctness: "off" },
    rules: { "no-debugger": "error" },
    overrides: [
      {
        files: ["src/**/*.ts", "ui/**/*.ts"],
        excludeFiles: ["src/excluded.ts"],
        rules: { "max-lines": ["error", { max: 2, skipBlankLines: true, skipComments: true }] },
      },
    ],
  });
  writeFileSync(join(cwd, ".oxlintrc.json"), config);
  const result = spawnSync(
    process.execPath,
    [runner, "--openclaw-focused-config", "--config", ".oxlintrc.json", "src", "ui"],
    {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_ACTIONS: "true",
        OPENCLAW_LINT_CUMULATIVE_SEVERITY: severity,
      },
    },
  );
  expect(readFileSync(join(cwd, ".oxlintrc.json"), "utf8")).toBe(config);
  expect(readdirSync(cwd).toSorted()).toEqual([".oxlintrc.json", "node_modules", "src", "ui"]);
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

describe("run-oxlint cumulative severity", () => {
  it.each([undefined, "error"])(
    "keeps line caps strict for severity %s, even in CI",
    (severity) => {
      const result = runCumulativeFixture(severity);
      expect(result.code, result.output).toBe(1);
      expect(result.output).toContain("File has too many lines (3)");
      expect(result.output).not.toContain("[oxlint] max-lines warnings:");
    },
  );

  it("warns on over-cap files in src and ui only when explicitly requested", () => {
    const result = runCumulativeFixture("warn");
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("File has too many lines (3)");
    expect(result.output).toContain("warning");
    expect(result.output).toContain("[oxlint] max-lines warnings: 2");
    expect(result.output).not.toContain("excluded.ts");
  });

  it("still fails other lint errors while reporting the line-cap warnings", () => {
    const result = runCumulativeFixture("warn", true);
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain("no-debugger");
    expect(result.output).toContain("[oxlint] max-lines warnings: 2");
  });
});
