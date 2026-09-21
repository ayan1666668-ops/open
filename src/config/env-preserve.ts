// Normalizes preserved environment-variable config for subprocess launches.
import { isPlainObject } from "../infra/plain-object.js";
import { isRecord } from "../utils.js";
import {
  EnvRefArrayMutationError,
  hasEnvVarRef,
  matchAuthoredEscapedTemplateArrayItems,
  matchAuthoredTemplateArrayItems,
} from "./env-preserve-array-identity.js";
import {
  containsAuthoredUnescapedEnvTemplate,
  containsAuthoredEscapedEnvTemplate,
  containsUnaccountedActiveEscapedEnvRef,
  preservesAuthoredEscapedEnvRefs,
} from "./env-preserve-authored.js";
import { resolveConfigEnvVars } from "./env-substitution.js";

export { EnvRefArrayMutationError };

/**
 * Preserves `${VAR}` environment variable references during config write-back.
 *
 * When config is read, `${VAR}` references are resolved to their values.
 * When writing back, callers pass the resolved config. This module detects
 * values that match what a `${VAR}` reference would resolve to and restores
 * the original reference, so env var references survive config round-trips.
 *
 * A value is restored only if:
 * 1. The pre-substitution value contained a `${VAR}` pattern
 * 2. The corresponding resolved source value matches the incoming value
 *
 * If a caller intentionally set a new value (different from what the env var
 * resolves to), the new value is kept as-is.
 */

type EnvRefResolveSlot = {
  readonly source: unknown;
  readonly container: Record<string, unknown> | unknown[];
  readonly key: string | number;
};

function settleEnvRefResolveSlot(slot: EnvRefResolveSlot, value: unknown): void {
  if (Array.isArray(slot.container)) {
    const key = slot.key;
    if (typeof key === "number") {
      slot.container[key] = value;
    }
    return;
  }
  const key = slot.key;
  if (typeof key === "string") {
    slot.container[key] = value;
  }
}

function resolveEnvVarRefsForComparison(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === "string") {
    return hasEnvVarRef(value) ? resolveConfigEnvVars(value, env, { onMissing: () => {} }) : value;
  }
  if (!Array.isArray(value) && !isPlainObject(value)) {
    return value;
  }
  // Walks the parsed document on an explicit work stack: document nesting
  // costs heap rather than call frames, so a schema-valid deep config cannot
  // crash comparison with a RangeError before restoration sees the values.
  const root: Record<string, unknown> = {};
  const pending: EnvRefResolveSlot[] = [{ source: value, container: root, key: "resolved" }];
  while (pending.length > 0) {
    const slot = pending.pop();
    if (slot === undefined) {
      break;
    }
    const source = slot.source;
    if (typeof source === "string") {
      settleEnvRefResolveSlot(
        slot,
        hasEnvVarRef(source) ? resolveConfigEnvVars(source, env, { onMissing: () => {} }) : source,
      );
      continue;
    }
    if (Array.isArray(source)) {
      const next: unknown[] = Array.from({ length: source.length });
      settleEnvRefResolveSlot(slot, next);
      for (let index = source.length - 1; index >= 0; index -= 1) {
        pending.push({ source: source[index], container: next, key: index });
      }
      continue;
    }
    if (isPlainObject(source)) {
      const next: Record<string, unknown> = {};
      settleEnvRefResolveSlot(slot, next);
      const entries = Object.entries(source);
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (entry === undefined) {
          continue;
        }
        pending.push({ source: entry[1], container: next, key: entry[0] });
      }
      continue;
    }
    settleEnvRefResolveSlot(slot, source);
  }
  return root.resolved;
}

/**
 * Deep-walk the incoming config and restore `${VAR}` references from the
 * pre-substitution parsed config wherever the resolved value matches.
 *
 * @param incoming - The resolved config about to be written
 * @param parsed - The pre-substitution parsed config (from the current file on disk)
 * @param env - Environment variables for verification
 * @returns A new config object with env var references restored where appropriate
 */
export function restoreEnvVarRefs(
  incoming: unknown,
  parsed: unknown,
  env: NodeJS.ProcessEnv = process.env,
): unknown {
  return restoreEnvVarRefsFromResolved(
    incoming,
    parsed,
    resolveEnvVarRefsForComparison(parsed, env),
  );
}

/**
 * Frame for the iterative env-ref restoration walk. `enter` frames resolve one
 * node and schedule their children; children write their restored values into
 * the parent container slot, so document nesting costs heap rather than call
 * frames and a schema-valid deep config cannot overflow the call stack here.
 * `escape-check` frames run after a template array's children have settled and
 * keep the fail-closed mutation check over the fully restored array.
 */
type EnvRefRestoreFrame =
  | {
      readonly kind: "enter";
      readonly incoming: unknown;
      readonly parsed: unknown;
      readonly resolved: unknown;
      readonly container: Record<string, unknown> | unknown[];
      readonly key: string | number;
    }
  | {
      readonly kind: "escape-check";
      readonly incoming: readonly unknown[];
      readonly parsed: readonly unknown[];
      readonly resolved: readonly unknown[];
      readonly next: unknown[];
      readonly matches: ReadonlyMap<number, number>;
      readonly matchedParsedIndexByIncoming: ReadonlyMap<number, number>;
      readonly container: Record<string, unknown> | unknown[];
      readonly key: string | number;
    };

function settleEnvRefRestoreFrame(frame: EnvRefRestoreFrame, value: unknown): void {
  if (Array.isArray(frame.container)) {
    const key = frame.key;
    if (typeof key === "number") {
      frame.container[key] = value;
    }
    return;
  }
  const key = frame.key;
  if (typeof key === "string") {
    frame.container[key] = value;
  }
}

/** Restore only references owned by the matching authored/resolved planning read. */
function restoreEnvVarRefsFromResolved(
  incoming: unknown,
  parsed: unknown,
  resolved: unknown,
): unknown {
  const root: Record<string, unknown> = {};
  const pending: EnvRefRestoreFrame[] = [
    { kind: "enter", incoming, parsed, resolved, container: root, key: "resolved" },
  ];
  while (pending.length > 0) {
    const frame = pending.pop();
    if (frame === undefined) {
      break;
    }
    if (frame.kind === "escape-check") {
      // Keep same-name real/escaped scalar reorders fail-closed: a raw `${VAR}`
      // is indistinguishable from a moved escaped literal or a newly active ref.
      for (const [escapedParsedIndex, escapedParsedItem] of frame.parsed.entries()) {
        if (!containsAuthoredEscapedEnvTemplate(escapedParsedItem)) {
          continue;
        }
        const matchedIncomingIndex = frame.matches.get(escapedParsedIndex);
        if (
          matchedIncomingIndex !== undefined &&
          preservesAuthoredEscapedEnvRefs(frame.next[matchedIncomingIndex], escapedParsedItem)
        ) {
          continue;
        }
        const hasUnaccountedActiveReference = frame.next.some((item, incomingIndex) => {
          const matchedParsedIndex = frame.matchedParsedIndexByIncoming.get(incomingIndex);
          return containsUnaccountedActiveEscapedEnvRef(
            item,
            escapedParsedItem,
            frame.incoming[incomingIndex],
            matchedParsedIndex === undefined ? undefined : frame.parsed[matchedParsedIndex],
            matchedParsedIndex === undefined ? undefined : frame.resolved[matchedParsedIndex],
          );
        });
        if (hasUnaccountedActiveReference) {
          throw new EnvRefArrayMutationError();
        }
      }
      continue;
    }
    const { incoming: frameIncoming, parsed: frameParsed, resolved: frameResolved } = frame;
    // If parsed has no env var refs at this level, return incoming as-is
    if (frameParsed === null || frameParsed === undefined) {
      settleEnvRefRestoreFrame(frame, frameIncoming);
      continue;
    }

    // String leaf: check if parsed was a ${VAR} template that resolves to incoming
    if (typeof frameIncoming === "string" && typeof frameParsed === "string") {
      if (hasEnvVarRef(frameParsed) && frameResolved === frameIncoming) {
        // The incoming value matches what the env var resolves to — restore the reference
        settleEnvRefRestoreFrame(frame, frameParsed);
        continue;
      }
      settleEnvRefRestoreFrame(frame, frameIncoming);
      continue;
    }

    // Array template entries must retain a unique identity before authored refs
    // can be restored; ambiguous moves would attach secrets or activate escaped
    // literals on the wrong entry.
    if (
      Array.isArray(frameIncoming) &&
      Array.isArray(frameParsed) &&
      Array.isArray(frameResolved)
    ) {
      if (
        !containsAuthoredUnescapedEnvTemplate(frameParsed) &&
        !containsAuthoredEscapedEnvTemplate(frameParsed)
      ) {
        const next = [...frameIncoming];
        settleEnvRefRestoreFrame(frame, next);
        for (let index = frameIncoming.length - 1; index >= 0; index -= 1) {
          if (index >= frameParsed.length) {
            continue;
          }
          pending.push({
            kind: "enter",
            incoming: frameIncoming[index],
            parsed: frameParsed[index],
            resolved: frameResolved[index],
            container: next,
            key: index,
          });
        }
        continue;
      }
      const unescapedMatches = matchAuthoredTemplateArrayItems({
        incoming: frameIncoming,
        parsed: frameParsed,
        resolved: frameResolved,
      });
      const escapedMatches = matchAuthoredEscapedTemplateArrayItems({
        incoming: frameIncoming,
        parsed: frameParsed,
        resolved: frameResolved,
        usedIncomingIndexes: new Set(unescapedMatches.values()),
      });
      const matches = new Map([...unescapedMatches, ...escapedMatches]);
      const next = [...frameIncoming];
      settleEnvRefRestoreFrame(frame, next);
      const matchedIncomingIndexes = new Set(matches.values());
      const matchedParsedIndexByIncoming = new Map(
        [...matches].map(([parsedIndex, incomingIndex]) => [incomingIndex, parsedIndex]),
      );
      // Pushed in reverse so the escape check runs only after every child slot
      // has been restored into `next`.
      pending.push({
        kind: "escape-check",
        incoming: frameIncoming,
        parsed: frameParsed,
        resolved: frameResolved,
        next,
        matches,
        matchedParsedIndexByIncoming,
        container: frame.container,
        key: frame.key,
      });
      for (const [parsedIndex, incomingIndex] of matches) {
        pending.push({
          kind: "enter",
          incoming: frameIncoming[incomingIndex],
          parsed: frameParsed[parsedIndex],
          resolved: frameResolved[parsedIndex],
          container: next,
          key: incomingIndex,
        });
      }
      for (let index = 0; index < frameIncoming.length && index < frameParsed.length; index += 1) {
        if (
          matchedIncomingIndexes.has(index) ||
          containsAuthoredUnescapedEnvTemplate(frameParsed[index]) ||
          containsAuthoredEscapedEnvTemplate(frameParsed[index])
        ) {
          continue;
        }
        pending.push({
          kind: "enter",
          incoming: frameIncoming[index],
          parsed: frameParsed[index],
          resolved: frameResolved[index],
          container: next,
          key: index,
        });
      }
      continue;
    }

    // Objects: walk key by key
    if (
      isPlainObject(frameIncoming) &&
      isPlainObject(frameParsed) &&
      isPlainObject(frameResolved)
    ) {
      const result: Record<string, unknown> = {};
      settleEnvRefRestoreFrame(frame, result);
      // Pushed in reverse so keys settle into `result` in document order; keys
      // the parsed document does not own pass through with `parsed: undefined`
      // and keep the caller-added value as-is.
      const entries = Object.entries(frameIncoming);
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (entry === undefined) {
          continue;
        }
        const key = entry[0];
        const hasParsedKey = Object.hasOwn(frameParsed, key);
        pending.push({
          kind: "enter",
          incoming: entry[1],
          parsed: hasParsedKey ? frameParsed[key] : undefined,
          resolved: hasParsedKey ? frameResolved[key] : undefined,
          container: result,
          key,
        });
      }
      continue;
    }

    // Mismatched types or primitives — keep incoming
    settleEnvRefRestoreFrame(frame, frameIncoming);
  }
  return root.resolved;
}

function parentPath(value: string): string {
  if (!value) {
    return "";
  }
  if (value.endsWith("]")) {
    const index = value.lastIndexOf("[");
    return index > 0 ? value.slice(0, index) : "";
  }
  const index = value.lastIndexOf(".");
  return index >= 0 ? value.slice(0, index) : "";
}

function isPathChanged(path: string, changedPaths: Set<string>): boolean {
  if (changedPaths.has(path)) {
    return true;
  }
  let current = parentPath(path);
  while (current) {
    if (changedPaths.has(current)) {
      return true;
    }
    current = parentPath(current);
  }
  return changedPaths.has("");
}

/**
 * Frames for the iterative env-ref map restoration walk. `enter` frames resolve
 * one node and schedule their children into a fresh container; the two `exit`
 * frame kinds run after every child slot has settled and keep the original
 * value in place unless a slot changed, so document nesting costs heap rather
 * than call frames.
 */
type EnvRefMapRestoreFrame =
  | {
      readonly kind: "enter";
      readonly value: unknown;
      readonly path: string;
      readonly container: Record<string, unknown> | unknown[];
      readonly key: string | number;
    }
  | {
      readonly kind: "exit-array";
      readonly value: readonly unknown[];
      readonly next: readonly unknown[];
      readonly container: Record<string, unknown> | unknown[];
      readonly key: string | number;
    }
  | {
      readonly kind: "exit-record";
      readonly value: Record<string, unknown>;
      readonly next: Record<string, unknown>;
      readonly container: Record<string, unknown> | unknown[];
      readonly key: string | number;
    };

function settleEnvRefMapRestoreFrame(frame: EnvRefMapRestoreFrame, value: unknown): void {
  if (Array.isArray(frame.container)) {
    const key = frame.key;
    if (typeof key === "number") {
      frame.container[key] = value;
    }
    return;
  }
  const key = frame.key;
  if (typeof key === "string") {
    frame.container[key] = value;
  }
}

export function restoreEnvRefsFromMap(
  value: unknown,
  path: string,
  envRefMap: Map<string, string>,
  changedPaths: Set<string>,
  identityRestoredPaths: ReadonlySet<string> = new Set(),
): unknown {
  const root: Record<string, unknown> = {};
  const pending: EnvRefMapRestoreFrame[] = [
    { kind: "enter", value, path, container: root, key: "resolved" },
  ];
  while (pending.length > 0) {
    const frame = pending.pop();
    if (frame === undefined) {
      break;
    }
    if (frame.kind === "exit-array") {
      // Keep the original value when no child slot changed, matching the
      // recursive form's changed detection by reference comparison.
      settleEnvRefMapRestoreFrame(
        frame,
        frame.next.some((item, index) => item !== frame.value[index]) ? frame.next : frame.value,
      );
      continue;
    }
    if (frame.kind === "exit-record") {
      // Keep the original value when no child slot changed, matching the
      // recursive form's changed detection by reference comparison.
      settleEnvRefMapRestoreFrame(
        frame,
        Object.keys(frame.value).some((key) => frame.next[key] !== frame.value[key])
          ? frame.next
          : frame.value,
      );
      continue;
    }
    const { value: frameValue, path: framePath } = frame;
    if (typeof frameValue === "string") {
      if (identityRestoredPaths.has(framePath)) {
        settleEnvRefMapRestoreFrame(frame, frameValue);
        continue;
      }
      if (!isPathChanged(framePath, changedPaths)) {
        const original = envRefMap.get(framePath);
        if (original !== undefined) {
          settleEnvRefMapRestoreFrame(frame, original);
          continue;
        }
      }
      settleEnvRefMapRestoreFrame(frame, frameValue);
      continue;
    }
    if (Array.isArray(frameValue)) {
      const next: unknown[] = Array.from({ length: frameValue.length });
      settleEnvRefMapRestoreFrame(frame, next);
      // Pushed in reverse so indices settle in order; the exit frame runs only
      // after every child slot has been restored.
      pending.push({
        kind: "exit-array",
        value: frameValue,
        next,
        container: frame.container,
        key: frame.key,
      });
      for (let index = frameValue.length - 1; index >= 0; index -= 1) {
        pending.push({
          kind: "enter",
          value: frameValue[index],
          path: `${framePath}[${index}]`,
          container: next,
          key: index,
        });
      }
      continue;
    }
    if (isRecord(frameValue)) {
      const next: Record<string, unknown> = {};
      settleEnvRefMapRestoreFrame(frame, next);
      pending.push({
        kind: "exit-record",
        value: frameValue,
        next,
        container: frame.container,
        key: frame.key,
      });
      const entries = Object.entries(frameValue);
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (entry === undefined) {
          continue;
        }
        const key = entry[0];
        pending.push({
          kind: "enter",
          value: entry[1],
          path: framePath ? `${framePath}.${key}` : key,
          container: next,
          key,
        });
      }
      continue;
    }
    settleEnvRefMapRestoreFrame(frame, frameValue);
  }
  return root.resolved;
}

export function resolveWriteEnvSnapshotForPath(params: {
  actualConfigPath: string;
  expectedConfigPath?: string;
  envSnapshotForRestore?: Record<string, string | undefined>;
}): Record<string, string | undefined> | undefined {
  if (
    params.expectedConfigPath === undefined ||
    params.expectedConfigPath === params.actualConfigPath
  ) {
    return params.envSnapshotForRestore;
  }
  return undefined;
}
