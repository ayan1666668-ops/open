import fs from "node:fs/promises";
import path from "node:path";
import { resolveGatewayInstallEntrypoint } from "../daemon/gateway-entrypoint.js";
import {
  parseOpenClawSchemaVersions,
  parsePackageOpenClawSchemaVersions,
  type OpenClawSchemaVersions,
} from "../state/openclaw-schema-versions.js";
import { tryReadJson } from "./json-files.js";

export type UpdateCandidateRuntimeIdentity = {
  root: string;
  nodeRunner: string;
  entrypoint: string;
  version: string;
  schemaVersions: OpenClawSchemaVersions;
};

async function canonicalPath(value: string): Promise<string> {
  return await fs.realpath(path.resolve(value));
}

export async function resolveUpdateCandidateRuntimeIdentity(params: {
  root: string;
  nodeRunner: string;
  entrypoint?: string;
}): Promise<UpdateCandidateRuntimeIdentity> {
  const packageJson = await tryReadJson<unknown>(path.join(params.root, "package.json"));
  if (!packageJson || typeof packageJson !== "object" || Array.isArray(packageJson)) {
    throw new Error(`Candidate package metadata is unreadable under ${params.root}.`);
  }
  const manifest = packageJson as Record<string, unknown>;
  const version = typeof manifest.version === "string" ? manifest.version.trim() : "";
  const schemaVersions = parsePackageOpenClawSchemaVersions(packageJson);
  const entrypoint = params.entrypoint ?? (await resolveGatewayInstallEntrypoint(params.root));
  if (!version || !schemaVersions || !entrypoint) {
    throw new Error(
      `Candidate runtime identity is incomplete under ${params.root}: ` +
        `version=${version || "unknown"}, schemas=${schemaVersions ? `${schemaVersions.state}/${schemaVersions.agent}` : "unknown"}, entrypoint=${entrypoint ?? "missing"}.`,
    );
  }
  const [root, nodeRunner, canonicalEntrypoint] = await Promise.all([
    canonicalPath(params.root),
    canonicalPath(params.nodeRunner),
    canonicalPath(entrypoint),
  ]);
  return {
    root,
    nodeRunner,
    entrypoint: canonicalEntrypoint,
    version,
    schemaVersions,
  };
}

export function parseUpdateCandidateRuntimeIdentity(
  value: unknown,
): UpdateCandidateRuntimeIdentity | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const schemaVersions = parseOpenClawSchemaVersions(record.schemaVersions);
  return typeof record.root === "string" &&
    path.isAbsolute(record.root) &&
    typeof record.nodeRunner === "string" &&
    path.isAbsolute(record.nodeRunner) &&
    typeof record.entrypoint === "string" &&
    path.isAbsolute(record.entrypoint) &&
    typeof record.version === "string" &&
    record.version.length > 0 &&
    schemaVersions
    ? {
        root: record.root,
        nodeRunner: record.nodeRunner,
        entrypoint: record.entrypoint,
        version: record.version,
        schemaVersions,
      }
    : undefined;
}

export function updateCandidateRuntimeIdentityMatches(
  expected: UpdateCandidateRuntimeIdentity,
  actual: UpdateCandidateRuntimeIdentity | undefined,
): boolean {
  return (
    actual !== undefined &&
    actual.root === expected.root &&
    actual.nodeRunner === expected.nodeRunner &&
    actual.entrypoint === expected.entrypoint &&
    actual.version === expected.version &&
    actual.schemaVersions.state === expected.schemaVersions.state &&
    actual.schemaVersions.agent === expected.schemaVersions.agent
  );
}

export function formatUpdateCandidateRuntimeIdentity(
  identity: UpdateCandidateRuntimeIdentity,
): string {
  return (
    `runtime=${identity.nodeRunner}; root=${identity.root}; entrypoint=${identity.entrypoint}; ` +
    `version=${identity.version}; schema-support=state:${identity.schemaVersions.state},agent:${identity.schemaVersions.agent}`
  );
}

export function formatUpdateCandidateSchemaMismatch(
  identity: UpdateCandidateRuntimeIdentity,
  actual: OpenClawSchemaVersions,
): string | undefined {
  return actual.state === identity.schemaVersions.state &&
    actual.agent === identity.schemaVersions.agent
    ? undefined
    : `Candidate recovery schema contract does not match ${formatUpdateCandidateRuntimeIdentity(identity)}; reported=state:${actual.state},agent:${actual.agent}.`;
}

export function parseUpdateCandidateRuntimeContract(
  value: unknown,
  identity: UpdateCandidateRuntimeIdentity,
): {
  schemaVersions?: OpenClawSchemaVersions;
  doctorConfigWrites: boolean;
  error?: string;
} {
  const schemaVersions = parseOpenClawSchemaVersions(value);
  const doctorConfigWrites =
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).doctorConfigWrites === "pid-start-v1";
  return schemaVersions
    ? {
        schemaVersions,
        doctorConfigWrites,
        error: formatUpdateCandidateSchemaMismatch(identity, schemaVersions),
      }
    : {
        doctorConfigWrites,
        error: "The update did not report its supported database versions",
      };
}
