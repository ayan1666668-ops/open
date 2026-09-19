import type { AgentMessage } from "../runtime/index.js";
import { wrapUntrustedInstructionBlock } from "./compaction-safeguard-quality.js";
import {
  buildCompactionSemanticRepairEvidence,
  isCompactionSemanticRepairFinding,
  observeCompactionSemanticFidelity,
} from "./compaction-semantic-fidelity.js";

type SemanticRepairLogger = {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
};

export type CompactionSemanticRepairResult =
  | { action: "accept" }
  | {
      action: "retry";
      correctiveInstructions: string;
      fallbackSummary: string;
    };

export async function evaluateCompactionSemanticRepair(params: {
  sourceMessages: AgentMessage[];
  retainedContext: string;
  bodyBudget: number;
  agentId?: string;
  signal?: AbortSignal;
  canRegenerate: boolean;
  hasRetry: boolean;
  logger: SemanticRepairLogger;
}): Promise<CompactionSemanticRepairResult> {
  if (!params.signal) {
    params.logger.debug(
      "Compaction safeguard: semantic fidelity observation skipped; reason=no-cancellation-signal",
    );
    return { action: "accept" };
  }

  const observation = await observeCompactionSemanticFidelity({
    sourceMessages: params.sourceMessages,
    retainedContext: params.retainedContext,
    agentId: params.agentId,
    signal: params.signal,
  });
  if (observation.status === "unavailable") {
    params.logger.debug(
      "Compaction safeguard: semantic fidelity observation unavailable; " +
        `reason=${observation.reason} checked=${observation.checked}`,
    );
    return { action: "accept" };
  }
  if (observation.status === "no-candidates") {
    params.logger.debug(
      "Compaction safeguard: semantic fidelity observation skipped; reason=no-candidates " +
        `verbatimPreserved=${observation.verbatimPreserved}`,
    );
    return { action: "accept" };
  }

  const relationCounts = observation.findings.reduce<Record<string, number>>((counts, finding) => {
    counts[finding.relation] = (counts[finding.relation] ?? 0) + 1;
    return counts;
  }, {});
  const repairFindings = observation.findings.filter(isCompactionSemanticRepairFinding);
  params.logger.info(
    "Compaction safeguard: semantic fidelity observation completed; " +
      `checked=${observation.checked} verbatimPreserved=${observation.verbatimPreserved} ` +
      `relations=${JSON.stringify(relationCounts)} repairFindings=${repairFindings.length} ` +
      `provider=${observation.providerId} model=${observation.model}`,
  );
  if (repairFindings.length === 0) {
    return { action: "accept" };
  }
  if (!params.canRegenerate || !params.hasRetry) {
    params.logger.warn(
      "Compaction safeguard: semantic fidelity findings remain after the available corrective retry budget; " +
        `findingCount=${repairFindings.length}`,
    );
    return { action: "accept" };
  }

  const repairEvidence = buildCompactionSemanticRepairEvidence(repairFindings);
  const semanticFeedback = wrapUntrustedInstructionBlock(
    "Semantic fidelity feedback",
    repairEvidence,
  );
  return {
    action: "retry",
    fallbackSummary: params.retainedContext,
    correctiveInstructions: [
      "Preserve the active meaning of the source requirements below. Do not mark them complete or superseded unless the retained conversation supports that conclusion.",
      `Keep the complete summary body within ${params.bodyBudget} UTF-16 code units so the finalized artifact remains valid after required suffixes.`,
      semanticFeedback,
    ].join("\n\n"),
  };
}
