import {
  readHelperResults,
  type FaceTimeHelperPeer,
  type FaceTimeHelperSocketServer,
  type HelperActionResult,
} from "./helper-rpc.js";
import type { PendingFaceTimeDial } from "./outbound-call.js";
import type { ActiveFaceTimeCall } from "./runtime-state.js";

export const OUTBOUND_DIAL_HELPER_BUNDLES = new Set([
  "com.apple.FaceTime",
  "com.apple.FaceTime.FTConversationService",
]);

export function readHelperPeers(result: HelperActionResult): FaceTimeHelperPeer[] {
  const peers: FaceTimeHelperPeer[] = [];
  for (const entry of readHelperResults(result)) {
    const peer = entry.helperPeer;
    if (
      peer &&
      typeof peer === "object" &&
      "processId" in peer &&
      "bundleIdentifier" in peer &&
      "connectionGeneration" in peer &&
      "processStartedAtMs" in peer &&
      typeof peer.processId === "number" &&
      typeof peer.bundleIdentifier === "string" &&
      typeof peer.connectionGeneration === "number" &&
      typeof peer.processStartedAtMs === "number"
    ) {
      peers.push({
        bundleIdentifier: peer.bundleIdentifier,
        processId: peer.processId,
        processStartedAtMs: peer.processStartedAtMs,
        connectionGeneration: peer.connectionGeneration,
      });
    }
  }
  return peers;
}

export function retainHelperResultPeers(
  call: ActiveFaceTimeCall,
  result: HelperActionResult,
): void {
  for (const peer of readHelperPeers(result)) {
    call.carrierPeers.set(peer.processId, peer);
  }
}

export function retainOutboundDialHelperPeers(
  peers: Map<number, FaceTimeHelperPeer>,
  result: HelperActionResult,
): void {
  for (const peer of readHelperPeers(result)) {
    if (OUTBOUND_DIAL_HELPER_BUNDLES.has(peer.bundleIdentifier)) {
      peers.set(peer.processId, peer);
    }
  }
}

export function readOutboundCallUUID(result: HelperActionResult): string | undefined {
  return readHelperResults(result)
    .map((entry) =>
      typeof entry.call_uuid === "string" && entry.call_uuid.trim()
        ? entry.call_uuid.trim()
        : undefined,
    )
    .find((value) => Boolean(value));
}

export function readOutboundProxyIdentifier(result: HelperActionResult): string | undefined {
  return readHelperResults(result)
    .map((entry) =>
      typeof entry.proxy_identifier === "string" && entry.proxy_identifier.trim()
        ? entry.proxy_identifier.trim()
        : undefined,
    )
    .find((value) => Boolean(value));
}

export function hasDialHelperConfirmation(results: HelperActionResult[]): boolean {
  return results.some(
    (entry) =>
      typeof entry.helperBundleIdentifier === "string" &&
      OUTBOUND_DIAL_HELPER_BUNDLES.has(entry.helperBundleIdentifier),
  );
}

export function hasDefinitiveDialHelperAbsence(results: HelperActionResult[]): boolean {
  return results.some(
    (entry) =>
      typeof entry.helperBundleIdentifier === "string" &&
      OUTBOUND_DIAL_HELPER_BUNDLES.has(entry.helperBundleIdentifier) &&
      entry.found === false &&
      entry.retained_outbound_dial !== true,
  );
}

export const OUTBOUND_RECONCILE_ATTEMPTS = 12;
export const OUTBOUND_RECONCILE_INTERVAL_MS = 250;

export async function findOutgoingCallDuringReconciliation(
  helper: FaceTimeHelperSocketServer,
  pending: PendingFaceTimeDial,
): Promise<HelperActionResult> {
  const { handle, callUUID, dialID, proxyIdentifier, requestedAt, mode } = pending;
  let result: HelperActionResult = { found: false };
  let previousAbsentTopology: number | undefined;
  for (let attempt = 0; attempt < OUTBOUND_RECONCILE_ATTEMPTS; attempt += 1) {
    result = await helper.findOutgoingCall(
      handle,
      callUUID,
      dialID,
      proxyIdentifier,
      requestedAt,
      mode,
    );
    if (
      readOutboundCallUUID(result) ||
      readHelperResults(result).some((entry) => entry.found === true)
    ) {
      return result;
    }
    const results = readHelperResults(result);
    const topologyGeneration =
      typeof result.topologyGeneration === "number" ? result.topologyGeneration : undefined;
    const completeAbsence =
      result.topologyComplete === true &&
      results.every((entry) => entry.found === false) &&
      hasDialHelperConfirmation(results) &&
      hasDefinitiveDialHelperAbsence(results);
    if (
      completeAbsence &&
      topologyGeneration !== undefined &&
      topologyGeneration === previousAbsentTopology
    ) {
      return { ...result, stableAbsence: true };
    }
    previousAbsentTopology = completeAbsence ? topologyGeneration : undefined;
    if (attempt + 1 < OUTBOUND_RECONCILE_ATTEMPTS) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, OUTBOUND_RECONCILE_INTERVAL_MS);
      });
    }
  }
  return result;
}
