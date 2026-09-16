import { bindSessionTranscriptQuestionAnswerAdmit } from "../../config/sessions/session-transcript-read-fence.js";
import {
  createAgentQuestionAnswerAuthority,
  type PreparedQuestionAnswerAuthority,
} from "../harness/host-private-capabilities.js";

/**
 * Bind question-answer admit while CLI ask_user runs under transcript custody so
 * a later channel claim can close over that scope (ALS alone is not enough).
 */
export function createCliQuestionAnswerAuthority(
  params: Parameters<typeof createAgentQuestionAnswerAuthority>[0],
): PreparedQuestionAnswerAuthority {
  return createAgentQuestionAnswerAuthority({
    ...params,
    admitTranscriptAnswer: bindSessionTranscriptQuestionAnswerAdmit(),
  });
}
