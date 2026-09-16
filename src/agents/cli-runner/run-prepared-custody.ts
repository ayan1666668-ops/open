import { runWithCliHistoryWriter } from "../../config/sessions/cli-history-boundary.js";
import { withSessionTranscriptQuestionAnswers } from "../../config/sessions/session-transcript-read-fence.js";
import type { EmbeddedAgentRunResult } from "../embedded-agent-runner.js";
import type { PreparedCliRunContext } from "./types.js";

/** Keep ask_user transcript custody alive for the whole prepared CLI run. */
export async function runPreparedCliAgentWithTranscriptCustody(
  context: PreparedCliRunContext,
  run: () => Promise<EmbeddedAgentRunResult>,
): Promise<EmbeddedAgentRunResult> {
  return await withSessionTranscriptQuestionAnswers(
    context.params.userTurnTranscriptRecorder,
    () => {
      context.params.assertCurrent?.();
    },
    async () => await runWithCliHistoryWriter(context.cliHistoryWriter, run),
  );
}
