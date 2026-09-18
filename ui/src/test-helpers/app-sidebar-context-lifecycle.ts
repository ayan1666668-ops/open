import { afterEach, beforeEach, vi } from "vitest";
import { createAgentSelectionCapability } from "../app/agent-selection.ts";
import { createApplicationTheme } from "../app/bootstrap-theme.ts";
import { createConnectionBootstrapCoordinator } from "../app/connection-bootstrap.ts";
import type { ApplicationGateway } from "../app/context.ts";
import { loadSettings, patchSettings } from "../app/settings.ts";
import type { AppSidebarSessionNavigationElement } from "../components/app-sidebar-session-navigation.ts";
import { settleLitElements } from "./lit-settle.ts";
import { createStorageMock } from "./storage.ts";

const cleanups = new Set<() => void>();

export function createSidebarContextLifecycle(
  gateway: ApplicationGateway,
  agents: Parameters<typeof createAgentSelectionCapability>[1],
  selectedAgentId: string,
) {
  const connectionBootstrap = createConnectionBootstrapCoordinator();
  const synchronizeBootstrap = (snapshot: ApplicationGateway["snapshot"]) =>
    connectionBootstrap.synchronize({
      client: snapshot.client,
      connected: snapshot.phase === "connected",
    });
  synchronizeBootstrap(gateway.snapshot);
  const stopBootstrap = gateway.subscribe(synchronizeBootstrap);
  const theme = createApplicationTheme(loadSettings(gateway.connection.gatewayUrl), gateway);
  const agentSelection = createAgentSelectionCapability(
    gateway,
    agents,
    { load: () => selectedAgentId, save: () => undefined },
    {
      get settings() {
        return theme.settings;
      },
      subscribe: theme.subscribe,
      patch: patchSettings,
    },
  );
  cleanups.add(() => {
    stopBootstrap();
    connectionBootstrap.reset();
    agentSelection.dispose();
    theme.dispose();
  });
  return { theme, agentSelection, connectionBootstrap };
}

export function disposeSidebarContextLifecycles() {
  for (const cleanup of cleanups) {
    cleanup();
  }
  cleanups.clear();
}

export function setupSidebarTest() {
  let originalLocalStorage: PropertyDescriptor | undefined;
  let originalScrollIntoView: PropertyDescriptor | undefined;
  let stubbedScrollIntoView = false;

  beforeEach(() => {
    // jsdom has no layout scrolling; browser tests retain the native implementation.
    stubbedScrollIntoView = typeof Element.prototype.scrollIntoView !== "function";
    if (stubbedScrollIntoView) {
      originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
      Object.defineProperty(Element.prototype, "scrollIntoView", {
        configurable: true,
        value: vi.fn(),
      });
    }
    originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: createStorageMock(),
    });
    // Coding defaults to compact; most cases assert expanded contents, so start
    // expanded. Collapse tests override this value.
    localStorage.setItem("openclaw:sidebar:sessions:collapsed-sections", JSON.stringify([]));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await vi.dynamicImportSettled();
    // Removing a prompt's DOM does not settle its promise or release its reentrancy guard.
    for (const modal of document.body.querySelectorAll("openclaw-modal-dialog")) {
      modal.dispatchEvent(new CustomEvent("modal-cancel", { cancelable: true }));
    }
    await vi.dynamicImportSettled();
    const sidebars =
      document.body.querySelectorAll<AppSidebarSessionNavigationElement>("openclaw-app-sidebar");
    document.body.replaceChildren();
    disposeSidebarContextLifecycles();
    // Disconnection queues Lit updates; finish them before retiring the DOM globals.
    await settleLitElements(sidebars);
    if (stubbedScrollIntoView) {
      if (originalScrollIntoView) {
        Object.defineProperty(Element.prototype, "scrollIntoView", originalScrollIntoView);
      } else {
        Reflect.deleteProperty(Element.prototype, "scrollIntoView");
      }
    }
    if (originalLocalStorage) {
      Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
    } else {
      Reflect.deleteProperty(globalThis, "localStorage");
    }
  });
}
