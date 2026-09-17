/**
 * Shared grammar for explicit redaction provenance in persisted text (#142821).
 *
 * A mask (`***`, or `first6…last4` from logging redaction) is ordinary-looking text:
 * once it is stored, no reader can tell "the producer redacted this secret" from
 * "the user typed these exact bytes". Persistence therefore wraps every mask it
 * produces in these markers, and replay may only rewrite marked spans. Unmarked
 * text is literal history and must be left alone — guessing from string shape
 * rewrites prose ellipses, markdown rules, and assignment prefixes.
 *
 * The encoding is unambiguous against literal text (#142821 review):
 * - A mark opens with `REDACTION_PROVENANCE_ESCAPE`, a non-printable control byte that
 *   persistence never stores bare: raw input is escaped first (every byte doubled),
 *   then redaction produces marks, then `escapeRedactionProvenanceLiterals` fixes
 *   literal runs to a fixed point. Replay restores those bytes. The byte is
 *   not whitespace (so redaction patterns keep the mark as one contiguous token) and is
 *   not trimmed or otherwise rewritten by serialization.
 * - A mark carries its own version (`:1`), so a later encoding is a different token
 *   instead of a reinterpretation of the same bytes.
 * - A mark only counts when its delimiter pair is complete and its body is mask-shaped
 *   (`***`, or one `<prefix>…<suffix>` hint) — the only bodies this encoder emits.
 *   Delimiter text with any other body is literal.
 * Records persisted before this encoding (bare masks, or the pre-versioning
 * delimiters) carry no escape byte at all, so replay never reinterprets them. A tool
 * that stripped the byte would leave a mark literal, which is the same safe direction
 * as unmarked history: it is never rewritten as provenance.
 *
 * Raw versus encoded (#142821 review):
 * - Raw text is arbitrary input. It may already contain escape bytes or even
 *   mark-shaped spans the user typed. `escapeRawRedactionProvenanceLiterals` encodes
 *   every raw escape byte (each becomes a pair), so no raw byte can be misread as a
 *   mark the producer emitted. Raw text has no producer spans by definition.
 * - Encoded text is what the persistence write path stores: raw input escaped first,
 *   then redacted with provenance, then passed through `escapeRedactionProvenanceLiterals`
 *   (an idempotent fixed point). A write that produced no genuine mark still stores the
 *   escaped form: only strings that carry no reserved byte stay byte-identical, and a
 *   string that needed escaping is never stored as bare bytes a reader could mistake for
 *   provenance (#142821 review).
 * - Stored strings that carry a reserved byte open with `REDACTION_PROVENANCE_STORAGE_MARK`
 *   (#143937 review): a mask proves nothing about the bytes around it, so a mask-free
 *   escaped write was indistinguishable from legacy raw history and could not be decoded.
 *   The mark states "this string uses the encoding" on its own, so readers decode escaped
 *   literals whether or not a mask is present, and writes of already marked strings reuse
 *   their prepared bytes instead of escaping producer markers as raw input again.
 * - Readers (`replaceRedactionProvenance`, `stripRedactionProvenance`) decode a string
 *   when it carries the storage mark, or when it carries at least one genuine mark —
 *   rows persisted before the mark existed. Everything else is returned byte-identical,
 *   so unencoded legacy history — including a literal escape-byte pair it happens to
 *   contain — is never rewritten. Detection uses the same scanner as replacement, never
 *   a divergent prefilter.
 */

/** Discriminator and escape byte for the grammar. Non-printable; never stored bare. */
export const REDACTION_PROVENANCE_ESCAPE = "\u001F";
/** Versioned delimiter bodies. The escape byte in front of them is the discriminator. */
const REDACTION_PROVENANCE_OPEN_BODY = "⟦openclaw:redacted:1⟧";
const REDACTION_PROVENANCE_CLOSE_BODY = "⟦/openclaw:redacted:1⟧";
/** Opens a persisted mask. */
export const REDACTION_PROVENANCE_START = `${REDACTION_PROVENANCE_ESCAPE}${REDACTION_PROVENANCE_OPEN_BODY}`;
/** Closes a persisted mask. */
export const REDACTION_PROVENANCE_END = `${REDACTION_PROVENANCE_ESCAPE}${REDACTION_PROVENANCE_CLOSE_BODY}`;
/** Opens every stored string this encoder escaped. The escape byte in front of the body is
 *  the discriminator, and raw input reaches storage with its own escape bytes doubled, so
 *  a stored string that opens with these bytes was written by this encoder (#143937). */
export const REDACTION_PROVENANCE_STORAGE_MARK = `${REDACTION_PROVENANCE_ESCAPE}⟦openclaw:encoded:1⟧`;

/** Mask-shaped mark body: the placeholder, or one `prefix…suffix` diagnostic hint. */
// oxlint-disable-next-line eslint/no-control-regex -- Intentional 0x1F discriminator for provenance marks.
const REDACTION_PROVENANCE_BODY_RE = /^(?:\*{3}|[^\u001F\u27E6\u27E7]+…[^\u001F\u27E6\u27E7]+)$/u;
/** Bytes the grammar reserves; a mask hint that would contain them degrades to `***`. */
// oxlint-disable-next-line eslint/no-control-regex -- Intentional 0x1F discriminator for provenance marks.
const REDACTION_PROVENANCE_SYNTAX_RE = /[\u001F\u27E6\u27E7]/u;
/** Returns whether text contains any byte the grammar reserves. */
export function containsRedactionProvenanceSyntax(text: string): boolean {
  return REDACTION_PROVENANCE_SYNTAX_RE.test(text);
}

/**
 * Returns whether the value is exactly one complete, mask-shaped marked span.
 *
 * Producer-side predicate only: it proves string shape, never that this encoder
 * produced the value, so it must never exempt untrusted input (raw sensitive fields,
 * registered-secret matches) from masking (#142821 review). Its only consumers are
 * `markRedactionProvenance` (double-wrap guard for masks just produced) and tests.
 */
export function isRedactionProvenanceMask(value: string): boolean {
  if (!value.startsWith(REDACTION_PROVENANCE_START) || !value.endsWith(REDACTION_PROVENANCE_END)) {
    return false;
  }
  const body = value.slice(
    REDACTION_PROVENANCE_START.length,
    value.length - REDACTION_PROVENANCE_END.length,
  );
  return REDACTION_PROVENANCE_BODY_RE.test(body);
}

/** Wraps one freshly produced mask. Trusted producer output only: input is a mask
 * this pass just built ("***" or a hint without grammar bytes), never raw user
 * input. The double-wrap guard keeps re-encoding idempotent. */
export function markRedactionProvenance(mask: string): string {
  if (isRedactionProvenanceMask(mask)) {
    return mask;
  }
  return `${REDACTION_PROVENANCE_START}${mask}${REDACTION_PROVENANCE_END}`;
}

type RedactionProvenanceVisitor = {
  /** Rewrites one literal run. */
  literal: (text: string) => string;
  /** Rewrites one complete mask-shaped marked span, passed its mask body. */
  marked: (mask: string) => string;
};

/**
 * Visits literal runs and marked spans of one string in a single pass.
 * A doubled escape byte is an escaped literal byte, an unterminated mark and a mark
 * whose body is not mask-shaped are both literal, and a mark never nests.
 *
 * This scanner is the single parsing rule for detection and replacement alike: every
 * reader decides "is this a mark?" by running it, so no prefilter can disagree with
 * the replacement pass (#142821 review).
 */
function scanRedactionProvenance(text: string, visit: RedactionProvenanceVisitor): string {
  if (!text.includes(REDACTION_PROVENANCE_ESCAPE)) {
    return visit.literal(text);
  }
  const parts: string[] = [];
  let cursor = 0;
  let index = 0;
  while (index < text.length) {
    if (text[index] !== REDACTION_PROVENANCE_ESCAPE) {
      index += 1;
      continue;
    }
    // A doubled escape byte is literal text and cannot open a mark.
    if (text.startsWith(REDACTION_PROVENANCE_ESCAPE, index + 1)) {
      index += 2;
      continue;
    }
    if (!text.startsWith(REDACTION_PROVENANCE_OPEN_BODY, index + 1)) {
      index += 1;
      continue;
    }
    const markStart = index + REDACTION_PROVENANCE_START.length;
    const close = text.indexOf(REDACTION_PROVENANCE_END, markStart);
    if (close < 0) {
      index += 1;
      continue;
    }
    const mask = text.slice(markStart, close);
    if (!REDACTION_PROVENANCE_BODY_RE.test(mask)) {
      index += 1;
      continue;
    }
    parts.push(visit.literal(text.slice(cursor, index)), visit.marked(mask));
    index = close + REDACTION_PROVENANCE_END.length;
    cursor = index;
  }
  return parts.length === 0
    ? visit.literal(text)
    : parts.join("") + visit.literal(text.slice(cursor));
}

/** Returns whether the scanner finds at least one complete mask-shaped marked span. */
function containsGenuineMark(text: string): boolean {
  if (!text.includes(REDACTION_PROVENANCE_ESCAPE)) {
    return false;
  }
  let found = false;
  scanRedactionProvenance(text, {
    literal: () => "",
    marked: () => {
      found = true;
      return "";
    },
  });
  return found;
}

/** Returns whether text carries at least one genuine provenance mark (scanner rule). */
export function hasRedactionProvenance(text: string): boolean {
  return containsGenuineMark(text);
}

/** Restores escaped literal bytes. Pairs collapse once, so raw bytes round-trip. */
function unescapeRedactionProvenanceLiterals(text: string): string {
  const escape = REDACTION_PROVENANCE_ESCAPE;
  if (!text.includes(escape)) {
    return text;
  }
  return text.split(`${escape}${escape}`).join(escape);
}

/**
 * Encodes every raw escape byte of untrusted input (each becomes a pair).
 *
 * Raw text has no producer spans by definition, so no scanning is needed or wanted:
 * scanning raw text for marks would preserve a user-typed complete mark as generated
 * provenance, and replay would then replace the user's own bytes (#142821 review).
 * The persistence write path runs this on the raw input before redaction produces
 * any mark. It is the exact inverse of `unescapeRedactionProvenanceLiterals` on
 * mark-free strings.
 */
export function escapeRawRedactionProvenanceLiterals(rawText: string): string {
  const escape = REDACTION_PROVENANCE_ESCAPE;
  if (!rawText.includes(escape)) {
    return rawText;
  }
  return rawText.split(escape).join(`${escape}${escape}`);
}

/** Normalizes one literal run so every escape byte it carries is escaped exactly once. */
function escapeLoneRedactionProvenanceEscapes(text: string): string {
  const escape = REDACTION_PROVENANCE_ESCAPE;
  let separator = text.indexOf(escape);
  if (separator < 0) {
    return text;
  }
  let result = "";
  let cursor = 0;
  while (separator >= 0) {
    result += text.slice(cursor, separator);
    cursor = separator + escape.length;
    if (text.startsWith(escape, cursor)) {
      // Already an escaped pair: it stays one escaped pair.
      cursor += escape.length;
    }
    result += `${escape}${escape}`;
    separator = text.indexOf(escape, cursor);
  }
  return result + text.slice(cursor);
}

/**
 * Escapes the literal bytes of encoded text that could otherwise be read as the grammar,
 * and leaves the marks this encoder emits exactly as they are. Already escaped text is a
 * fixed point, so repeated persistence passes cannot re-encode it. Text without a
 * genuine mark is returned unchanged: it is raw or legacy history, not encoder output,
 * and must round-trip byte-identical (#142821 review).
 */
export function escapeRedactionProvenanceLiterals(text: string): string {
  if (!containsGenuineMark(text)) {
    return text;
  }
  return scanRedactionProvenance(text, {
    literal: escapeLoneRedactionProvenanceEscapes,
    marked: (mask) => `${REDACTION_PROVENANCE_START}${mask}${REDACTION_PROVENANCE_END}`,
  });
}

/**
 * Adds the storage mark to one encoded body. Strings that carry no reserved byte come back
 * byte-identical, so untouched history stays untouched, and every string that does carry one
 * — escaped literal or produced mark — says so on its own, which is what lets a reader decode
 * the escaped literals of a mask-free write instead of leaving them doubled (#143937 review).
 */
export function markEncodedRedactionProvenance(encodedBody: string): string {
  // Only a string that carries the escape byte decodes differently from its stored bytes, so
  // only those are marked: text with no reserved byte — including delimiter text without the
  // discriminator — stays byte-identical (#142821 review).
  return encodedBody.includes(REDACTION_PROVENANCE_ESCAPE)
    ? `${REDACTION_PROVENANCE_STORAGE_MARK}${encodedBody}`
    : encodedBody;
}

/** Returns whether a stored string carries the storage mark. */
export function isEncodedRedactionProvenance(text: string): boolean {
  return text.startsWith(REDACTION_PROVENANCE_STORAGE_MARK);
}

/** Removes one storage mark. Unmarked text — raw input or pre-marker history — is returned
 *  unchanged, so writers can tell a prepared body from a raw one by comparing bytes. */
export function stripEncodedRedactionProvenance(text: string): string {
  return isEncodedRedactionProvenance(text)
    ? text.slice(REDACTION_PROVENANCE_STORAGE_MARK.length)
    : text;
}

/**
 * Body a reader may decode: the payload of a marked string, or the text itself when it
 * carries a genuine mark (a row persisted before the mark existed). `undefined` means the
 * bytes are raw or legacy history, and no reader may rewrite them (#143937 review).
 */
function resolveStoredRedactionProvenance(text: string): string | undefined {
  if (isEncodedRedactionProvenance(text)) {
    return text.slice(REDACTION_PROVENANCE_STORAGE_MARK.length);
  }
  return containsGenuineMark(text) ? text : undefined;
}

/**
 * Replaces every complete marked span with `replacement`, keeping all surrounding
 * text byte-identical after restoring its escaped bytes. An unterminated opener is
 * left verbatim: a reader that cannot see the end of a mask must not invent one.
 * Text that is neither marked as encoded nor carries a genuine mark is returned
 * unchanged, so unencoded legacy history is never rewritten (#142821 review).
 */
export function replaceRedactionProvenance(text: string, replacement: string): string {
  const body = resolveStoredRedactionProvenance(text);
  if (body === undefined) {
    return text;
  }
  return scanRedactionProvenance(body, {
    literal: unescapeRedactionProvenanceLiterals,
    marked: () => replacement,
  });
}

/**
 * Canonical form of one persisted string for byte-level identity comparison: every
 * marked span collapses to its mask body and escaped literal bytes are restored, so a
 * pre-upgrade row with bare masks and a freshly encoded row with the same content
 * compare equal. Genuinely different payloads still differ. Text that is neither marked
 * as encoded nor carries a genuine mark is returned unchanged, so legacy rows keep their
 * own canonical form.
 */
export function stripRedactionProvenance(text: string): string {
  const body = resolveStoredRedactionProvenance(text);
  if (body === undefined) {
    return text;
  }
  return scanRedactionProvenance(body, {
    literal: unescapeRedactionProvenanceLiterals,
    marked: (mask) => mask,
  });
}
