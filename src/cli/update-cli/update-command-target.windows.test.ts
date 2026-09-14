import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { resolveNpmRunner } from "../../../scripts/npm-runner.mts";
import {
  buildWindowsCmdExeCommandLine,
  resolveTrustedWindowsCmdExe,
} from "../../process/windows-command.js";
import { withTempDir } from "../../test-utils/temp-dir.js";
import { resolveUpdateCommandTarget } from "./update-command-target.js";

vi.mock("./update-command-config.js", () => ({
  readUpdateChannelConfig: async () => ({ configSnapshot: { valid: true }, storedChannel: null }),
}));

describe.skipIf(process.platform !== "win32")("Windows npm dirty Git relocation", () => {
  it("keeps the invoked npm prefix through CMD and PowerShell with another prefix first on PATH", async () => {
    await withTempDir("openclaw npm relocation ", async (temp) => {
      const root = await fs.realpath(temp);
      const checkout = path.join(root, "operator checkout");
      const prefix = path.join(root, "invoked prefix");
      const otherPrefix = path.join(root, "PATH prefix");
      await fs.mkdir(checkout);
      await fs.writeFile(
        path.join(checkout, "package.json"),
        JSON.stringify({ name: "openclaw", version: "1.0.0", bin: { openclaw: "openclaw.mjs" } }),
      );
      await fs.writeFile(
        path.join(checkout, "openclaw.mjs"),
        "#!/usr/bin/env node\nconsole.log(JSON.stringify({ argv1: process.argv[1] }));\n",
      );
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        npm_config_userconfig: path.join(root, "user.npmrc"),
        npm_config_globalconfig: path.join(root, "global.npmrc"),
        npm_config_cache: path.join(root, "npm cache"),
      };
      const run = (command: string, args: string[], windowsVerbatimArguments = false) => {
        const result = spawnSync(command, args, {
          cwd: checkout,
          env,
          encoding: "utf8",
          timeout: 30_000,
          windowsVerbatimArguments,
        });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        return result.stdout;
      };
      run("git", ["init", "--quiet"]);
      for (const installPrefix of [prefix, otherPrefix]) {
        const npm = resolveNpmRunner({
          npmArgs: [
            "install",
            "--global",
            "--prefix",
            installPrefix,
            "--ignore-scripts",
            "--offline",
            "--no-audit",
            "--no-fund",
            checkout,
          ],
          env,
        });
        run(npm.command, npm.args, npm.windowsVerbatimArguments);
      }
      const packageRoot = path.join(prefix, "node_modules", "openclaw");
      expect((await fs.lstat(packageRoot)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(packageRoot)).toBe(checkout);
      const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
      env[pathKey] = `${otherPrefix}${path.delimiter}${env[pathKey] ?? ""}`;
      const originalArgv = process.argv;
      onTestFinished(() => {
        process.argv = originalArgv;
        vi.unstubAllEnvs();
      });
      vi.stubEnv("OPENCLAW_GIT_DIR", path.join(root, "fresh checkout"));
      vi.stubEnv(pathKey, env[pathKey]);
      for (const shell of ["cmd", "powershell"]) {
        const output =
          shell === "cmd"
            ? run(
                resolveTrustedWindowsCmdExe(),
                [
                  "/d",
                  "/s",
                  "/c",
                  buildWindowsCmdExeCommandLine(path.join(prefix, "openclaw.cmd"), []),
                ],
                true,
              )
            : run("powershell.exe", [
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                path.join(prefix, "openclaw.ps1"),
              ]);
        const observed = JSON.parse(output) as { argv1: string };
        expect(observed.argv1).toBe(path.join(packageRoot, "openclaw.mjs"));
        process.argv = [process.execPath, observed.argv1];
        const target = await resolveUpdateCommandTarget(
          { channel: "dev", yes: true },
          { triageTarget: { env: {} } },
          checkout,
          {
            startedAt: Date.now(),
            postCoreUpdateResume: false,
            postCoreUpdateChannel: undefined,
            timeoutMs: 30_000,
            shouldRestart: false,
            requestedChannel: "dev",
            devTarget: undefined,
            controlPlaneUpdateSentinelMeta: null,
            discoveredRoot: checkout,
            installKind: "git",
            servicePlan: undefined,
          },
          {
            enter: async () => {
              throw new Error("Target admission must not start an update");
            },
          },
          30_000,
        );
        expect(target?.gitRelocation?.installTarget.packageRoot, shell).toBe(packageRoot);
        await target?.gitRelocation?.assertCurrent();
        expect(await fs.realpath(packageRoot)).toBe(checkout);
      }
    });
  }, 120_000);
});
