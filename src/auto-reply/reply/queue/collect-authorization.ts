import { stableStringify } from "@openclaw/normalization-core";
import { compareChannelAdmissionParticipants } from "../../../channels/message-access/admission-evidence.js";
import type { FollowupRun } from "./types.js";

// Keep this key aligned with the fields that affect per-message authorization or
// exec-context propagation in collect-mode batching. Display-only sender fields
// stay out of the key so profile/name drift does not force conservative splits.
// Fields like authProfileId, elevatedLevel, ownerNumbers, and config are
// intentionally excluded because they are session-level or not consulted in
// per-message authorization checks.
function hasVerifiedAdmissionParticipant(run: FollowupRun): boolean {
  return compareChannelAdmissionParticipants([run.channelAdmissionEvidence]) === "same";
}

export function resolveFollowupAuthorizationKey(run: FollowupRun): string {
  const execution = run.run;
  return JSON.stringify([
    execution.senderId ?? "",
    JSON.stringify(execution.channelContext ?? null),
    stableStringify(execution.conversationToolPolicy ?? null),
    execution.senderE164 ?? "",
    execution.senderIsOwner === true,
    execution.execOverrides?.host ?? "",
    execution.execOverrides?.security ?? "",
    execution.execOverrides?.ask ?? "",
    execution.execOverrides?.node ?? "",
    execution.execOverrides?.nodeCwd ?? "",
    execution.bashElevated?.enabled === true,
    execution.bashElevated?.allowed === true,
    execution.bashElevated?.defaultLevel ?? "",
    execution.approvalReviewerDeviceId ?? "",
  ]);
}

export function resolveCollectedRun(items: readonly FollowupRun[], source: FollowupRun["run"]) {
  const participantComparison = compareChannelAdmissionParticipants(
    items.map((item) => item.channelAdmissionEvidence),
  );
  if (
    participantComparison === "same" ||
    !items.every((item) => hasVerifiedAdmissionParticipant(item))
  ) {
    return source;
  }
  // Mixed or unverifiable people share no downstream sender authority. The
  // opaque admission aggregate records unknown identity at the run boundary.
  return {
    ...source,
    senderId: undefined,
    senderName: undefined,
    senderUsername: undefined,
    senderE164: undefined,
    senderIsOwner: false,
    traceAuthorized: false,
    reasoningVisibility: undefined,
    ownerNumbers: [],
  };
}
