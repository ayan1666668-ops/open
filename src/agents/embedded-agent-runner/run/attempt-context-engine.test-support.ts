import type { AttemptContextEngine } from "./attempt-context-engine-helpers.js";

export function createTestContextEngine(
  params: Partial<AttemptContextEngine>,
): AttemptContextEngine {
  // SAFETY: Each test supplies the context-engine operations its scenario invokes.
  return {
    info: {
      id: "test-context-engine",
      name: "Test Context Engine",
      version: "0.0.1",
    },
    ingest: async () => ({ ingested: true }),
    compact: async () => ({
      ok: false,
      compacted: false,
      reason: "not used in this test",
    }),
    ...params,
  } as AttemptContextEngine;
}
