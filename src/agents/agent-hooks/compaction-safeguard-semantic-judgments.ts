import type {
  JudgmentAnswer,
  JudgmentRuntimeV1,
} from "../../judgments/types.js";
import type {
  CompactionFidelityResult,
  CompactionSemanticSnapshot,
  CompactionShadowCurationResult,
} from "./compaction-safeguard-semantic.js";

const MAX_SEGMENTS_PER_JUDGMENT = 64;
const DEFAULT_SEMANTIC_TIMEOUT_MS = 750;
const MAX_SEMANTIC_TIMEOUT_MS = 5_000;

function clampTimeoutMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_SEMANTIC_TIMEOUT_MS;
  }
  return Math.max(1, Math.min(MAX_SEMANTIC_TIMEOUT_MS, Math.floor(value)));
}

function allRetainedResult(
  snapshot: CompactionSemanticSnapshot,
  status: "unavailable" | "skipped",
  reason: string,
): CompactionShadowCurationResult {
  const selectedSegmentIds = snapshot.segments.map((segment) => segment.id);
  return {
    status,
    sourceFingerprint: snapshot.sourceFingerprint,
    reason,
    selectedSegmentIds,
    excludedSegmentIds: [],
    uncertainSegmentIds: [],
    evaluatedSegmentIds: [],
    originalChars: snapshot.originalChars,
    selectedChars: snapshot.originalChars,
    reductionRatio: 0,
    complete: false,
  };
}

function asChoiceAnswer(answer: JudgmentAnswer | undefined):
  | Extract<JudgmentAnswer, { type: "choice" }>
  | undefined {
  return answer?.type === "choice" ? answer : undefined;
}

export async function evaluateCompactionShadowCuration(params: {
  runtime: Pick<JudgmentRuntimeV1, "evaluate">;
  snapshot: CompactionSemanticSnapshot;
  signal: AbortSignal;
  timeoutMs?: number;
}): Promise<CompactionShadowCurationResult> {
  const eligible = params.snapshot.segments.filter((segment) => !segment.protected);
  if (eligible.length === 0) {
    return allRetainedResult(params.snapshot, "skipped", "no-discretionary-segments");
  }
  if (params.snapshot.obligations.length === 0) {
    return allRetainedResult(params.snapshot, "skipped", "no-source-backed-obligations");
  }

  const candidates = eligible.slice(0, MAX_SEGMENTS_PER_JUDGMENT);
  const questions = Object.fromEntries(
    candidates.map((segment) => [
      segment.id,
      {
        type: "choice" as const,
        instructions: { segmentId: segment.id },
        criteria: {
          keep: "Keep this segment because it may materially affect an active obligation or unresolved work.",
          drop: "This segment is not needed to preserve the meaning or execution of the active obligations and unresolved work.",
          uncertain: "The supplied evidence is insufficient to safely decide whether this segment can be omitted.",
        },
      },
    ]),
  );
  const outcome = await params.runtime.evaluate(
    {
      state: {
        purpose: "compaction-shadow-curation",
        obligations: params.snapshot.obligations.map((obligation) => ({
          id: obligation.id,
          kind: obligation.kind,
          text: obligation.text,
          complete: obligation.complete,
        })),
        segments: candidates.map((segment) => ({
          id: segment.id,
          roles: segment.roles,
          text: segment.text,
        })),
      },
      questions,
    },
    {
      purpose: "compaction-shadow-curation",
      rubricVersion: "compaction-shadow-curation-v1",
      timeoutMs: clampTimeoutMs(params.timeoutMs),
      signal: params.signal,
    },
  );

  if (outcome.status !== "ok") {
    return allRetainedResult(params.snapshot, "unavailable", outcome.reason);
  }

  const excluded = new Set<string>();
  const uncertain = new Set<string>();
  const evaluated = new Set<string>();
  for (const segment of candidates) {
    const answer = asChoiceAnswer(outcome.result.answers[segment.id]);
    if (!answer) {
      uncertain.add(segment.id);
      continue;
    }
    evaluated.add(segment.id);
    if (answer.choice === "drop") {
      excluded.add(segment.id);
    } else if (answer.choice === "uncertain") {
      uncertain.add(segment.id);
    }
  }

  const selectedSegmentIds = params.snapshot.segments
    .filter((segment) => !excluded.has(segment.id))
    .map((segment) => segment.id);
  const selectedChars = params.snapshot.segments
    .filter((segment) => !excluded.has(segment.id))
    .reduce((total, segment) => total + segment.originalChars, 0);
  const reductionRatio =
    params.snapshot.originalChars > 0
      ? Math.max(0, 1 - selectedChars / params.snapshot.originalChars)
      : 0;

  return {
    status: "ok",
    sourceFingerprint: params.snapshot.sourceFingerprint,
    selectedSegmentIds,
    excludedSegmentIds: [...excluded],
    uncertainSegmentIds: [...uncertain],
    evaluatedSegmentIds: [...evaluated],
    originalChars: params.snapshot.originalChars,
    selectedChars,
    reductionRatio,
    complete:
      params.snapshot.complete &&
      eligible.length <= MAX_SEGMENTS_PER_JUDGMENT &&
      evaluated.size === candidates.length &&
      uncertain.size === 0,
    provenance: outcome.provenance,
    ...(outcome.result.usage ? { usage: outcome.result.usage } : {}),
  };
}

export async function evaluateCompactionFidelity(params: {
  runtime: Pick<JudgmentRuntimeV1, "evaluate">;
  snapshot: CompactionSemanticSnapshot;
  candidateSummary: string;
  signal: AbortSignal;
  timeoutMs?: number;
}): Promise<CompactionFidelityResult> {
  const candidateFingerprint = fingerprint(params.candidateSummary);
  if (params.snapshot.obligations.length === 0) {
    return {
      status: "skipped",
      sourceFingerprint: params.snapshot.sourceFingerprint,
      candidateFingerprint,
      reason: "no-source-backed-obligations",
    };
  }
  const questions = Object.fromEntries(
    params.snapshot.obligations.map((obligation) => [
      obligation.id,
      {
        type: "choice" as const,
        instructions: { obligationId: obligation.id },
        criteria: {
          preserved:
            "The retained context preserves this obligation's meaning, scope, and unresolved state.",
          missing:
            "The retained context omits material information required to continue this obligation correctly.",
          contradicted:
            "The retained context conflicts with the source-backed obligation.",
          uncertain:
            "The supplied source and retained context do not support a reliable classification.",
        },
      },
    ]),
  );
  const outcome = await params.runtime.evaluate(
    {
      state: {
        purpose: "compaction-fidelity",
        sourceFingerprint: params.snapshot.sourceFingerprint,
        obligations: params.snapshot.obligations.map((obligation) => ({
          id: obligation.id,
          kind: obligation.kind,
          text: obligation.text,
          complete: obligation.complete,
          sourceSegmentId: obligation.sourceSegmentId ?? null,
        })),
        retainedContext: params.candidateSummary,
      },
      questions,
    },
    {
      purpose: "compaction-fidelity",
      rubricVersion: "compaction-fidelity-v1",
      timeoutMs: clampTimeoutMs(params.timeoutMs),
      signal: params.signal,
    },
  );
  if (outcome.status !== "ok") {
    return {
      status: "unavailable",
      sourceFingerprint: params.snapshot.sourceFingerprint,
      candidateFingerprint,
      reason: outcome.reason,
    };
  }

  const assessments = params.snapshot.obligations.map((obligation) => {
    const answer = asChoiceAnswer(outcome.result.answers[obligation.id]);
    return {
      obligationId: obligation.id,
      classification:
        answer?.choice === "preserved" ||
        answer?.choice === "missing" ||
        answer?.choice === "contradicted"
          ? answer.choice
          : ("uncertain" as const),
      probabilities: answer?.probabilities ?? {},
    };
  });

  return {
    status: "ok",
    sourceFingerprint: params.snapshot.sourceFingerprint,
    candidateFingerprint,
    assessments,
    provenance: outcome.provenance,
    ...(outcome.result.usage ? { usage: outcome.result.usage } : {}),
  };
}
