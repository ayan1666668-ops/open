import { createHash } from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import type {
  PluginStateCompareResult,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
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
    activeInventoryCompleted: boolean;
    activeInventoryHasSandbox: boolean;
    verifiedDestroyed: boolean;
    contradiction?: string;
  };
};

export type RailwayGlobalAdmissionRecord = {
  version: 1;
  operationId: string;
  ownerAgentId: string;
  ownerSessionKey: string;
  environmentId: string;
  state: RailwayOperationState;
  sandboxId?: string;
  updatedAt: number;
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
  truncated?: boolean;
};

export type GlobalAdmissionResult =
  | { status: "acquired" | "held"; admission: RailwayGlobalAdmissionRecord }
  | { status: "blocked"; admission: RailwayGlobalAdmissionRecord };

export type RailwayOperationStore = {
  registerCreateIntent(record: RailwayOperationRecord): Promise<boolean>;
  load(operationId: string): Promise<RailwayOperationRecord | undefined>;
  save(record: RailwayOperationRecord): Promise<void>;
  list(): Promise<RailwayOperationRecord[]>;
  acquireGlobalAdmission(record: RailwayOperationRecord): Promise<GlobalAdmissionResult>;
  updateGlobalAdmission(record: RailwayOperationRecord): Promise<void>;
  releaseGlobalAdmission(record: RailwayOperationRecord): Promise<boolean>;
  loadGlobalAdmission(): Promise<RailwayGlobalAdmissionRecord | undefined>;
};

const STATE_NAMESPACE = "operations";
const GLOBAL_STATE_NAMESPACE = "global-admission";
const GLOBAL_ADMISSION_KEY = "active";
const MAX_STATE_ENTRIES = 500;

const OPEN_STATES = new Set<RailwayOperationState>([
  "creating",
  "running",
  "create_uncertain",
  "destroying",
  "cleanup_uncertain",
]);

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

function admissionFromRecord(record: RailwayOperationRecord): RailwayGlobalAdmissionRecord {
  if (!record.ownerAgentId || !record.ownerSessionKey) {
    throw new Error("Railway sandbox global admission requires a recorded owner agent and session");
  }
  return {
    version: 1,
    operationId: record.operationId,
    ownerAgentId: record.ownerAgentId,
    ownerSessionKey: record.ownerSessionKey,
    environmentId: record.environmentId,
    state: record.state,
    ...(record.sandboxId ? { sandboxId: record.sandboxId } : {}),
    updatedAt: nowMs(),
  };
}

function normalizeAdmission(value: unknown): RailwayGlobalAdmissionRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as RailwayGlobalAdmissionRecord;
  if (
    record.version !== 1 ||
    typeof record.operationId !== "string" ||
    typeof record.ownerAgentId !== "string" ||
    typeof record.ownerSessionKey !== "string" ||
    typeof record.environmentId !== "string" ||
    typeof record.state !== "string"
  ) {
    return undefined;
  }
  return record;
}

function isOpenAdmission(record: RailwayGlobalAdmissionRecord | undefined): record is RailwayGlobalAdmissionRecord {
  return Boolean(record && OPEN_STATES.has(record.state));
}

function requireAtomicCompare<T>(store: PluginStateKeyedStore<T>): Required<Pick<PluginStateKeyedStore<T>, "observe" | "compareAndApply">> {
  if (typeof store.observe !== "function" || typeof store.compareAndApply !== "function") {
    throw new Error(
      "Railway sandbox global admission requires atomic plugin-state compareAndApply support; allocation refused",
    );
  }
  return { observe: store.observe.bind(store), compareAndApply: store.compareAndApply.bind(store) };
}

function conflictAdmission<T>(result: PluginStateCompareResult<T>): RailwayGlobalAdmissionRecord | undefined {
  return result.status === "conflict" ? normalizeAdmission(result.current.value) : undefined;
}

export function openRailwayOperationStore(api: Pick<OpenClawPluginApi, "runtime">): RailwayOperationStore {
  const store = api.runtime.state.openKeyedStore<RailwayOperationRecord>({
    namespace: STATE_NAMESPACE,
    maxEntries: MAX_STATE_ENTRIES,
    overflowPolicy: "reject-new",
  }) as PluginStateKeyedStore<RailwayOperationRecord>;
  const globalStore = api.runtime.state.openKeyedStore<RailwayGlobalAdmissionRecord>({
    namespace: GLOBAL_STATE_NAMESPACE,
    maxEntries: 1,
    overflowPolicy: "reject-new",
  }) as PluginStateKeyedStore<RailwayGlobalAdmissionRecord>;

  return {
    async registerCreateIntent(record) {
      if (typeof store.registerIfAbsent !== "function") {
        throw new Error("Railway sandbox create intent requires atomic registerIfAbsent support; allocation refused");
      }
      return await store.registerIfAbsent(record.operationId, record);
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
    async acquireGlobalAdmission(record) {
      const atomic = requireAtomicCompare(globalStore);
      const candidate = admissionFromRecord(record);
      const observed = await atomic.observe(GLOBAL_ADMISSION_KEY);
      const current = normalizeAdmission(observed.value);
      if (isOpenAdmission(current)) {
        return current.operationId === candidate.operationId
          ? { status: "held", admission: current }
          : { status: "blocked", admission: current };
      }
      const result = await atomic.compareAndApply(GLOBAL_ADMISSION_KEY, observed.comparison, {
        operation: "update",
        action: "set",
        value: candidate,
      });
      if (result.status === "conflict") {
        const conflict = conflictAdmission(result);
        if (isOpenAdmission(conflict) && conflict.operationId !== candidate.operationId) {
          return { status: "blocked", admission: conflict };
        }
        throw new Error("Railway sandbox global admission changed concurrently; allocation refused without retry");
      }
      return { status: "acquired", admission: candidate };
    },
    async updateGlobalAdmission(record) {
      const atomic = requireAtomicCompare(globalStore);
      const candidate = admissionFromRecord(record);
      const observed = await atomic.observe(GLOBAL_ADMISSION_KEY);
      const current = normalizeAdmission(observed.value);
      if (isOpenAdmission(current) && current.operationId !== candidate.operationId) {
        throw new Error(`Railway sandbox global admission belongs to ${current.operationId}; refusing to update ${candidate.operationId}`);
      }
      const result = await atomic.compareAndApply(GLOBAL_ADMISSION_KEY, observed.comparison, {
        operation: "update",
        action: "set",
        value: candidate,
      });
      if (result.status === "conflict") {
        throw new Error("Railway sandbox global admission changed concurrently; custody update refused");
      }
    },
    async releaseGlobalAdmission(record) {
      const atomic = requireAtomicCompare(globalStore);
      const observed = await atomic.observe(GLOBAL_ADMISSION_KEY);
      const current = normalizeAdmission(observed.value);
      if (!current) {
        return true;
      }
      if (current.operationId !== record.operationId) {
        return false;
      }
      const result = await atomic.compareAndApply(GLOBAL_ADMISSION_KEY, observed.comparison, {
        operation: "delete",
        action: "delete",
      });
      return result.status !== "conflict";
    },
    async loadGlobalAdmission() {
      return normalizeAdmission(await globalStore.lookup(GLOBAL_ADMISSION_KEY));
    },
  };
}
