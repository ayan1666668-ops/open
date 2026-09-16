import type { ModelExecutionSelection } from "../model-picker/execution-selection.js";
import type { LiveSessionModelSelection } from "./live-model-switch.js";

/** Carries an accepted selection to the next safe live restart boundary. */
export class LiveSessionModelSwitchError extends Error {
  selection: ModelExecutionSelection;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";

  constructor(selection: LiveSessionModelSelection) {
    super("Live session model switch requested");
    this.name = "LiveSessionModelSwitchError";
    this.selection = selection.selection;
    this.authProfileId = selection.authProfileId;
    this.authProfileIdSource = selection.authProfileIdSource;
  }
}
