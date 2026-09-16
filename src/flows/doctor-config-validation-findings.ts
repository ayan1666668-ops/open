import type { ConfigValidationIssue } from "../config/types.openclaw.js";
import { CONFIGURED_PLUGIN_PATH_UNAVAILABLE } from "../plugins/discovery-availability.js";
import { PLUGIN_AVAILABILITY_POLICY } from "../plugins/runtime-degraded-state.js";
import type { HealthFinding } from "./health-checks.js";

export const FINAL_CONFIG_VALIDATION_CHECK_ID = "core/doctor/final-config-validation";

export function configValidationIssuesToHealthFindings(
  issues: readonly ConfigValidationIssue[],
): readonly HealthFinding[] {
  return issues.map((issue): HealthFinding => ({
    checkId: FINAL_CONFIG_VALIDATION_CHECK_ID,
    severity: "error",
    message: issue.message,
    path: issue.path || "<root>",
  }));
}

export function configValidationWarningsToHealthFindings(
  warnings: readonly ConfigValidationIssue[],
): readonly HealthFinding[] {
  return warnings
    .filter(
      (warning) =>
        warning.code === CONFIGURED_PLUGIN_PATH_UNAVAILABLE &&
        warning.path === "plugins.load.paths",
    )
    .map((warning) => ({
      checkId: FINAL_CONFIG_VALIDATION_CHECK_ID,
      severity: PLUGIN_AVAILABILITY_POLICY.severity,
      target: PLUGIN_AVAILABILITY_POLICY.state,
      requirement: warning.code,
      source: warning.source,
      message: warning.message,
      path: warning.path,
      fixHint: PLUGIN_AVAILABILITY_POLICY.repairCommand,
    }));
}
