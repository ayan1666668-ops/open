import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { convergePostCoreUpdatePlugins } from "../cli/update-cli/update-command-resume.js";
import type { CommandOptions } from "../process/exec.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { loadInstalledPluginIndexInstallRecords } from "./installed-plugin-index-records.js";
import { seedInstalledPluginIndex } from "./test-helpers/installed-plugin-index.js";
import { updateNpmInstalledPlugins } from "./update-installed.js";

// The real command runner still owns timeout, termination and child settlement.
const npmChildSource = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const argv = JSON.parse(process.argv[2]);
const proof = process.argv[3];
const delay = Number(process.argv[4]);
const event = (kind) => fs.appendFileSync(proof, JSON.stringify({kind, pid: process.pid, command: argv[1], planning: argv.includes('--package-lock-only'), at: Date.now()}) + '\n');
event('start');
process.on('SIGTERM', () => { event('terminated'); process.exit(143); });
const pkg = { name: 'budget-fixture', version: '2.0.0', openclaw: { extensions: ['./index.js'] } };
if (argv[1] === 'view' && process.argv[5] === 'stall-metadata') {
  setInterval(() => {}, 1000);
} else if (argv[1] === 'view' && process.argv[5] === 'first-metadata-miss' && fs.readFileSync(proof, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(e => e.kind === 'start' && e.command === 'view').length === 1) {
  event('unavailable');
  process.stderr.write('E404 fixture metadata unavailable');
  process.exitCode = 1;
} else if (argv[1] === 'view') {
  process.stdout.write(JSON.stringify(pkg));
  event('complete');
} else if (argv[1] === 'install') {
  const complete = () => {
    const dir = path.join(process.cwd(), 'node_modules', 'budget-fixture');
    fs.mkdirSync(dir, {recursive:true});
    fs.writeFileSync(path.join(process.cwd(), 'package-lock.json'), JSON.stringify({lockfileVersion:3, packages:{'':{dependencies:{'budget-fixture':'2.0.0'}},'node_modules/budget-fixture':{version:'2.0.0'}}}));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
    fs.writeFileSync(path.join(dir, 'openclaw.plugin.json'), JSON.stringify({id:'budget-fixture', configSchema:{type:'object'}}));
    fs.writeFileSync(path.join(dir, 'index.js'), 'export default {};\n');
    event('complete');
  };
  setTimeout(complete, argv.includes('--package-lock-only') ? 0 : delay);
} else {
  event('unexpected');
  process.stderr.write('Unsupported fixture operation');
  process.exitCode = 2;
}
`;

const fixture = vi.hoisted(() => ({
  child: "",
  events: "",
  delay: 1500,
  mode: "",
  calls: [] as { argv: string[]; timeoutMs: number | undefined }[],
}));
vi.mock("../process/exec.js", async (original) => {
  const actual = await original<typeof import("../process/exec.js")>();
  return {
    ...actual,
    runCommandWithTimeout: (argv: string[], options: CommandOptions) => {
      if (argv[0] !== "npm") {
        throw new Error(`Unexpected fixture command ${argv[0]}`);
      }
      fixture.calls.push({ argv, timeoutMs: options.timeoutMs });
      return actual.runCommandWithTimeout(
        [
          process.execPath,
          fixture.child,
          JSON.stringify(argv),
          fixture.events,
          String(fixture.delay),
          fixture.mode,
        ],
        options,
      );
    },
  };
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("post-core plugin work deadlines", () => {
  it.each([
    "ordinary",
    "larger-explicit",
    "explicit-expiry",
    "direct-omission",
    "direct-fallback",
  ] as const)("%s", async (scenario) => {
    await withOpenClawTestState(
      { label: `post-core-budget-${scenario}`, env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
      async (state) => {
        fixture.child = await state.writeText("npm-child.cjs", npmChildSource);
        fixture.events = state.path("events.jsonl");
        fixture.calls = [];
        const allowance = 1000;
        fixture.delay = 1500;
        fixture.mode = scenario === "direct-fallback" ? "first-metadata-miss" : "";
        const direct = scenario.startsWith("direct-");
        vi.stubEnv("NPM_CONFIG_GLOBALCONFIG", await state.writeText("global-npmrc", ""));
        const oldPath = state.statePath("extensions", "budget-fixture");
        await fs.mkdir(oldPath, { recursive: true });
        await fs.writeFile(
          path.join(oldPath, "package.json"),
          JSON.stringify({
            name: "budget-fixture",
            version: "1.0.0",
            openclaw: { extensions: ["./index.js"] },
          }),
        );
        await fs.writeFile(
          path.join(oldPath, "openclaw.plugin.json"),
          JSON.stringify({ id: "budget-fixture", configSchema: { type: "object" } }),
        );
        await fs.writeFile(path.join(oldPath, "index.js"), "export default {};\n");
        await fs.writeFile(
          path.join(state.workspaceDir, "package.json"),
          JSON.stringify({ name: "openclaw", version: "2026.9.4" }),
        );
        const records = {
          "budget-fixture": {
            source: "npm" as const,
            spec: "budget-fixture@latest",
            version: "1.0.0",
            installPath: oldPath,
          },
        };
        const cfg = {
          plugins: {
            enabled: true,
            allow: ["budget-fixture"],
            entries: { "budget-fixture": { enabled: true } },
          },
        };
        await state.writeConfig(cfg);
        await seedInstalledPluginIndex(records, { config: cfg, env: state.env });
        const explicit =
          scenario === "larger-explicit"
            ? String((allowance * 3) / 1000)
            : scenario === "explicit-expiry"
              ? String(allowance / 1000)
              : undefined;
        const directResult = direct
          ? await updateNpmInstalledPlugins({
              config: { ...cfg, plugins: { ...cfg.plugins, installs: records } },
              ...(scenario === "direct-fallback"
                ? { timeoutMs: allowance, workTimeoutMs: null }
                : {}),
              onCapabilityConsent: async (review) => ({ reviewToken: review.reviewToken }),
            })
          : undefined;
        const convergence = direct
          ? undefined
          : await convergePostCoreUpdatePlugins({
              root: state.workspaceDir,
              channel: "stable",
              requestedChannel: null,
              opts: { json: true, timeout: explicit, acceptCapabilities: true },
              timeoutMs: scenario === "larger-explicit" ? allowance * 3 : allowance,
              parentOwnsCompletion: true,
            });
        const events: Array<{ kind: string; pid: number; command: string; planning: boolean }> = (
          await fs.readFile(fixture.events, "utf8")
        )
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const outcomes = directResult?.outcomes ?? convergence?.pluginUpdate.npm?.outcomes ?? [];
        const pids = [...new Set<number>(events.map((e) => e.pid))];
        const alive = pids.filter((pid) => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        });
        const persisted = direct ? {} : await loadInstalledPluginIndexInstallRecords();
        const installedPath = direct
          ? directResult?.config.plugins?.installs?.["budget-fixture"]?.installPath
          : persisted["budget-fixture"]?.installPath;
        const installedVersion = installedPath
          ? JSON.parse(await fs.readFile(path.join(installedPath, "package.json"), "utf8")).version
          : undefined;
        expect(alive).toEqual([]);
        const installed = outcomes.find((o) => o.pluginId === "budget-fixture");
        if (scenario === "explicit-expiry") {
          expect(installed?.status).toBe("error");
          expect(installed?.message).toContain("timeout");
          expect(installedVersion).toBe("1.0.0");
          expect(
            JSON.parse(await fs.readFile(path.join(oldPath, "package.json"), "utf8")).version,
          ).toBe("1.0.0");
          expect(
            events.some((e) => e.kind === "complete" && e.command === "install" && !e.planning),
          ).toBe(false);
        } else {
          expect(installed?.status).toBe("updated");
          expect(installedVersion).toBe("2.0.0");
          expect(
            events.some((e) => e.kind === "complete" && e.command === "install" && !e.planning),
          ).toBe(true);
        }
        const metadataCalls = fixture.calls.filter((call) => call.argv[1] === "view");
        expect(metadataCalls.length).toBeGreaterThan(0);
        expect(metadataCalls.every((call) => Number.isFinite(call.timeoutMs))).toBe(true);
        if (scenario === "direct-fallback") {
          expect(events.some((event) => event.kind === "unavailable")).toBe(true);
        }
      },
    );
  });
});
