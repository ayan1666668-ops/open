import { createHash } from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { RailwaySandboxResources } from "./config.js";

export type RailwayOperationState =
  | "creating"
  | "running"
  | "create_uncertain"
  | "destroying"
  | "destroyed"
  | "cleanup_uncertain";

export type RailwayOperationRecord = {
  version: 1;
  operationId: string;
  ownerAgentId?: string;
  ownerSessionKey?: string;
  environmentId: string;
  state: RailwayOperationState;
  sandboxId?: string;
  sandboxStatus?: string;
  networkIsolation: "ISOLATED";
  idleTimeoutMinutes: number;
  resources: RailwaySandboxResources;
  createdAt: number;
  updatedAt: number;
  lastError?: string;
  lastExec?: CompactExecReceipt;
  lastFile?: CompactFileReceipt;
  destroyProof?: {
    checkedAt: number;
    status?: string;
    activeInventoryEmpty?: boolean;
  };
};

export type CompactExecReceipt = {
  completedAt: number;
  commandHash: string;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
  stdoutPreview?: string;
  stderrPreview?: string;
};

export type CompactFileReceipt = {
  completedAt: number;
  action: string;
  path: string;
  exitCode: number;
  bytes?: number;
};

export type RailwayOperationStore = {
  registerCreateIntent(record: RailwayOperationRecord): Promise<boolean>;
  load(operationId: string): Promise<RailwayOperationRecord | undefined>;
  save(record: RailwayOperationRecord): Promise<void>;
  list(): Promise<RailwayOperationRecord[]>;
};

const STATE_NAMESPACE = "operations";
const MAX_STATE_ENTRIES = 500;

export function nowMs(): number {
  return Date.now();
}

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export function previewText(text: string, max = 2000): string | undefined {
  if (!text) {
    return undefined;
  }
  if (text.length <= max) {
    return text;
  }
  const head = text.slice(0, Math.floor(max * 0.7));
  const tail = text.slice(text.length - Math.floor(max * 0.3));
  return `${head}\n[... truncated by railway-sandbox plugin receipt ...]\n${tail}`;
}

function normalizeRecord(value: unknown): RailwayOperationRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as RailwayOperationRecord;
  if (
    record.version !== 1 ||
    typeof record.operationId !== "string" ||
    typeof record.environmentId !== "string" ||
    typeof record.state !== "string"
  ) {
    return undefined;
  }
  return record;
}

export function openRailwayOperationStore(api: Pick<OpenClawPluginApi, "runtime">): RailwayOperationStore {
  const store = api.runtime.state.openKeyedStore<RailwayOperationRecord>({
    namespace: STATE_NAMESPACE,
    maxEntries: MAX_STATE_ENTRIES,
    overflowPolicy: "reject-new",
  }) as PluginStateKeyedStore<RailwayOperationRecord> & {
    registerIfAbsent?: PluginStateKeyedStore<RailwayOperationRecord>["registerIfAbsent"];
  };
  return {
    async registerCreateIntent(record) {
      if (store.registerIfAbsent) {
        return await store.registerIfAbsent(record.operationId, record);
      }
      const existing = normalizeRecord(await store.lookup(record.operationId));
      if (existing) {
        return false;
      }
      await store.register(record.operationId, record);
      return true;
    },
    async load(operationId) {
      return normalizeRecord(await store.lookup(operationId));
    },
    async save(record) {
      await store.register(record.operationId, record);
    },
    async list() {
      const entries = await store.entries();
      return entries.map((entry) => normalizeRecord(entry.value)).filter(Boolean) as RailwayOperationRecord[];
    },
  };
}
