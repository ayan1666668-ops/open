import { createParams } from "./run-attempt-test-harness.js";

/** Attempt params carrying the loop-detection tool the relay suites assert against. */
export function createLoopRelayParams(sessionFile: string, workspaceDir: string) {
  const params = createParams(sessionFile, workspaceDir);
  params.config = { tools: { loopDetection: { enabled: true } } };
  return params;
}
