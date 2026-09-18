import { isRecord } from "@openclaw/normalization-core/record-coerce";
/** Doctor repair for stale plugin-owned routing state persisted in session entries. */
import { normalizeOptionalString as normalizeString } from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntriesLower } from "@openclaw/normalization-core/string-normalization";
import { note } from "../../packages/terminal-core/src/note.js";
import {
  resolveAgentModelFallbacksOverride,
  tryResolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { resolveAgentHarnessPolicy } from "../agents/harness/policy.js";
import {
  modelKey,
  normalizeProviderId,
  parseModelRef,
  resolveDefaultModelForAgent,
} from "../agents/model-selection.js";
import { resolveAgentModelFallbackValues } from "../config/model-input.js";
import type { SessionEntry } from "../config/sessions.js";
import { applySessionEntryReplacements } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { updateLegacySessionStore } from "../infra/state-migrations.legacy-session-store.js";
import { listPluginDoctorSessionRouteStateOwners } from "../plugins/doctor-contract-registry.js";
import type { DoctorSessionRouteStateOwner } from "../plugins/doctor-session-route-state-owner-types.js";
import { isValidAgentHarnessSessionStoreEntry } from "../sessions/agent-harness-session-key.js";
import { parseAgentSessionKey } from "../sessions/session-key-utils.js";
import { countLabel } from "./doctor-state-integrity-format.js";

type DoctorPrompterLike = {
  confirmRuntimeRepair: (params: {
    message: string;
    initialValue?: boolean;
    requiresInteractiveConfirmation?: boolean;
  }) => Promise<boolean>;
  note?: typeof note;
};

function normalizeIdSet(values: readonly string[] | undefined): Set<string> {
  return new Set((values ?? []).map((value) => normalizeProviderId(value)));
}

function normalizePrefixList(values: readonly string[] | undefined): string[] {
  return normalizeStringEntriesLower(values);
}

function ownsPrefixedValue(prefixes: readonly string[], value: unknown): boolean {
  const normalized = normalizeString(value)?.toLowerCase();
  return normalized !== undefined && prefixes.some((prefix) => normalized.startsWith(prefix));
}

function countSessionLabel(count: number): string {
  return countLabel(count, "session");
}

function repairExample(repair: DoctorSessionRouteStateRepair): string {
  return `${repair.key} (${repair.reasons.join(", ")})`;
}

function resolveSessionAgentId(
  cfg: OpenClawConfig,
  sessionKey: string,
  storeAgentId?: string,
): string | undefined {
  return parseAgentSessionKey(sessionKey)?.agentId ?? storeAgentId ?? tryResolveDefaultAgentId(cfg);
}

/** Resolves the currently configured provider/model/runtime route for a session key. */
function resolveConfiguredDoctorSessionStateRoute(params: {
  agentId?: string;
  cfg: OpenClawConfig;
  sessionKey: string;
  env?: NodeJS.ProcessEnv;
}): DoctorSessionRouteState | undefined {
  const agentId = resolveSessionAgentId(params.cfg, params.sessionKey, params.agentId);
  if (!agentId) {
    return undefined;
  }
  const primary = resolveDefaultModelForAgent({ cfg: params.cfg, agentId });
  const configuredModelRefs = new Set<string>();
  const addRef = (provider: string, model: string) => {
    configuredModelRefs.add(modelKey(provider, model));
  };
  addRef(primary.provider, primary.model);
  const fallbacks =
    resolveAgentModelFallbacksOverride(params.cfg, agentId) ??
    resolveAgentModelFallbackValues(params.cfg.agents?.defaults?.model);
  for (const fallback of fallbacks) {
    const parsed = parseModelRef(fallback, primary.provider, {
      allowManifestNormalization: false,
      allowPluginNormalization: false,
    });
    if (parsed) {
      addRef(parsed.provider, parsed.model);
    }
  }
  const runtime = resolveAgentHarnessPolicy({
    provider: primary.provider,
    modelId: primary.model,
    config: params.cfg,
    agentId,
    sessionKey: params.sessionKey,
  }).runtime;
  return {
    defaultProvider: primary.provider,
    configuredModelRefs: [...configuredModelRefs],
    runtime,
  };
}

function resolvePluginDoctorSessionRouteStateOwners(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): DoctorSessionRouteStateOwner[] {
  return listPluginDoctorSessionRouteStateOwners({ config: params.cfg, env: params.env });
}

function entryMayContainPluginSessionRouteState(sessionKey: string, entry: SessionEntry): boolean {
  if (isValidAgentHarnessSessionStoreEntry(sessionKey, entry)) {
    return false;
  }
  // Accepted choices and imported requests survive later configuration changes.
  if (entry.executionSelection || entry.acp) {
    return false;
  }
  if (!isRecord(entry)) {
    return false;
  }
  const record = entry;
  return (
    record.liveModelSwitchPending !== undefined ||
    normalizeString(record.modelProvider) !== undefined ||
    normalizeString(record.model) !== undefined ||
    normalizeString(record.agentHarnessId) !== undefined ||
    record.cliSessionBindings !== undefined ||
    record.cliSessionIds !== undefined ||
    normalizeString(record.claudeCliSessionId) !== undefined ||
    normalizeString(record.authProfileOverride) !== undefined ||
    normalizeString(record.authProfileOverrideSource) !== undefined
  );
}

type DoctorSessionRouteState = {
  defaultProvider: string;
  configuredModelRefs: string[];
  runtime?: string;
};

type DoctorSessionRouteStateRepair = {
  key: string;
  ownerId: string;
  ownerLabel: string;
  reasons: string[];
  pinnedRuntimeKeys: Array<"agentHarnessId">;
  cliSessionKeys: string[];
};

type DoctorSessionRouteStateScan = {
  repairs: DoctorSessionRouteStateRepair[];
};

function resolvePersistedOverrideModelRef(params: {
  defaultProvider: string;
  overrideProvider?: unknown;
  overrideModel?: unknown;
}): { provider: string; model: string } | null {
  const overrideModel = normalizeString(params.overrideModel);
  if (!overrideModel) {
    return null;
  }
  const overrideProvider = normalizeString(params.overrideProvider);
  return parseModelRef(
    overrideProvider ? `${overrideProvider}/${overrideModel}` : overrideModel,
    params.defaultProvider,
    { allowManifestNormalization: false, allowPluginNormalization: false },
  );
}

function addReason(reasons: string[], reason: string) {
  if (!reasons.includes(reason)) {
    reasons.push(reason);
  }
}

function routeAllowsOwnerState(params: {
  owner: DoctorSessionRouteStateOwner;
  route: DoctorSessionRouteState | undefined;
}): boolean {
  const providerIds = normalizeIdSet(params.owner.providerIds);
  const runtimeIds = normalizeIdSet(params.owner.runtimeIds);
  const routeRuntime = normalizeString(params.route?.runtime);
  if (routeRuntime && runtimeIds.has(normalizeProviderId(routeRuntime))) {
    return true;
  }
  return (
    params.route?.configuredModelRefs.some((ref) => {
      const slash = ref.indexOf("/");
      return slash > 0 && providerIds.has(normalizeProviderId(ref.slice(0, slash)));
    }) ?? false
  );
}

function hasOwnedCliSession(params: {
  entry: Pick<SessionEntry, "cliSessionBindings" | "cliSessionIds" | "claudeCliSessionId">;
  cliSessionKeys: readonly string[];
}): boolean {
  const bindings = params.entry.cliSessionBindings;
  const ids = params.entry.cliSessionIds;
  return params.cliSessionKeys.some((key) => {
    const normalized = normalizeProviderId(key);
    return (
      (normalized === "claude-cli" &&
        normalizeString(params.entry.claudeCliSessionId) !== undefined) ||
      (bindings !== null &&
        typeof bindings === "object" &&
        normalized in bindings &&
        bindings[normalized] !== undefined) ||
      (ids !== null &&
        typeof ids === "object" &&
        normalized in ids &&
        ids[normalized] !== undefined)
    );
  });
}

function scanEntryForOwner(params: {
  key: string;
  entry: SessionEntry;
  owner: DoctorSessionRouteStateOwner;
  route: DoctorSessionRouteState | undefined;
}): {
  repair?: DoctorSessionRouteStateRepair;
} {
  const providerIds = normalizeIdSet(params.owner.providerIds);
  const runtimeIds = normalizeIdSet(params.owner.runtimeIds);
  const cliSessionKeys = [...normalizeIdSet(params.owner.cliSessionKeys)];
  const authProfilePrefixes = normalizePrefixList(params.owner.authProfilePrefixes);
  const routeAllowsOwner = routeAllowsOwnerState({ owner: params.owner, route: params.route });
  const routeRuntime = normalizeString(params.route?.runtime);
  const routeAllowsOwnerRuntime =
    routeRuntime !== undefined && runtimeIds.has(normalizeProviderId(routeRuntime));
  const reasons: string[] = [];
  const pinnedRuntimeKeys: Array<"agentHarnessId"> = [];
  if (!routeAllowsOwnerRuntime) {
    const harnessId = normalizeString(params.entry.agentHarnessId);
    if (harnessId && runtimeIds.has(normalizeProviderId(harnessId))) {
      addReason(reasons, "pinned runtime");
      pinnedRuntimeKeys.push("agentHarnessId");
    }
  }
  if (!routeAllowsOwner) {
    const runtimeRef = resolvePersistedOverrideModelRef({
      defaultProvider: "",
      overrideProvider: params.entry.modelProvider,
      overrideModel: params.entry.model,
    });
    if (runtimeRef && providerIds.has(normalizeProviderId(runtimeRef.provider))) {
      addReason(reasons, "runtime model state");
    }
    if (hasOwnedCliSession({ entry: params.entry, cliSessionKeys })) {
      addReason(reasons, "CLI session binding");
    }
    if (
      params.entry.authProfileOverrideSource === "auto" &&
      ownsPrefixedValue(authProfilePrefixes, params.entry.authProfileOverride)
    ) {
      addReason(reasons, "auto auth profile override");
    }
  }

  if (reasons.length === 0) {
    return {};
  }
  return {
    repair: {
      key: params.key,
      ownerId: params.owner.id,
      ownerLabel: params.owner.label,
      reasons,
      pinnedRuntimeKeys,
      cliSessionKeys,
    },
  };
}

/** Streams session entries into compact plugin-owned route-state findings. */
export function createPluginSessionStateDoctorScanner(params: {
  agentId?: string;
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}) {
  const repairs: DoctorSessionRouteStateRepair[] = [];
  let owners: DoctorSessionRouteStateOwner[] | undefined;
  const routeByAgentId = new Map<string, DoctorSessionRouteState>();
  return {
    scanEntry(key: string, entry: SessionEntry) {
      if (!entryMayContainPluginSessionRouteState(key, entry)) {
        return;
      }
      if (!isRecord(entry)) {
        return;
      }
      owners ??= resolvePluginDoctorSessionRouteStateOwners(params);
      if (owners.length === 0) {
        return;
      }
      const agentId = resolveSessionAgentId(params.cfg, key, params.agentId);
      if (!agentId) {
        return;
      }
      let route = routeByAgentId.get(agentId);
      if (!route) {
        route = resolveConfiguredDoctorSessionStateRoute({
          agentId,
          cfg: params.cfg,
          sessionKey: key,
          env: params.env,
        });
        if (!route) {
          return;
        }
        routeByAgentId.set(agentId, route);
      }
      for (const owner of owners) {
        const scan = scanEntryForOwner({ key, entry, owner, route });
        if (scan.repair) {
          repairs.push(scan.repair);
        }
      }
    },
    result(): DoctorSessionRouteStateScan {
      return { repairs };
    },
  };
}

function clearRecordKeys<T>(
  value: Record<string, T> | undefined,
  ownedKeys: readonly string[],
): Record<string, T> | undefined {
  if (value === null || typeof value !== "object") {
    return value;
  }
  let changed = false;
  const next = { ...value };
  for (const key of ownedKeys) {
    const normalized = normalizeProviderId(key);
    if (next[normalized] !== undefined) {
      delete next[normalized];
      changed = true;
    }
  }
  return changed ? (Object.keys(next).length > 0 ? next : undefined) : value;
}

/** Clears stale plugin-owned routing fields from a session entry and refreshes updatedAt. */
function applySessionRouteStateRepair(params: {
  sessionKey: string;
  entry: SessionEntry;
  repair: DoctorSessionRouteStateRepair;
  now: number;
}): boolean {
  // Revalidate at mutation time: the harness may have claimed and locked this row after the scan.
  if (
    isValidAgentHarnessSessionStoreEntry(params.sessionKey, params.entry) ||
    params.entry.executionSelection ||
    params.entry.acp
  ) {
    return false;
  }
  let changed = false;
  const clear = (
    key: keyof Pick<
      SessionEntry,
      | "model"
      | "modelProvider"
      | "contextTokens"
      | "systemPromptReport"
      | "fallbackNotice"
      | "agentHarnessId"
      | "claudeCliSessionId"
      | "authProfileOverride"
      | "authProfileOverrideSource"
      | "authProfileOverrideCompactionCount"
    >,
  ) => {
    if (params.entry[key] !== undefined) {
      delete params.entry[key];
      changed = true;
    }
  };
  if (params.repair.reasons.includes("runtime model state")) {
    clear("model");
    clear("modelProvider");
    clear("contextTokens");
    clear("systemPromptReport");
    clear("fallbackNotice");
  }
  if (params.repair.reasons.includes("pinned runtime")) {
    for (const key of params.repair.pinnedRuntimeKeys) {
      clear(key);
    }
  }
  if (params.repair.reasons.includes("CLI session binding")) {
    const bindings = clearRecordKeys(params.entry.cliSessionBindings, params.repair.cliSessionKeys);
    if (bindings !== params.entry.cliSessionBindings) {
      params.entry.cliSessionBindings = bindings;
      changed = true;
    }
    const ids = clearRecordKeys(params.entry.cliSessionIds, params.repair.cliSessionKeys);
    if (ids !== params.entry.cliSessionIds) {
      params.entry.cliSessionIds = ids;
      changed = true;
    }
    if (params.repair.cliSessionKeys.includes("claude-cli")) {
      // Doctor's later binding migration must not restore a conversation this repair cleared.
      clear("claudeCliSessionId");
    }
  }
  if (params.repair.reasons.includes("auto auth profile override")) {
    clear("authProfileOverride");
    clear("authProfileOverrideSource");
    clear("authProfileOverrideCompactionCount");
  }
  if (changed) {
    params.entry.updatedAt = params.now;
  }
  return changed;
}

function groupRepairsByOwner(
  repairs: readonly DoctorSessionRouteStateRepair[],
): Map<string, DoctorSessionRouteStateRepair[]> {
  const grouped = new Map<string, DoctorSessionRouteStateRepair[]>();
  for (const repair of repairs) {
    const key = repair.ownerLabel;
    grouped.set(key, [...(grouped.get(key) ?? []), repair]);
  }
  return grouped;
}

type DoctorSessionStateStore =
  | { kind: "legacy"; path: string }
  | { kind: "sqlite"; agentId: string; path: string };

/** Prompts for and applies plugin-owned session route state repairs to the session store. */
export async function runPluginSessionStateDoctorRepairs(params: {
  scan: DoctorSessionRouteStateScan;
  store: DoctorSessionStateStore;
  prompter: DoctorPrompterLike;
  warnings: string[];
  changes: string[];
}): Promise<void> {
  const { scan } = params;
  if (scan.repairs.length > 0) {
    for (const [ownerLabel, repairs] of groupRepairsByOwner(scan.repairs)) {
      const staleCount = countSessionLabel(repairs.length);
      params.warnings.push(
        [
          `- Found stale ${ownerLabel} session routing state in ${staleCount} outside the current configured model/runtime route.`,
          "  These records describe a previous execution route and can be cleared.",
          `  Examples: ${repairs.slice(0, 3).map(repairExample).join(", ")}`,
        ].join("\n"),
      );
      const repairState = await params.prompter.confirmRuntimeRepair({
        message: `Clear stale ${ownerLabel} session routing state for ${staleCount}?`,
        initialValue: true,
      });
      if (repairState) {
        let repaired = 0;
        const repairedAt = Date.now();
        const repairsByKey = new Map(repairs.map((repair) => [repair.key, repair]));
        if (params.store.kind === "sqlite") {
          repaired = await applySessionEntryReplacements<number>({
            agentId: params.store.agentId,
            sessionKeys: [...repairsByKey.keys()],
            storePath: params.store.path,
            update: (currentEntries) => {
              const replacements = currentEntries.flatMap(({ entry, sessionKey }) => {
                const repair = repairsByKey.get(sessionKey);
                return repair &&
                  isRecord(entry) &&
                  applySessionRouteStateRepair({
                    sessionKey,
                    entry,
                    repair,
                    now: repairedAt,
                  })
                  ? [{ entry, sessionKey }]
                  : [];
              });
              return { replacements, result: replacements.length };
            },
          });
        } else {
          await updateLegacySessionStore(params.store.path, (currentStore) => {
            for (const [key, repair] of repairsByKey) {
              const current = currentStore[key];
              if (
                isRecord(current) &&
                applySessionRouteStateRepair({
                  sessionKey: key,
                  entry: current,
                  repair,
                  now: repairedAt,
                })
              ) {
                repaired += 1;
              }
            }
          });
        }
        if (repaired > 0) {
          params.changes.push(
            `- Cleared stale ${ownerLabel} session routing state for ${countSessionLabel(
              repaired,
            )}.`,
          );
        }
      }
    }
  }
}
