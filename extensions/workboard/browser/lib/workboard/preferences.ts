/**
 * Persisted UI preferences for the Workboard plugin.
 *
 * Scoped to the small set of choices a user would reasonably expect to
 * survive leaving the page and coming back: layout (board vs list),
 * density (comfortable vs compact), and how empty columns are handled.
 *
 * Storage is deliberately client-side via localStorage. Cross-device sync
 * would mean swapping this module for a server-backed preference store;
 * nothing else in the plugin needs to know where the values live.
 */

export type WorkboardViewMode = "board" | "list";
export type WorkboardLayoutDensity = "comfortable" | "compact";
export type WorkboardEmptyColumnMode = "show" | "collapse" | "hide";

export interface WorkboardUiPreferences {
  viewMode: WorkboardViewMode;
  layout: WorkboardLayoutDensity;
  emptyColumnMode: WorkboardEmptyColumnMode;
}

const STORAGE_KEY = "openclaw:workboard:prefs:v1";

function freshDefaults(): WorkboardUiPreferences {
  return {
    viewMode: "board",
    layout: "comfortable",
    emptyColumnMode: "show",
  };
}

function isWorkboardUiPreferences(value: unknown): value is WorkboardUiPreferences {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const viewMode = Reflect.get(value, "viewMode");
  const layout = Reflect.get(value, "layout");
  const emptyColumnMode = Reflect.get(value, "emptyColumnMode");
  return (
    (viewMode === "board" || viewMode === "list") &&
    (layout === "comfortable" || layout === "compact") &&
    (emptyColumnMode === "show" || emptyColumnMode === "collapse" || emptyColumnMode === "hide")
  );
}

export function loadWorkboardPreferences(): WorkboardUiPreferences {
  try {
    const raw = globalThis.localStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      return freshDefaults();
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isWorkboardUiPreferences(parsed)) {
      return freshDefaults();
    }
    return {
      viewMode: parsed.viewMode,
      layout: parsed.layout,
      emptyColumnMode: parsed.emptyColumnMode,
    };
  } catch {
    return freshDefaults();
  }
}

export function saveWorkboardPreferences(prefs: WorkboardUiPreferences): void {
  try {
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage may be unavailable (private mode, quota exceeded, etc.).
    // The in-memory state stays authoritative for the session.
  }
}

export function extractWorkboardPreferences(state: {
  viewMode: WorkboardViewMode;
  layout: WorkboardLayoutDensity;
  emptyColumnMode: WorkboardEmptyColumnMode;
}): WorkboardUiPreferences {
  return {
    viewMode: state.viewMode,
    layout: state.layout,
    emptyColumnMode: state.emptyColumnMode,
  };
}
