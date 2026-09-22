/**
 * Durable tab cleanup owns claims, fingerprint verification, close, and retirement.
 * A concurrent touch or competing sweep cannot delete another generation's row.
 */
import { randomUUID } from "node:crypto";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { CloseTrackedCdpTargetResult } from "./cdp.helpers.js";
import type { ResolvedBrowserConfig } from "./config.js";
import { BROWSER_TAB_UNREACHABLE_RETIRE_MS } from "./constants.js";
import type { BrowserSessionTabRoute } from "./session-tab-route.js";
import {
  type BrowserSessionTabRecord,
  deleteBrowserSessionTabIf,
  getBrowserSessionTabStore,
  parseBrowserSessionTabRecord,
  sameBrowserSessionTabRecord,
  updateBrowserSessionTab,
} from "./session-tab-store.js";

const log = createSubsystemLogger("browser").child("service").child("session-tabs");

type DurableTab = BrowserSessionTabRecord & {
  kind: "durable";
  storageKey: string;
};

export type CleanupKind = "lifecycle" | "sweep";

type DurableCleanupResult =
  | CloseTrackedCdpTargetResult
  | { status: "unavailable"; reason: "extension-relay-unavailable" };
type CloseTab = (tab: {
  targetId: string;
  nativeTargetId?: string;
  baseUrl?: string;
  route?: BrowserSessionTabRoute;
  profile?: string;
}) => Promise<void>;
export type CloseParams = {
  closeTab?: CloseTab;
  closeDurableTab?: (
    tab: DurableTab,
    options: { shouldClose: () => boolean },
  ) => Promise<CloseTrackedCdpTargetResult>;
  getResolvedBrowserConfig?: () =>
    | ResolvedBrowserConfig
    | null
    | Promise<ResolvedBrowserConfig | null>;
  onWarn?: (message: string) => void;
  onDebug?: (message: string) => void;
};

/**
 * The deferral a tracked tab row already reported. A stopped managed browser can
 * defer cleanup for the whole 24h retire window while the sweep ticks every few
 * minutes, so the same unreachable state must warn once per row rather than once
 * per sweep. Row identity is part of the key so a retracked or re-owned tab can
 * report again. Owned by `globalThis` because the Browser plugin can run from
 * more than one bundle instance inside the same Gateway process.
 */
type DeferredTabDiagnostic = {
  reason: string;
  trackedAt: number;
  profileFingerprint: string;
  browserInstanceFingerprint: string;
};

const deferredTabDiagnosticsSymbol = Symbol.for(
  "openclaw.browser.session-tabs.deferred-diagnostics",
);

/** Defensive bound: live deferrals are already forgotten as their rows settle. */
const MAX_DEFERRED_TAB_DIAGNOSTICS = 512;

function deferredTabDiagnostics(): Map<string, DeferredTabDiagnostic> {
  // SAFETY: symbol-keyed extension only adds our own process-local map; the Browser plugin can run from multiple bundle instances sharing globalThis.
  const state = globalThis as typeof globalThis & {
    [deferredTabDiagnosticsSymbol]?: Map<string, DeferredTabDiagnostic>;
  };
  state[deferredTabDiagnosticsSymbol] ??= new Map();
  return state[deferredTabDiagnosticsSymbol];
}

function sameDeferredTabRow(previous: DeferredTabDiagnostic, tab: DurableTab): boolean {
  return (
    previous.trackedAt === tab.trackedAt &&
    previous.profileFingerprint === tab.profileFingerprint &&
    previous.browserInstanceFingerprint === tab.browserInstanceFingerprint
  );
}

/** Records a deferral, returning true when the row has not reported it yet. */
function recordDeferredTabDiagnostic(tab: DurableTab, reason: string): boolean {
  const diagnostics = deferredTabDiagnostics();
  const previous = diagnostics.get(tab.storageKey);
  if (previous?.reason === reason && sameDeferredTabRow(previous, tab)) {
    return false;
  }
  // Re-insert so the least recently reported deferral is evicted first.
  diagnostics.delete(tab.storageKey);
  diagnostics.set(tab.storageKey, {
    reason,
    trackedAt: tab.trackedAt,
    profileFingerprint: tab.profileFingerprint,
    browserInstanceFingerprint: tab.browserInstanceFingerprint,
  });
  if (diagnostics.size > MAX_DEFERRED_TAB_DIAGNOSTICS) {
    const oldest = diagnostics.keys().next();
    if (!oldest.done) {
      diagnostics.delete(oldest.value);
    }
  }
  return true;
}

/** Lets a settled row report the next outage instead of staying muted forever. */
function forgetDeferredTabDiagnostic(tab: DurableTab): void {
  const diagnostics = deferredTabDiagnostics();
  const previous = diagnostics.get(tab.storageKey);
  if (previous && sameDeferredTabRow(previous, tab)) {
    diagnostics.delete(tab.storageKey);
  }
}

/**
 * Reports a tab whose cleanup could not complete yet. The first deferral of a row
 * warns; later identical deferrals stay observable at debug level so a stopped
 * browser cannot flood the warning stream for the full retire window.
 */
function reportDeferredTab(params: CloseParams, tab: DurableTab, reason: string): void {
  const message = `deferred tracked browser tab ${tab.nativeTargetId}: ${reason}`;
  if (recordDeferredTabDiagnostic(tab, reason)) {
    params.onWarn?.(message);
    return;
  }
  if (params.onDebug) {
    params.onDebug(message);
    return;
  }
  log.debug(message);
}

export function isIgnorableTabCloseError(error: unknown): boolean {
  const message = normalizeLowercaseStringOrEmpty(String(error));
  return (
    message.includes("tab not found") ||
    message.includes("target closed") ||
    message.includes("target not found") ||
    message.includes("no such target") ||
    message.includes("no target with given id found")
  );
}

function claimCleanup(tab: DurableTab, now: number, kind: CleanupKind): DurableTab | undefined {
  const cleanupAttemptToken = randomUUID();
  // Lifecycle intent survives periodic retries; a touch may revoke only an
  // idle/cap sweep claim, never cleanup for a session that already ended.
  const cleanupKind = kind === "lifecycle" ? "lifecycle" : (tab.cleanupKind ?? kind);
  const claimed = updateBrowserSessionTab(tab.storageKey, (current) => {
    const record = parseBrowserSessionTabRecord(current);
    if (!record || !sameBrowserSessionTabRecord(record, tab)) {
      return undefined;
    }
    return {
      ...record,
      cleanupRequestedAt: now,
      cleanupAttemptToken,
      cleanupKind,
    };
  });
  return claimed
    ? { ...tab, cleanupRequestedAt: now, cleanupAttemptToken, cleanupKind }
    : undefined;
}

function matchesCleanupAttempt(
  current: BrowserSessionTabRecord | undefined,
  tab: DurableTab,
): current is BrowserSessionTabRecord {
  return Boolean(
    current &&
    current.cleanupAttemptToken === tab.cleanupAttemptToken &&
    current.cleanupRequestedAt === tab.cleanupRequestedAt &&
    current.cleanupKind === tab.cleanupKind &&
    // Lifecycle activity may advance lastUsedAt without revoking mandatory
    // cleanup. Every other field, especially the generation, must still match.
    sameBrowserSessionTabRecord({ ...current, lastUsedAt: tab.lastUsedAt }, tab),
  );
}

function ownsCleanupAttempt(tab: DurableTab): boolean {
  const current = parseBrowserSessionTabRecord(getBrowserSessionTabStore().lookup(tab.storageKey));
  return matchesCleanupAttempt(current, tab);
}

function deleteClaimedTab(tab: DurableTab, onWarn?: (message: string) => void): void {
  forgetDeferredTabDiagnostic(tab);
  try {
    if (tab.dashboard?.state === "stopping") {
      updateBrowserSessionTab(tab.storageKey, (current) => {
        const record = parseBrowserSessionTabRecord(current);
        if (!matchesCleanupAttempt(record, tab) || !record.dashboard) {
          return undefined;
        }
        const {
          cleanupRequestedAt: _requested,
          cleanupAttemptToken: _token,
          cleanupKind: _kind,
          ...settled
        } = record;
        return { ...settled, dashboard: { ...record.dashboard, state: "stopped" } };
      });
      return;
    }
    deleteBrowserSessionTabIf(tab.storageKey, (current) => {
      const record = parseBrowserSessionTabRecord(current);
      return matchesCleanupAttempt(record, tab);
    });
  } catch (error) {
    onWarn?.(`failed to delete tracked browser tab ${tab.nativeTargetId}: ${String(error)}`);
  }
}

async function closeCurrentDurableTab(
  tab: DurableTab,
  shouldClose: () => boolean,
  getResolvedBrowserConfig?: CloseParams["getResolvedBrowserConfig"],
): Promise<DurableCleanupResult> {
  // Empty session cleanup must not initialize Browser control or its CDP graph.
  const [{ getRuntimeConfig }, { resolveCdpControlPolicy }, { closeTrackedCdpTarget }, config] =
    await Promise.all([
      import("../config/config.js"),
      import("./cdp-reachability-policy.js"),
      import("./cdp.helpers.js"),
      import("./config.js"),
    ]);
  let resolved = await getResolvedBrowserConfig?.();
  if (!shouldClose()) {
    return { status: "cancelled" };
  }
  if (!resolved) {
    const cfg = getRuntimeConfig();
    resolved = config.resolveBrowserConfig(cfg.browser, cfg);
  }
  const profile = config.resolveProfile(resolved, tab.profile);
  if (!profile?.cdpUrl) {
    return { status: "ownership-mismatch" };
  }
  if (tab.dashboard && !config.isLocalManagedProfile(profile)) {
    return { status: "ownership-mismatch" };
  }
  if (profile.driver === "extension" && !resolved.extensionRelayInternalTokens[profile.name]) {
    return { status: "unavailable", reason: "extension-relay-unavailable" };
  }
  const cdpControlPolicy = resolveCdpControlPolicy(profile, resolved.ssrfPolicy);
  return await closeTrackedCdpTarget({
    profileName: profile.name,
    cdpUrl: profile.cdpUrl,
    nativeTargetId: tab.nativeTargetId,
    timeoutMs: resolved.remoteCdpTimeoutMs,
    ssrfPolicy: cdpControlPolicy,
    expectedProfileFingerprint: tab.profileFingerprint,
    expectedBrowserInstanceFingerprint: tab.browserInstanceFingerprint,
    shouldClose,
  });
}

export async function closeDurableTab(
  candidate: DurableTab,
  params: CloseParams,
  now: number,
  cleanupKind: CleanupKind,
): Promise<number> {
  if (candidate.dashboard?.state === "active" || candidate.dashboard?.state === "stopped") {
    return 0;
  }
  const tab = claimCleanup(candidate, now, cleanupKind);
  if (!tab) {
    return 0;
  }
  const shouldClose = () => ownsCleanupAttempt(tab);
  let outcome: DurableCleanupResult;
  try {
    if (params.closeDurableTab) {
      outcome = await params.closeDurableTab(tab, { shouldClose });
    } else if (params.closeTab) {
      if (!shouldClose()) {
        return 0;
      }
      await params.closeTab({
        targetId: tab.nativeTargetId,
        nativeTargetId: tab.nativeTargetId,
        profile: tab.profile,
      });
      outcome = { status: "closed" };
    } else {
      outcome = await closeCurrentDurableTab(tab, shouldClose, params.getResolvedBrowserConfig);
    }
  } catch (error) {
    if (isIgnorableTabCloseError(error)) {
      deleteClaimedTab(tab, params.onWarn);
      return 0;
    }
    params.onWarn?.(`failed to close tracked browser tab ${tab.nativeTargetId}: ${String(error)}`);
    return 0;
  }
  if (outcome.status === "cancelled") {
    return 0;
  }
  if (outcome.status === "unavailable") {
    if (outcome.reason === "extension-relay-unavailable") {
      reportDeferredTab(params, tab, "extension relay runtime unavailable");
      return 0;
    }
    // Expire unreachable ordinary tabs before they fill the bounded tracking store.
    // Retained dashboards require proof of release, regardless of their idle age.
    if (!tab.dashboard && now - tab.lastUsedAt >= BROWSER_TAB_UNREACHABLE_RETIRE_MS) {
      params.onWarn?.(
        `retired unreachable tracked browser tab ${tab.nativeTargetId}: ${outcome.reason}`,
      );
      deleteClaimedTab(tab, params.onWarn);
      return 0;
    }
    reportDeferredTab(params, tab, outcome.reason);
    return 0;
  }
  if (outcome.status === "ownership-mismatch") {
    params.onWarn?.(`retired tracked browser tab ${tab.nativeTargetId}: ownership mismatch`);
    deleteClaimedTab(tab, params.onWarn);
    return 0;
  }
  deleteClaimedTab(tab, params.onWarn);
  return outcome.status === "closed" ? 1 : 0;
}
