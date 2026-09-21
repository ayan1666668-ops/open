import { afterEach, beforeEach, vi } from "vitest";
import { installDomComponents } from "./dom-host.ts";
import { workboardTestHost } from "./host.setup.ts";

// UI tests run with isolate: false, so a previous file can leave this key behind.
function removePersistedWorkboardPreferences(): void {
  try {
    globalThis.localStorage.removeItem("openclaw:workboard:prefs:v1");
  } catch {
    // localStorage may be missing or refuse access in this runner.
  }
}

const hasNativeHidePopover = typeof HTMLElement.prototype.hidePopover === "function";
beforeEach(() => {
  removePersistedWorkboardPreferences();
  // The unit DOM has no top layer. Browser coverage owns native dismissal behavior.
  if (!hasNativeHidePopover) {
    Object.defineProperty(HTMLElement.prototype, "hidePopover", {
      configurable: true,
      value: vi.fn(),
    });
  }
  installDomComponents(workboardTestHost().host);
});

afterEach(() => {
  removePersistedWorkboardPreferences();
  document.body.replaceChildren();
  if (!hasNativeHidePopover) {
    Reflect.deleteProperty(HTMLElement.prototype, "hidePopover");
  }
});
