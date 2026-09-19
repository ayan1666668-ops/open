import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AcpxRuntime as BaseAcpxRuntime, type AcpRuntimeOptions } from "acpx/runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, expect, it, vi } from "vitest";
import { prepareAcpxCodexAuthConfig } from "./codex-auth-bridge.js";
import { splitCommandParts } from "./command-line.js";
import { resolveAcpxPluginConfig } from "./config.js";
import {
  createAcpxProcessLeaseStore,
  openAcpxProcessLeaseStateStore,
  readAcpxProcessLeaseIdentity,
} from "./process-lease.js";
import { AcpxRuntime, createAgentRegistry, createFileSessionStore } from "./runtime.js";

const script = fileURLToPath(new URL("../test/fixtures/owner-agent.mjs", import.meta.url));
const sessionKey = "agent:main:acp:argv";
const samples = ["", "space value", `owner's "choice"`, String.raw`C:\tools\adapter`];

it("does not reinterpret a legacy command when a workspace file has the same name", async () => {
  await withOpenClawTestState({ label: "acpx-command-source" }, async (state) => {
    await fs.writeFile(path.join(state.root, "node --version"), "workspace content");
    const config = resolveAcpxPluginConfig({
      rawConfig: { agents: { fixture: { command: "node --version", args: ["suffix"] } } },
      workspaceDir: state.root,
    });
    expect(config.agents.fixture).toEqual(["node", "--version", "suffix"]);
  });
});

afterEach(() => vi.unstubAllEnvs());

async function prompt(
  runtime: AcpxRuntime,
  handle: Awaited<ReturnType<AcpxRuntime["ensureSession"]>>,
  text: string,
  phase: (name: string) => void = () => {},
) {
  phase(`${text}:start-turn`);
  const turn = runtime.startTurn({ handle, text, mode: "prompt", requestId: text });
  const chunks: string[] = [];
  phase(`${text}:events`);
  for await (const event of turn.events) {
    if (event.type === "text_delta") {
      chunks.push(event.text);
    }
  }
  phase(`${text}:result`);
  expect(await turn.result).toMatchObject({ status: "completed" });
  phase(`${text}:complete`);
  return JSON.parse(chunks.join(""));
}

it.each([
  { wrapped: false, form: "path" },
  { wrapped: true, form: "path" },
  { wrapped: false, form: "relative" },
  { wrapped: false, form: "combined" },
])(
  "preserves ACP argv through real processes and reconnect (leased=$wrapped, command=$form)",
  async ({ wrapped, form }) => {
    // Only synthetic fixture labels, relative paths and peer lifecycle; no contents or environment.
    // A timeout alone cannot distinguish ACP work from fixture cleanup.
    const phase = (name: string) => {
      console.error(`[acpx-argv-process leased=${wrapped} command=${form}] ${name}`);
    };
    phase("state:setup");
    await withOpenClawTestState({ label: "acpx-argv-process" }, async (state) => {
      const peerDirectory = path.join(state.root, "peer");
      // Keep the fixture's real cleanup owner; distinguish its drain from file removal.
      const restoreEnv = state.restoreEnv;
      state.restoreEnv = async () => {
        phase("state:release-resources");
        await restoreEnv();
        phase("state:resources-released");
        // Read only this synthetic peer's log; do not sample unrelated processes.
        const trace = await fs
          .readFile(path.join(peerDirectory, "process-lifecycle.log"), "utf8")
          .catch(() => "");
        const records = trace.trim().split("\n");
        for (const line of records) {
          if (/^\d+ (?:started|stdin-end|exit)$/.test(line)) {
            phase(`peer:${line}`);
          }
        }
        const pids = new Set(records.map((line) => Number(line.split(" ")[0])));
        for (const pid of pids) {
          if (!Number.isSafeInteger(pid) || pid <= 0) {
            continue;
          }
          let alive = false;
          try {
            process.kill(pid, 0);
            alive = true;
          } catch {
            // Signal zero only observes the synthetic fixture PID.
          }
          phase(`peer:${pid} alive=${alive}`);
        }
      };
      const cleanup = state.cleanup;
      state.cleanup = async () => {
        phase("state:cleanup-entered");
        const reportRemaining = async () => {
          const pending = [state.root];
          let count = 0;
          while (pending.length > 0 && count < 64) {
            const directory = pending.shift()!;
            const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
            for (const entry of entries) {
              if (count++ >= 64) {
                break;
              }
              const filename = path.join(directory, entry.name);
              const relative = path.relative(state.root, filename);
              phase(`remaining:${entry.isDirectory() ? "directory" : "file"}:${relative}`);
              if (entry.isDirectory() && relative.split(path.sep).length < 8) {
                pending.push(filename);
              }
            }
          }
        };
        // One read-only snapshot, not a retry or a change to the cleanup timeout.
        const timer = setTimeout(() => {
          void reportRemaining().catch(() => phase("remaining:unavailable"));
        }, 1_000);
        timer.unref();
        try {
          await cleanup();
          phase("state:cleanup-complete");
        } finally {
          clearTimeout(timer);
        }
      };
      phase("fixture:setup");
      vi.stubEnv("OPENCLAW_ACPX_TEST_PROCESS_TRACE", "1");
      await fs.mkdir(peerDirectory);
      const executable = path.join(
        state.root,
        process.platform === "win32" ? "node program.exe" : "node program",
      );
      if (process.platform === "win32") {
        await fs.copyFile(process.execPath, executable);
      } else {
        // Homebrew Node resolves libnode beside its real executable.
        await fs.symlink(process.execPath, executable);
      }
      const args = [script, peerDirectory, ...samples];
      const agent = wrapped ? "codex" : "fixture";
      const spawnExecutable =
        form === "relative" ? `.${path.sep}${path.basename(executable)}` : executable;
      const configuredCommand =
        form === "combined"
          ? `"${spawnExecutable}" "${script}" "${peerDirectory}"`
          : form === "relative"
            ? `"${spawnExecutable}"`
            : executable;
      let config = resolveAcpxPluginConfig({
        rawConfig: {
          agents: {
            [agent]: { command: configuredCommand, args: form === "combined" ? samples : args },
          },
        },
        workspaceDir: state.root,
      });
      if (wrapped) {
        const codexHome = path.join(state.root, "empty-codex-home");
        await fs.mkdir(codexHome);
        vi.stubEnv("CODEX_HOME", codexHome);
        phase("wrapper:prepare");
        config = await prepareAcpxCodexAuthConfig({
          pluginConfig: config,
          stateDir: state.root,
          resolveInstalledCodexAcpBinPath: async () => script,
          resolveInstalledClaudeAcpBinPath: async () => script,
        });
      }
      phase("stores:setup");
      const store = createFileSessionStore({ stateDir: config.stateDir });
      const leases = createAcpxProcessLeaseStore({
        store: openAcpxProcessLeaseStateStore((options) =>
          createPluginStateKeyedStoreForTests("acpx", {
            ...options,
            env: state.env,
          }),
        ),
      });
      const createRuntime = () =>
        new AcpxRuntime({
          cwd: state.root,
          sessionStore: store,
          agentRegistry: createAgentRegistry({ overrides: config.agents }),
          permissionMode: "deny-all",
          timeoutMs: 5_000,
          ...(wrapped
            ? {
                openclawWrapperRoot: path.join(state.root, "acpx"),
                openclawGatewayInstanceId: "argv-test",
                openclawProcessLeaseStore: leases,
              }
            : {}),
        });
      phase("runtime:create");
      let runtime = createRuntime();
      let handle: Awaited<ReturnType<AcpxRuntime["ensureSession"]>> | undefined;
      try {
        phase("session:ensure");
        handle = await runtime.ensureSession({ sessionKey, agent, mode: "persistent" });
        expect(await prompt(runtime, handle, "first", phase)).toMatchObject({
          argv: samples,
          history: ["first"],
        });
        phase("record:load");
        const record = await store.load(handle.acpxRecordId!);
        const command = splitCommandParts(config.agents[agent]!);
        expect(record?.agentArgv?.slice(0, command.length)).toEqual(command);
        const identity = readAcpxProcessLeaseIdentity(record?.agentArgv);
        if (wrapped) {
          expect(identity?.gatewayInstanceId).toBe("argv-test");
          phase("lease:load");
          expect(await leases.load(identity!.leaseId)).toMatchObject({
            rootPid: record!.pid,
            sessionKey,
            state: "open",
          });
        } else {
          expect(record?.agentArgv).toEqual([spawnExecutable, ...args]);
        }
        phase("runtime:close-restart");
        await runtime.close({ handle, reason: "restart" });
        phase("runtime:recreate");
        runtime = createRuntime();
        phase("session:reconnect");
        const resumed = await runtime.ensureSession({
          sessionKey,
          agent,
          mode: "persistent",
        });
        expect(resumed.backendSessionId).toBe(handle.backendSessionId);
        handle = resumed;
        expect(await prompt(runtime, handle, "second", phase)).toMatchObject({
          argv: samples,
          history: ["first", "second"],
        });
        phase("record:reload");
        expect(
          readAcpxProcessLeaseIdentity((await store.load(handle.acpxRecordId!))?.agentArgv),
        ).toEqual(identity);
      } finally {
        try {
          if (handle) {
            phase("runtime:close-final");
            await runtime.close({ handle, reason: "test-complete" });
          }
        } finally {
          phase("stores:reset");
          resetPluginStateStoreForTests();
          phase("state:cleanup");
        }
      }
    });
    phase("state:cleaned");
  },
);

it.skipIf(process.platform === "win32")(
  "reuses an unchanged persisted POSIX scalar ACP command",
  async () => {
    await withOpenClawTestState({ label: "acpx-scalar-reuse" }, async (state) => {
      const peerDirectory = path.join(state.root, "peer");
      await fs.mkdir(peerDirectory);
      const argv = [process.execPath, script, peerDirectory];
      const scalar = argv.map((arg) => JSON.stringify(arg)).join(" ");
      const store = createFileSessionStore({ stateDir: state.root });
      const previous = new BaseAcpxRuntime({
        cwd: state.root,
        sessionStore: store,
        agentRegistry: createAgentRegistry({ overrides: { fixture: scalar } }),
        permissionMode: "deny-all",
        timeoutMs: 5_000,
      });
      const original = await previous.ensureSession({
        sessionKey,
        agent: "fixture",
        mode: "persistent",
      });
      await previous.close({ handle: original, reason: "upgrade" });
      const runtime = new AcpxRuntime({
        cwd: state.root,
        sessionStore: store,
        agentRegistry: createAgentRegistry({ overrides: { fixture: argv } }),
        permissionMode: "deny-all",
        timeoutMs: 5_000,
      });
      const handle = await runtime.ensureSession({
        sessionKey,
        agent: "fixture",
        mode: "persistent",
      });
      try {
        expect(handle.backendSessionId).toBe(original.backendSessionId);
        expect((await store.load(handle.acpxRecordId!))?.agentCommand).toBe(scalar);
        expect(await prompt(runtime, handle, "resumed")).toMatchObject({ history: ["resumed"] });
      } finally {
        await runtime.close({ handle, reason: "test-complete" });
      }
    });
  },
);

it("keeps generated Codex and Claude wrapper commands as portable argv", async () => {
  await withOpenClawTestState({ label: "acpx-wrapper-argv" }, async (state) => {
    const codexHome = path.join(state.root, "empty-codex-home");
    await fs.mkdir(codexHome);
    vi.stubEnv("CODEX_HOME", codexHome);
    const config = resolveAcpxPluginConfig({
      rawConfig: {
        agents: {
          codex: { command: "codex-acp", args: samples },
          claude: { command: "claude-agent-acp", args: samples },
        },
      },
      workspaceDir: state.root,
    });
    const prepared = await prepareAcpxCodexAuthConfig({
      pluginConfig: config,
      stateDir: state.root,
      resolveInstalledCodexAcpBinPath: async () => script,
      resolveInstalledClaudeAcpBinPath: async () => script,
    });
    expect(prepared.agents.codex).toEqual([
      process.execPath,
      path.join(state.root, "acpx", "codex-acp-wrapper.mjs"),
      ...samples,
    ]);
    expect(prepared.agents.claude).toEqual([
      process.execPath,
      path.join(state.root, "acpx", "claude-agent-acp-wrapper.mjs"),
      ...samples,
    ]);
  });
});

it("binds the prepared launch command to its selected ACP agent", async () => {
  const codex = [process.execPath, "/fixture/codex.mjs"];
  const claude = [process.execPath, "/fixture/claude.mjs"];
  const runtime = new AcpxRuntime(
    {
      cwd: process.cwd(),
      sessionStore: { load: async () => undefined, save: async () => {} },
      agentRegistry: createAgentRegistry({ overrides: { codex, claude } }),
      probeAgent: "codex",
      permissionMode: "deny-all",
    },
    {
      probeRunner: async (options: AcpRuntimeOptions) => {
        expect(options.agentRegistry.resolve("codex")).toEqual(codex);
        expect(options.agentRegistry.resolve("claude")).toEqual(claude);
        return { ok: true, message: "ready" };
      },
    },
  );
  expect(await runtime.doctor()).toMatchObject({ ok: true });
});
