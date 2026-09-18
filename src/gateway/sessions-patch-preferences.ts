import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionsPatchParams } from "../../packages/gateway-protocol/src/index.js";
import {
  normalizeElevatedLevel,
  normalizeFastMode,
  normalizeReasoningLevel,
  normalizeUsageDisplay,
} from "../auto-reply/thinking.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { normalizeExecTarget } from "../infra/exec-approvals.js";
import {
  applyTraceOverride,
  applyVerboseOverride,
  parseTraceOverride,
  parseVerboseOverride,
} from "../sessions/level-overrides.js";
import { normalizeSessionToolOverrides } from "./session-tool-overrides.js";

/** Project non-model run preferences without changing selection or runtime authority. */
export function applySessionsPatchPreferences(
  patch: SessionsPatchParams,
  next: InternalSessionEntry,
): string | undefined {
  const rawFastMode = patch.fastMode;
  if (rawFastMode === null) {
    delete next.fastMode;
  } else if (rawFastMode !== undefined) {
    const normalized = normalizeFastMode(rawFastMode);
    if (normalized === undefined) {
      return 'invalid fastMode (use true, false, or "auto")';
    }
    next.fastMode = normalized;
  }

  if ("toolOverrides" in patch) {
    const raw = patch.toolOverrides;
    if (raw === null) {
      delete next.toolOverrides;
    } else if (raw !== undefined) {
      // Session patches replace this sparse overlay atomically; they never deep-merge old policy.
      const normalized = normalizeSessionToolOverrides(raw);
      if (normalized) {
        next.toolOverrides = normalized;
      } else {
        delete next.toolOverrides;
      }
    }
  }

  if ("verboseLevel" in patch) {
    const parsed = parseVerboseOverride(patch.verboseLevel);
    if (!parsed.ok) {
      return parsed.error;
    }
    applyVerboseOverride(next, parsed.value);
  }

  if ("traceLevel" in patch) {
    const parsed = parseTraceOverride(patch.traceLevel);
    if (!parsed.ok) {
      return parsed.error;
    }
    applyTraceOverride(next, parsed.value);
  }

  if ("reasoningLevel" in patch) {
    const raw = patch.reasoningLevel;
    if (raw === null) {
      delete next.reasoningLevel;
    } else if (raw !== undefined) {
      const normalized = normalizeReasoningLevel(raw);
      if (!normalized) {
        return 'invalid reasoningLevel (use "on"|"off"|"stream")';
      }
      // Persist "off" explicitly so that resolveDefaultReasoningLevel()
      // does not re-enable reasoning for capable models (#24406).
      next.reasoningLevel = normalized;
    }
  }

  const rawResponseUsage = patch.responseUsage;
  if (rawResponseUsage === null) {
    delete next.responseUsage;
  } else if (rawResponseUsage !== undefined) {
    const normalized = normalizeUsageDisplay(rawResponseUsage);
    if (!normalized) {
      return 'invalid responseUsage (use "off"|"tokens"|"full")';
    }
    next.responseUsage = normalized;
  }

  if ("elevatedLevel" in patch) {
    const raw = patch.elevatedLevel;
    if (raw === null) {
      delete next.elevatedLevel;
    } else if (raw !== undefined) {
      const normalized = normalizeElevatedLevel(raw);
      if (!normalized) {
        return 'invalid elevatedLevel (use "on"|"off"|"ask"|"full")';
      }
      // Persist "off" explicitly so patches can override defaults.
      next.elevatedLevel = normalized;
    }
  }

  if ("execHost" in patch) {
    const raw = patch.execHost;
    if (raw === null) {
      delete next.execHost;
    } else if (raw !== undefined) {
      const normalized = normalizeExecTarget(raw) ?? undefined;
      if (!normalized) {
        return 'invalid execHost (use "auto"|"sandbox"|"gateway"|"node")';
      }
      next.execHost = normalized;
    }
  }

  if ("execNode" in patch) {
    if (patch.execNode === null) {
      delete next.execNode;
      delete next.execCwd;
      if (next.execHost === "node") {
        delete next.execHost;
      }
    } else if (patch.execNode !== undefined) {
      const trimmed = normalizeOptionalString(patch.execNode) ?? "";
      if (!trimmed) {
        return "invalid execNode: empty";
      }
      if (trimmed !== next.execNode) {
        // A cwd belongs to one node's filesystem; never carry it across node bindings.
        delete next.execCwd;
      }
      next.execNode = trimmed;
    }
  }
  if (patch.permissionMode === null) {
    delete next.permissionMode;
  } else if (patch.permissionMode !== undefined) {
    next.permissionMode = patch.permissionMode;
  }
  return undefined;
}
