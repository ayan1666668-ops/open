import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { consumeCompactionSafeguardCancellation } from "../agent-hooks/compaction-safeguard-runtime.js";
import { resolveCompactionFailure } from "./compact-reasons.js";
import type { CompactEmbeddedAgentSessionParams } from "./compact.types.js";
import { recordCompactionQualityRejection } from "./compaction-quality-rejections.js";
import { log } from "./logger.js";
import type { EmbeddedAgentCompactResult } from "./types.js";

export async function reportCompactionSessionFailure(input: {
  error: unknown;
  sessionManager: unknown;
  params: CompactEmbeddedAgentSessionParams;
  context?: { target: SessionTranscriptRuntimeTarget; assertActive: () => void };
  fail: (reason: string, error?: unknown) => EmbeddedAgentCompactResult;
}): Promise<EmbeddedAgentCompactResult> {
  const { params } = input;
  const failure = resolveCompactionFailure({
    error: input.error,
    safeguardCancellation: consumeCompactionSafeguardCancellation(input.sessionManager),
    abortSignal: params.abortSignal,
  });
  if (failure.qualityReasonCodes && input.context) {
    const { target, assertActive } = input.context;
    assertActive();
    const rejection = recordCompactionQualityRejection(
      target,
      failure.qualityReasonCodes,
      params.modelSelectionLocked,
    );
    if (rejection.notice) {
      failure.reason = rejection.notice;
      if (rejection.log) {
        log.warn(failure.reason, { sessionId: target.sessionId, sessionKey: target.sessionKey });
      }
      if (rejection.notify && params.onCompactionHookMessages) {
        try {
          await params.onCompactionHookMessages({
            phase: "after",
            completed: false,
            messages: [failure.reason],
            sessionId: target.sessionId,
            sessionKey: target.sessionKey,
          });
          assertActive();
          rejection.acknowledgeNotice?.();
        } catch (noticeError) {
          log.warn("Could not deliver the repeated compaction rejection notice", {
            errorMessage: formatErrorMessage(noticeError),
          });
        }
        assertActive();
      }
    }
  }
  return input.fail(failure.reason, failure.error);
}
