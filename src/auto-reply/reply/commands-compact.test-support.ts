// Shared compact-command mocks and fixtures for focused behavior suites.
import { vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  resolveAgentDirMock,
  resolveSessionAgentIdMock,
} from "./commands-agent-scope.test-support.js";
import { attachCompactModelPreparation } from "./commands-compact-model.test-support.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { clearInlineDirectives } from "./get-reply-directives-utils.js";

vi.mock("./commands-compact.runtime.js", () => ({
  abortEmbeddedAgentRun: vi.fn(),
  compactEmbeddedAgentSession: vi.fn(),
  enqueueSystemEvent: vi.fn(),
  formatContextUsageShort: vi.fn(() => "Context 12.1k"),
  incrementCompactionCount: vi.fn(),
  resolveCurrentSessionEntry: vi.fn(
    ({ expected }: { expected: Pick<SessionEntry, "sessionId" | "lifecycleRevision"> }) => ({
      updatedAt: 1,
      ...expected,
    }),
  ),
  isEmbeddedAgentRunAbortableForCompaction: vi.fn().mockReturnValue(false),
  waitForEmbeddedAgentRunEnd: vi.fn().mockResolvedValue(true),
}));

export const {
  abortEmbeddedAgentRun,
  compactEmbeddedAgentSession,
  enqueueSystemEvent,
  formatContextUsageShort,
  incrementCompactionCount,
  resolveCurrentSessionEntry,
  isEmbeddedAgentRunAbortableForCompaction,
  waitForEmbeddedAgentRunEnd,
} = await import("./commands-compact.runtime.js");
const { handleCompactCommand } = await import("./commands-compact.js");

export async function runCompactCommand(params: HandleCommandsParams, allowTextCommands: boolean) {
  attachCompactModelPreparation(params);
  return handleCompactCommand(params, allowTextCommands);
}

export function buildCompactParams(
  commandBodyNormalized: string,
  cfg: OpenClawConfig,
): HandleCommandsParams {
  return {
    cfg,
    ctx: {
      Provider: "whatsapp",
      Surface: "whatsapp",
      CommandSource: "text",
      CommandBody: commandBodyNormalized,
      commandText: commandBodyNormalized,
    },
    command: {
      surface: "whatsapp",
      rawBodyNormalized: commandBodyNormalized,
      commandBodyNormalized,
      isAuthorizedSender: true,
      senderIsOwner: false,
      senderId: "owner",
      channel: "whatsapp",
      ownerList: [],
    },
    agentId: "main",
    workspaceDir: "/tmp/workspace",
    provider: "fixture",
    model: "compact-model",
    contextTokens: 0,
    isGroup: false,
    directives: clearInlineDirectives(commandBodyNormalized),
    elevated: { enabled: false, allowed: false, failures: [] },
    defaultGroupActivation: () => "always",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    prepareModelState: async () => {
      throw new Error("Compaction fixture was not attached.");
    },
    resolveModelLevels: async () => ({
      resolvedThinkLevel: "medium",
      resolvedReasoningLevel: "off",
    }),
    sessionKey: "agent:main:main",
    sessionStore: {},
    resolveDefaultThinkingLevel: async () => "medium",
  };
}

export function resetCompactCommandMocks() {
  vi.clearAllMocks();
  vi.mocked(incrementCompactionCount).mockResolvedValue(1);
  vi.mocked(resolveCurrentSessionEntry).mockImplementation(({ expected }) => ({
    updatedAt: 1,
    ...expected,
  }));
  resolveAgentDirMock.mockImplementation(
    (_cfg: unknown, agentId: string) => `/tmp/workspace/.openclaw/agents/${agentId}/agent`,
  );
  resolveSessionAgentIdMock.mockReturnValue("main");
}

export function requireCompactEmbeddedAgentSessionCall(index = 0) {
  const call = vi.mocked(compactEmbeddedAgentSession).mock.calls[index]?.[0];
  if (!call) {
    throw new Error(`compactEmbeddedAgentSession call ${index} missing`);
  }
  return call;
}

export function requireIncrementCompactionCountCall(index = 0) {
  const call = vi.mocked(incrementCompactionCount).mock.calls[index]?.[0];
  if (!call) {
    throw new Error(`incrementCompactionCount call ${index} missing`);
  }
  return call;
}

export function requireResolveSessionAgentIdCall(index = 0) {
  const call = (
    resolveSessionAgentIdMock.mock.calls[index] as unknown as [unknown] | undefined
  )?.[0] as { sessionKey?: string; config?: OpenClawConfig } | undefined;
  if (!call) {
    throw new Error(`resolveSessionAgentId call ${index} missing`);
  }
  return call;
}

export function requireResolveAgentDirCall(index = 0) {
  const call = resolveAgentDirMock.mock.calls[index] as [OpenClawConfig, string] | undefined;
  if (!call) {
    throw new Error(`resolveAgentDir call ${index} missing`);
  }
  return call;
}
