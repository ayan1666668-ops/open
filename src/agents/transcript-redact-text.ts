/**
 * Transcript write-side redaction helpers.
 *
 * These are the calls the transcript persistence path makes into logging redaction, so
 * they are also what opts into redaction provenance: every mask they produce is wrapped
 * for replay, and replay rewrites only wrapped spans (#142821).
 */
import {
  escapeRawRedactionProvenanceLiterals,
  escapeRedactionProvenanceLiterals,
  hasRedactionProvenance,
  markEncodedRedactionProvenance,
  stripEncodedRedactionProvenance,
} from "@openclaw/normalization-core/redaction-provenance";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readLoggingConfig } from "../logging/config.js";
import { redactSourceInputTextWithConfig } from "../logging/redact-source.js";
import {
  redactModelVisibleSensitiveFieldValueWithConfig,
  redactModelVisibleToolPayloadTextWithConfig,
  redactSensitiveFieldValueWithConfig,
  redactToolPayloadTextWithConfig,
  withRedactionProvenance,
} from "../logging/redact.js";

export function resolveTranscriptLoggingConfig(cfg?: OpenClawConfig) {
  const configuredLogging = readLoggingConfig();
  const redactPatterns = cfg?.logging?.redactPatterns ?? configuredLogging?.redactPatterns;
  return redactPatterns ? { redactPatterns } : undefined;
}

/**
 * One persisted transcript string: masks are marked for replay, and literal bytes that
 * could be read as a mark are escaped, so replay can never mistake history for a mask
 * and repeated passes leave the bytes alone (#142821).
 *
 * Raw input is escaped first (every escape byte doubled), so a user-typed complete
 * mark cannot survive as a genuine mark; redaction then produces fresh single marks,
 * and the final escape fixes literal runs to a fixed point. When redaction produced no
 * mark, the escaped form is still what persistence writes: strings that carry no
 * reserved byte stay byte-identical, and strings that do keep the encoded/raw
 * distinction instead of storing bytes replay would read as provenance (#142821
 * review).
 *
 * Input that already carries the storage mark is this encoder's own prepared output — a
 * repeated pass over the same tool result, or a re-write of a stored row — so its body is
 * reused instead of being escaped as raw text, which would turn produced marks back into
 * literal bytes and lose the provenance replay reads (#143937 review). The redaction
 * below still runs over it, so a changed policy revalidates the visible bytes.
 *
 * `markMasks: false` is the model-visible tool-text dialect: those bytes were admitted
 * live by the delivery path (`prepareModelVisibleToolTextBlock`, #146596), so
 * persistence escapes literals but leaves produced masks bare, and replay reuses the
 * admitted result instead of rewriting it.
 */
function encodePersistedTranscriptText(
  rawOrPrepared: string,
  redact: (body: string) => string,
  markMasks = true,
): string {
  const prepared = stripEncodedRedactionProvenance(rawOrPrepared);
  const body =
    prepared === rawOrPrepared ? escapeRawRedactionProvenanceLiterals(rawOrPrepared) : prepared;
  const redacted = markMasks ? withRedactionProvenance(() => redact(body)) : redact(body);
  if (hasRedactionProvenance(redacted)) {
    return markEncodedRedactionProvenance(escapeRedactionProvenanceLiterals(redacted));
  }
  // No fresh mark: keep the bytes redaction changed (truncation, omission, custom
  // patterns) and otherwise the body — never the bare bytes a replay could read as a
  // mark (#142821 review). Strings carrying no reserved byte stay byte-identical, and
  // every string that does records that it uses the encoding, so replay decodes its
  // escaped literals even when redaction produced no mask (#143937 review).
  return markEncodedRedactionProvenance(redacted === body ? body : redacted);
}

export function redactTranscriptText(
  value: string,
  cfg?: OpenClawConfig,
  modelVisibleToolResult = false,
): string {
  const loggingConfig = resolveTranscriptLoggingConfig(cfg);
  // Persisted masks carry explicit provenance so replay never has to guess (#142821).
  return encodePersistedTranscriptText(
    value,
    (body) =>
      modelVisibleToolResult
        ? redactModelVisibleToolPayloadTextWithConfig(body, loggingConfig)
        : redactToolPayloadTextWithConfig(body, loggingConfig),
    !modelVisibleToolResult,
  );
}

export function redactTranscriptStructuredFieldValue(
  key: string,
  value: string,
  cfg?: OpenClawConfig,
  modelVisibleToolResult = false,
): string {
  // Preserve pagination state only in transcripts; value-pattern and global log redaction remain.
  // Page-token values already encode via redactTranscriptText: delegate directly to avoid
  // double-escaping already-encoded marks.
  if (/^(?:next[_-]?)?page[_-]?token$|^page[_-]?cursor$/i.test(key)) {
    return redactTranscriptText(value, cfg, modelVisibleToolResult);
  }
  return encodePersistedTranscriptText(
    value,
    (body) =>
      modelVisibleToolResult
        ? redactModelVisibleSensitiveFieldValueWithConfig(
            key,
            body,
            resolveTranscriptLoggingConfig(cfg),
          )
        : redactSensitiveFieldValueWithConfig(key, body, resolveTranscriptLoggingConfig(cfg)),
    !modelVisibleToolResult,
  );
}

/** Source input text is persisted too, so its masks need the same provenance. */
export function redactTranscriptSourceInputText(value: string, cfg?: OpenClawConfig): string {
  return encodePersistedTranscriptText(value, (body) =>
    redactSourceInputTextWithConfig(body, resolveTranscriptLoggingConfig(cfg)),
  );
}
