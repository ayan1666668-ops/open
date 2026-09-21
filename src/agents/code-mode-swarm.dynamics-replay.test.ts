import "./subagents/spawn/subagent-spawn-model.mocks.shared.js";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stableStringify } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { applyCodeModeCatalog } from "./code-mode.js";
import { codeModeSwarmHandlers } from "./code-mode-swarm.runtime.js";
import { createToolSearchCatalogRef } from "./tool-search-catalog.js";
import type { ToolSearchRuntime } from "./tool-search-runtime.js";
import type { ToolSearchToolContext } from "./tool-search-types.js";
import {
  resetSubagentRegistryForTests,
  testing as subagentRegistryTesting,
} from "./subagents/registry/subagent-registry.test-helpers.js";
import { prepareDynamicsSpawn } from "./subagents/swarm/dynamics/dynamics-spawn.js";
import { testing as swarmSchedulerTesting } from "./subagents/swarm/swarm-scheduler.test-support.js";
import { spawnSubagentDirect } from "./subagents/spawn/subagent-spawn.js";
import { testing as subagentSpawnTesting } from "./subagents/spawn/subagent-spawn.test-support.js";
import { createSessionsSpawnTool } from "./tools/sessions-spawn-tool.js";

const envSnapshot = captureEnv(["OPENCLAW_CONFIG_PATH", "OPENCLAW_STATE_DIR"]);
const task = "Verify the frozen candidate against the acceptance criteria.";
const sessionKey = "agent:main:main";
const parentRunId = "parent-run";
const codeModeRunId = "code-run";
const requestId = "bridge:1";
const groupId = `swarm:${sessionKey}:${parentRunId}`;
const replayKey = `${codeModeRunId}:${requestId}`;

let stateDir = "";

function candidate(policyDigest = "sha256:policy-a") {
  return {
    version: 1 as const,
    candidateDigest: "sha256:candidate",
    sourceDigest: "sha256:source",
    recipeDigest: "sha256:recipe",
    policyDigest,
  };
}

function dynamics(policyDigest = "sha256:policy-a") {
  return {
    boundary: "artifact-only",
      requirements: {
        sandbox: "require",
        candidateDigest: "required",
        artifactRefs: "required",
      },
    handoff: {
      candidateDigest: "sha256:candidate",
      artifactRefs: ["artifact://candidate"],
    },
    candidate: candidate(policyDigest),
  };
}

function preparedInput(dynamicsInput: ReturnType<typeof dynamics>) {
  return {
    ...prepareDynamicsSpawn({
      task,
      dynamics: dynamicsInput,
      sourceReplicaId: groupId,
      targetReplicaId: replayKey,
    }),
    collect: true,
    groupId,
  };
}

function fingerprint(input: ReturnType<typeof preparedInput>): string {
  return `sha256:${createHash("sha256").update(stableStringify(input)).digest("hex")}`;
}

async function writeConfig(): Promise<OpenClawConfig> {
  const config: OpenClawConfig = {
    session: { mainKey: "main", scope: "per-sender" },
    tools: {
      codeMode: true,
      swarm: { enabled: true, maxConcurrent: 2 },
    },
    agents: {
      defaults: {
        workspace: stateDir,
        sandbox: { mode: "all" },
      },
      entries: { main: { workspace: stateDir } },
    },
  };
  await writeFile(path.join(stateDir, "openclaw.json"), `${JSON.stringify(config)}\n`);
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  return config;
}

describe("Code Mode dynamics native replay", () => {
  beforeEach(async () => {
    resetGatewayWorkAdmission();
    swarmSchedulerTesting.reset();
    resetSubagentRegistryForTests({ persist: false });
    subagentRegistryTesting.setDepsForTest({
      loadAgentRuntimePluginRegistryHandle: () => undefined,
      persistSubagentRunsToDisk: () => {},
      persistSubagentRunsToDiskOrThrow: () => {},
      restoreSubagentRunsFromDisk: () => 0,
    });
    stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-dynamics-replay-"));
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    setTestEnvValue("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
  });

  afterEach(async () => {
    resetGatewayWorkAdmission();
    swarmSchedulerTesting.reset();
    resetSubagentRegistryForTests({ persist: false });
    subagentRegistryTesting.setDepsForTest();
    subagentSpawnTesting.setDepsForTest();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    await cleanupSessionStateForTest({ stateDir });
    envSnapshot.restore();
    if (stateDir) {
      await rm(stateDir, { recursive: true, force: true });
      stateDir = "";
    }
  });

  it(
    "replays the exact candidate without redispatch and rejects changed governing identity",
    async () => {
      const config = await writeConfig();
      const dispatchGatewayMethodInProcess = vi.fn(
        async <T>(
        _method: string,
        _params: Record<string, unknown>,
        _options?: unknown,
      ) => {
          // SAFETY: this fixture supplies the accepted Gateway response shape for the generic T.
          return { runId: "native-replay-run", status: "accepted" } as T;
        },
      );
      subagentSpawnTesting.setDepsForTest({
        hasInProcessGatewayContext: () => true,
        dispatchGatewayMethodInProcess,
      });

      const originalDynamics = dynamics();
      const input = preparedInput(originalDynamics);
      const seeded = await spawnSubagentDirect(
        {
          ...input,
          swarmLaunchReplayKey: replayKey,
          swarmLaunchRequestFingerprint: fingerprint(input),
        },
        {
          agentSessionKey: sessionKey,
          requesterRunId: parentRunId,
        },
      );
      expect(seeded).toMatchObject({ status: "accepted" });
      expect(dispatchGatewayMethodInProcess).toHaveBeenCalledTimes(1);
      expect(dispatchGatewayMethodInProcess.mock.calls[0]?.[1]?.message).toEqual(
        expect.stringContaining('"policyDigest":"sha256:policy-a"'),
      );

      const catalogRef = createToolSearchCatalogRef();
      const spawnTool = createSessionsSpawnTool({
        config,
        agentSessionKey: sessionKey,
        requesterRunId: parentRunId,
      });
      const ctx: ToolSearchToolContext = {
        config,
        runtimeConfig: config,
        sessionKey,
        sessionId: "session-parent",
        runId: parentRunId,
        catalogRef,
      };
      applyCodeModeCatalog({ ...ctx, tools: [spawnTool] });

      const callExactId = vi.fn(async () => {
        throw new Error("exact replay must not redispatch sessions_spawn");
      });
      const runtime: Pick<ToolSearchRuntime, "callExactId"> = { callExactId };
      const request = {
        id: requestId,
        method: "agentSpawn" as const,
        args: [task, { dynamics: originalDynamics }],
      };

      await expect(
        codeModeSwarmHandlers.agentSpawn({
          runtime,
          parentToolCallId: "parent-call",
          request,
          codeModeRunId,
          ctx,
        }),
      ).resolves.toMatchObject({ status: "accepted", runId: seeded.runId });
      expect(callExactId).not.toHaveBeenCalled();
      expect(dispatchGatewayMethodInProcess).toHaveBeenCalledTimes(1);

      await expect(
        codeModeSwarmHandlers.agentSpawn({
          runtime,
          parentToolCallId: "parent-call",
          request: {
            ...request,
            args: [task, { dynamics: dynamics("sha256:policy-b") }],
          },
          codeModeRunId,
          ctx,
        }),
      ).rejects.toThrow("replay request does not match the persisted collector");
      expect(callExactId).not.toHaveBeenCalled();
      expect(dispatchGatewayMethodInProcess).toHaveBeenCalledTimes(1);
    },
  );
});
