import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";

const scriptsDir = path.resolve(".agents/skills/telegram-e2e-userbot/scripts");
const testNodeExecPath = resolveTestNodeExecPath();

function reportTrace(directory: string, failed: boolean): boolean {
  const latest: string[] = [];
  const earlier: string[] = [];
  const identities = new Set<number>();
  let complete = true;
  const names = fs
    .readdirSync(directory)
    .toSorted(
      (a, b) =>
        Number(b.startsWith("coordinator-")) - Number(a.startsWith("coordinator-")) ||
        a.localeCompare(b),
    );
  for (const name of names) {
    if (!/^(coordinator|[0-9]+)-[0-9]+\.jsonl$/u.test(name)) {
      complete = false;
      continue;
    }
    const file = path.join(directory, name);
    if (!fs.lstatSync(file).isFile() || fs.statSync(file).size > 16 * 1024) {
      complete = false;
      continue;
    }
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    let finalIndex = -1;
    let exited = false;
    let exitCodeOk = false;
    for (const [index, line] of lines.entries()) {
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        complete = false;
        continue;
      }
      if (!isRecord(record)) {
        complete = false;
        continue;
      }
      if (record.event === "start") {
        if (typeof record.fileIndex !== "number" || identities.has(record.fileIndex)) {
          complete = false;
        } else {
          identities.add(record.fileIndex);
        }
      }
      if (
        typeof record.event === "string" &&
        (record.event.startsWith("deadline-") || record.event === "process-exit")
      ) {
        finalIndex = index;
      }
      if (record.event === "process-exit") {
        exited = true;
        complete &&=
          record.dropped === 0 &&
          record.omittedChildren === 0 &&
          Array.isArray(record.unresolved) &&
          record.unresolved.length === 0;
      }
      if (record.event === "exit-code") {
        exitCodeOk = record.code === 0;
      }
    }
    complete &&= exited && exitCodeOk;
    if (finalIndex >= 0) {
      latest.push(lines[finalIndex]!);
    }
    earlier.push(...lines.filter((_, index) => index !== finalIndex));
  }
  complete &&=
    names.length === 14 &&
    identities.size === 14 &&
    Array.from({ length: 14 }, (_, index) => index - 1).every((index) => identities.has(index));
  let remaining = 64 * 1024 - 1024;
  let omittedRecords = 0;
  if (failed || !complete) {
    // Every process gets its latest snapshot before earlier lifecycle records.
    for (const line of [...latest, ...earlier]) {
      const output = `[skill-ci-trace] ${line}\n`;
      const bytes = Buffer.byteLength(output);
      if (bytes > remaining) {
        omittedRecords += 1;
        continue;
      }
      fs.writeSync(2, output);
      remaining -= bytes;
    }
  }
  const summary = `[skill-ci-trace] ${JSON.stringify({
    complete,
    filesObserved: names.length,
    emittedRecordBytes: 64 * 1024 - 1024 - remaining,
    omittedRecords,
    lifecycle: "not-observed-closed-does-not-prove-still-alive",
  })}\n`;
  if (Buffer.byteLength(summary) <= 1024) {
    fs.writeSync(2, summary);
  }
  return complete;
}

function requireSuccess(
  command: string,
  args: string[],
  trace?: { directory: string; env: NodeJS.ProcessEnv },
) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 120_000,
    ...(trace ? { env: trace.env } : {}),
  });
  const complete = trace
    ? reportTrace(trace.directory, Boolean(result.error) || result.status !== 0)
    : true;
  expect(result.error, `${result.stdout}${result.stderr}`).toBeUndefined();
  expect(`${result.stdout}${result.stderr}`).not.toContain("not ok");
  expect(result.status, `${command} ${args.join(" ")}\n${result.stdout}${result.stderr}`).toBe(0);
  return complete;
}

describe("repository Telegram E2E skill", () => {
  it("registers its UI metadata through the skill interface", () => {
    const descriptor = parse(
      fs.readFileSync(".agents/skills/telegram-e2e-userbot/agents/openai.yaml", "utf8"),
    );
    expect(Object.keys(descriptor)).toEqual(["interface"]);
    expect(descriptor.interface).toMatchObject({
      display_name: "Telegram E2E (Userbot)",
      short_description: "Drive leased Telegram Test Server bots as a real QA user.",
    });
    expect(descriptor.interface.default_prompt).toContain("$telegram-e2e-userbot");
    expect(descriptor.interface.default_prompt).toContain("exact changed Telegram behavior");
    expect(descriptor.interface.default_prompt).toContain("extend the harness freely");
  });

  it("passes its Node test suite", () => {
    const tests = fs
      .readdirSync(scriptsDir)
      .filter((entry) => entry.endsWith(".test.mjs"))
      .toSorted()
      .map((entry) => path.join(scriptsDir, entry));
    expect(tests.length).toBeGreaterThan(0);
    const directory = fs.mkdtempSync(path.join(tmpdir(), "openclaw-skill-ci-trace-"));
    const env = {
      ...process.env,
      OPENCLAW_SKILL_CI_TRACE_DIR: directory,
      OPENCLAW_SKILL_CI_TRACE_FILES: JSON.stringify(tests),
      OPENCLAW_SKILL_CI_TRACE_STARTED: String(Date.now()),
    };
    const complete = requireSuccess(
      testNodeExecPath,
      ["--require", path.resolve("test/helpers/telegram-skill-ci-trace.cjs"), "--test", ...tests],
      { directory, env },
    );
    // Failed or uncertain child ownership retains the diagnostic fixture.
    if (complete) {
      fs.rmSync(directory, { recursive: true });
    }
  });

  it("passes its Python test suite", () => {
    const tests = fs
      .readdirSync(scriptsDir)
      .filter((entry) => entry.endsWith(".test.py"))
      .toSorted();
    expect(tests.length).toBeGreaterThan(0);
    for (const test of tests) {
      requireSuccess("python3", [path.join(scriptsDir, test)]);
    }
  });
});
