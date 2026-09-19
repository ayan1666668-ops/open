import type { ApplicationGateway } from "./gateway.ts";
import { webKitHostWindow } from "./native-webkit-bridge.ts";

export type NativeGateway = {
  id: string;
  name: string;
  kind: "local" | "remote";
  isPrimary: boolean;
  canPromote: boolean;
  health: "ok" | "error" | "unknown";
};

export type NativeGatewaysSnapshot = { gateways: NativeGateway[]; currentId: string };
type NativeGatewaysWindow = Window & {
  __OPENCLAW_NATIVE_GATEWAYS__?: unknown;
  __OPENCLAW_NATIVE_GATEWAY_HEALTH__?: { gatewayUrl: string; health: NativeGateway["health"] };
};

const NATIVE_GATEWAYS_CHANGED_EVENT = "openclaw:native-gateways-changed";

export type NativeGatewaysCapability = {
  readonly snapshot: NativeGatewaysSnapshot | null;
  subscribe(listener: (snapshot: NativeGatewaysSnapshot) => void): () => void;
  select(id: string): void;
  openWindow(id: string): void;
  setPrimary(id: string): void;
  reconnect(id: string): void;
  reconnectCancel(id: string): void;
  openSettings(): void;
};

function snapshotFrom(value: unknown): NativeGatewaysSnapshot | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const snapshot = value as Partial<NativeGatewaysSnapshot>;
  // The embedder owns this payload; deep validation only defends the Mac app from itself.
  return Array.isArray(snapshot.gateways) && typeof snapshot.currentId === "string"
    ? (snapshot as NativeGatewaysSnapshot)
    : null;
}

function createNativeGatewaysCapability(): NativeGatewaysCapability | null {
  if (typeof window === "undefined") {
    return null;
  }
  const nativeWindow = window as NativeGatewaysWindow;
  const handler = webKitHostWindow()?.webkit?.messageHandlers?.openclawGateways;
  if (!handler?.postMessage) {
    return null;
  }
  const post = handler.postMessage.bind(handler);
  const postWithId = (
    type: "select" | "open-window" | "set-primary" | "reconnect" | "reconnect-cancel",
    id: string,
  ) => post({ type, id });
  let snapshot = snapshotFrom(nativeWindow["__OPENCLAW_NATIVE_GATEWAYS__"]);
  const listeners = new Set<(snapshot: NativeGatewaysSnapshot) => void>();
  const onChange = (event: Event) => {
    const next = snapshotFrom((event as CustomEvent<unknown>).detail);
    if (!next) {
      return;
    }
    snapshot = next;
    listeners.forEach((listener) => listener(next));
  };
  window.addEventListener(NATIVE_GATEWAYS_CHANGED_EVENT, onChange);
  return {
    get snapshot() {
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    select: (id) => postWithId("select", id),
    openWindow: (id) => postWithId("open-window", id),
    setPrimary: (id) => postWithId("set-primary", id),
    reconnect: (id) => postWithId("reconnect", id),
    reconnectCancel: (id) => postWithId("reconnect-cancel", id),
    openSettings: () => post({ type: "open-settings" }),
  };
}

let healthReporter: object | undefined;

export function startNativeGatewayHealthReporting(gateway: ApplicationGateway): () => void {
  // SAFETY: The native document owns these optional globals; this reporter writes the typed health value.
  const nativeWindow = window as NativeGatewaysWindow;
  const owner = {};
  healthReporter = owner;
  const publish = (health: NativeGateway["health"]) => {
    if (healthReporter !== owner) {
      return;
    }
    const gatewayUrl = gateway.connection.gatewayUrl;
    const previous = nativeWindow["__OPENCLAW_NATIVE_GATEWAY_HEALTH__"];
    if (previous?.gatewayUrl === gatewayUrl && previous.health === health) {
      return;
    }
    nativeWindow["__OPENCLAW_NATIVE_GATEWAY_HEALTH__"] = { gatewayUrl, health };
    // The Mac embedder forwards this wake-up and reads the current document.
    // Linux shares the action bridge but does not implement health reporting.
    window.dispatchEvent(new Event("openclaw:native-gateway-health-changed"));
  };
  const refresh = () => {
    const { phase, lastError } = gateway.snapshot;
    publish(phase === "connected" ? "ok" : phase !== "stopped" && lastError ? "error" : "unknown");
  };
  const unsubscribe = gateway.subscribe(refresh);
  refresh();
  return () => {
    unsubscribe();
    if (healthReporter === owner) {
      publish("unknown");
      healthReporter = undefined;
    }
  };
}

let singleton: NativeGatewaysCapability | null | undefined;

// Loaded by native chat features and sidebar menus, outside the startup bundle.
export function nativeGatewaysCapability(): NativeGatewaysCapability | null {
  if (singleton === undefined) {
    singleton = createNativeGatewaysCapability();
  }
  return singleton;
}
