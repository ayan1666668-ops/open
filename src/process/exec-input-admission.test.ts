import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { describe, expect, it, vi } from "vitest";
import { isPidAlive } from "../shared/pid-alive.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { runCommandWithTimeout } from "./exec.js";

describe("child input admission", () => {
  it("publishes input only after binding the actual spawned PID and argv", async () => {
    let admittedPid: number | undefined;
    let admittedArgv: readonly string[] | undefined;
    const result = await runCommandWithTimeout(
      [
        process.execPath,
        "-e",
        "let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({pid:process.pid,argv:[process.argv0,...process.execArgv,...process.argv.slice(1)],input})))",
      ],
      {
        input: "owned",
        timeoutMs: 5_000,
        beforeInput: (pid, argv) => {
          admittedPid = pid;
          admittedArgv = argv;
        },
      },
    );
    expect(result.code).toBe(0);
    expect(admittedArgv).toBeDefined();
    expect(JSON.parse(result.stdout)).toEqual({
      pid: admittedPid,
      argv: admittedArgv,
      input: "owned",
    });
  });

  it("joins the child without delivering input when admission rejects", async () => {
    let pid: number | undefined;
    const refusal = new Error("authority lost before input");
    const work = runCommandWithTimeout(
      [
        process.execPath,
        "-e",
        "process.stdin.on('data',()=>process.stdout.write('effect'));setInterval(()=>{},1000)",
      ],
      {
        input: "forbidden",
        timeoutMs: 5_000,
        killProcessTree: true,
        beforeInput: (childPid) => {
          pid = childPid;
          throw refusal;
        },
      },
    );
    await expect(work).rejects.toBe(refusal);
    expect(refusal).toMatchObject({
      cleanup: process.platform === "win32" ? "forced" : "cooperative",
    });
    expect(pid).toBeTypeOf("number");
    expect(isPidAlive(pid!)).toBe(false);
  });

  it.runIf(process.platform !== "win32")(
    "does not deliver EOF when admission rejects",
    async () => {
      await withTempDir("openclaw-exec-admission-rejection-", async (dir) => {
        const effectPath = path.join(dir, "effect");
        const program = [
          "const fs=require('node:fs');",
          "const input=fs.readFileSync(0,'utf8');",
          `fs.writeFileSync(${JSON.stringify(effectPath)},input === '' ? 'eof' : input);`,
        ].join("");
        let pid: number | undefined;
        const refusal = new Error("authority lost before input");
        const admission = vi.fn((childPid: number) => {
          pid = childPid;
          throw refusal;
        });
        const work = runCommandWithTimeout([process.execPath, "-e", program], {
          input: "forbidden",
          timeoutMs: 5_000,
          killProcessTree: true,
          // Keep cancellation from racing the EOF under test; escalation must
          // still terminate the blocked child when admission is refused.
          killSignal: "SIGCHLD",
          beforeInput: admission,
        });

        await expect(work).rejects.toBe(refusal);
        expect(admission).toHaveBeenCalledOnce();
        expect(existsSync(effectPath)).toBe(false);
        expect(refusal).toMatchObject({ cleanup: "forced" });
        expect(pid).toBeTypeOf("number");
        expect(isPidAlive(pid!)).toBe(false);
      });
    },
  );

  it("delivers admitted empty input as EOF", async () => {
    await withTempDir("openclaw-exec-admission-empty-input-", async (dir) => {
      const effectPath = path.join(dir, "effect");
      const program = [
        "const fs=require('node:fs');",
        "const input=fs.readFileSync(0,'utf8');",
        `fs.writeFileSync(${JSON.stringify(effectPath)},input === '' ? 'eof' : input);`,
      ].join("");
      const admission = vi.fn();
      const result = await runCommandWithTimeout([process.execPath, "-e", program], {
        input: "",
        timeoutMs: 5_000,
        beforeInput: admission,
      });

      expect(result.code).toBe(0);
      expect(admission).toHaveBeenCalledOnce();
      expect(readFileSync(effectPath, "utf8")).toBe("eof");
    });
  });

  it("rejects asynchronous admission and drains its rejection before returning", async () => {
    let pid: number | undefined;
    const options = { input: "forbidden", timeoutMs: 5_000, killProcessTree: true };
    // Model an untyped JS caller; the typed callback contract forbids a Promise.
    Reflect.set(options, "beforeInput", async (childPid: number) => {
      pid = childPid;
      throw new Error("late refusal");
    });
    const work = runCommandWithTimeout(
      [process.execPath, "-e", "process.stdin.resume();setInterval(()=>{},1000)"],
      options,
    );
    await expect(work).rejects.toThrow("must complete synchronously");
    expect(isPidAlive(pid!)).toBe(false);
  });
});
