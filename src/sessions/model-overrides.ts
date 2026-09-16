// Session model override helpers normalize per-session provider model choices.
import type { SessionEntry } from "../config/sessions/types.js";
import { encodeLegacySessionModelSelection } from "../model-picker/execution-selection-codec.js";

type ModelOverrideSelection = {
  provider: string;
  model: string;
  isDefault?: boolean;
};

export const MODEL_SELECTION_LOCKED_MESSAGE = "Model selection is locked for this session.";
export const MODEL_SELECTION_LOCKED_RESET_MESSAGE =
  "This session cannot be reset while model selection is locked.";
export const MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE =
  "Model-selection-locked sessions cannot create child sessions from parent context.";

/** Raised when a caller attempts to mutate a locked session model selection. */
export class ModelSelectionLockedError extends Error {
  constructor(message = MODEL_SELECTION_LOCKED_MESSAGE) {
    super(message);
    this.name = "ModelSelectionLockedError";
  }
}

export function isModelSelectionLocked(entry: SessionEntry | undefined): boolean {
  return entry?.modelSelectionLocked === true;
}

/** A locked harness owns both model selection and transcript lineage. */
export function assertModelSelectionUnlocked(
  entry: SessionEntry,
  message = MODEL_SELECTION_LOCKED_MESSAGE,
): void {
  if (isModelSelectionLocked(entry)) {
    throw new ModelSelectionLockedError(message);
  }
}

/** @deprecated Use applySessionModelSelection; removed in the first stable release after 2026.10. */
export function applyModelOverrideToSessionEntry(params: {
  entry: SessionEntry;
  selection: ModelOverrideSelection;
  profileOverride?: string;
  profileOverrideSource?: "auto" | "user";
  preserveAuthProfileOverride?: boolean;
  selectionSource?: "auto" | "user";
  explicitDefaultSelection?: boolean;
  markLiveSwitchPending?: boolean;
}): { updated: boolean } {
  assertModelSelectionUnlocked(params.entry);
  return encodeLegacySessionModelSelection(params);
}
