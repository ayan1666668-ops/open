// Background exec finalization stores a bounded, redacted output tail in the task
// record detail. Gateway lookup and CLI consumers share this reader so the
// retained-field contract lives in one place.

/** Upper bound for the redacted output tail stored on background exec task records. */
export const TASK_OUTPUT_TAIL_MAX_CHARS = 4_000;

export function readTaskOutputTail(detail: unknown): string {
  const value =
    detail && typeof detail === "object" && !Array.isArray(detail)
      ? (detail as Record<string, unknown>).outputTail
      : undefined;
  return typeof value === "string" ? value : "";
}
