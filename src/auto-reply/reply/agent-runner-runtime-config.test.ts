// Tests agent runner runtime config assembly from command and session state.
import { afterEach, describe, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildEmbeddedRunBaseParams } from "./agent-runner-run-params.js";
import type { FollowupRun } from "./queue.js";

function makeRun(config: OpenClawConfig): FollowupRun["run"] {
  return {
    sessionId: "session-1",
    agentId: "main",
    config,
    executionSelection: {
      model: { provider: "openai", id: "gpt-4.1-mini" },
      executor: { kind: "harness", id: "openclaw" },
    },
    agentDir: "/tmp/agent",
    sessionKey: "agent:main:session",
    sessionFile: "/tmp/session.json",
    workspaceDir: "/tmp/workspace",
    skillsSnapshot: { prompt: "", skills: [] },
    ownerNumbers: ["+15550001"],
    enforceFinalTag: false,
    skipProviderRuntimeHints: true,
    thinkingCatalog: [
      {
        provider: "openai",
        id: "gpt-4.1-mini",
        input: ["text"],
        baseUrl: "https://api.openai.com/v1",
      },
    ],
    thinkLevel: "medium",
    verboseLevel: "off",
    reasoningLevel: "off",
    execOverrides: {},
    bashElevated: { enabled: false, allowed: false, defaultLevel: "off" },
    blockReplyBreak: "message_end",
    timeoutMs: 60_000,
  };
}

afterEach(() => {
  clearRuntimeConfigSnapshot();
});

describe("buildEmbeddedRunBaseParams runtime config", () => {
  it("keeps an already-resolved run config instead of reverting to a stale runtime snapshot", async () => {
    const staleSnapshot: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: {
              source: "env",
              provider: "default",
              id: "OPENAI_API_KEY",
            },
            models: [],
          },
        },
      },
    };
    const resolvedRunConfig: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: "resolved-runtime-key",
            models: [],
          },
        },
      },
    };
    setRuntimeConfigSnapshot(staleSnapshot, staleSnapshot);

    const resolved = await buildEmbeddedRunBaseParams({
      run: makeRun(resolvedRunConfig),
      runId: "run-1",
    });

    expect(resolved.config).toBe(resolvedRunConfig);
  });

  it("carries out-of-band tool bindings into the embedded run", async () => {
    const run = makeRun({});
    run.toolBindings = { browser: { kind: "tab", targetId: "target-1" } };

    const resolved = await buildEmbeddedRunBaseParams({
      run,
      runId: "run-1",
    });

    expect(resolved.toolBindings).toEqual(run.toolBindings);
  });
});
