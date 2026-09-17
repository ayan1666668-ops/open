import path from "node:path";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import {
  clampIdleTimeoutMinutes,
  clampResources,
  requireRailwayApiToken,
  requireRailwayEnvironmentId,
  resolveRailwaySandboxConfig,
} from "./config.js";
import { createRailwaySandboxClient, type RailwaySandboxClient, type RailwaySandboxRecord } from "./railway-api.js";
import {
  hashText,
  nowMs,
  openRailwayOperationStore,
  previewText,
  type RailwayOperationRecord,
  type RailwayOperationStore,
} from "./state.js";

const MAX_COMMAND_TIMEOUT_SEC = 600;
const DEFAULT_COMMAND_TIMEOUT_SEC = 300;
const MAX_TOOL_OUTPUT_CHARS = 20_000;
const MAX_FILE_BYTES = 256_000;
const MAX_DESTROY_INVENTORY_PAGES = 100;
const TERMINAL_SANDBOX_STATUSES = new Set(["DESTROYED", "DELETED", "REMOVED"]);

const RailwaySandboxToolSchema = Type.Object(
  {
    action: Type.Union([
      Type.Literal("create"),
      Type.Literal("status"),
      Type.Literal("destroy"),
      Type.Literal("list_open"),
    ]),
    operation_id: Type.Optional(Type.String({ description: "Durable logical operation handle." })),
    idle_timeout_minutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
    resources: Type.Optional(
      Type.Object(
        {
          cpu: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 4 })),
          memoryGB: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 8 })),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

const RailwayExecToolSchema = Type.Object(
  {
    operation_id: Type.String({ description: "Durable logical operation handle created by railway_sandbox." }),
    command: Type.String({ description: "Command to execute inside the owned Railway sandbox." }),
    timeout_sec: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_COMMAND_TIMEOUT_SEC })),
    max_output_chars: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TOOL_OUTPUT_CHARS })),
  },
  { additionalProperties: false },
);

const RailwayFileToolSchema = Type.Object(
  {
    action: Type.Union([Type.Literal("write"), Type.Literal("read"), Type.Literal("list")]),
    operation_id: Type.String({ description: "Durable logical operation handle created by railway_sandbox." }),
    path: Type.String({ description: "Relative path inside the Railway sandbox workspace." }),
    content: Type.Optional(Type.String({ description: "UTF-8 content for write." })),
    max_bytes: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_FILE_BYTES })),
  },
  { additionalProperties: false },
);

type ToolDeps = {
  client?: RailwaySandboxClient;
  store?: RailwayOperationStore;
  fetchImpl?: typeof globalThis.fetch;
};

type ToolOwnerContext = Pick<OpenClawPluginToolContext, "agentId" | "sessionKey"> | undefined;

type DestroyProof = NonNullable<RailwayOperationRecord["destroyProof"]>;

function textResult(text: string, details: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

function jsonTextResult(value: unknown, details?: Record<string, unknown>) {
  return textResult(JSON.stringify(value, null, 2), details);
}

function readAction(params: Record<string, unknown>): string {
  return typeof params.action === "string" ? params.action : "";
}

function normalizeParamString(params: Record<string, unknown>, key: string, required = false): string | undefined {
  const value = normalizeOptionalString(params[key]);
  if (value) {
    return value;
  }
  if (required) {
    throw new Error(`${key} is required`);
  }
  return undefined;
}

function readRawString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" ? value : undefined;
}

function readInteger(params: Record<string, unknown>, key: string, fallback: number, max: number): number {
  const value = params[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return Math.min(value, max);
}

function requireOperationId(params: Record<string, unknown>): string {
  const operationId = normalizeParamString(params, "operation_id", true)!;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,120}$/.test(operationId)) {
    throw new Error("operation_id must start with an alphanumeric character and contain only alphanumeric, _, ., :, or - characters");
  }
  return operationId;
}

function createRuntime(api: Pick<OpenClawPluginApi, "pluginConfig" | "runtime">, deps?: ToolDeps) {
  const cfg = resolveRailwaySandboxConfig(api);
  return {
    cfg,
    client: deps?.client ?? createRailwaySandboxClient({
      apiToken: requireRailwayApiToken(cfg),
      apiEndpoint: cfg.apiEndpoint,
      ...(deps?.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    }),
    store: deps?.store ?? openRailwayOperationStore(api),
  };
}

function requireToolOwner(ctx: ToolOwnerContext): { agentId: string; sessionKey: string } {
  if (!ctx?.agentId || !ctx.sessionKey) {
    throw new Error("Railway sandbox tools require an agent and session owner context; no anonymous custody is allowed");
  }
  return { agentId: ctx.agentId, sessionKey: ctx.sessionKey };
}

function assertOperationOwner(record: RailwayOperationRecord, ctx: ToolOwnerContext, action: string): void {
  const owner = requireToolOwner(ctx);
  if (!record.ownerAgentId || !record.ownerSessionKey) {
    throw new Error(`Railway operation ${record.operationId} has no recorded owner; ${action} refused`);
  }
  if (record.ownerAgentId !== owner.agentId || record.ownerSessionKey !== owner.sessionKey) {
    throw new Error(`Railway operation ${record.operationId} is owned by another agent/session; ${action} refused`);
  }
}

function ensureRunning(record: RailwayOperationRecord | undefined, ctx: ToolOwnerContext): RailwayOperationRecord {
  if (!record) {
    throw new Error("Railway sandbox operation is not recorded; create it with railway_sandbox first. No local fallback was attempted.");
  }
  assertOperationOwner(record, ctx, "use");
  if (!record.sandboxId || record.state !== "running") {
    throw new Error(`Railway sandbox operation is ${record.state}; no local fallback was attempted.`);
  }
  return record;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function normalizeRemotePath(input: string, opts: { allowRoot: boolean }): string {
  const trimmed = input.trim();
  if (!trimmed || trimmed.includes("\0") || path.isAbsolute(trimmed)) {
    throw new Error("path must be a non-empty relative path");
  }
  const normalized = path.posix.normalize(trimmed.replace(/\\/g, "/"));
  if (normalized === ".") {
    if (opts.allowRoot) {
      return ".";
    }
    throw new Error("path must name a file inside the Railway sandbox workspace");
  }
  if (normalized.startsWith("../") || normalized === "..") {
    throw new Error("path must stay inside the Railway sandbox workspace");
  }
  return normalized;
}

function anchoredPath(remotePath: string): string {
  return remotePath === "." ? "." : `./${remotePath}`;
}

function workspacePreamble(): string {
  return "set -euo pipefail\nWORKSPACE=${OPENCLAW_SANDBOX_WORKSPACE:-$PWD}\ncd -- \"$WORKSPACE\"";
}

function capText(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const head = text.slice(0, Math.floor(max * 0.7));
  const tail = text.slice(text.length - Math.floor(max * 0.3));
  return `${head}\n[... truncated by railway-sandbox tool output cap ...]\n${tail}`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadRunningOperation(runtime: ReturnType<typeof createRuntime>, operationId: string, ctx: ToolOwnerContext) {
  return ensureRunning(await runtime.store.load(operationId), ctx);
}

function validateSandboxBeforeUse(params: {
  sandbox: RailwaySandboxRecord;
  environmentId: string;
  idleTimeoutMinutes: number;
}): { ready: true } | { ready: false; reason: string } {
  if (!params.sandbox.id.trim()) {
    return { ready: false, reason: "Railway returned an empty sandbox id" };
  }
  if (params.sandbox.environmentId !== params.environmentId) {
    return { ready: false, reason: "Railway returned a sandbox in the wrong environment" };
  }
  if (params.sandbox.networkIsolation !== "ISOLATED") {
    return { ready: false, reason: "Railway returned a sandbox without ISOLATED networking" };
  }
  if (
    typeof params.sandbox.idleTimeoutMinutes !== "number" ||
    !Number.isFinite(params.sandbox.idleTimeoutMinutes) ||
    params.sandbox.idleTimeoutMinutes <= 0 ||
    params.sandbox.idleTimeoutMinutes > 10 ||
    params.sandbox.idleTimeoutMinutes > params.idleTimeoutMinutes
  ) {
    return { ready: false, reason: "Railway returned an invalid or excessive idle timeout" };
  }
  if (params.sandbox.status !== "RUNNING") {
    return { ready: false, reason: `Railway sandbox is ${params.sandbox.status}, not RUNNING` };
  }
  return { ready: true };
}

function reconcileLiveStatus(record: RailwayOperationRecord, live: RailwaySandboxRecord | null): RailwayOperationRecord {
  if (!live) {
    return record;
  }
  const validation = validateSandboxBeforeUse({
    sandbox: live,
    environmentId: record.environmentId,
    idleTimeoutMinutes: record.idleTimeoutMinutes,
  });
  return {
    ...record,
    sandboxStatus: live.status,
    ...(validation.ready ? { state: "running" as const, lastError: undefined } : { lastError: validation.reason }),
    updatedAt: nowMs(),
  };
}

async function listAllActiveSandboxes(params: {
  client: RailwaySandboxClient;
  environmentId: string;
  signal?: AbortSignal;
}): Promise<{ items: RailwaySandboxRecord[]; completed: boolean }> {
  const items: RailwaySandboxRecord[] = [];
  let after: string | null | undefined;
  for (let page = 0; page < MAX_DESTROY_INVENTORY_PAGES; page += 1) {
    const result = await params.client.listActiveSandboxes(
      { environmentId: params.environmentId, first: 50, after },
      params.signal,
    );
    items.push(...result.items);
    if (!result.pageInfo.hasNextPage) {
      return { items, completed: true };
    }
    after = result.pageInfo.endCursor;
    if (!after) {
      return { items, completed: false };
    }
  }
  return { items, completed: false };
}

async function verifyDestroyProof(params: {
  client: RailwaySandboxClient;
  environmentId: string;
  sandboxId: string;
  signal?: AbortSignal;
}): Promise<DestroyProof> {
  const [sandbox, active] = await Promise.all([
    params.client.getSandbox({ environmentId: params.environmentId, id: params.sandboxId }, params.signal),
    listAllActiveSandboxes({ client: params.client, environmentId: params.environmentId, signal: params.signal }),
  ]);
  const activeInventoryHasSandbox = active.items.some((item) => item.id === params.sandboxId);
  const status = sandbox?.status;
  let contradiction: string | undefined;
  if (status && TERMINAL_SANDBOX_STATUSES.has(status) && activeInventoryHasSandbox) {
    contradiction = `exact sandbox status is ${status} but active inventory still contains it`;
  } else if (status && !TERMINAL_SANDBOX_STATUSES.has(status) && !activeInventoryHasSandbox && active.completed) {
    contradiction = `exact sandbox status is ${status} while complete active inventory omits it`;
  }
  const verifiedDestroyed = !contradiction && (
    (status !== undefined && TERMINAL_SANDBOX_STATUSES.has(status) && !activeInventoryHasSandbox) ||
    (!sandbox && active.completed && !activeInventoryHasSandbox)
  );
  return {
    checkedAt: nowMs(),
    ...(status ? { status } : {}),
    activeInventoryCompleted: active.completed,
    activeInventoryHasSandbox,
    verifiedDestroyed,
    ...(contradiction ? { contradiction } : {}),
  };
}

async function persistCreateUncertain(params: {
  runtime: ReturnType<typeof createRuntime>;
  intent: RailwayOperationRecord;
  message: string;
  sandbox?: RailwaySandboxRecord;
}) {
  const record: RailwayOperationRecord = {
    ...params.intent,
    state: "create_uncertain",
    ...(params.sandbox?.id ? { sandboxId: params.sandbox.id } : {}),
    ...(params.sandbox?.status ? { sandboxStatus: params.sandbox.status } : {}),
    lastError: params.message,
    updatedAt: nowMs(),
  };
  await Promise.allSettled([
    params.runtime.store.save(record),
    params.runtime.store.updateGlobalAdmission(record),
  ]);
}

function decodeBase64Utf8(encoded: string): string {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error("remote file read returned invalid or truncated base64");
  }
  return Buffer.from(encoded, "base64").toString("utf8");
}

export function createRailwaySandboxTool(
  api: Pick<OpenClawPluginApi, "pluginConfig" | "runtime">,
  ctx?: OpenClawPluginToolContext,
  deps?: ToolDeps,
) {
  return {
    name: "railway_sandbox",
    label: "Railway Sandbox",
    description:
      "Create, inspect, destroy, and list owned Railway sandboxes. Creates are globally at-most-one by atomic admission and use ISOLATED networking with a finite idle timeout.",
    parameters: RailwaySandboxToolSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      const runtime = createRuntime(api, deps);
      const environmentId = requireRailwayEnvironmentId(runtime.cfg);
      const action = readAction(rawParams);

      if (action === "list_open") {
        const owner = requireToolOwner(ctx);
        const records = await runtime.store.list();
        return jsonTextResult({
          globalAdmission: await runtime.store.loadGlobalAdmission(),
          operations: records.filter(
            (record) =>
              record.state !== "destroyed" &&
              record.ownerAgentId === owner.agentId &&
              record.ownerSessionKey === owner.sessionKey,
          ),
        });
      }

      const operationId = requireOperationId(rawParams);
      if (action === "status") {
        const record = await runtime.store.load(operationId);
        if (!record) {
          return jsonTextResult({ operation: null, live: null });
        }
        assertOperationOwner(record, ctx, "status");
        const live = record.sandboxId
          ? await runtime.client.getSandbox({ environmentId: record.environmentId, id: record.sandboxId }, signal)
          : null;
        const nextRecord = reconcileLiveStatus(record, live);
        if (nextRecord !== record) {
          await runtime.store.save(nextRecord);
          if (nextRecord.state !== "destroyed") {
            await runtime.store.updateGlobalAdmission(nextRecord);
          }
        }
        return jsonTextResult({ operation: nextRecord, live });
      }

      if (action === "create") {
        const owner = requireToolOwner(ctx);
        const idleTimeoutMinutes = clampIdleTimeoutMinutes(rawParams.idle_timeout_minutes, runtime.cfg);
        const resources = clampResources(rawParams.resources, runtime.cfg);
        const now = nowMs();
        const intent: RailwayOperationRecord = {
          version: 1,
          operationId,
          ownerAgentId: owner.agentId,
          ownerSessionKey: owner.sessionKey,
          environmentId,
          state: "creating",
          networkIsolation: "ISOLATED",
          idleTimeoutMinutes,
          resources,
          createdAt: now,
          updatedAt: now,
        };
        const admission = await runtime.store.acquireGlobalAdmission(intent);
        if (admission.status === "blocked") {
          throw new Error(
            `Railway sandbox global capacity is held by ${admission.admission.operationId}; no second sandbox was allocated.`,
          );
        }
        const registered = await runtime.store.registerCreateIntent(intent);
        if (!registered) {
          const existing = await runtime.store.load(operationId);
          if (existing) {
            assertOperationOwner(existing, ctx, "create replay");
          }
          if (existing?.sandboxId && existing.state === "running") {
            await runtime.store.updateGlobalAdmission(existing);
            return jsonTextResult({ reused: true, operation: existing });
          }
          if (existing?.state === "destroyed") {
            await runtime.store.releaseGlobalAdmission(intent);
          }
          throw new Error(
            `Railway operation ${operationId} already has state ${existing?.state ?? "unknown"}; create will not be repeated or adopted.`,
          );
        }
        let sandbox: RailwaySandboxRecord;
        try {
          sandbox = await runtime.client.createSandbox(
            { environmentId, idleTimeoutMinutes, resources },
            signal,
          );
        } catch (error) {
          const message = formatError(error);
          await persistCreateUncertain({ runtime, intent, message });
          throw new Error(
            `Railway sandbox create outcome is uncertain for ${operationId}; no duplicate create or local fallback was attempted. ${message}`,
          );
        }
        const validation = validateSandboxBeforeUse({ sandbox, environmentId, idleTimeoutMinutes });
        const record: RailwayOperationRecord = {
          ...intent,
          state: validation.ready ? "running" : "creating",
          sandboxId: sandbox.id,
          sandboxStatus: sandbox.status,
          ...(validation.ready ? {} : { lastError: validation.reason }),
          updatedAt: nowMs(),
        };
        try {
          await runtime.store.save(record);
          await runtime.store.updateGlobalAdmission(record);
        } catch (error) {
          const message = `storage failed after Railway returned exact sandbox id ${sandbox.id}: ${formatError(error)}`;
          await persistCreateUncertain({ runtime, intent, message, sandbox });
          throw new Error(
            `Railway sandbox custody is uncertain for ${operationId}; exact sandbox id ${sandbox.id}. Do not allocate another sandbox. ${message}`,
          );
        }
        return jsonTextResult({ created: true, ready: validation.ready, operation: record, sandbox });
      }

      if (action === "destroy") {
        const existing = await runtime.store.load(operationId);
        if (!existing?.sandboxId) {
          throw new Error(`Railway operation ${operationId} has no sandbox id to destroy.`);
        }
        assertOperationOwner(existing, ctx, "destroy");
        const preProof = await verifyDestroyProof({
          client: runtime.client,
          environmentId: existing.environmentId,
          sandboxId: existing.sandboxId,
          signal,
        });
        if (preProof.verifiedDestroyed) {
          const record: RailwayOperationRecord = {
            ...existing,
            state: "destroyed",
            sandboxStatus: preProof.status ?? existing.sandboxStatus,
            destroyProof: preProof,
            updatedAt: nowMs(),
          };
          await runtime.store.save(record);
          await runtime.store.releaseGlobalAdmission(record);
          return jsonTextResult({ reconciled: true, proof: preProof, operation: record });
        }
        await runtime.store.save({ ...existing, state: "destroying", destroyProof: preProof, updatedAt: nowMs() });
        await runtime.store.updateGlobalAdmission({ ...existing, state: "destroying", updatedAt: nowMs() });
        try {
          const destroyed = await runtime.client.destroySandbox(
            { environmentId: existing.environmentId, id: existing.sandboxId },
            signal,
          );
          const proof = await verifyDestroyProof({
            client: runtime.client,
            environmentId: existing.environmentId,
            sandboxId: existing.sandboxId,
            signal,
          });
          const record: RailwayOperationRecord = {
            ...existing,
            state: proof.verifiedDestroyed ? "destroyed" : "cleanup_uncertain",
            sandboxStatus: destroyed?.status ?? proof.status,
            destroyProof: proof,
            ...(proof.contradiction ? { lastError: proof.contradiction } : {}),
            updatedAt: nowMs(),
          };
          await runtime.store.save(record);
          if (record.state === "destroyed") {
            await runtime.store.releaseGlobalAdmission(record);
          } else {
            await runtime.store.updateGlobalAdmission(record);
          }
          return jsonTextResult({ destroyed, proof, operation: record });
        } catch (error) {
          const message = formatError(error);
          const record: RailwayOperationRecord = {
            ...existing,
            state: "cleanup_uncertain",
            lastError: message,
            destroyProof: preProof,
            updatedAt: nowMs(),
          };
          await Promise.allSettled([
            runtime.store.save(record),
            runtime.store.updateGlobalAdmission(record),
          ]);
          throw new Error(
            `Railway sandbox cleanup is uncertain for ${operationId}; retain custody and do not allocate another sandbox. ${message}`,
          );
        }
      }

      throw new Error("Unsupported railway_sandbox action");
    },
  };
}

export function createRailwayExecTool(
  api: Pick<OpenClawPluginApi, "pluginConfig" | "runtime">,
  ctx?: OpenClawPluginToolContext,
  deps?: ToolDeps,
) {
  return {
    name: "railway_exec",
    label: "Railway Exec",
    resultContentSource: "network" as const,
    description:
      "Run a bounded command inside an already-created owned Railway sandbox. Failure never falls back to local execution.",
    parameters: RailwayExecToolSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      const runtime = createRuntime(api, deps);
      const operationId = requireOperationId(rawParams);
      const command = normalizeParamString(rawParams, "command", true)!;
      const timeoutSec = readInteger(rawParams, "timeout_sec", DEFAULT_COMMAND_TIMEOUT_SEC, MAX_COMMAND_TIMEOUT_SEC);
      const maxOutputChars = readInteger(rawParams, "max_output_chars", MAX_TOOL_OUTPUT_CHARS, MAX_TOOL_OUTPUT_CHARS);
      const record = await loadRunningOperation(runtime, operationId, ctx);
      try {
        const result = await runtime.client.exec(
          { environmentId: record.environmentId, id: record.sandboxId!, command, timeoutSec },
          signal,
        );
        const receipt = {
          completedAt: nowMs(),
          commandHash: hashText(command),
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          truncated: result.truncated,
          stdoutPreview: previewText(result.stdout),
          stderrPreview: previewText(result.stderr),
        };
        await runtime.store.save({ ...record, lastExec: receipt, sandboxStatus: "RUNNING", updatedAt: nowMs() });
        return jsonTextResult(
          {
            operation_id: operationId,
            sandbox_id: record.sandboxId,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            truncated: result.truncated,
            stdout: capText(result.stdout, maxOutputChars),
            stderr: capText(result.stderr, maxOutputChars),
          },
          { status: result.exitCode === 0 && !result.timedOut ? "ok" : "failed", exitCode: result.exitCode },
        );
      } catch (error) {
        const message = formatError(error);
        await runtime.store.save({ ...record, lastError: message, updatedAt: nowMs() });
        throw new Error(`Railway exec outcome is uncertain for ${operationId}; custody is preserved and no local fallback was attempted. ${message}`);
      }
    },
  };
}

export function createRailwayFileTool(
  api: Pick<OpenClawPluginApi, "pluginConfig" | "runtime">,
  ctx?: OpenClawPluginToolContext,
  deps?: ToolDeps,
) {
  return {
    name: "railway_file",
    label: "Railway File",
    resultContentSource: "network" as const,
    description:
      "Read, write, or list bounded UTF-8 files inside an owned Railway sandbox workspace via sandboxExec.",
    parameters: RailwayFileToolSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      const runtime = createRuntime(api, deps);
      const operationId = requireOperationId(rawParams);
      const action = readAction(rawParams);
      const remotePath = normalizeRemotePath(normalizeParamString(rawParams, "path", true)!, { allowRoot: action === "list" });
      const record = await loadRunningOperation(runtime, operationId, ctx);
      const maxBytes = readInteger(rawParams, "max_bytes", MAX_FILE_BYTES, MAX_FILE_BYTES);
      let command: string;
      if (action === "write") {
        const content = readRawString(rawParams, "content") ?? "";
        const bytes = Buffer.byteLength(content, "utf8");
        if (bytes > maxBytes) {
          throw new Error(`content is ${bytes} bytes, above max_bytes ${maxBytes}`);
        }
        const encoded = Buffer.from(content, "utf8").toString("base64");
        const target = anchoredPath(remotePath);
        const dir = path.posix.dirname(target);
        command = [
          workspacePreamble(),
          dir === "." ? "" : `mkdir -p -- ${shellQuote(dir)}`,
          `base64 -d > ${shellQuote(target)} <<'OPENCLAW_RAILWAY_FILE_B64'`,
          encoded,
          "OPENCLAW_RAILWAY_FILE_B64",
          `wc -c < ${shellQuote(target)}`,
        ]
          .filter(Boolean)
          .join("\n");
      } else if (action === "read") {
        const target = anchoredPath(remotePath);
        command = [
          workspacePreamble(),
          `bytes=$(wc -c < ${shellQuote(target)})`,
          `if [ "$bytes" -gt ${maxBytes} ]; then echo "file exceeds max_bytes" >&2; exit 64; fi`,
          `base64 < ${shellQuote(target)} | tr -d '\\n'`,
        ].join("\n");
      } else if (action === "list") {
        const target = anchoredPath(remotePath);
        command = `${workspacePreamble()}\nfind -- ${shellQuote(target)} -maxdepth 2 -mindepth 0 -printf '%y %p\\n' | sort | head -200`;
      } else {
        throw new Error("Unsupported railway_file action");
      }
      const result = await runtime.client.exec(
        { environmentId: record.environmentId, id: record.sandboxId!, command, timeoutSec: 60 },
        signal,
      );
      const receipt = {
        completedAt: nowMs(),
        action,
        path: remotePath,
        exitCode: result.exitCode,
        truncated: result.truncated,
      };
      let response: Record<string, unknown> = {
        operation_id: operationId,
        sandbox_id: record.sandboxId,
        action,
        path: remotePath,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        truncated: result.truncated,
        stderr: capText(result.stderr, 4000),
      };
      if (action === "read" && result.exitCode === 0) {
        if (result.truncated) {
          await runtime.store.save({ ...record, lastFile: receipt, lastError: "file read output was truncated", updatedAt: nowMs() });
          throw new Error("Railway file read output was truncated before complete base64 content was received");
        }
        response = { ...response, content: decodeBase64Utf8(result.stdout) };
      } else {
        response = { ...response, stdout: capText(result.stdout, 4000) };
      }
      await runtime.store.save({
        ...record,
        lastFile: {
          ...receipt,
          ...(action === "write" && typeof response.stdout === "string"
            ? { bytes: Number.parseInt(response.stdout.trim(), 10) || undefined }
            : {}),
        },
        updatedAt: nowMs(),
      });
      return jsonTextResult(response, { status: result.exitCode === 0 ? "ok" : "failed", exitCode: result.exitCode });
    },
  };
}
