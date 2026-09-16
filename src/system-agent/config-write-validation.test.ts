import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createSystemAgentTool } from "../agents/tools/system-agent-tool.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { executeSystemAgentOperation, type SystemAgentCommandDeps } from "./operations.js";
import { createSystemAgentTestRuntime } from "./system-agent.runtime.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  clearConfigCache();
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
});

describe("createSystemAgentTool.execute config writes", () => {
  it("offers approval for a default-route runtime config write", async () => {
    const stateDir = tempDirs.make("openclaw-config-write-");
    const configPath = path.join(stateDir, "openclaw.json");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    await fs.writeFile(configPath, "{}\n");
    const result = await createSystemAgentTool({ surface: "cli" }).execute("t", {
      action: "config_set",
      path: "agents.defaults.models.fixture/primary.agentRuntime.id",
      value: "openclaw",
    });
    expect(result.details).toMatchObject({ needsApproval: true });
    expect(await fs.readFile(configPath, "utf8")).toBe("{}\n");
  });
});

describe("executeSystemAgentOperation approved config writes", () => {
  it.each([true, false])(
    "verifies the staged route and commits only when verification succeeds (%s)",
    async (ok) => {
      const stateDir = tempDirs.make("openclaw-config-write-execute-");
      const configPath = path.join(stateDir, "openclaw.json");
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
      const config = {
        agents: {
          defaults: { model: { primary: "fixture/primary" }, params: { temperature: 0.2 } },
        },
      };
      const raw = JSON.stringify(config);
      await fs.writeFile(configPath, raw);
      const { runtime, lines } = createSystemAgentTestRuntime();
      const verifyInferenceConfig = vi.fn<
        NonNullable<SystemAgentCommandDeps["verifyInferenceConfig"]>
      >(async ({ config: staged }) => {
        expect(staged.agents?.defaults?.params?.temperature).toBe(0.5);
        expect(await fs.readFile(configPath, "utf8")).toBe(raw);
        return ok
          ? { ok: true, modelRef: "fixture/primary", latencyMs: 1 }
          : { ok: false, status: "unavailable", error: "fixture route rejected" };
      });
      const execute = executeSystemAgentOperation(
        { kind: "config-set", path: "agents.defaults.params.temperature", value: "0.5" },
        runtime,
        { approved: true, deps: { verifyInferenceConfig } },
      );
      if (ok) {
        await expect(execute).resolves.toMatchObject({ applied: true });
        expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toMatchObject({
          agents: { defaults: { params: { temperature: 0.5 } } },
        });
      } else {
        // The CLI writer reports the failure on the runtime, then exits; the
        // chat host relays that captured report to the model for a repair.
        await expect(execute).rejects.toThrow("operation exited with code 1");
        expect(lines.join("\n")).toContain(
          "Config write not applied: the default inference route would stop working (fixture route rejected)",
        );
        expect(await fs.readFile(configPath, "utf8")).toBe(raw);
      }
      expect(verifyInferenceConfig).toHaveBeenCalledOnce();
      expect(verifyInferenceConfig).toHaveBeenCalledWith(
        expect.objectContaining({ requireExecutionOwner: true }),
      );
    },
  );

  it("saves a heartbeat change without an inference probe", async () => {
    const stateDir = tempDirs.make("openclaw-config-write-heartbeat-");
    const configPath = path.join(stateDir, "openclaw.json");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    await fs.writeFile(configPath, "{}\n");
    const { runtime } = createSystemAgentTestRuntime();
    const verifyInferenceConfig =
      vi.fn<NonNullable<SystemAgentCommandDeps["verifyInferenceConfig"]>>();
    await expect(
      executeSystemAgentOperation(
        { kind: "config-set", path: "agents.defaults.heartbeat.every", value: "30m" },
        runtime,
        { approved: true, deps: { verifyInferenceConfig } },
      ),
    ).resolves.toMatchObject({ applied: true });
    expect(verifyInferenceConfig).not.toHaveBeenCalled();
    expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toMatchObject({
      agents: { defaults: { heartbeat: { every: "30m" } } },
    });
  });

  it("rechecks the approving run's authority inside the verifier before the live probe", async () => {
    const stateDir = tempDirs.make("openclaw-config-write-authority-");
    const configPath = path.join(stateDir, "openclaw.json");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    const raw = JSON.stringify({ agents: { defaults: { model: { primary: "fixture/primary" } } } });
    await fs.writeFile(configPath, raw);
    const { runtime, lines } = createSystemAgentTestRuntime();
    // The real verifier rechecks the guard right before provider I/O; the
    // stand-in mirrors that boundary and never answers once it throws.
    let verifierRecheck = false;
    const verifyInferenceConfig = vi.fn<
      NonNullable<SystemAgentCommandDeps["verifyInferenceConfig"]>
    >(async ({ assertAuthority }) => {
      verifierRecheck = true;
      assertAuthority?.();
      return { ok: true, modelRef: "fixture/primary", latencyMs: 1 };
    });
    // Authority holds through the commit boundary and the writer's own guard,
    // then lapses at the verifier's recheck.
    const beforePersistentApply = () => {
      if (verifierRecheck) {
        throw new Error("approving run closed");
      }
    };
    await expect(
      executeSystemAgentOperation(
        { kind: "config-set", path: "agents.defaults.params.temperature", value: "0.5" },
        runtime,
        { approved: true, beforePersistentApply, deps: { verifyInferenceConfig } },
      ),
    ).rejects.toThrow("operation exited with code 1");
    expect(lines.join("\n")).toContain("approving run closed");
    expect(verifyInferenceConfig).toHaveBeenCalledOnce();
    expect(await fs.readFile(configPath, "utf8")).toBe(raw);
  });
});
