// MCP loopback runtime scope cache.
// Resolves Gateway-visible tools for MCP clients with short-lived schema caching.
import { randomUUID } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import {
  loadPairedComputerUseAvailabilityForSurface,
  type PairedComputerUseAvailability,
} from "../agents/computer-use-node-capabilities.js";
import {
  isCoreCodingSurfaceToolName,
  listCoreToolFactoryDescriptors,
} from "../agents/core-tool-factory-descriptors.js";
import { applyEmbeddedAttemptToolsAllow } from "../agents/embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { loadNodeExecAvailability } from "../agents/node-exec-availability.js";
import type { PreparedRootedExecutionCapability } from "../agents/rooted-run-params.js";
import { normalizeToolPolicyName } from "../agents/tool-policy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { DirectoryCache } from "../infra/outbound/directory-cache.js";
import { logWarn } from "../logger.js";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import type { SkillLibraryAuthoringCapability } from "../skills/library/authoring.js";
import type {
  McpLoopbackClientGrantCloseReason,
  McpLoopbackRequestContext,
} from "./mcp-grant-store.js";
import {
  buildMcpToolSchema,
  readMcpLoopbackToolName,
  type McpLoopbackTool,
  type McpToolSchemaEntry,
} from "./mcp-http.schema.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

// MCP loopback runtime scopes gateway tools to the current session/channel
// context and caches the expensive schema projection for short bursts of tool
// list/call traffic from the same MCP client.
const TOOL_CACHE_TTL_MS = 30_000;
const TOOL_CACHE_MAX_ENTRIES = 256;
// Node closes ride on best-effort node invokes. A successor computer row waits
// this long for a retired predecessor's close to reach the node, and shutdown
// waits the same budget for closes already in flight.
const NODE_CLOSE_BUDGET_MS = 5_000;
const NATIVE_TOOL_EXCLUDE = new Set(
  listCoreToolFactoryDescriptors()
    .map(({ name }) => name)
    .filter(isCoreCodingSurfaceToolName),
);

type ScopedToolsCleanup = (reason: string) => Promise<void>;

type CachedScopedTools = {
  agentId: string | undefined;
  // Tool policy resolves the workspace root (grant value, else the agent's
  // configured workspace). Hook context must carry the same one the tools were
  // built with, or before-tool-call policy resolves state against a different root.
  workspaceDir: string | undefined;
  tools: McpLoopbackTool[];
  toolSchema: McpToolSchemaEntry[];
  // Grant-owned rows only: drains the node resources the tool instances
  // registered (a computer execution opens on the first screenshot). Idempotent.
  dispose?: ScopedToolsCleanup;
};

type ScopedToolsCleanupOwner = {
  register: (cleanup: ScopedToolsCleanup) => void;
  dispose: ScopedToolsCleanup;
};

/** Collects one row's tool cleanups. Registration is a construction-time contract. */
function createScopedToolsCleanupOwner(): ScopedToolsCleanupOwner {
  const cleanups: ScopedToolsCleanup[] = [];
  let pending: Promise<void> | undefined;
  return {
    register: (cleanup) => {
      if (pending) {
        throw new Error("mcp loopback tool cleanup registered after its row was retired");
      }
      cleanups.push(cleanup);
    },
    dispose: (reason) => {
      pending ??= (async () => {
        const results = await Promise.allSettled(cleanups.map((cleanup) => cleanup(reason)));
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length > 0) {
          throw new AggregateError(failures, failures.map(formatErrorMessage).join("; "));
        }
      })();
      return pending;
    },
  };
}

// A client grant owns the node execution its rows drive for the whole run:
// the schema rows live with the grant, not with the short schema cache, so a
// run never re-mints the execution the node still holds.
type GrantResources = {
  computerExecutionId: string;
  // Bumped when the authority behind the token is replaced: a row built against
  // the previous authority may still answer its own request but is never published.
  generation: number;
  rows: Map<string, { cfg: OpenClawConfig; row: CachedScopedTools }>;
  // Cleanups of rows that left `rows` (replaced authority, cap, config change);
  // they close with the grant because their sessions may have bound targets.
  retiredCleanups: Set<ScopedToolsCleanup>;
  // The run's settlement once the grant ended; a row still discovering nodes
  // at that point closes with it instead of a made-up reason.
  closeReason?: McpLoopbackClientGrantCloseReason;
};

type McpLoopbackScopeParams = {
  context: Omit<McpLoopbackRequestContext, "senderIsOwner"> & { senderIsOwner?: boolean };
  cfg: OpenClawConfig;
  authProfileStore?: AuthProfileStore;
  authProfileStoreAgentDir?: string;
  skillLibraryAuthoring?: SkillLibraryAuthoringCapability;
  rootedExecution?: PreparedRootedExecutionCapability;
  messageActionTurnCapability?: string;
  grantToken?: string;
  /**
   * Liveness of the authenticating client grant. Deliberately absent from the
   * cache key: the grant token is already in it, and every row replacement
   * evicts that token's cached tools, so a cached closure can only ever observe
   * the exact row it was built for.
   */
  isGrantCurrent?: () => boolean;
  /** Owner-scoped computer execution identity; absent from the cache key like the grant liveness. */
  computerExecutionId?: string;
  yieldContextCacheKey?: string;
  onYield?: (message: string, acknowledgment?: string) => Promise<void> | void;
  nodeExecAvailability?: Awaited<ReturnType<typeof loadNodeExecAvailability>>;
  pairedComputerUseAvailability?: PairedComputerUseAvailability;
  signal?: AbortSignal;
};

type LoopbackToolsAllowMode = "exact" | "policy";

function resolveMediatedNativeTools(
  toolsAllow: string[] | undefined,
  mode: LoopbackToolsAllowMode,
): Set<string> {
  if (mode === "exact") {
    return new Set(
      (toolsAllow ?? [])
        .map((name) => normalizeToolPolicyName(name))
        .filter((name) => NATIVE_TOOL_EXCLUDE.has(name)),
    );
  }
  if (
    toolsAllow === undefined ||
    toolsAllow.some((toolName) => normalizeToolPolicyName(toolName) === "*")
  ) {
    return new Set();
  }
  return new Set(
    applyEmbeddedAttemptToolsAllow(
      Array.from(NATIVE_TOOL_EXCLUDE, (name) => ({ name })),
      toolsAllow,
    ).map((tool) => tool.name),
  );
}

async function resolveNodeExecScope(
  params: McpLoopbackScopeParams,
  mode: LoopbackToolsAllowMode,
): Promise<McpLoopbackScopeParams> {
  const shouldResolveExec =
    !params.rootedExecution &&
    params.context.nodeExecAllowed === true &&
    resolveMediatedNativeTools(params.context.toolsAllow, mode).size === 0;
  if (!shouldResolveExec) {
    return params;
  }
  return { ...params, nodeExecAvailability: await loadNodeExecAvailability(params.signal) };
}

function isComputerAllowedByMcpScope(
  params: McpLoopbackScopeParams,
  mode: LoopbackToolsAllowMode,
): boolean {
  const { toolsAllow } = params.context;
  if (mode === "exact") {
    return (
      toolsAllow === undefined ||
      toolsAllow.some((name) => normalizeToolPolicyName(name) === "computer")
    );
  }
  return applyEmbeddedAttemptToolsAllow([{ name: "computer" }], toolsAllow).length === 1;
}

type ResolvedNodeScope = {
  params: McpLoopbackScopeParams;
  policyResolved?: CachedScopedTools;
};

async function resolveNodeScope(
  input: McpLoopbackScopeParams,
  mode: LoopbackToolsAllowMode,
): Promise<ResolvedNodeScope> {
  return resolvePairedComputerNodeScope(await resolveNodeExecScope(input, mode), mode);
}

async function resolvePairedComputerNodeScope(
  params: McpLoopbackScopeParams,
  mode: LoopbackToolsAllowMode,
): Promise<ResolvedNodeScope> {
  const canReachOrdinaryComputerSurface =
    isComputerAllowedByMcpScope(params, mode) &&
    params.context.modelHasVision !== false &&
    !params.rootedExecution;
  if (!canReachOrdinaryComputerSurface) {
    return { params };
  }
  // Resolve the actual configured surface before contacting Gateway. Grant policy
  // alone is insufficient: profile, agent, sandbox, sender, and Gateway policy
  // can all remove computer from the final catalog.
  const policyResolved = resolveMcpLoopbackTools(params, mode);
  const computerAllowed = policyResolved.tools.some(
    (tool) => readMcpLoopbackToolName(tool) === "computer",
  );
  const pairedComputerUseAvailability = await loadPairedComputerUseAvailabilityForSurface({
    computerAllowed,
    modelHasVision: params.context.modelHasVision,
    computerTransport: params.rootedExecution ? null : undefined,
    signal: params.signal,
  });
  if (!pairedComputerUseAvailability) {
    return { params, policyResolved };
  }
  const resolvedParams = {
    params: {
      ...params,
      pairedComputerUseAvailability,
    },
  };
  // Rebuild computer with the prepared host/node action projection and target
  // status. A discarded probe row never bound a node, so it holds nothing to release.
  return pairedComputerUseAvailability.prepared
    ? resolvedParams
    : { ...resolvedParams, policyResolved };
}

function resolveMcpLoopbackTools(
  params: McpLoopbackScopeParams,
  mode: LoopbackToolsAllowMode,
): CachedScopedTools {
  params.signal?.throwIfAborted();
  const { toolsAllow, ...context } = params.context;
  const excludeToolNames = new Set(NATIVE_TOOL_EXCLUDE);
  // Restricted CLI grants use OpenClaw's implementations for coding tools;
  // native CLI tools bypass path, approval, sandbox, and exec policy.
  const mediatedNativeTools = params.rootedExecution
    ? new Set(NATIVE_TOOL_EXCLUDE)
    : resolveMediatedNativeTools(toolsAllow, mode);
  for (const toolName of mediatedNativeTools) {
    excludeToolNames.delete(toolName);
  }
  const includeNodeExecTool = context.nodeExecAllowed === true && mediatedNativeTools.size === 0;
  if (includeNodeExecTool) {
    excludeToolNames.delete("exec");
  }
  const skillWorkshop =
    context.skillWorkshop || params.skillLibraryAuthoring
      ? { ...context.skillWorkshop, libraryAuthoring: params.skillLibraryAuthoring }
      : undefined;
  // Only grant-owned rows get a cleanup owner. Runtime-token callers (the
  // owner/non-owner bearer, used for probes and listings) have no run to end,
  // so they keep the untracked per-row execution they had before, and no owner
  // means no execution-owned actions in their schema.
  const cleanupOwner = params.computerExecutionId ? createScopedToolsCleanupOwner() : undefined;
  const scoped = resolveGatewayScopedTools({
    ...context,
    rootedExecution: params.rootedExecution,
    messageActionTurnCapability: params.messageActionTurnCapability,
    cfg: params.cfg,
    authProfileStore: params.authProfileStore,
    onYield: params.onYield,
    skillWorkshop,
    nativeCronCreatorToolAllowlist: context.nativeCronCreatorToolAllowlist ?? undefined,
    agentDir: params.authProfileStoreAgentDir,
    conversationReadOrigin: "delegated",
    surface: "loopback",
    isGrantCurrent: params.isGrantCurrent,
    excludeToolNames,
    mediatedToolNames: mediatedNativeTools,
    includeNodeExecTool,
    nodeExecAvailable: params.nodeExecAvailability?.isAvailable,
    pairedNodeComputerUse: params.pairedComputerUseAvailability?.prepared,
    registerRunCleanup: cleanupOwner?.register,
    computerExecutionId: params.computerExecutionId,
  });
  const tools =
    mode === "exact"
      ? applyGrantToolsAllow(scoped.tools, toolsAllow)
      : applyPolicyToolsAllow(scoped.tools, toolsAllow);
  const toolSchema = buildMcpToolSchema(tools);
  scoped.captureFinalCronCreatorTools?.(new Set(toolSchema.map((tool) => tool.name)));
  return {
    agentId: scoped.agentId,
    workspaceDir: scoped.workspaceDir,
    tools,
    toolSchema,
    ...(cleanupOwner ? { dispose: cleanupOwner.dispose } : {}),
  };
}

/** Resolves loopback-visible tools from the exact names carried by a minted grant. */
export async function resolveMcpLoopbackScopedTools(params: McpLoopbackScopeParams): Promise<{
  agentId: string | undefined;
  workspaceDir?: string;
  tools: McpLoopbackTool[];
}> {
  const resolved = await resolveNodeScope(params, "exact");
  return resolved.policyResolved ?? resolveMcpLoopbackTools(resolved.params, "exact");
}

/** Materializes runtime policy expressions against the concrete loopback catalog. */
export async function resolveMcpLoopbackPolicyTools(params: McpLoopbackScopeParams): Promise<{
  agentId: string | undefined;
  tools: McpLoopbackTool[];
}> {
  const resolved = await resolveNodeScope(params, "policy");
  return resolved.policyResolved ?? resolveMcpLoopbackTools(resolved.params, "policy");
}

/**
 * Hard-enforces a per-run grant allowlist on the loopback surface. Both
 * tools/list and tools/call consume this list, so a tool outside the
 * allowlist can be neither discovered nor executed even when the CLI runs
 * with a bypass permission mode. An empty allowlist fails closed.
 */
function applyGrantToolsAllow(
  tools: McpLoopbackTool[],
  toolsAllow: string[] | undefined,
): McpLoopbackTool[] {
  if (!toolsAllow) {
    return tools;
  }
  const allowed = new Set(toolsAllow.map((name) => normalizeToolPolicyName(name)).filter(Boolean));
  return tools.filter((tool) => {
    const name = readMcpLoopbackToolName(tool);
    return name !== undefined && allowed.has(normalizeToolPolicyName(name));
  });
}

function applyPolicyToolsAllow(
  tools: McpLoopbackTool[],
  toolsAllow: string[] | undefined,
): McpLoopbackTool[] {
  if (!toolsAllow) {
    return tools;
  }
  // Grant lists remain exact; only this pre-mint path may expand groups,
  // globs, plugin ids, and write-to-apply_patch policy semantics.
  const candidates = tools.flatMap((tool) => {
    const name = readMcpLoopbackToolName(tool);
    return name ? [{ name, tool }] : [];
  });
  return applyEmbeddedAttemptToolsAllow(candidates, toolsAllow, {
    toolMeta: (candidate) => getPluginToolMeta(candidate.tool),
  }).map((candidate) => candidate.tool);
}

function buildMcpLoopbackToolCacheKey(params: McpLoopbackScopeParams): string {
  const { context } = params;
  // Only the serializable grant context enters this key. Prepared credentials,
  // authoring capabilities, and callbacks stay bound to their grant lifetime.
  return `${params.grantToken ?? ""}\u0000${stableStringify({
    context: {
      ...context,
      clientCaps: [...new Set(context.clientCaps ?? [])].toSorted(),
      // Missing allows all; an empty list denies all.
      toolsAllow: context.toolsAllow ? [...new Set(context.toolsAllow)].toSorted() : undefined,
      modelHasVision: context.modelHasVision,
      pinnedWidgetAuthoring: context.pinnedWidgetAuthoring === true,
      currentInboundAudio: context.currentInboundAudio === true,
      sourceReplyOnly: context.sourceReplyOnly === true,
      requireExplicitMessageTarget: context.requireExplicitMessageTarget === true,
      nodeExecAllowed: context.nodeExecAllowed === true,
      delegationCapability:
        context.delegationCapability === "report_only" ? "report_only" : undefined,
    },
    authProfileStoreAgentDir: params.authProfileStoreAgentDir,
    yieldContextCacheKey: params.yieldContextCacheKey,
    nodeExecAvailability: params.nodeExecAvailability?.cacheKey,
    pairedComputerUseAvailability: params.pairedComputerUseAvailability?.cacheKey,
  })}`;
}

function hasComputerTool(row: CachedScopedTools): boolean {
  return row.tools.some((tool) => readMcpLoopbackToolName(tool) === "computer");
}

/** Short-lived cache for loopback tool lists keyed by session/channel context. */
export class McpLoopbackToolCache {
  // Rows without a client grant: schema-only rows under the short TTL.
  #entries = new DirectoryCache<CachedScopedTools>(TOOL_CACHE_TTL_MS, TOOL_CACHE_MAX_ENTRIES);
  // Rows with a client grant live here until the grant is revoked. The global
  // cap still bounds them; a row the cap drops is rebuilt on the same execution.
  #grants = new Map<string, GrantResources>();
  #grantRowCount = 0;
  // Concurrent misses for one grant scope share a single construction, so one
  // request cannot screenshot on a row another request's publication discards.
  // The entry remembers which authority it observed: a request under replaced
  // or retired authority starts its own build instead of joining a stale one.
  #inflight = new Map<
    string,
    {
      grant: GrantResources;
      generation: number;
      cfg: OpenClawConfig;
      pending: Promise<CachedScopedTools>;
    }
  >();
  #pendingDisposals = new Set<Promise<void>>();
  #epoch = 0;

  #grant(grantToken: string): GrantResources {
    let grant = this.#grants.get(grantToken);
    if (!grant) {
      grant = {
        computerExecutionId: randomUUID(),
        generation: 0,
        rows: new Map(),
        retiredCleanups: new Set(),
      };
      this.#grants.set(grantToken, grant);
    }
    return grant;
  }

  #retire(
    dispose: ScopedToolsCleanup,
    reason: McpLoopbackClientGrantCloseReason,
    executionId: string,
  ): void {
    const disposal = dispose(reason).catch((error: unknown) => {
      logWarn(
        `mcp loopback: closing computer execution ${executionId} failed (${reason}): ` +
          `${formatErrorMessage(error)}; if the node reports COMPUTER_HOST_BUSY, run ` +
          `\`openclaw nodes invoke --node <node> --command computer.act --params ` +
          `'{"action":"__close_execution","executionId":"${executionId}","reason":"unstick"}'\``,
      );
    });
    this.#pendingDisposals.add(disposal);
    void disposal.finally(() => {
      this.#pendingDisposals.delete(disposal);
    });
  }

  /** Drops the grant's rows without touching the execution they share. */
  #unpinRows(grant: GrantResources): boolean {
    const hadRows = grant.rows.size > 0;
    for (const { row } of grant.rows.values()) {
      if (row.dispose) {
        grant.retiredCleanups.add(row.dispose);
      }
    }
    this.#grantRowCount -= grant.rows.size;
    grant.rows.clear();
    return hadRows;
  }

  #retireGrant(grant: GrantResources, reason: McpLoopbackClientGrantCloseReason): void {
    this.#unpinRows(grant);
    for (const dispose of grant.retiredCleanups) {
      this.#retire(dispose, reason, grant.computerExecutionId);
    }
    grant.retiredCleanups.clear();
  }

  /** Waits for in-flight node closes, bounded by the budget and the caller's signal. */
  async #settleDisposals(signal?: AbortSignal): Promise<void> {
    const pending = [...this.#pendingDisposals];
    if (pending.length === 0 || signal?.aborted) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const budget = new Promise<"timeout" | "aborted">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), NODE_CLOSE_BUDGET_MS);
      // The caller stops waiting on abort; the closes themselves keep running.
      onAbort = () => resolve("aborted");
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const outcome = await Promise.race([
        Promise.all(pending).then(() => "settled" as const),
        budget,
      ]);
      if (outcome === "timeout") {
        logWarn(
          `mcp loopback: computer execution close still running after ${NODE_CLOSE_BUDGET_MS}ms; continuing`,
        );
      }
    } finally {
      clearTimeout(timer);
      if (onAbort) {
        signal?.removeEventListener("abort", onAbort);
      }
    }
  }

  #pin(grant: GrantResources, cacheKey: string, cfg: OpenClawConfig, row: CachedScopedTools): void {
    const previous = grant.rows.get(cacheKey);
    if (previous) {
      // A config reload changes cfg identity under the same key; the old row's
      // session may have bound a target, so its cleanup stays with the grant.
      if (previous.row.dispose) {
        grant.retiredCleanups.add(previous.row.dispose);
      }
    } else {
      this.#grantRowCount += 1;
    }
    grant.rows.set(cacheKey, { cfg, row });
    while (this.#grantRowCount > TOOL_CACHE_MAX_ENTRIES && this.#dropOneGrantRow()) {
      // Bounded by the rows that exist; each iteration removes one.
    }
  }

  #dropOneGrantRow(): boolean {
    for (const grant of this.#grants.values()) {
      for (const [key, { row }] of grant.rows) {
        grant.rows.delete(key);
        this.#grantRowCount -= 1;
        if (row.dispose) {
          grant.retiredCleanups.add(row.dispose);
        }
        return true;
      }
    }
    return false;
  }

  #lookup(
    grant: GrantResources | undefined,
    cacheKey: string,
    cfg: OpenClawConfig,
  ): CachedScopedTools | undefined {
    if (!grant) {
      return this.#entries.get(cacheKey, cfg);
    }
    const pinned = grant.rows.get(cacheKey);
    return pinned?.cfg === cfg ? pinned.row : undefined;
  }

  async resolve(input: McpLoopbackScopeParams): Promise<CachedScopedTools> {
    const epoch = this.#epoch;
    const grantToken = input.grantToken;
    // A grant revoked between request auth and this resolve gets a plain row;
    // the request is refused right after resolve, so nothing should pin it.
    const grant =
      grantToken && input.isGrantCurrent?.() !== false ? this.#grant(grantToken) : undefined;
    // Authority replaced during any discovery below must keep this row unpublished.
    const generation = grant?.generation;
    const nodeExecParams = await resolveNodeExecScope(
      grant ? { ...input, computerExecutionId: grant.computerExecutionId } : input,
      "exact",
    );
    input.signal?.throwIfAborted();
    // A policy-excluded computer scope has no inventory component. It can use
    // the ordinary cached catalog without touching Gateway again.
    const preDiscoveryCacheKey = buildMcpLoopbackToolCacheKey(nodeExecParams);
    const preDiscoveryCached = this.#lookup(grant, preDiscoveryCacheKey, nodeExecParams.cfg);
    if (preDiscoveryCached) {
      return grant
        ? await this.#serveGrantRow(preDiscoveryCached, input.signal)
        : preDiscoveryCached;
    }
    if (grantToken && grant) {
      const observedGeneration = generation ?? 0;
      const inflightKey = `${grantToken}\u0000${preDiscoveryCacheKey}`;
      const inflight = this.#inflight.get(inflightKey);
      if (
        inflight?.grant === grant &&
        inflight.generation === observedGeneration &&
        inflight.cfg === nodeExecParams.cfg
      ) {
        const row = await inflight.pending;
        input.signal?.throwIfAborted();
        return row;
      }
      // The shared build belongs to the cache, not to the request that started
      // it: one request's cancellation must not fail the others, and the row it
      // finishes stays useful to them. Each waiter applies its own signal after.
      const pending = this.#resolveGrantRow(grantToken, grant, observedGeneration, {
        ...nodeExecParams,
        signal: undefined,
      });
      this.#inflight.set(inflightKey, {
        grant,
        generation: observedGeneration,
        cfg: nodeExecParams.cfg,
        pending,
      });
      try {
        const row = await pending;
        input.signal?.throwIfAborted();
        return row;
      } finally {
        if (this.#inflight.get(inflightKey)?.pending === pending) {
          this.#inflight.delete(inflightKey);
        }
      }
    }

    // Availability belongs to the current connection, not the schema TTL.
    const resolved = await resolvePairedComputerNodeScope(nodeExecParams, "exact");
    input.signal?.throwIfAborted();
    const { params } = resolved;
    const cacheKey = buildMcpLoopbackToolCacheKey(params);
    const cached = this.#entries.get(cacheKey, params.cfg);
    if (cached) {
      return cached;
    }
    const nextEntry = resolved.policyResolved ?? resolveMcpLoopbackTools(params, "exact");
    // Revocation may overtake discovery before a row is cached.
    if (epoch !== this.#epoch) {
      return nextEntry;
    }
    this.#entries.set(cacheKey, nextEntry, params.cfg);
    return nextEntry;
  }

  /**
   * A retired predecessor's close must reach the node before a grant row's next
   * screenshot, or the provider still reports the old execution busy. Applies
   * to cached rows as well: a successor may have built its row while the
   * predecessor was still running.
   */
  async #serveGrantRow(row: CachedScopedTools, signal?: AbortSignal): Promise<CachedScopedTools> {
    if (this.#pendingDisposals.size > 0 && hasComputerTool(row)) {
      await this.#settleDisposals(signal);
      signal?.throwIfAborted();
    }
    return row;
  }

  async #resolveGrantRow(
    grantToken: string,
    grant: GrantResources,
    generation: number,
    nodeExecParams: McpLoopbackScopeParams,
  ): Promise<CachedScopedTools> {
    // Availability belongs to the current connection, not the schema TTL.
    const resolved = await resolvePairedComputerNodeScope(nodeExecParams, "exact");
    const { params } = resolved;
    const cacheKey = buildMcpLoopbackToolCacheKey(params);
    const cached = this.#lookup(grant, cacheKey, params.cfg);
    if (cached) {
      return await this.#serveGrantRow(cached);
    }
    const nextEntry = resolved.policyResolved ?? resolveMcpLoopbackTools(params, "exact");
    if (hasComputerTool(nextEntry)) {
      await this.#settleDisposals();
    }
    if (this.#grants.get(grantToken) !== grant) {
      // The run ended, or the token was transferred, while this row was still
      // discovering nodes; nothing may keep it. A transferred token's request is
      // refused right after resolve, so its row never binds a target to close.
      if (nextEntry.dispose) {
        this.#retire(nextEntry.dispose, grant.closeReason ?? "cancel", grant.computerExecutionId);
      }
      return nextEntry;
    }
    if (grant.generation !== generation) {
      // The authority behind the token changed meanwhile. This request may still
      // answer with the row it observed, but later requests must not.
      if (nextEntry.dispose) {
        grant.retiredCleanups.add(nextEntry.dispose);
      }
      return nextEntry;
    }
    this.#pin(grant, cacheKey, params.cfg, nextEntry);
    return nextEntry;
  }

  /**
   * The authority behind a live token was replaced: its rows captured the old
   * authority and must go, but the node execution the run drives stays open.
   */
  evictGrant(token: string): boolean {
    this.#epoch += 1;
    const grant = this.#grants.get(token);
    if (!grant) {
      return false;
    }
    grant.generation += 1;
    return this.#unpinRows(grant);
  }

  /** The run moved onto a successor token; its execution and cleanups move with it. */
  transferGrant(token: string, successorToken: string): void {
    this.#epoch += 1;
    const source = this.#grants.get(token);
    if (!source) {
      return;
    }
    this.#grants.delete(token);
    this.#unpinRows(source);
    const successor = this.#grants.get(successorToken);
    if (successor) {
      // A warm process keeps its execution across turns; the fresh turn's grant
      // never built rows of its own, so only its bookkeeping joins the successor.
      for (const dispose of source.retiredCleanups) {
        successor.retiredCleanups.add(dispose);
      }
      return;
    }
    this.#grants.set(successorToken, source);
  }

  /** The run the token served ended; close the node execution with its real outcome. */
  revokeGrant(token: string, closeReason: McpLoopbackClientGrantCloseReason): boolean {
    this.#epoch += 1;
    const grant = this.#grants.get(token);
    if (!grant) {
      return false;
    }
    this.#grants.delete(token);
    grant.closeReason = closeReason;
    const released = grant.rows.size > 0 || grant.retiredCleanups.size > 0;
    this.#retireGrant(grant, closeReason);
    return released;
  }

  /**
   * Drops every row. The loopback server revokes its grants before clearing, so
   * this normally only waits for their closes; a grant still tracked here is
   * cancelled as well so nothing outlives the cache.
   */
  async clear(): Promise<void> {
    this.#epoch += 1;
    this.#entries.clear();
    for (const grant of this.#grants.values()) {
      grant.closeReason = "cancel";
      this.#retireGrant(grant, "cancel");
    }
    this.#grants.clear();
    await this.#settleDisposals();
  }
}
