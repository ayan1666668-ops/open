import { formatErrorMessage } from "../../infra/errors.js";
import {
  resolveUpdateCandidateRuntimeIdentity,
  type UpdateCandidateRuntimeIdentity,
} from "../../infra/update-candidate-runtime-identity.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import { defaultRuntime } from "../../runtime.js";
import type { OpenClawSchemaVersions } from "../../state/openclaw-schema-versions.js";
import {
  checkTargetDatabaseSchemasForContexts,
  formatSchemaRefusalLines,
  hasSchemaRefusal,
} from "./schema-preflight.js";
import { resolveNodeRunner, UpdatePreMutationError } from "./shared.js";
import { inspectUpdateDatabaseContexts } from "./update-command-database-context.js";
import { revalidateUpdateDatabaseContext } from "./update-command-managed-context.js";
import { isUpdatedInstallGatewayExecutorSupported } from "./update-command-service-command.js";
import { resolveUpdatedInstallCommandEnv } from "./update-command-service-env.js";

type UpdateDatabaseAdmission = Awaited<ReturnType<typeof inspectUpdateDatabaseContexts>>;

export async function resolvePackageUpdateCandidateRuntime(params: {
  root: string;
  nodeRunner?: string;
}): Promise<UpdateCandidateRuntimeIdentity> {
  const nodeRunner = params.nodeRunner ?? resolveNodeRunner();
  try {
    return await resolveUpdateCandidateRuntimeIdentity({ root: params.root, nodeRunner });
  } catch (error) {
    throw new UpdatePreMutationError(
      "target-runtime-identity",
      `Candidate runtime identity preflight failed for runtime=${nodeRunner}; root=${params.root}; version=unknown; schema-support=unknown: ${formatErrorMessage(error)}`,
      { cause: error },
    );
  }
}

export async function recheckUpdateAdmissionSchemas(params: {
  admission: UpdateDatabaseAdmission | undefined;
  versions: OpenClawSchemaVersions | undefined;
  candidateRuntime?: UpdateCandidateRuntimeIdentity;
  revalidateServices: (admission: UpdateDatabaseAdmission) => Promise<void>;
}): Promise<void> {
  if (!params.admission) {
    throw new UpdatePreMutationError(
      "database-schema-preflight",
      "Database admission was not inspected.",
    );
  }
  await params.revalidateServices(params.admission);
  params.admission.contexts = await Promise.all(
    params.admission.contexts.map(revalidateUpdateDatabaseContext),
  );
  const schemas = await checkTargetDatabaseSchemasForContexts(
    params.versions,
    params.admission.contexts,
  );
  if (hasSchemaRefusal(schemas)) {
    throw new UpdatePreMutationError(
      "database-schema-preflight",
      formatSchemaRefusalLines(schemas, false, params.candidateRuntime).join("\n"),
    );
  }
}

export async function preflightUpdateCandidatePlugins(params: {
  context: UpdateDatabaseAdmission["contexts"][number];
  targetVersion: string | null;
  channel: Parameters<
    typeof import("./update-command-plugin-preflight.js").preflightConfiguredNpmPluginTargets
  >[0]["channel"];
  timeoutMs: number;
  jsonMode: boolean;
}): Promise<void> {
  const { preflightConfiguredNpmPluginTargets } =
    await import("./update-command-plugin-preflight.js");
  const warnings = await preflightConfiguredNpmPluginTargets({
    config: params.context.configSnapshot.sourceConfig,
    env: params.context.env,
    targetVersion: params.targetVersion,
    channel: params.channel,
    timeoutMs: params.timeoutMs,
  });
  for (const warning of warnings) {
    defaultRuntime[params.jsonMode ? "error" : "log"](warning.message);
  }
}

/** Prove the exact candidate can own native service mutation before activation. */
export async function assertUpdateCandidateNativeServiceSupport(params: {
  root: string;
  processEnv: NodeJS.ProcessEnv;
  invocationCwd?: string;
  executor: UpdateRecoveryFence;
  timeoutMs: number;
  nodeRunner?: string;
  signal?: AbortSignal;
}): Promise<void> {
  let failureDetail: string | undefined;
  const supported = await isUpdatedInstallGatewayExecutorSupported({
    root: params.root,
    env: resolveUpdatedInstallCommandEnv({
      processEnv: params.processEnv,
      invocationCwd: params.invocationCwd,
    }),
    executor: params.executor,
    timeoutMs: params.timeoutMs,
    nodeRunner: params.nodeRunner,
    signal: params.signal,
    onFailureDetail: (detail) => {
      failureDetail = detail;
    },
  });
  if (!supported) {
    throw new UpdatePreMutationError(
      "target-native-unsupported",
      [
        "Target runtime cannot fence update-owned native commands; refusing before Gateway stop or package activation.",
        failureDetail,
      ]
        .filter(Boolean)
        .join(" "),
    );
  }
}
