import { vi } from "vitest";
// Test fixture helpers for constructing ACP runtime session metadata.
import type { AcpSessionResolution } from "../../../acp/control-plane/manager.types.js";
import type { SessionAcpLifecycle, SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { commitSessionExecutionSelection } from "../../../model-picker/apply-session-model-selection.js";
import type { AcpExecutionSelection } from "../../../model-picker/execution-selection.js";
import { resolveAgentIdFromSessionKey } from "../../../routing/session-key.js";
import type { ReplyDispatcher } from "../reply-dispatcher.types.js";

const settledCounts = (delivered: number) => ({
  delivered,
  deliveredNotVisible: 0,
  cancelled: 0,
  failedBeforeSend: 0,
  failedAfterSend: 0,
});

export function createAcpTestReplyDispatcher(): ReplyDispatcher {
  const sendToolResult = vi.fn(() => true);
  const sendBlockReply = vi.fn(() => true);
  const sendFinalReply = vi.fn(() => true);
  return {
    sendToolResult,
    sendBlockReply,
    sendFinalReply,
    supportsSettledReceipt: true,
    waitForIdle: vi.fn(async () => ({
      counts: {
        tool: settledCounts(sendToolResult.mock.calls.length),
        block: settledCounts(sendBlockReply.mock.calls.length),
        final: settledCounts(sendFinalReply.mock.calls.length),
      },
      anyVisibleDelivered:
        sendToolResult.mock.calls.length +
          sendBlockReply.mock.calls.length +
          sendFinalReply.mock.calls.length >
        0,
    })),
    getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
    getFailedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
    markComplete: vi.fn(),
  };
}

export function createAcpTestReplyDispatcherFixture(): {
  dispatcher: ReplyDispatcher;
  counts: Record<"tool" | "block" | "final", number>;
} {
  return {
    dispatcher: createAcpTestReplyDispatcher(),
    counts: { tool: 0, block: 0, final: 0 },
  };
}

export function createAcpTestConfig(overrides?: Partial<OpenClawConfig>): OpenClawConfig {
  return {
    acp: {
      enabled: true,
      stream: {
        coalesceIdleMs: 0,
        maxChunkChars: 64,
      },
    },
    ...overrides,
  } as OpenClawConfig;
}

export function createAcpSessionMeta(
  overrides?: Partial<SessionAcpLifecycle>,
): SessionAcpLifecycle {
  return {
    runtimeSessionName: "runtime:1",
    mode: "persistent",
    state: "idle",
    lastActivityAt: Date.now(),
    identity: {
      state: "resolved",
      acpxSessionId: "acpx-session-1",
      source: "status",
      lastUpdatedAt: Date.now(),
    },
    ...overrides,
  };
}

export function createReadyAcpSessionResolution(params: {
  sessionKey: string;
  agentId?: string;
  entry?: SessionEntry;
  meta?: SessionAcpLifecycle;
  selection?: AcpExecutionSelection;
}): Extract<AcpSessionResolution, { kind: "ready" }> {
  const selection: AcpExecutionSelection = params.selection ?? {
    executor: { kind: "acp", backend: "acpx", agent: "codex" },
    model: "native-managed",
  };
  const entry = structuredClone(params.entry ?? { sessionId: "session-1", updatedAt: 1 });
  commitSessionExecutionSelection(entry, selection);
  return {
    kind: "ready",
    sessionKey: params.sessionKey,
    agentId: params.agentId ?? resolveAgentIdFromSessionKey(params.sessionKey),
    entry,
    selection,
    meta: params.meta ?? createAcpSessionMeta(),
  };
}
