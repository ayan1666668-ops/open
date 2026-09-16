import { isDeepStrictEqual } from "node:util";
import {
  loadSessionEntryReadOnly,
  patchSessionEntryWithKey,
} from "../../config/sessions/session-accessor.js";
import {
  commitSessionExecutionSelection,
  getSessionExecutionSelection,
} from "../../model-picker/apply-session-model-selection.js";
import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";
import type { AgentHarnessHostCapabilities } from "./host-capability-types.js";

type NativeSelectionAttempt = Partial<EmbeddedRunAttemptParams>;

/** Grants model materialization only to the admitted executor of this physical session. */
export function bindNativeExecutionSelection(params: {
  attempt: NativeSelectionAttempt;
  harnessId: string | undefined;
  assertActive: () => void;
}): AgentHarnessHostCapabilities["commitNativeSelection"] {
  const { attempt, harnessId, assertActive } = params;
  const target = attempt.sessionTarget;
  if (
    !harnessId ||
    !target ||
    !attempt.sessionKey ||
    !attempt.sessionId ||
    attempt.expectedSessionRuntimeOwnership?.auth !== "native"
  )
    return undefined;
  const scope = {
    agentId: attempt.agentId,
    storePath: target.storePath,
    sessionKey: attempt.sessionKey,
  };
  const initial = loadSessionEntryReadOnly(scope);
  const selected = getSessionExecutionSelection(initial);
  if (
    !initial ||
    !selected ||
    selected.executor.kind !== "harness" ||
    selected.executor.id !== harnessId ||
    initial.sessionId !== attempt.sessionId
  )
    return undefined;
  const before = structuredClone(selected);
  const expectedWriterRunId = target.expectedWriterRunId;
  const sessionId = initial.sessionId;
  const lifecycleRevision = initial.lifecycleRevision;
  return async ({ provider, model }) => {
    assertActive();
    if (!provider.trim() || !model.trim())
      throw new Error("Native model materialization returned an incomplete selection.");
    const selection = {
      executor: { kind: "harness" as const, id: harnessId },
      model: { provider, id: model },
    };
    if (before.model !== "native-managed" && !isDeepStrictEqual(selection, before))
      throw new Error(
        "The native app changed the accepted model before inference. Select the model again.",
      );
    const committed = await patchSessionEntryWithKey(
      scope,
      (entry) => {
        assertActive();
        if (
          entry.sessionId !== sessionId ||
          entry.lifecycleRevision !== lifecycleRevision ||
          (expectedWriterRunId !== undefined && entry.activeWriterRunId !== expectedWriterRunId) ||
          !isDeepStrictEqual(getSessionExecutionSelection(entry), before)
        )
          throw new Error("The session changed before its native model could be accepted.");
        const next = { ...entry };
        commitSessionExecutionSelection(next, selection, { cause: { kind: "inherit", entry } });
        return next;
      },
      { replaceEntry: true, assertCommitAllowed: assertActive },
    );
    assertActive();
    if (!committed)
      throw new Error("The session disappeared before its native model could be accepted.");
  };
}
