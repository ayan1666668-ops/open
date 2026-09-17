import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import {
  clampIdleTimeoutMinutes,
  clampResources,
  requireRailwayEnvironmentId,
  resolveRailwaySandboxConfig,
} from "./config.js";
import { createRailwaySandboxClient, type RailwaySandboxClient } from "./railway-api.js";
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
};

function textResult(text: string, details?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text }],
    ...(details ? { details } : {}),
  };
}

function jsonTextResult(value: unknown, details?: Record<string, unknown>) {
  return textResult(JSON.stringify(value, null, 2), details);
}

function readAction(params: Record<string, unknown>): string {
  return typeof params.action === "string" ? params.action : "";
}

function readString(params: Record<string, unknown>, key: string, required = false): string | undefined {
  const value = params[key];
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (required) {
    throw new Error(`${key} is required`);
  }
  return undefined;
}

function readInteger(params: Record<string, unknown>, key: string, fallback: number, max: number): number {
  const value = params[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return Math.min(value, max);
}

function requireOperationId(params: Record<string, unknown>): string {
  const operationId = readString(params, "operation_id", true)!;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,120}$/.test(operationId)) {
    throw new Error("operation_id must start with an alphanumeric character and contain only alphanumeric, _, ., :, or - characters");
  }
  return operationId;
}

function createRuntime(api: Pick<OpenClawPluginApi, "config" | "runtime">, deps?: ToolDeps) {
  const cfg = resolveRailwaySandboxConfig(api);
  return {
    cfg,
    client: deps?.client ?? createRailwaySandboxClient(cfg.cliCommand),
    store: deps?.store ?? openRailwayOperationStore(api),
  };
}

function ensureRunning(record: RailwayOperationRecord | undefined): RailwayOperationRecord {
  if (!record) {
    throw new Error("Railway sandbox operation is not recorded; create it with railway_sandbox first. No local fallback was attempted.");
  }
  if (!record.sandboxId || record.state !== "running") {
    throw new Error(`Railway sandbox operation is ${record.state}; no local fallback was attempted.`);
  }
  return record;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function normalizeRemotePath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed || trimmed.includes("\0") || path.isAbsolute(trimmed)) {
    throw new Error("path must be a non-empty relative path");
  }
  const normalized = path.posix.normalize(trimmed.replace(/\\/g, "/"));
  if (normalized === "." || normalized.startsWith("../") || normalized === "..") {
    throw new Error("path must stay inside the Railway sandbox workspace");
  }
  return normalized;
}

function capText(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const head = text.slice(0, Math.floor(max * 0.7));
  const tail = text.slice(text.length - Math.floor(max * 0.3));
  return `${head}\n[... truncated by railway-sandbox tool output cap ...]\n${tail}`;
}

async function loadRunningOperation(runtime: ReturnType<typeof createRuntime>, operationId: string) {
  return ensureRunning(await runtime.store.load(operationId));
}

async function verifyDestroyProof(params: {
  client: RailwaySandboxClient;
  environmentId: string;
  sandboxId: string;
  signal?: AbortSignal;
}) {
  const [sandbox, active] = await Promise.all([
    params.client.getSandbox({ environmentId: params.environmentId, id: params.sandboxId }, params.signal),
    params.client.listActiveSandboxes({ environmentId: params.environmentId, first: 50 }, params.signal),
  ]);
  return {
    checkedAt: nowMs(),
    status: sandbox?.status,
    activeInventoryEmpty: !active.some((item) => item.id === params.sandboxId),
  };
}

export function createRailwaySandboxTool(
  api: Pick<OpenClawPluginApi, "config" | "runtime">,
  ctx?: OpenClawPluginToolContext,
  deps?: ToolDeps,
) {
  return {
    name: "railway_sandbox",
    label: "Railway Sandbox",
    description:
      "Create, inspect, destroy, and list owned Railway sandboxes. Creates are at-most-once by durable operation_id and use ISOLATED networking with a finite idle timeout.",
    parameters: RailwaySandboxToolSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      const runtime = createRuntime(api, deps);
      const environmentId = requireRailwayEnvironmentId(runtime.cfg);
      const action = readAction(rawParams);

      if (action === "list_open") {
        const records = await runtime.store.list();
        return jsonTextResult({
          operations: records.filter((record) => record.state !== "destroyed"),
        });
      }

      const operationId = requireOperationId(rawParams);
      if (action === "status") {
        const record = await runtime.store.load(operationId);
        const live = record?.sandboxId
          ? await runtime.client.getSandbox({ environmentId: record.environmentId, id: record.sandboxId }, signal)
          : null;
        return jsonTextResult({ operation: record, live });
      }

      if (action === "create") {
        const idleTimeoutMinutes = clampIdleTimeoutMinutes(rawParams.idle_timeout_minutes, runtime.cfg);
        const resources = clampResources(rawParams.resources, runtime.cfg);
        const now = nowMs();
        const intent: RailwayOperationRecord = {
          version: 1,
          operationId,
          ...(ctx?.agentId ? { ownerAgentId: ctx.agentId } : {}),
          ...(ctx?.sessionKey ? { ownerSessionKey: ctx.sessionKey } : {}),
          environmentId,
          state: "creating",
          networkIsolation: "ISOLATED",
          idleTimeoutMinutes,
          resources,
          createdAt: now,
          updatedAt: now,
        };
        const registered = await runtime.store.registerCreateIntent(intent);
        if (!registered) {
          const existing = await runtime.store.load(operationId);
          if (existing?.sandboxId && existing.state === "running") {
            return jsonTextResult({ reused: true, operation: existing });
          }
          throw new Error(
            `Railway operation ${operationId} already has state ${existing?.state ?? "unknown"}; create will not be repeated or adopted.`,
          );
        }
        try {
          const sandbox = await runtime.client.createSandbox(
            { environmentId, idleTimeoutMinutes, resources },
            signal,
          );
          const record: RailwayOperationRecord = {
            ...intent,
            state: "running",
            sandboxId: sandbox.id,
            sandboxStatus: sandbox.status,
            updatedAt: nowMs(),
          };
          await runtime.store.save(record);
          return jsonTextResult({ created: true, operation: record, sandbox });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await runtime.store.save({
            ...intent,
            state: "create_uncertain",
            lastError: message,
            updatedAt: nowMs(),
          });
          throw new Error(
            `Railway sandbox create outcome is uncertain for ${operationId}; no duplicate create or local fallback was attempted. ${message}`,
          );
        }
      }

      if (action === "destroy") {
        const existing = await runtime.store.load(operationId);
        if (!existing?.sandboxId) {
          throw new Error(`Railway operation ${operationId} has no sandbox id to destroy.`);
        }
        await runtime.store.save({ ...existing, state: "destroying", updatedAt: nowMs() });
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
            state: proof.status === "DESTROYED" || proof.activeInventoryEmpty ? "destroyed" : "cleanup_uncertain",
            sandboxStatus: destroyed?.status ?? proof.status,
            destroyProof: proof,
            updatedAt: nowMs(),
          };
          await runtime.store.save(record);
          return jsonTextResult({ destroyed, proof, operation: record });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await runtime.store.save({
            ...existing,
            state: "cleanup_uncertain",
            lastError: message,
            updatedAt: nowMs(),
          });
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
  api: Pick<OpenClawPluginApi, "config" | "runtime">,
  _ctx?: OpenClawPluginToolContext,
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
      const command = readString(rawParams, "command", true)!;
      const timeoutSec = readInteger(rawParams, "timeout_sec", DEFAULT_COMMAND_TIMEOUT_SEC, MAX_COMMAND_TIMEOUT_SEC);
      const maxOutputChars = readInteger(rawParams, "max_output_chars", MAX_TOOL_OUTPUT_CHARS, MAX_TOOL_OUTPUT_CHARS);
      const record = await loadRunningOperation(runtime, operationId);
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
    },
  };
}

export function createRailwayFileTool(
  api: Pick<OpenClawPluginApi, "config" | "runtime">,
  _ctx?: OpenClawPluginToolContext,
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
      const remotePath = normalizeRemotePath(readString(rawParams, "path", true)!);
      const record = await loadRunningOperation(runtime, operationId);
      const maxBytes = readInteger(rawParams, "max_bytes", MAX_FILE_BYTES, MAX_FILE_BYTES);
      let command: string;
      if (action === "write") {
        const content = readString(rawParams, "content", false) ?? "";
        const bytes = Buffer.byteLength(content, "utf8");
        if (bytes > maxBytes) {
          throw new Error(`content is ${bytes} bytes, above max_bytes ${maxBytes}`);
        }
        const encoded = Buffer.from(content, "utf8").toString("base64");
        const dir = path.posix.dirname(remotePath);
        command = [
          "set -euo pipefail",
          dir === "." ? "" : `mkdir -p -- ${shellQuote(dir)}`,
          `base64 -d > ${shellQuote(remotePath)} <<'OPENCLAW_RAILWAY_FILE_B64'`,
          encoded,
          "OPENCLAW_RAILWAY_FILE_B64",
          `wc -c < ${shellQuote(remotePath)}`,
        ]
          .filter(Boolean)
          .join("\n");
      } else if (action === "read") {
        command = [
          "set -euo pipefail",
          `bytes=$(wc -c < ${shellQuote(remotePath)})`,
          `if [ "$bytes" -gt ${maxBytes} ]; then echo "file exceeds max_bytes" >&2; exit 64; fi`,
          `base64 < ${shellQuote(remotePath)} | tr -d '\\n'`,
        ].join("\n");
      } else if (action === "list") {
        command = `set -euo pipefail\nfind ${shellQuote(remotePath)} -maxdepth 2 -mindepth 0 -printf '%y %p\\n' | sort | head -200`;
      } else {
        throw new Error("Unsupported railway_file action");
      }
      const result = await runtime.client.exec(
        { environmentId: record.environmentId, id: record.sandboxId!, command, timeoutSec: 60 },
        signal,
      );
      let response: Record<string, unknown> = {
        operation_id: operationId,
        sandbox_id: record.sandboxId,
        action,
        path: remotePath,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        stderr: capText(result.stderr, 4000),
      };
      if (action === "read" && result.exitCode === 0) {
        response = { ...response, content: Buffer.from(result.stdout.trim(), "base64").toString("utf8") };
      } else {
        response = { ...response, stdout: capText(result.stdout, 4000) };
      }
      await runtime.store.save({
        ...record,
        lastFile: {
          completedAt: nowMs(),
          action,
          path: remotePath,
          exitCode: result.exitCode,
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
