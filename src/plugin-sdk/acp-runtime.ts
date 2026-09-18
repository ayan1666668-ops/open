// Public ACP runtime helpers for plugins that integrate with ACP control/session state.

import type { SessionAcpMeta } from "@openclaw/acp-core/types";
import {
  testing as managerTesting,
  getAcpSessionManagerCore as getInternalAcpSessionManager,
} from "../acp/control-plane/manager.js";
import { requireAcpExecutionSelection } from "../acp/control-plane/manager.utils.js";
import { resolveRuntimeOptionsForSelection } from "../acp/control-plane/runtime-options.js";
import { resolveAcpAgentPolicyError, resolveAcpDispatchPolicyError } from "../acp/policy.js";
import { testing as registryTesting, requireAcpRuntimeBackend } from "../acp/runtime/registry.js";
import {
  readAcpSessionEntryCore as readInternalAcpSessionEntry,
  type AcpSessionStoreEntry as InternalAcpSessionStoreEntry,
} from "../acp/runtime/session-meta.js";
import type { SessionAcpLifecycle } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AcpExecutionSelection } from "../model-picker/execution-selection.js";
import { projectPluginSessionEntry, type SessionEntry } from "./session-store-runtime-internal.js";

export { AcpRuntimeError, isAcpRuntimeError } from "../acp/runtime/errors.js";
export type { AcpRuntimeErrorCode } from "../acp/runtime/errors.js";
export {
  getAcpRuntimeBackend,
  registerAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
} from "../acp/runtime/registry.js";
export { requireAcpRuntimeBackend };
export type {
  AcpRuntime,
  AcpRuntimeCapabilities,
  AcpRuntimeConfigOptionResult,
  AcpRuntimeDoctorReport,
  AcpRuntimeEnsureInput,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeStatus,
  AcpRuntimeTurn,
  AcpRuntimeTurnAttachment,
  AcpRuntimeTurnInput,
  AcpRuntimeTurnResult,
  AcpRuntimeTurnResultError,
  AcpSessionUpdateTag,
} from "@openclaw/acp-core/runtime/types";
export type AcpSessionStoreEntry = Omit<InternalAcpSessionStoreEntry, "entry" | "acp"> & {
  entry?: SessionEntry;
  acp?: SessionAcpMeta;
};

function projectAcpMeta(
  meta: SessionAcpLifecycle,
  selection: AcpExecutionSelection,
): SessionAcpMeta {
  return {
    ...meta,
    backend: selection.executor.backend,
    agent: selection.executor.agent,
    runtimeOptions: resolveRuntimeOptionsForSelection(meta, selection),
  };
}

export function readAcpSessionEntry(
  params: Parameters<typeof readInternalAcpSessionEntry>[0],
): AcpSessionStoreEntry | null {
  const stored = readInternalAcpSessionEntry(params);
  if (!stored) {
    return null;
  }
  const { entry, acp, ...location } = stored;
  return {
    ...location,
    entry: entry ? projectPluginSessionEntry(entry) : undefined,
    acp: acp ? projectAcpMeta(acp, requireAcpExecutionSelection(entry)) : undefined,
  };
}

type InternalManager = ReturnType<typeof getInternalAcpSessionManager>;
function createPublicAcpManager(manager: InternalManager) {
  return {
    resolveSession(params: Parameters<InternalManager["resolveSession"]>[0]) {
      const resolved = manager.resolveSession(params);
      return resolved.kind === "ready"
        ? {
            ...resolved,
            entry: projectPluginSessionEntry(resolved.entry),
            meta: projectAcpMeta(resolved.meta, resolved.selection),
          }
        : resolved;
    },
    async initializeSession(params: Parameters<InternalManager["initializeSession"]>[0]) {
      const initialized = await manager.initializeSession(params);
      return {
        ...initialized,
        meta: projectAcpMeta(
          initialized.meta,
          requireAcpExecutionSelection(initialized.sessionEntry),
        ),
        sessionEntry: projectPluginSessionEntry(initialized.sessionEntry),
      };
    },
    getObservabilitySnapshot: manager.getObservabilitySnapshot.bind(manager),
    reconcilePendingSessionIdentities: manager.reconcilePendingSessionIdentities.bind(manager),
    getSessionStatus: manager.getSessionStatus.bind(manager),
    setSessionRuntimeMode: manager.setSessionRuntimeMode.bind(manager),
    setSessionConfigOption: manager.setSessionConfigOption.bind(manager),
    updateSessionRuntimeOptions: manager.updateSessionRuntimeOptions.bind(manager),
    resetSessionRuntimeOptions: manager.resetSessionRuntimeOptions.bind(manager),
    runTurn: manager.runTurn.bind(manager),
    cancelSession: manager.cancelSession.bind(manager),
    closeSession: manager.closeSession.bind(manager),
  };
}

const publicManagers = new WeakMap<InternalManager, ReturnType<typeof createPublicAcpManager>>();
export function getAcpSessionManager(): ReturnType<typeof createPublicAcpManager> {
  const manager = getInternalAcpSessionManager();
  const existing = publicManagers.get(manager);
  if (existing) {
    return existing;
  }
  const facade = createPublicAcpManager(manager);
  publicManagers.set(manager, facade);
  return facade;
}
export { tryDispatchAcpReplyHook } from "./acpx.js";

export function resolveAcpSessionAvailability(params: {
  config: OpenClawConfig;
  backendId: string;
  agentId: string;
}): { available: true } | { available: false; message: string } {
  const policyError =
    resolveAcpDispatchPolicyError(params.config) ??
    resolveAcpAgentPolicyError(params.config, params.agentId);
  if (policyError) {
    return { available: false, message: policyError.message };
  }
  try {
    requireAcpRuntimeBackend(params.backendId);
    return { available: true };
  } catch (error) {
    return {
      available: false,
      message: error instanceof Error ? error.message : "ACP runtime backend is unavailable.",
    };
  }
}

// Keep test helpers off the hot init path. Eagerly merging them here can
// create a back-edge through the bundled ACP runtime chunk before the imported
// testing bindings finish initialization.
/** Lazy ACP test helper facade combining control-plane and runtime registry helpers. */
export const testing = new Proxy({} as typeof managerTesting & typeof registryTesting, {
  get(_target, prop, receiver) {
    if (Reflect.has(managerTesting, prop)) {
      return Reflect.get(managerTesting, prop, receiver);
    }
    return Reflect.get(registryTesting, prop, receiver);
  },
  has(_target, prop) {
    return Reflect.has(managerTesting, prop) || Reflect.has(registryTesting, prop);
  },
  ownKeys() {
    return Array.from(
      new Set([...Reflect.ownKeys(managerTesting), ...Reflect.ownKeys(registryTesting)]),
    );
  },
  getOwnPropertyDescriptor(_target, prop) {
    if (Reflect.has(managerTesting, prop) || Reflect.has(registryTesting, prop)) {
      return {
        configurable: true,
        enumerable: true,
      };
    }
    return undefined;
  },
});

/** @deprecated Use `testing`. */
export { testing as __testing };
