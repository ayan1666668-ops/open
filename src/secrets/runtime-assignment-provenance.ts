/** Internal provenance for assignments collected outside openclaw.json. */
import type { SecretRef } from "../config/types.secrets.js";
import { secretRefKey } from "./ref-contract.js";
import type { SecretAssignment } from "./runtime-shared.js";

export type SecretAssignmentSource = "auth-store" | "config";

const assignmentSources = new WeakMap<SecretAssignment, SecretAssignmentSource>();

export function setSecretAssignmentSource(
  assignment: SecretAssignment,
  source: SecretAssignmentSource,
): void {
  assignmentSources.set(assignment, source);
}

export function getSecretAssignmentSource(assignment: SecretAssignment): SecretAssignmentSource {
  return assignmentSources.get(assignment) ?? "config";
}

/** Separator used to build source-qualified store value keys (never valid in a SecretRef id). */
export const SECRET_SOURCE_KEY_SEPARATOR = "\u0000source:";

/**
 * Builds the per-ref assignment-source projection ("auth-store" vs "config")
 * used to scope `storeOwnerEnv` to credential-owner refs. Unlike a single-value
 * map, equal ref keys collected from both sources keep BOTH sources so each
 * assignment can be resolved from its own store (P1-B, Codex R6): auth-store
 * refs read the shared owner store, config refs keep the current run store, and
 * a config assignment never silently receives the shared credential. Building at
 * the assignment boundary preserves source provenance before
 * `normalizeAndGroupSecretRefs` collapses ref identity.
 */
export function buildRefSourceByKey(
  assignments: readonly SecretAssignment[],
): Map<string, ReadonlySet<SecretAssignmentSource>> {
  const byKey = new Map<string, Set<SecretAssignmentSource>>();
  for (const assignment of assignments) {
    const key = secretRefKey(assignment.ref);
    const source = getSecretAssignmentSource(assignment);
    const sources = byKey.get(key);
    if (sources) {
      sources.add(source);
    } else {
      byKey.set(key, new Set([source]));
    }
  }
  return byKey;
}

/** Source-qualified store value key for a ref+source pair. */
export function sourceQualifiedStoreKey(ref: SecretRef, source: SecretAssignmentSource): string {
  return `${secretRefKey(ref)}${SECRET_SOURCE_KEY_SEPARATOR}${source}`;
}

/**
 * Looks up a resolved value for an assignment, preferring the source-qualified
 * store key and falling back to the plain ref key (non-store refs and legacy
 * callers that still resolve without provenance). This is the single place that
 * reconciles composite store keys with plain keys so an equal-named config
 * reference cannot read the shared owner credential.
 */
export function lookupResolvedAssignmentValue(
  assignment: SecretAssignment,
  resolved: ReadonlyMap<string, unknown>,
): unknown | undefined {
  const source = getSecretAssignmentSource(assignment);
  const composite = sourceQualifiedStoreKey(assignment.ref, source);
  if (resolved.has(composite)) {
    return resolved.get(composite);
  }
  return resolved.get(secretRefKey(assignment.ref));
}
