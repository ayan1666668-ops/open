import { join } from "node:path";
import { vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { acceptedModelSelection } from "../../test-utils/session-execution-selection.js";

export async function createNativeCompactCommandFixture(params: {
  workspaceDir: string;
  sessionId: string;
  sessionKey: string;
}) {
  // Load after the compaction harness installs this suite's runtime module mocks.
  const command = await import("../../auto-reply/reply/commands-compact.test-support.js");
  vi.mocked(command.compactEmbeddedAgentSession).mockReset();
  const sessionScope = {
    agentId: "main",
    sessionKey: params.sessionKey,
    storePath: join(params.workspaceDir, "sessions.json"),
  };
  const sessionEntry = {
    sessionId: params.sessionId,
    updatedAt: Date.now(),
    agentHarnessId: "codex",
    modelSelectionLocked: true,
    executionSelection: acceptedModelSelection("openai", "gpt-5.5", {
      executor: { kind: "harness", id: "codex" },
    }),
  };
  await upsertSessionEntryCore(sessionScope, sessionEntry);
  return {
    command,
    sessionScope,
    commandParams: {
      ...command.buildCompactParams("/compact", {
        commands: { text: true },
        channels: { whatsapp: { allowFrom: ["*"] } },
        session: { store: sessionScope.storePath },
      }),
      provider: "openai",
      model: "gpt-5.5",
      workspaceDir: params.workspaceDir,
      agentDir: join(params.workspaceDir, "agents/main/agent"),
      sessionKey: params.sessionKey,
      sessionEntry,
    },
  };
}
