import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { areRuntimeModelRefsEquivalent } from "../agents/model-runtime-aliases.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export type FallbackNoticeState = Pick<SessionEntry, "fallbackNotice">;

/** Notice providers are case-insensitive; provider-local model ids are not. */
export function matchesFallbackNoticeModelRef(
  notice: string | undefined,
  modelRef: string,
): boolean {
  const stored = normalizeOptionalString(notice);
  if (!stored) {
    return false;
  }
  if (stored === modelRef) {
    return true;
  }
  const selected = parseModelCatalogRef(modelRef);
  const recorded = parseModelCatalogRef(stored);
  return (
    selected !== null &&
    recorded !== null &&
    selected.provider === recorded.provider &&
    selected.modelId === recorded.modelId
  );
}

export function resolveActiveFallbackState(params: {
  selectedModelRef: string;
  activeModelRef: string;
  config?: OpenClawConfig;
  state?: FallbackNoticeState;
}): { active: boolean; reason?: string } {
  const notice = params.state?.fallbackNotice;
  const reason = normalizeOptionalString(notice?.reason);
  // Reject stale notices before runtime alias resolution can discover plugins.
  const fallbackActive =
    matchesFallbackNoticeModelRef(notice?.selectedModel, params.selectedModelRef) &&
    matchesFallbackNoticeModelRef(notice?.activeModel, params.activeModelRef) &&
    !areRuntimeModelRefsEquivalent(params.selectedModelRef, params.activeModelRef, {
      config: params.config,
    });
  return {
    active: fallbackActive,
    reason: fallbackActive ? reason : undefined,
  };
}
