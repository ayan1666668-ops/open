import { loadSettings, patchSettings } from "../../../app/settings.ts";
import { t } from "../../../i18n/index.ts";
import { adjustTextareaHeight } from "./chat-composer-dom.ts";
import {
  clampComposerColumnMaxPx,
  clampComposerHeightPx,
  COMPOSER_COLUMN_MIN_PX,
  COMPOSER_HEIGHT_MIN_PX,
  COMPOSER_HEIGHT_STORAGE_KEY,
  COMPOSER_WIDTH_DRAG_COMMIT_THRESHOLD_PX,
  parseStoredPixels,
  shouldCommitWidthDrag,
} from "./chat-composer-resize-geometry.ts";

// Drag handles on the composer input: a top grip grows the editor past its
// six-line CSS cap (persisted in localStorage), a hover-revealed left grip
// widens the whole chat column through the existing Message width setting
// (Settings → Appearance → Chat → Message width, `chatMessageMaxWidth`).
// The grip never owns stored width: drags use --chat-thread-drag-width
// so host renders cannot overwrite the preview. Commits call
// patchSettings so the Settings page stays the single owner. Double-click
// either grip to return it to the default.

const TOP_HANDLE_CLASS = "agent-chat__composer-resize-top";
const SIDE_HANDLE_CLASS = "agent-chat__composer-resize-side";
const DRAGGING_CLASS = "agent-chat__composer-resizing";

/** Width commit as a Message width setting value (`"900px"`), or undefined
    on double-click reset. Hosts forward it to settings; the chat host uses
    applySettings so its snapshot refreshes with it. */
export type ComposerWidthCommit = (value: string | undefined) => void;

type ComposerResizeOptions = {
  heightEnabled?: boolean;
  // Host commit for width drags. The chat host persists through settings,
  // refreshes its snapshot, and invalidates so the view's styleMap takes
  // over; hosts without one (new-session page) use the default, which
  // persists through settings with no live view to refresh.
  onWidthCommit?: ComposerWidthCommit;
};

type ComposerResizeState = {
  topHandle: HTMLElement;
  sideHandle: HTMLElement;
  abort: AbortController;
  onWidthCommit: ComposerWidthCommit;
  syncValues: () => void;
  cancelDrag: (() => void) | null;
};

const composerResizeStates = new WeakMap<HTMLElement, ComposerResizeState>();

function defaultWidthCommit(value: string | undefined): void {
  patchSettings({ chatMessageMaxWidth: value });
}

type HeightPreference = number | "grow" | null;

function readStoredHeightPx(): HeightPreference {
  try {
    const stored = window.localStorage.getItem(COMPOSER_HEIGHT_STORAGE_KEY);
    return stored === "grow" ? "grow" : parseStoredPixels(stored);
  } catch {
    return null;
  }
}

function writeStoredHeightPx(px: HeightPreference): void {
  try {
    if (px === null) {
      window.localStorage.removeItem(COMPOSER_HEIGHT_STORAGE_KEY);
    } else {
      window.localStorage.setItem(COMPOSER_HEIGHT_STORAGE_KEY, String(px));
    }
  } catch {
    // Private mode or denied storage: the drag still applies for this session.
  }
}

function findTextarea(input: HTMLElement): HTMLTextAreaElement | null {
  return input.querySelector<HTMLTextAreaElement>(".agent-chat__composer-combobox > textarea");
}

function findColumnRoot(input: HTMLElement): HTMLElement {
  // --chat-thread-max-width caps both the transcript (.chat-thread-inner) and
  // the composer shell, so one token widens the whole centered column. The
  // chat view renders the saved token through styleMap; the grip uses a
  // separate temporary token mid-drag. Fall back to the shell, then the input.
  return (
    input.closest<HTMLElement>(".card.chat") ??
    input.closest<HTMLElement>(".chat") ??
    input.closest<HTMLElement>(".agent-chat__composer-shell") ??
    input
  );
}

function currentColumnMaxPx(input: HTMLElement): number {
  // Always measure the rendered shell: the token stays author-unit in
  // computed style (so "48rem" never parses as px), and a stored pixel
  // token can exceed the visible composer when the pane is narrower than
  // the cap. The shell already reflects min(available, token), so drags
  // respond from the first pixel in both directions. The first drag from
  // a non-px value commits it as px; reset returns to default.
  const shell = input.closest<HTMLElement>(".agent-chat__composer-shell") ?? input;
  return Math.max(Math.round(shell.getBoundingClientRect().width), COMPOSER_COLUMN_MIN_PX);
}

function applyColumnPreview(root: HTMLElement, value: string | null): void {
  if (value === null) {
    root.style.removeProperty("--chat-thread-max-width");
  } else {
    root.style.setProperty("--chat-thread-max-width", value);
  }
}

function minimumTextareaHeight(textarea: HTMLTextAreaElement): number {
  const style = getComputedStyle(textarea);
  return Math.ceil(
    Number.parseFloat(style.lineHeight) +
      Number.parseFloat(style.paddingTop) +
      Number.parseFloat(style.paddingBottom),
  );
}

// Available editor height inside the visible chat pane. Every height mode
// renders through this ceiling; the remembered preference is never rewritten.
function paneHeightLimit(textarea: HTMLTextAreaElement): number {
  const viewport = window.visualViewport;
  const viewportTop = viewport?.offsetTop ?? 0;
  const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight);
  const input = textarea.closest<HTMLElement>(".agent-chat__input");
  const chat = textarea.closest<HTMLElement>(".chat");
  const thread = chat?.querySelector<HTMLElement>(".chat-thread") ?? chat;
  const minimum = minimumTextareaHeight(textarea);
  const ratioLimit = clampComposerHeightPx(Infinity, viewportBottom - viewportTop, minimum);
  if (!input || !thread) {
    return ratioLimit;
  }
  // The transcript starts below the page header. Reserve all non-editor
  // composer chrome and the grip's hit area; never budget from editor top,
  // which moves upward as the bottom-anchored composer grows.
  const box = input.getBoundingClientRect();
  const chrome = box.height - textarea.getBoundingClientRect().height;
  const threadStyle = getComputedStyle(thread);
  const threadInsets =
    Number.parseFloat(threadStyle.paddingTop) + Number.parseFloat(threadStyle.paddingBottom);
  const available =
    Math.min(chat?.getBoundingClientRect().bottom ?? box.bottom, viewportBottom) -
    14 -
    Math.max(viewportTop, thread.getBoundingClientRect().top) -
    chrome -
    threadInsets -
    12;
  return Math.max(minimum, Math.min(ratioLimit, Math.floor(available)));
}

function applyHeightOverride(textarea: HTMLTextAreaElement, px: HeightPreference): void {
  if (px === null) {
    textarea.style.maxHeight = "";
  } else if (px === "grow") {
    textarea.style.maxHeight = `${paneHeightLimit(textarea)}px`;
  } else {
    textarea.style.maxHeight = `${Math.min(
      clampComposerHeightPx(px, window.innerHeight, minimumTextareaHeight(textarea)),
      paneHeightLimit(textarea),
    )}px`;
  }
  const scrollTop = textarea.scrollTop;
  adjustTextareaHeight(textarea);
  textarea.scrollTop = scrollTop;
}

function hasSevenDraftLines(textarea: HTMLTextAreaElement): boolean {
  const style = getComputedStyle(textarea);
  const probe = textarea.cloneNode() as HTMLTextAreaElement;
  probe.removeAttribute("id");
  probe.removeAttribute("name");
  probe.tabIndex = -1;
  probe.setAttribute("aria-hidden", "true");
  for (const property of [
    "font",
    "line-height",
    "letter-spacing",
    "padding",
    "box-sizing",
    "white-space",
    "word-break",
    "overflow-wrap",
    "tab-size",
  ]) {
    probe.style.setProperty(property, style.getPropertyValue(property));
  }
  Object.assign(probe.style, {
    position: "fixed",
    visibility: "hidden",
    pointerEvents: "none",
    width: `${textarea.getBoundingClientRect().width}px`,
    height: "0px",
    minHeight: "0px",
    maxHeight: "none",
    overflow: "hidden",
  });
  probe.value = textarea.value;
  document.body.append(probe);
  const height = probe.scrollHeight;
  probe.remove();
  return (
    height >=
    Number.parseFloat(style.lineHeight) * 7 +
      Number.parseFloat(style.paddingTop) +
      Number.parseFloat(style.paddingBottom) -
      1
  );
}

function currentTextareaMaxPx(textarea: HTMLTextAreaElement): number {
  const computed = getComputedStyle(textarea).maxHeight.trim();
  const match = /^(\d+(?:\.\d+)?)px$/u.exec(computed);
  if (match) {
    return Number(match[1]);
  }
  return textarea.scrollHeight || COMPOSER_HEIGHT_MIN_PX;
}

function startDrag(
  handle: HTMLElement,
  event: PointerEvent,
  onMove: (dx: number, dy: number) => void,
  onEnd: (cancelled: boolean) => void,
): void {
  const input = handle.closest<HTMLElement>(".agent-chat__input");
  const state = input ? composerResizeStates.get(input) : undefined;
  if (!state || state.cancelDrag) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  const pointerId = event.pointerId;
  const startX = event.clientX;
  const startY = event.clientY;
  handle.setPointerCapture(event.pointerId);
  input?.classList.add(DRAGGING_CLASS);
  handle.classList.add("is-dragging");
  const move = (moveEvent: PointerEvent) => {
    if (moveEvent.pointerId === pointerId) {
      onMove(moveEvent.clientX - startX, moveEvent.clientY - startY);
    }
  };
  const finish = (cancelled: boolean) => {
    state.cancelDrag = null;
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", up);
    handle.removeEventListener("pointercancel", cancel);
    handle.removeEventListener("lostpointercapture", cancel);
    if (handle.hasPointerCapture(pointerId)) {
      handle.releasePointerCapture(pointerId);
    }
    input?.classList.remove(DRAGGING_CLASS);
    handle.classList.remove("is-dragging");
    onEnd(cancelled);
  };
  const up = (upEvent: PointerEvent) => {
    if (upEvent.pointerId === pointerId) {
      finish(false);
    }
  };
  const cancel = (cancelEvent: PointerEvent) => {
    if (cancelEvent.pointerId === pointerId) {
      finish(true);
    }
  };
  state.cancelDrag = () => finish(true);
  handle.addEventListener("lostpointercapture", cancel);
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", up);
  handle.addEventListener("pointercancel", cancel);
}

function makeHandle(className: string, orientation: "horizontal" | "vertical"): HTMLElement {
  const handle = document.createElement("div");
  handle.className = className;
  handle.tabIndex = 0;
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", orientation);
  handle.dataset.composerResizeHandle = className;
  return handle;
}

function labelHandles(state: ComposerResizeState): void {
  const heightLabel = t("chat.composer.resizeInputHeight");
  const widthLabel = t("chat.composer.resizeInputWidth");
  for (const [handle, label] of [
    [state.topHandle, heightLabel],
    [state.sideHandle, widthLabel],
  ] as const) {
    handle.setAttribute("aria-label", label);
  }
}

function disconnectComposerResize(input: HTMLElement): void {
  const state = composerResizeStates.get(input);
  composerResizeStates.delete(input);
  if (!state) {
    return;
  }
  state.cancelDrag?.();
  state.abort.abort();
  state.topHandle.remove();
  state.sideHandle.remove();
}

export function observeComposerResize(input: HTMLElement, options?: ComposerResizeOptions): void {
  const heightEnabled = options?.heightEnabled !== false;
  const onWidthCommit = options?.onWidthCommit ?? defaultWidthCommit;
  const existing = composerResizeStates.get(input);
  if (existing) {
    // Host callbacks close over live state; keep the newest one.
    existing.onWidthCommit = onWidthCommit;
    labelHandles(existing);
    existing.syncValues();
    return;
  }
  const topHandle = makeHandle(TOP_HANDLE_CLASS, "horizontal");
  const sideHandle = makeHandle(SIDE_HANDLE_CLASS, "vertical");
  const abort = new AbortController();
  let preferredHeight = heightEnabled ? readStoredHeightPx() : null;
  const rememberHeight = (px: HeightPreference) => {
    preferredHeight = px;
    writeStoredHeightPx(px);
  };
  // Geometry can change without any window event: a stacked-split divider
  // resizes the containing pane, a side panel opens, the input itself grows.
  // The ceiling derives from the pane, so the pane must be observed — but the
  // input ref runs before its ancestors attach, so the pane cannot be found
  // at construction. Resolve it on the first sync after connection.
  let observer: ResizeObserver | null = null;
  let observedPane: HTMLElement | null = null;
  const observePaneOnceConnected = () => {
    if (observedPane || !observer || !input.isConnected) {
      return;
    }
    const pane = input.closest<HTMLElement>(".chat");
    if (pane && pane !== input) {
      observedPane = pane;
      observer.observe(pane);
    }
  };
  const syncValues = () => {
    observePaneOnceConnected();
    const textarea = findTextarea(input);
    topHandle.hidden =
      !heightEnabled ||
      !textarea ||
      Boolean(textarea.closest('[data-composer-layout="single-line"]'));
    topHandle.classList.toggle(
      "is-persistent",
      preferredHeight !== null || Boolean(textarea && hasSevenDraftLines(textarea)),
    );
    if (textarea && preferredHeight !== null && !topHandle.classList.contains("is-dragging")) {
      // Pane geometry can change without a window resize (split dividers,
      // side panels): re-render the remembered preference through the live
      // ceiling, leaving the stored value untouched.
      applyHeightOverride(textarea, preferredHeight);
    }
    topHandle.classList.toggle(
      "is-fixed-height",
      preferredHeight !== "grow" ||
        Boolean(
          textarea && textarea.getBoundingClientRect().height >= paneHeightLimit(textarea) - 1,
        ),
    );
    // Renders must not read storage: the host already paints the owned width
    // onto the column root as an inline token, so the DOM is the source here.
    sideHandle.classList.toggle(
      "is-custom-width",
      Boolean(findColumnRoot(input).style.getPropertyValue("--chat-thread-max-width")),
    );
    for (const [handle, value, min, max] of [
      [
        topHandle,
        textarea ? currentTextareaMaxPx(textarea) : COMPOSER_HEIGHT_MIN_PX,
        textarea ? minimumTextareaHeight(textarea) : COMPOSER_HEIGHT_MIN_PX,
        clampComposerHeightPx(Infinity, window.innerHeight),
      ],
      [
        sideHandle,
        currentColumnMaxPx(input),
        COMPOSER_COLUMN_MIN_PX,
        clampComposerColumnMaxPx(Infinity, window.innerWidth),
      ],
    ] as const) {
      handle.setAttribute("aria-valuenow", String(value));
      handle.setAttribute("aria-valuemin", String(Math.min(min, value)));
      handle.setAttribute("aria-valuemax", String(Math.max(max, value)));
    }
  };
  const state: ComposerResizeState = {
    topHandle,
    sideHandle,
    abort,
    onWidthCommit,
    syncValues,
    cancelDrag: null,
  };
  labelHandles(state);

  topHandle.addEventListener(
    "pointerdown",
    (event) => {
      if (event.button !== 0) {
        return;
      }
      const textarea = findTextarea(input);
      if (!textarea) {
        return;
      }
      if (textarea.closest('[data-composer-layout="single-line"]')) {
        return;
      }
      const startMax = textarea.getBoundingClientRect().height;
      let dy = 0;
      startDrag(
        topHandle,
        event,
        (_dx, delta) => {
          dy = delta;
          applyHeightOverride(textarea, startMax - delta);
          syncValues();
        },
        (cancelled) => {
          if (cancelled || Math.abs(dy) < COMPOSER_WIDTH_DRAG_COMMIT_THRESHOLD_PX) {
            applyHeightOverride(textarea, preferredHeight);
          } else {
            const preference = dy < 0 ? "grow" : currentTextareaMaxPx(textarea);
            rememberHeight(preference);
            applyHeightOverride(textarea, preference);
          }
          syncValues();
        },
      );
    },
    { signal: abort.signal },
  );
  topHandle.addEventListener(
    "dblclick",
    (event) => {
      event.preventDefault();
      event.stopPropagation();
      rememberHeight(null);
      const textarea = findTextarea(input);
      if (textarea) {
        applyHeightOverride(textarea, null);
      }
      syncValues();
    },
    { signal: abort.signal },
  );

  sideHandle.addEventListener(
    "pointerdown",
    (event) => {
      if (event.button !== 0) {
        return;
      }
      const root = findColumnRoot(input);
      // The column is centered: each edge moves half the width delta.
      // Match the left edge to the pointer, not half its travel.
      const startMax = currentColumnMaxPx(input);
      let committed = `${startMax}px`;
      let maxAbsDx = 0;
      let lastDx = 0;
      startDrag(
        sideHandle,
        event,
        (dx) => {
          lastDx = dx;
          maxAbsDx = Math.max(maxAbsDx, Math.abs(dx));
          if (maxAbsDx < COMPOSER_WIDTH_DRAG_COMMIT_THRESHOLD_PX) {
            return;
          }
          committed = `${clampComposerColumnMaxPx(startMax - 2 * dx, window.innerWidth)}px`;
          root.style.setProperty("--chat-thread-drag-width", committed);
          // Reflow the draft in this event, before painting the new column width.
          // Deferring this to ResizeObserver's next frame paints stale height.
          const textarea = findTextarea(input);
          if (textarea) {
            const scrollTop = textarea.scrollTop;
            adjustTextareaHeight(textarea);
            textarea.scrollTop = scrollTop;
          }
          syncValues();
        },
        (cancelled) => {
          root.style.removeProperty("--chat-thread-drag-width");
          if (!shouldCommitWidthDrag(cancelled, maxAbsDx, Math.abs(lastDx))) {
            // Clicks, jitter, cancellations, and out-and-back drags never
            // owned the setting. Restore the stored preference instead of
            // clearing blindly: the host renders it as inline style on
            // this same element, so a bare remove would drop to the CSS
            // default until the host's next render.
            const owned = loadSettings().chatMessageMaxWidth;
            applyColumnPreview(root, owned ?? null);
            syncValues();
            return;
          }
          // Preview already shows the committed value, so the host's
          // styleMap render lands with no visible jump.
          applyColumnPreview(root, committed);
          composerResizeStates.get(input)?.onWidthCommit(committed);
          syncValues();
        },
      );
    },
    { signal: abort.signal },
  );
  sideHandle.addEventListener(
    "dblclick",
    (event) => {
      event.preventDefault();
      event.stopPropagation();
      // Removing the preview IS the reset visual; the host clears the
      // setting so its next render omits the token (default width).
      sideHandle.dataset.resetHidden = "true";
      applyColumnPreview(findColumnRoot(input), null);
      composerResizeStates.get(input)?.onWidthCommit(undefined);
      syncValues();
    },
    { signal: abort.signal },
  );

  for (const [handle, grow, shrink] of [
    [topHandle, "ArrowUp", "ArrowDown"],
    [sideHandle, "ArrowLeft", "ArrowRight"],
  ] as const) {
    handle.addEventListener("focus", syncValues, { signal: abort.signal });
    handle.addEventListener(
      "keydown",
      (event) => {
        if (
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          ![grow, shrink, "Home", "End", "Enter"].includes(event.key)
        ) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Enter") {
          handle.dispatchEvent(new MouseEvent("dblclick"));
          return;
        }
        const textarea = findTextarea(input);
        const height = handle === topHandle;
        const current =
          height && textarea ? currentTextareaMaxPx(textarea) : currentColumnMaxPx(input);
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? Infinity
              : current + (event.key === grow ? 16 : -16);
        if (height && textarea) {
          const px = clampComposerHeightPx(
            next,
            window.innerHeight,
            minimumTextareaHeight(textarea),
          );
          applyHeightOverride(textarea, px);
          rememberHeight(px);
        } else if (!height) {
          const value = `${clampComposerColumnMaxPx(next, window.innerWidth)}px`;
          applyColumnPreview(findColumnRoot(input), value);
          state.onWidthCommit(value);
        }
        syncValues();
      },
      { signal: abort.signal },
    );
  }
  observer = typeof ResizeObserver === "function" ? new ResizeObserver(syncValues) : null;
  observer?.observe(input);
  abort.signal.addEventListener("abort", () => observer?.disconnect(), { once: true });
  window.addEventListener(
    "resize",
    () => {
      // The viewport constrains the display, not the remembered user choice.
      const textarea = findTextarea(input);
      if (textarea && preferredHeight !== null) {
        applyHeightOverride(textarea, preferredHeight);
      }
      syncValues();
    },
    { signal: abort.signal },
  );

  window.visualViewport?.addEventListener("resize", syncValues, { signal: abort.signal });
  input.addEventListener("input", syncValues, { signal: abort.signal });
  if (heightEnabled) {
    input.prepend(topHandle);
  }
  sideHandle.addEventListener(
    "pointerleave",
    () => {
      delete sideHandle.dataset.resetHidden;
    },
    { signal: abort.signal },
  );
  input.prepend(sideHandle);

  // Hosts render the width setting on their column/shell. Input refs run
  // before ancestors attach, so mount-time restoration cannot find its owner.
  const textarea = findTextarea(input);
  if (textarea) {
    const stored = readStoredHeightPx();
    if (heightEnabled && stored !== null) {
      applyHeightOverride(textarea, stored);
    }
  }

  composerResizeStates.set(input, state);
}

export function rebindComposerResizeInput(
  prev: HTMLElement | null,
  next: HTMLElement | null,
  options?: ComposerResizeOptions,
): void {
  if (prev !== next) {
    if (prev) {
      disconnectComposerResize(prev);
    }
    if (next) {
      observeComposerResize(next, options);
    }
    return;
  }
  if (next) {
    observeComposerResize(next, options);
  }
}

export function restoreComposerHeightOverride(textarea: HTMLTextAreaElement): void {
  // Called from each composer's textarea ref, which runs in the same commit as
  // the input ref: whichever mounts second still picks up the stored height.
  const stored = readStoredHeightPx();
  if (stored !== null) {
    applyHeightOverride(textarea, stored);
  }
}
