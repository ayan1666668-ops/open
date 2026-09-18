// Persists device authorization records for paired nodes.
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import type { DeviceAuthEntry } from "../shared/device-auth.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerOperations } from "../state/openclaw-state-worker-contract.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import {
  createDeviceAuthEntry,
  type DeviceAuthTokenObservation,
} from "./device-auth-store.kernel.js";
import type { SqliteWorkerStore } from "./sqlite-worker-contract.js";
import { createSqliteWorkerOperationAdmission } from "./sqlite-worker-operation-admission.js";

export { clearDeviceAuthTokenFromDatabase } from "./device-auth-store.kernel.js";

// The Gateway lock makes state-directory contents process-stable. Cache both
// outcomes to keep reconnects free of freshness polling; Doctor invalidates
// the entry after its exclusive legacy import removes the retired file.
const legacyPresenceCache = new Map<string, boolean>();

function assertNoLegacyDeviceAuth(env: NodeJS.ProcessEnv | undefined): void {
  const stateDir = resolveStateDir(env);
  let hasLegacy = legacyPresenceCache.get(stateDir);
  if (hasLegacy === undefined) {
    hasLegacy = fs.existsSync(path.join(stateDir, "identity", "device-auth.json"));
    legacyPresenceCache.set(stateDir, hasLegacy);
  }
  if (hasLegacy) {
    throw new Error(
      "Legacy device auth requires migration; stop the Gateway and run `openclaw doctor --fix`.",
    );
  }
}

/** Forget one process-local legacy-state probe after Doctor removes the source. */
export function resetLegacyDeviceAuthPresenceCache(env: NodeJS.ProcessEnv): void {
  legacyPresenceCache.delete(resolveStateDir(env));
}

type DeviceAuthOperation = {
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  assertCurrent?: () => void;
};
type DeviceAuthLookup = DeviceAuthOperation & { deviceId: string; role: string };
type OriginDeviceAuthLookup = DeviceAuthLookup & { gatewayScope: string };
type DeviceAuthRead = {
  onSnapshot?: (observation: DeviceAuthTokenObservation) => void;
};
type DeviceAuthWrite = DeviceAuthLookup & {
  token: string;
  scopes?: string[];
  expectedToken?: string | null;
};
type DeviceAuthClear = DeviceAuthLookup & {
  expectedToken?: string;
  observedToken?: string;
};

type DeviceAuthCommand = Extract<keyof OpenClawStateWorkerOperations, `deviceAuth.${string}`>;

function executeDeviceAuth<Type extends DeviceAuthCommand>(
  params: DeviceAuthOperation,
  type: Type,
  input: OpenClawStateWorkerOperations[Type]["input"],
): Promise<OpenClawStateWorkerOperations[Type]["output"]>;
function executeDeviceAuth<Type extends DeviceAuthCommand>(
  params: DeviceAuthOperation,
  type: Type,
  input: OpenClawStateWorkerOperations[Type]["input"],
  readOnly: boolean,
): Promise<OpenClawStateWorkerOperations[Type]["output"] | undefined>;
async function executeDeviceAuth<Type extends DeviceAuthCommand>(
  params: DeviceAuthOperation,
  type: Type,
  input: OpenClawStateWorkerOperations[Type]["input"],
  readOnly = false,
): Promise<OpenClawStateWorkerOperations[Type]["output"] | undefined> {
  assertNoLegacyDeviceAuth(params.env);
  const context = captureOpenClawStateWorkerContext({ env: params.env });
  const { signal, assertCurrent } = params;
  const assertActive = () => {
    context.admission.assertCurrent();
    signal?.throwIfAborted();
    assertCurrent?.();
  };
  const mutation =
    type === "deviceAuth.store" ||
    type === "deviceAuth.storeOrigin" ||
    type === "deviceAuth.clear" ||
    type === "deviceAuth.clearOrigin";
  const operation = (scope: Pick<SqliteWorkerStore<OpenClawStateWorkerOperations>, "execute">) =>
    scope.execute({ type, input }, { signal });
  const options = {
    assertCurrent: assertActive,
    ...(mutation
      ? {
          createAdmission: () => ({
            nativeLocations: [context.admission.databasePath],
            admission: createSqliteWorkerOperationAdmission((request, grant) => {
              if (request.stage !== "transaction" && request.stage !== "commit") {
                throw new Error("Device token mutation requires transaction admission");
              }
              assertActive();
              grant();
            }),
          }),
        }
      : {}),
  };
  const result = await (readOnly
    ? runOpenClawStateWorkerOperation(context, operation, { ...options, existingOnly: true })
    : runOpenClawStateWorkerOperation(context, operation, options));
  // Missing stores settle without dispatching the callback, but still need current read authority.
  if (!mutation) {
    assertActive();
  }
  return result;
}

async function readDeviceAuth(
  params: DeviceAuthLookup & DeviceAuthRead & { gatewayScope?: string },
  readOnly: boolean,
): Promise<DeviceAuthEntry | null> {
  const { deviceId, role, gatewayScope, onSnapshot, signal, assertCurrent } = params;
  const observation = (await (gatewayScope === undefined
    ? executeDeviceAuth(params, "deviceAuth.read", { deviceId, role, readOnly }, readOnly)
    : executeDeviceAuth(
        params,
        "deviceAuth.readOrigin",
        { deviceId, role, gatewayScope, readOnly },
        readOnly,
      ))) ?? { entry: null, expectedToken: null };
  signal?.throwIfAborted();
  assertCurrent?.();
  onSnapshot?.(observation);
  return observation.entry;
}

export function loadDeviceAuthToken(
  params: DeviceAuthLookup & DeviceAuthRead,
): Promise<DeviceAuthEntry | null> {
  return readDeviceAuth(params, false);
}

export function loadDeviceAuthTokenReadOnly(
  params: DeviceAuthLookup & DeviceAuthRead,
): Promise<DeviceAuthEntry | null> {
  return readDeviceAuth(params, true);
}

export async function loadDeviceAuthTokens(
  params: DeviceAuthOperation & { deviceId: string },
): Promise<DeviceAuthEntry[]> {
  return await executeDeviceAuth(params, "deviceAuth.list", { deviceId: params.deviceId });
}

export async function storeDeviceAuthToken(
  params: DeviceAuthWrite,
): Promise<DeviceAuthEntry | null> {
  return await executeDeviceAuth(params, "deviceAuth.store", {
    deviceId: params.deviceId,
    ...createDeviceAuthEntry(params),
    expectedToken: params.expectedToken,
  });
}

export async function clearDeviceAuthToken(params: DeviceAuthClear): Promise<boolean> {
  const { deviceId, role, expectedToken, observedToken } = params;
  return await executeDeviceAuth(params, "deviceAuth.clear", {
    deviceId,
    role,
    expectedToken,
    observedToken,
  });
}

export function loadOriginDeviceToken(
  params: OriginDeviceAuthLookup & DeviceAuthRead,
): Promise<DeviceAuthEntry | null> {
  return readDeviceAuth(params, false);
}

export function loadOriginDeviceTokenReadOnly(
  params: OriginDeviceAuthLookup & DeviceAuthRead,
): Promise<DeviceAuthEntry | null> {
  return readDeviceAuth(params, true);
}

export async function storeOriginDeviceToken(
  params: DeviceAuthWrite & { gatewayScope: string },
): Promise<DeviceAuthEntry | null> {
  return await executeDeviceAuth(params, "deviceAuth.storeOrigin", {
    gatewayScope: params.gatewayScope,
    deviceId: params.deviceId,
    ...createDeviceAuthEntry(params),
    expectedToken: params.expectedToken,
  });
}

export async function clearOriginDeviceToken(
  params: DeviceAuthClear & { gatewayScope: string },
): Promise<boolean> {
  const { deviceId, role, gatewayScope, expectedToken, observedToken } = params;
  return await executeDeviceAuth(params, "deviceAuth.clearOrigin", {
    deviceId,
    role,
    gatewayScope,
    expectedToken,
    observedToken,
  });
}
