import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import { withPreparedEmbeddedRunToolAuthority } from "../../agents/harness/tool-authority.runtime.js";
import { isModelExecutionSelection } from "../../model-picker/execution-selection.js";
import type { FollowupRun } from "./queue.js";
import { createReplyOperation } from "./reply-run-registry.js";
import { prepareReplyToolAuthority } from "./reply-tool-authority.js";

export async function withQuestionCreator(
  key: string,
  run: FollowupRun,
  test: (operation: ReturnType<typeof createReplyOperation>, fingerprint: string) => Promise<void>,
) {
  run.run.agentId = "main";
  run.run.sessionKey = key;
  const runId = "accepted-backing-work";
  const operation = createReplyOperation({
    sessionKey: key,
    sessionId: run.run.sessionId,
    resetTriggered: false,
  });
  operation.bindToolAuthoritySnapshot(prepareReplyToolAuthority(run));
  const selection = run.run.executionSelection;
  if (!isModelExecutionSelection(selection)) {
    throw new Error("Question custody fixture requires a concrete model.");
  }
  const fingerprint = operation.bindToolAuthorityRoute({
    provider: selection.model.provider,
    model: selection.model.id,
  });
  const admission = prepareAgentRunAdmission({
    cfg: run.run.config,
    operationalRunInstance: createOperationalRunInstanceRef(runId),
    facts: {
      agentId: "main",
      runId,
      ingress: { kind: "system", state: "present", boundary: "question-custody-test" },
    },
  });
  try {
    await withPreparedEmbeddedRunToolAuthority(
      {
        admittedRunContext: await admission.admit("embedded", "question-custody-test"),
        replyOperation: operation,
      },
      {
        ...run.run,
        runId,
        provider: selection.model.provider,
        modelId: selection.model.id,
        toolAuthorityFingerprint: fingerprint,
        abortSignal: operation.abortSignal,
      },
      undefined,
      () => test(operation, fingerprint),
    );
  } finally {
    operation.complete();
    admission.close();
  }
}
