import { parseConcreteConfigPath, toDotPath } from "../shared/dot-path.js";
import type { EnvSubstitutionWarning } from "./env-substitution.js";
import {
  coerceSecretRef,
  DEFAULT_SECRET_PROVIDER_ALIAS,
  isValidEnvSecretRefId,
  type SecretRef,
} from "./types.secrets.js";

/** `null` means this value has not passed through authoritative config env substitution. */
export type ConfigResolutionFacts = ReadonlySet<string> | null;

const configResolutionFacts = new WeakMap<object, ReadonlySet<string>>();
type ConfigEnvSecretRefFact = Readonly<{
  ref: SecretRef;
  state: "pending" | "resolved";
}>;

const envSecretRefsByFacts = new WeakMap<
  ReadonlySet<string>,
  ReadonlyMap<string, ConfigEnvSecretRefFact>
>();

export function createConfigResolutionFacts(
  warnings: readonly EnvSubstitutionWarning[],
  pendingEnvSecretRefs: ReadonlyMap<string, string> = new Map(),
  envProvider: string | undefined = DEFAULT_SECRET_PROVIDER_ALIAS,
  resolvedEnvSecretRefs: ReadonlyMap<string, string> = new Map(),
): ReadonlySet<string> {
  const facts = new Set(warnings.map(({ configPath }) => configPath));
  const provider = envProvider?.trim() || DEFAULT_SECRET_PROVIDER_ALIAS;
  if (pendingEnvSecretRefs.size > 0 || resolvedEnvSecretRefs.size > 0) {
    const envSecretRefs = new Map<string, ConfigEnvSecretRefFact>();
    for (const [path, id] of pendingEnvSecretRefs) {
      envSecretRefs.set(path, {
        ref: { source: "env", provider, id },
        state: "pending",
      });
    }
    for (const [path, id] of resolvedEnvSecretRefs) {
      envSecretRefs.set(path, {
        ref: { source: "env", provider, id },
        state: "resolved",
      });
    }
    envSecretRefsByFacts.set(facts, envSecretRefs);
  }
  return facts;
}

export function setConfigResolutionFacts(target: unknown, facts: ConfigResolutionFacts): void {
  if (!target || typeof target !== "object") {
    return;
  }
  if (facts === null) {
    configResolutionFacts.delete(target);
    return;
  }
  configResolutionFacts.set(target, facts);
}

export function getConfigResolutionFacts(target: unknown): ConfigResolutionFacts {
  return target && typeof target === "object" ? (configResolutionFacts.get(target) ?? null) : null;
}

export function copyConfigResolutionFacts(source: unknown, target: unknown): void {
  setConfigResolutionFacts(target, getConfigResolutionFacts(source));
}

export function cloneConfigWithResolutionFacts<T>(value: T): T {
  const cloned = structuredClone(value);
  copyConfigResolutionFacts(value, cloned);
  return cloned;
}

export function copyConfigResolutionFactsExcept(
  source: unknown,
  target: unknown,
  paths: readonly string[],
): void {
  const facts = getConfigResolutionFacts(source);
  if (facts === null) {
    setConfigResolutionFacts(target, null);
    return;
  }
  const envSecretRefs = envSecretRefsByFacts.get(facts);
  if (
    paths.length === 0 ||
    !paths.some((path) => facts.has(path) || envSecretRefs?.has(path) === true)
  ) {
    setConfigResolutionFacts(target, facts);
    return;
  }
  const remaining = new Set(facts);
  paths.forEach((path) => remaining.delete(path));
  if (envSecretRefs) {
    const remainingEnvSecretRefs = new Map(envSecretRefs);
    paths.forEach((path) => remainingEnvSecretRefs.delete(path));
    if (remainingEnvSecretRefs.size > 0) {
      envSecretRefsByFacts.set(remaining, remainingEnvSecretRefs);
    }
  }
  setConfigResolutionFacts(target, remaining);
}

type SerializedConfigResolutionFacts = Readonly<{
  unresolvedPaths: readonly string[];
  envSecretRefs: readonly (readonly [string, ConfigEnvSecretRefFact])[];
}> | null;

/** Captures loader provenance as deterministic data for a prepared worker generation. */
export function serializeConfigResolutionFacts(target: unknown): SerializedConfigResolutionFacts {
  const facts = getConfigResolutionFacts(target);
  return facts === null
    ? null
    : {
        unresolvedPaths: [...facts].toSorted(),
        envSecretRefs: [...(envSecretRefsByFacts.get(facts) ?? [])].toSorted(([left], [right]) =>
          left.localeCompare(right),
        ),
      };
}

/** Restores known-empty facts too: absence would reparse decoded literals as references. */
export function restoreConfigResolutionFacts(
  target: unknown,
  data: SerializedConfigResolutionFacts,
): void {
  if (data === null) {
    setConfigResolutionFacts(target, null);
    return;
  }
  const facts = new Set(data.unresolvedPaths);
  if (data.envSecretRefs.length > 0) {
    envSecretRefsByFacts.set(facts, new Map(data.envSecretRefs));
  }
  setConfigResolutionFacts(target, facts);
}

/**
 * Recorded keys are canonical config paths, while the plugin SDK entry points take a
 * single `path` string and callers that build one by hand spell record keys without
 * quoting. The reference lookups below retry such a miss by segment identity, so a
 * caller that can only supply a string still reaches the fact it named.
 *
 * The retry is deliberately confined to the reference lookups. The unresolved-path
 * predicates stay exact: internal callers hold registry paths, and quoting is the
 * only thing that separates the two spellings, so a retry there would buy nothing.
 *
 * A recorded key is indexed by its flattened spelling only when that spelling is
 * unambiguous. Flattening drops the quotes, so `a["b.c"].d` and a real `a.b.c.d`
 * both spell the same string; the same query can therefore name a neighbouring
 * target. Dropping a spelling that two recorded keys claim removes the collisions
 * the facts can see, and the exact match is always tried first.
 */
const pathSpellingIndexByOwner = new WeakMap<object, ReadonlyMap<string, string>>();

function pathSpelling(path: string): string | null {
  try {
    return toDotPath(parseConcreteConfigPath(path));
  } catch {
    return null;
  }
}

/** Maps each non-canonical spelling of a recorded key back to that key. */
function pathSpellingIndex(owner: object, recorded: Iterable<string>): ReadonlyMap<string, string> {
  const cached = pathSpellingIndexByOwner.get(owner);
  if (cached) {
    return cached;
  }
  const index = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const path of recorded) {
    const spelling = pathSpelling(path);
    // A key that is already its own spelling is reachable exactly, and skipping it
    // keeps the index empty for the common config, so a miss costs nothing there.
    if (spelling === null || spelling === path) {
      continue;
    }
    // Two recorded keys can spell the same string only through a quoted segment;
    // dropping it keeps the retry from answering with a neighbouring reference.
    if (index.has(spelling)) {
      ambiguous.add(spelling);
      continue;
    }
    index.set(spelling, path);
  }
  ambiguous.forEach((spelling) => index.delete(spelling));
  pathSpellingIndexByOwner.set(owner, index);
  return index;
}

/** Returns the recorded reference key that names the same segments as `path`. */
function matchRecordedSecretRefPath(
  envSecretRefs: ReadonlyMap<string, ConfigEnvSecretRefFact>,
  path: string,
): string | undefined {
  if (envSecretRefs.has(path)) {
    return path;
  }
  const index = pathSpellingIndex(envSecretRefs, envSecretRefs.keys());
  if (index.size === 0) {
    return undefined;
  }
  const spelling = pathSpelling(path);
  return spelling === null ? undefined : index.get(spelling);
}

export function hasUnresolvedConfigPath(target: unknown, path: string): boolean {
  return getConfigResolutionFacts(target)?.has(path) === true;
}

function getEnvSecretRefFact(target: unknown, path: string): ConfigEnvSecretRefFact | undefined {
  const facts = getConfigResolutionFacts(target);
  const envSecretRefs = facts === null ? undefined : envSecretRefsByFacts.get(facts);
  if (!envSecretRefs) {
    return undefined;
  }
  const recordedPath = matchRecordedSecretRefPath(envSecretRefs, path);
  return recordedPath === undefined ? undefined : envSecretRefs.get(recordedPath);
}

/** Returns only a still-pending reference recorded from the authored config source. */
export function getAuthoredConfigSecretRef(target: unknown, path: string): SecretRef | null {
  const fact = getEnvSecretRefFact(target, path);
  return fact?.state === "pending" ? fact.ref : null;
}

/** Returns the env source of a value that config substitution already materialized. */
export function getResolvedConfigEnvSecretRef(target: unknown, path: string): SecretRef | null {
  const fact = getEnvSecretRefFact(target, path);
  return fact?.state === "resolved" ? fact.ref : null;
}

/** Collect authored env references, including shorthand already materialized by config loading. */
export function collectEnvSecretRefIds(value: unknown): Set<string> {
  const facts = getConfigResolutionFacts(value);
  const ids = new Set<string>();
  for (const { ref } of (facts && envSecretRefsByFacts.get(facts))?.values() ?? []) {
    ids.add(ref.id);
  }
  const seen = new WeakSet<object>();
  const visit = (candidate: unknown): void => {
    // Loaded strings are decoded literals; only their recorded provenance can name a reference.
    const ref = typeof candidate === "string" && facts !== null ? null : coerceSecretRef(candidate);
    if (ref?.source === "env" && isValidEnvSecretRefId(ref.id)) {
      ids.add(ref.id);
      return;
    }
    if (typeof candidate !== "object" || candidate === null || seen.has(candidate)) {
      return;
    }
    seen.add(candidate);
    for (const child of Array.isArray(candidate) ? candidate : Object.values(candidate)) {
      visit(child);
    }
  };
  visit(value);
  return ids;
}

/** Reads inline references from authored facts and structured references from their values. */
export function resolveConfigSecretRef(params: {
  config: unknown;
  path: string;
  value: unknown;
  defaults?: Parameters<typeof coerceSecretRef>[1];
  /** Authoring and audit consumers also need the source of materialized values. */
  includeResolved?: boolean;
}): SecretRef | null {
  return typeof params.value === "string" && getConfigResolutionFacts(params.config) !== null
    ? (getAuthoredConfigSecretRef(params.config, params.path) ??
        (params.includeResolved ? getResolvedConfigEnvSecretRef(params.config, params.path) : null))
    : coerceSecretRef(params.value, params.defaults);
}

export function hasUnresolvedConfigPathInSubtree(target: unknown, path: string): boolean {
  const facts = getConfigResolutionFacts(target);
  if (facts === null) {
    return false;
  }
  for (const candidate of facts) {
    if (
      candidate === path ||
      candidate.startsWith(`${path}.`) ||
      candidate.startsWith(`${path}[`)
    ) {
      return true;
    }
  }
  return false;
}
