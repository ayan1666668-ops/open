// Inbound media ownership binds a staged media-store object to the session that
// published its reference, so the assistant-media route can enforce origin-session
// authority before it serves bytes.
//
// A staged reference is a copy of bytes the agent already holds, written into the
// shared inbound bucket so the chat display projection can keep a reference. The
// bucket is one of the default media roots, so a reader who learned the reference
// could otherwise fetch it without naming any session, and outlive the visibility of
// the session that published it. This registry records the originating session and the
// route refuses an ownerless or mismatched request.
//
// Records are advisory to nothing and enforced by the route, so a write failure must
// not silently publish an unbound object: recordStagedInboundMedia reports failure and
// the caller keeps the bytes private rather than attaching an unenforceable reference.
//
// Two invariants hold the binding together. A registry that cannot be read is a failure
// rather than an empty registry, because an empty registry is the state that binds
// nothing. And a record is forgotten only once the bytes it names are gone, because
// forgetting a live record would stop restricting an object that is still readable.
import fs from "node:fs/promises";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { parseInboundMediaUri } from "./media-reference.js";
import { getMediaDir } from "./store.js";

const log = createSubsystemLogger("media/inbound-ownership");

/** Ownership record for one staged inbound media object. */
export type InboundMediaOwnership = {
  /** Epoch ms the object was staged into the shared store. */
  stagedAt: number;
  /** Session that published the reference; absent until its result is persisted. */
  sessionKey?: string;
  agentId?: string;
};

const OWNERSHIP_FILE_NAME = "inbound-ownership.json";
const OWNERSHIP_FILE_MODE = 0o600;
/** Bounded so a long-lived store cannot grow the registry without limit. */
const MAX_OWNERSHIP_ENTRIES = 5000;
/**
 * How many records one prune pass may test against the store. The pass runs inside the
 * update lock, on every staged object and every persisted tool result, so the work it does
 * is bounded; a record whose test is deferred is kept, which is the safe direction.
 */
const PRUNE_EXISTENCE_CHECKS_PER_PASS = 128;
/** Depth bound for the reference walk, which runs on every persisted tool result. */
const MAX_REFERENCE_WALK_DEPTH = 6;

type OwnershipIndex = Record<string, InboundMediaOwnership>;

function ownershipFilePath(): string {
  return path.join(getMediaDir(), OWNERSHIP_FILE_NAME);
}

/** Rejects ids that are not a single bounded path component inside the inbound bucket. */
export function isSafeInboundMediaId(id: string): boolean {
  return (
    id.length > 0 &&
    id !== "." &&
    id !== ".." &&
    !id.includes("/") &&
    !id.includes("\\") &&
    !id.includes("\0")
  );
}

/** Parses a canonical media://inbound/<id> reference into its inbound id. */
export function inboundMediaIdFromReference(source: string): string | undefined {
  try {
    const id = parseInboundMediaUri(source)?.id;
    return id && isSafeInboundMediaId(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads the registry.
 *
 * A file that is not there is an empty registry, because nothing has been staged. Every
 * other failure, an unreadable file, a truncated write, or malformed JSON, is reported as a
 * FAILURE rather than as an empty registry. The two states mean opposite things: an empty
 * registry is the state in which nothing is bound, and a caller that cannot resolve a
 * record must refuse the request rather than fall back to the access an object had before
 * it was staged.
 */
async function readOwnershipIndex(): Promise<OwnershipIndex> {
  let raw: string;
  try {
    raw = await fs.readFile(ownershipFilePath(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    log.warn("Inbound media ownership registry could not be read", {
      path: ownershipFilePath(),
      error: String(err),
    });
    throw err;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    log.warn("Inbound media ownership registry does not hold an index", {
      path: ownershipFilePath(),
    });
    throw new Error(`${OWNERSHIP_FILE_NAME} does not hold an ownership index`);
  }
  const index: OwnershipIndex = {};
  // SAFETY: parsed is confirmed a non-null, non-array object immediately above.
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isSafeInboundMediaId(id) || !value || typeof value !== "object") {
      continue;
    }
    // SAFETY: value is confirmed a non-null object by the guard on the loop entry above.
    const record = value as Record<string, unknown>;
    if (typeof record.stagedAt !== "number" || !Number.isFinite(record.stagedAt)) {
      continue;
    }
    index[id] = {
      stagedAt: record.stagedAt,
      ...(typeof record.sessionKey === "string" ? { sessionKey: record.sessionKey } : {}),
      ...(typeof record.agentId === "string" ? { agentId: record.agentId } : {}),
    };
  }
  return index;
}

/** Whether the store still holds the bytes an inbound id names. */
async function inboundMediaBytesExist(id: string): Promise<boolean> {
  try {
    return (await fs.stat(path.join(getMediaDir(), "inbound", id))).isFile();
  } catch (err) {
    // Only a missing file is proof that the bytes are gone. An unreadable or unresolvable
    // path is not, and keeping the record only ever restricts.
    return (err as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/**
 * Drops the records whose bytes are gone, and nothing else.
 *
 * The registry is the only thing that keeps a staged object bound to its session, and the
 * route refuses an object with no owner, so dropping a record while its file still exists
 * is a downgrade: the object stops being restricted while it is still readable. Age and
 * size are therefore never a reason on their own to forget a record. The bound decides
 * which records are worth re-examining, oldest first because the store deletes the oldest
 * bytes, and a record whose bytes are still there is kept however old it is.
 *
 * Consequence, and the reason for it: a registry at its bound whose oldest records all
 * still name live files stays at its bound rather than discarding a live binding, so the
 * bound is enforced over successive passes rather than in one.
 */
async function pruneOwnershipIndex(index: OwnershipIndex): Promise<OwnershipIndex> {
  if (Object.keys(index).length <= MAX_OWNERSHIP_ENTRIES) {
    return index;
  }
  const oldestFirst = Object.entries(index).toSorted(
    ([, left], [, right]) => left.stagedAt - right.stagedAt,
  );
  const kept: OwnershipIndex = { ...index };
  for (const [id] of oldestFirst.slice(0, PRUNE_EXISTENCE_CHECKS_PER_PASS)) {
    if (id in kept && !(await inboundMediaBytesExist(id))) {
      delete kept[id];
    }
  }
  return kept;
}

/** Writes the index atomically so a reader never observes a truncated registry. */
async function writeOwnershipIndex(index: OwnershipIndex): Promise<void> {
  const target = ownershipFilePath();
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(index), { mode: OWNERSHIP_FILE_MODE });
  try {
    await fs.rename(temp, target);
  } catch (err) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * Serializes read-modify-write cycles. Concurrent tool results would otherwise
 * overwrite each other's records, and a lost record is an unenforceable reference.
 */
let ownershipQueue: Promise<unknown> = Promise.resolve();
function withOwnershipLock<T>(run: () => Promise<T>): Promise<T> {
  const next = ownershipQueue.then(run, run);
  ownershipQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function updateOwnership(
  id: string,
  apply: (existing: InboundMediaOwnership | undefined, now: number) => InboundMediaOwnership,
  options: { requireExisting?: boolean } = {},
): Promise<boolean> {
  if (!isSafeInboundMediaId(id)) {
    return false;
  }
  return await withOwnershipLock(async () => {
    try {
      const now = Date.now();
      const index = await pruneOwnershipIndex(await readOwnershipIndex());
      const existing = index[id];
      if (options.requireExisting && !existing) {
        // Binding is what narrows a published object. An object that was never staged
        // belongs to a lane this registry does not own, so it keeps its current access.
        return false;
      }
      index[id] = apply(existing, now);
      await writeOwnershipIndex(index);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Records that an object was staged, before any reference to it is attached.
 *
 * The staged marker alone already binds the object to a session: the route refuses an
 * object with a record unless the request resolves to a session. Reporting failure lets
 * the caller publish nothing rather than publish a reference the route cannot enforce.
 */
export async function recordStagedInboundMedia(id: string): Promise<boolean> {
  return await updateOwnership(id, (existing, now) => ({
    stagedAt: existing?.stagedAt ?? now,
    ...(existing?.sessionKey ? { sessionKey: existing.sessionKey } : {}),
    ...(existing?.agentId ? { agentId: existing.agentId } : {}),
  }));
}

/**
 * Records the originating session for a staged object, when the result that carries its
 * reference is persisted. Best-effort, and only for an object that was staged: the staged
 * marker already requires a session, and this narrows the object to the one session that
 * published it. A reference to an object this registry never staged is left alone, so an
 * unrelated lane such as a channel attachment keeps the access it has today.
 */
export async function recordInboundMediaOwner(
  id: string,
  owner: { sessionKey: string; agentId?: string },
): Promise<boolean> {
  if (!owner.sessionKey) {
    return false;
  }
  return await updateOwnership(
    id,
    (existing, now) => ({
      stagedAt: existing?.stagedAt ?? now,
      sessionKey: owner.sessionKey,
      ...((owner.agentId ?? existing?.agentId)
        ? { agentId: owner.agentId ?? existing?.agentId }
        : {}),
    }),
    { requireExisting: true },
  );
}

/**
 * Reads the ownership record for an inbound id, or undefined when it is not staged.
 *
 * A registry that cannot be read rejects rather than reporting "not staged": the two states
 * mean opposite things, so a caller must refuse what it cannot resolve and never fall back
 * to the access an object had before it was staged.
 */
export async function resolveInboundMediaOwnership(
  id: string,
): Promise<InboundMediaOwnership | undefined> {
  if (!isSafeInboundMediaId(id)) {
    return undefined;
  }
  return (await readOwnershipIndex())[id];
}

function collectInboundMediaIdsFromValue(value: unknown, found: Set<string>, depth: number): void {
  if (depth > MAX_REFERENCE_WALK_DEPTH || found.size >= 32) {
    return;
  }
  if (typeof value === "string") {
    if (value.includes("media://inbound/")) {
      const id = inboundMediaIdFromReference(value);
      if (id) {
        found.add(id);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectInboundMediaIdsFromValue(entry, found, depth + 1);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  // SAFETY: value is confirmed a non-null, non-array object by the guard immediately above.
  for (const entry of Object.values(value as Record<string, unknown>)) {
    collectInboundMediaIdsFromValue(entry, found, depth + 1);
  }
}

/** Collects canonical inbound references anywhere inside a persisted session value. */
export function collectInboundMediaIds(value: unknown): string[] {
  const found = new Set<string>();
  collectInboundMediaIdsFromValue(value, found, 0);
  return [...found];
}

/**
 * Binds every staged reference inside a persisted value to the session that persisted it.
 * Returns the ids bound, so a caller can log or assert the binding without re-walking.
 */
export async function recordInboundMediaOwnersInValue(
  value: unknown,
  owner: { sessionKey: string; agentId?: string },
): Promise<string[]> {
  const ids = collectInboundMediaIds(value);
  const bound: string[] = [];
  for (const id of ids) {
    if (await recordInboundMediaOwner(id, owner)) {
      bound.push(id);
    }
  }
  return bound;
}
