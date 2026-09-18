// Display-metadata mutations for sessions.patch.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionsPatchParams } from "../../packages/gateway-protocol/src/index.js";
import {
  normalizeSessionColorValue,
  normalizeSessionIconValue,
  SESSION_COLOR_IDS,
  SESSION_ICON_GLYPH_IDS,
} from "../../packages/gateway-protocol/src/session-agent-status.js";
import { isPinnableSessionEntry } from "../config/sessions/session-pin-policy.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import {
  isSessionAgentAttentionIconId,
  resolveActiveSessionAgentStatus,
  sanitizeSessionAgentStatusNote,
  sessionAgentStatusExpiresAt,
  SESSION_AGENT_STATUS_MAX_TTL_MINUTES,
} from "../sessions/session-agent-status.js";
import { parseSessionLabel, SESSION_LABEL_MAX_LENGTH } from "../sessions/session-label.js";

/** Applies display-metadata patch fields onto the next entry; returns an error message on invalid input. */
export function applySessionsPatchDisplayMetadata(params: {
  patch: SessionsPatchParams;
  next: InternalSessionEntry;
  isLabelInUse: (label: string) => boolean;
}): string | undefined {
  const { patch, next } = params;

  if ("autoLabel" in patch) {
    if (patch.autoLabel === null) {
      delete next.autoLabel;
    } else if (patch.autoLabel !== undefined) {
      const parsed = parseSessionLabel(patch.autoLabel);
      if (!parsed.ok) {
        return parsed.error;
      }
      // Device names are presentation metadata, not unique custom-label claims.
      next.autoLabel = parsed.label;
    }
  }

  if ("label" in patch) {
    const raw = patch.label;
    if (raw === null) {
      delete next.label;
    } else if (raw !== undefined) {
      const parsed = parseSessionLabel(raw);
      if (!parsed.ok) {
        return parsed.error;
      }
      if (params.isLabelInUse(parsed.label)) {
        return `label already in use: ${parsed.label}`;
      }
      next.label = parsed.label;
    }
  }

  if ("icon" in patch) {
    const raw = patch.icon;
    if (raw === null || raw === "") {
      delete next.icon;
    } else if (raw !== undefined) {
      const icon = normalizeSessionIconValue(raw);
      if (!icon) {
        return `icon must be a single emoji, a named icon (${SESSION_ICON_GLYPH_IDS.join(", ")}), or self-contained SVG markup/data URL up to 16 KiB`;
      }
      next.icon = icon;
    }
  }

  if ("color" in patch) {
    const raw = patch.color;
    if (raw === null || raw === "") {
      delete next.color;
    } else if (raw !== undefined) {
      const color = normalizeSessionColorValue(raw);
      if (!color) {
        return `color must be one of: ${SESSION_COLOR_IDS.join(", ")}`;
      }
      next.color = color;
    }
  }

  if ("category" in patch) {
    const raw = patch.category;
    if (raw === null) {
      delete next.category;
    } else if (raw !== undefined) {
      // Categories are shared organization buckets, so duplicates are expected (unlike labels).
      const trimmed = normalizeOptionalString(raw) ?? "";
      if (!trimmed) {
        return "invalid category: empty";
      }
      if (trimmed.length > SESSION_LABEL_MAX_LENGTH) {
        return `invalid category: too long (max ${SESSION_LABEL_MAX_LENGTH})`;
      }
      next.category = trimmed;
    }
  }

  if ("boardFace" in patch && patch.boardFace !== undefined) {
    next.boardFace = patch.boardFace;
  }

  if ("boardPresentation" in patch) {
    if (patch.boardPresentation === null) {
      delete next.boardPresentation;
    } else if (patch.boardPresentation !== undefined) {
      next.boardPresentation = patch.boardPresentation;
    }
  }

  return undefined;
}

export function applySessionsPatchAgentStatus(
  patch: SessionsPatchParams,
  next: InternalSessionEntry,
  now: number,
): string | undefined {
  if (!("statusNote" in patch || "attention" in patch || "ttlMinutes" in patch)) {
    return undefined;
  }
  const rawNote = patch.statusNote;
  const rawAttention = patch.attention;
  const ttlMinutes = patch.ttlMinutes;
  if (
    ttlMinutes !== undefined &&
    (!Number.isInteger(ttlMinutes) ||
      ttlMinutes < 1 ||
      ttlMinutes > SESSION_AGENT_STATUS_MAX_TTL_MINUTES)
  ) {
    return `invalid ttlMinutes (use 1-${SESSION_AGENT_STATUS_MAX_TTL_MINUTES})`;
  }
  if (rawNote === null || rawAttention === null) {
    if (
      (rawNote !== undefined && rawNote !== null) ||
      (rawAttention !== undefined && rawAttention !== null)
    ) {
      return "cannot clear and set agent status in the same patch";
    }
    delete next.agentStatus;
  } else {
    const current = resolveActiveSessionAgentStatus(next.agentStatus, now);
    const note = rawNote === undefined ? current?.note : sanitizeSessionAgentStatusNote(rawNote);
    if (!note) {
      return "statusNote required before setting attention or ttlMinutes";
    }
    if (rawAttention !== undefined && !isSessionAgentAttentionIconId(rawAttention)) {
      return "invalid attention icon";
    }
    const attention = rawAttention ?? current?.attention;
    next.agentStatus = {
      note,
      expiresAt: sessionAgentStatusExpiresAt(now, ttlMinutes),
      ...(attention ? { attention } : {}),
    };
  }
  return undefined;
}

export function applySessionsPatchListState(params: {
  patch: SessionsPatchParams;
  next: InternalSessionEntry;
  storeKey: string;
  now: number;
  archivedBy?: InternalSessionEntry["archivedBy"];
}): string | undefined {
  const { patch, next, storeKey, now } = params;
  if ("archived" in patch) {
    if (patch.archived === true) {
      // Archived sessions leave the active quick-access set in the same write.
      if (next.archivedAt === undefined) {
        next.archivedAt = now;
        next.archiveReason = "manual";
        if (params.archivedBy) {
          next.archivedBy = params.archivedBy;
        } else {
          delete next.archivedBy;
        }
      }
      delete next.pinnedAt;
    } else {
      delete next.archivedAt;
      delete next.archivedBy;
      delete next.archiveReason;
    }
  }

  const pinnable = isPinnableSessionEntry(storeKey, next);
  if (!pinnable) {
    delete next.pinnedAt;
  }
  if ("pinned" in patch) {
    if (patch.pinned === true) {
      if (next.archivedAt !== undefined) {
        return "cannot pin an archived session; restore it first";
      }
      if (!pinnable) {
        return "cannot pin a child session; pin its parent session instead";
      }
      next.pinnedAt ??= now;
    } else {
      delete next.pinnedAt;
    }
  }

  if ("unread" in patch) {
    if (patch.unread === true) {
      // This timestamp is also the conditional-ack revision. Repeated writes in
      // one clock tick must still represent distinct manual unread intent.
      next.markedUnreadAt = Math.max(now, (next.markedUnreadAt ?? 0) + 1);
    } else {
      next.lastReadAt = now;
      delete next.markedUnreadAt;
      delete next.agentStatus;
    }
  }
  return undefined;
}
