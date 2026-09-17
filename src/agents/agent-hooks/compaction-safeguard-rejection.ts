import { createSubsystemLogger } from "../../logging/subsystem.js";
import { setCompactionSafeguardCancellation } from "./compaction-safeguard-runtime.js";

const log = createSubsystemLogger("compaction-safeguard");

/** Retain stable audit codes without copying transcript-derived reason details. */
export function cancelCompactionForFailedAudit(sessionManager: unknown, reasons: string[]) {
  const reasonCodes = [
    ...new Set(
      reasons.map((reason) => {
        const separator = reason.indexOf(":");
        return separator < 0 ? reason : reason.slice(0, separator);
      }),
    ),
  ];
  log.warn(
    "Compaction safeguard: finalized summary failed quality checks; " +
      `reasonCodes=${reasonCodes.join(",")} reasonCount=${reasons.length}`,
  );
  setCompactionSafeguardCancellation(
    sessionManager,
    "Compaction safeguard finalized summary failed quality checks.",
    undefined,
    reasonCodes,
  );
  return { cancel: true };
}
