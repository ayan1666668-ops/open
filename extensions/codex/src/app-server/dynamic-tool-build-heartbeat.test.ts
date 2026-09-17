import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createOpenClawCodingTools } from "openclaw/plugin-sdk/agent-harness";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createAgentHarnessHostCapabilitiesForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dynamicToolBuildState } from "./dynamic-tool-build-state.js";
import { buildDynamicTools } from "./dynamic-tool-build.js";
import { createCodexTestModel } from "./test-support.js";

let tempDir: string;
let closeHostCapabilities: (() => void) | undefined;

async function buildHeartbeatTools(conversationDenied: boolean) {
  const workspaceDir = path.join(tempDir, "workspace");
  const params = {
    prompt: "heartbeat",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    sessionFile: path.join(tempDir, "session.jsonl"),
    workspaceDir,
    runId: "run-1",
    provider: "codex",
    modelId: "gpt-5.4-codex",
    model: createCodexTestModel("codex"),
    contextTokenBudget: 150_000,
    contextWindowInfo: {
      tokens: 150_000,
      referenceTokens: 200_000,
      source: "agentContextTokens",
    },
    thinkLevel: "medium",
    disableTools: false,
    enableHeartbeatTool: true,
    forceHeartbeatTool: true,
    toolsAllow: ["read"],
    ...(conversationDenied ? { conversationToolPolicy: { deny: ["heartbeat_respond"] } } : {}),
    timeoutMs: 5_000,
    authStorage: {},
    authProfileStore: { version: 1, profiles: {} },
    modelRegistry: {},
  } as EmbeddedRunAttemptParams;
  const host = await createAgentHarnessHostCapabilitiesForTest({
    attempt: params,
    pluginId: "codex",
  });
  params.hostCapabilities = host.capabilities;
  closeHostCapabilities = host.close;
  dynamicToolBuildState.openClawCodingToolsFactory = (options) =>
    createOpenClawCodingTools(options).filter((tool) => tool.name === "heartbeat_respond");

  return buildDynamicTools({
    params,
    resolvedWorkspace: workspaceDir,
    effectiveWorkspace: workspaceDir,
    sandboxSessionKey: params.sessionKey ?? "agent:main:session-1",
    sandbox: null as never,
    nativeToolSurfaceEnabled: true,
    runAbortController: new AbortController(),
    sessionAgentId: "main",
    policyAgentId: "main",
    pluginConfig: {},
    onYieldDetected: () => undefined,
  });
}

describe("Codex heartbeat dynamic tool build", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-heartbeat-tools-"));
  });

  afterEach(async () => {
    closeHostCapabilities?.();
    closeHostCapabilities = undefined;
    dynamicToolBuildState.openClawCodingToolsFactory = undefined;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it.each([
    { conversationDenied: false, expectedNames: ["heartbeat_respond"] },
    { conversationDenied: true, expectedNames: [] },
  ])(
    "keeps the host-required heartbeat tool unless conversation policy denies it: $conversationDenied",
    async ({ conversationDenied, expectedNames }) => {
      const tools = await buildHeartbeatTools(conversationDenied);
      expect(tools.map((tool) => tool.name)).toEqual(expectedNames);
      if (!conversationDenied) {
        expect(tools[0]?.catalogMode).toBe("direct-only");
      }
    },
  );
});
