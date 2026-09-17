import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { RailwaySandboxResources } from "./config.js";

const execFileAsync = promisify(execFile);
const RAILWAY_API_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_STDIO_BUFFER = 2 * 1024 * 1024;

export type RailwaySandboxRecord = {
  id: string;
  environmentId: string;
  status: string;
  networkIsolation: string;
  idleTimeoutMinutes: number | null;
  region: string;
  createdAt?: string;
};

export type RailwayExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
};

export type RailwaySandboxClient = {
  createSandbox(input: {
    environmentId: string;
    idleTimeoutMinutes: number;
    resources: RailwaySandboxResources;
  }, signal?: AbortSignal): Promise<RailwaySandboxRecord>;
  getSandbox(input: { environmentId: string; id: string }, signal?: AbortSignal): Promise<RailwaySandboxRecord | null>;
  listActiveSandboxes(input: { environmentId: string; first?: number }, signal?: AbortSignal): Promise<RailwaySandboxRecord[]>;
  destroySandbox(input: { environmentId: string; id: string }, signal?: AbortSignal): Promise<RailwaySandboxRecord | null>;
  exec(input: {
    environmentId: string;
    id: string;
    command: string;
    timeoutSec?: number;
  }, signal?: AbortSignal): Promise<RailwayExecResult>;
};

type RailwayCliGraphQlResponse<T> = {
  data?: T;
  errors?: Array<{ message?: string }>;
};

function formatGraphQlErrors(errors: Array<{ message?: string }> | undefined): string {
  return errors?.map((error) => error.message || "unknown GraphQL error").join("; ") || "unknown GraphQL error";
}

async function runRailwayApi<T>(params: {
  cliCommand: string;
  query: string;
  variables: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "openclaw-railway-api-"));
  const queryPath = path.join(dir, "query.graphql");
  const variablesPath = path.join(dir, "variables.json");
  try {
    await writeFile(queryPath, params.query, "utf8");
    await writeFile(variablesPath, JSON.stringify(params.variables), "utf8");
    const { stdout } = await execFileAsync(
      params.cliCommand,
      ["api", "--compact", "--file", queryPath, "--variables", `@${variablesPath}`],
      {
        encoding: "utf8",
        maxBuffer: MAX_STDIO_BUFFER,
        timeout: RAILWAY_API_TIMEOUT_MS,
        ...(params.signal ? { signal: params.signal } : {}),
      },
    );
    const parsed = JSON.parse(stdout) as RailwayCliGraphQlResponse<T>;
    if (parsed.errors?.length) {
      throw new Error(`Railway GraphQL error: ${formatGraphQlErrors(parsed.errors)}`);
    }
    if (parsed.data === undefined) {
      throw new Error("Railway GraphQL response did not include data");
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Railway API unavailable; no local fallback was attempted: ${error.message}`);
    }
    throw new Error("Railway API unavailable; no local fallback was attempted");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function createRailwaySandboxClient(cliCommand: string): RailwaySandboxClient {
  return {
    async createSandbox(input, signal) {
      const data = await runRailwayApi<{ sandboxCreate: RailwaySandboxRecord }>({
        cliCommand,
        signal,
        query: `mutation CreateSandbox($input: SandboxCreateInput!) {
  sandboxCreate(input: $input) {
    id
    environmentId
    status
    networkIsolation
    idleTimeoutMinutes
    region
    createdAt
  }
}`,
        variables: {
          input: {
            environmentId: input.environmentId,
            idleTimeoutMinutes: input.idleTimeoutMinutes,
            networkIsolation: "ISOLATED",
            resources: input.resources,
          },
        },
      });
      return data.sandboxCreate;
    },
    async getSandbox(input, signal) {
      const data = await runRailwayApi<{ sandbox: RailwaySandboxRecord | null }>({
        cliCommand,
        signal,
        query: `query GetSandbox($environmentId: String!, $id: String!) {
  sandbox(environmentId: $environmentId, id: $id) {
    id
    environmentId
    status
    networkIsolation
    idleTimeoutMinutes
    region
    createdAt
  }
}`,
        variables: input,
      });
      return data.sandbox;
    },
    async listActiveSandboxes(input, signal) {
      const data = await runRailwayApi<{
        sandboxes: { edges: Array<{ node: RailwaySandboxRecord }> };
      }>({
        cliCommand,
        signal,
        query: `query ListSandboxes($environmentId: String!, $active: Boolean, $first: Int) {
  sandboxes(environmentId: $environmentId, active: $active, first: $first) {
    edges {
      node {
        id
        environmentId
        status
        networkIsolation
        idleTimeoutMinutes
        region
        createdAt
      }
    }
  }
}`,
        variables: { environmentId: input.environmentId, active: true, first: input.first ?? 50 },
      });
      return data.sandboxes.edges.map((edge) => edge.node);
    },
    async destroySandbox(input, signal) {
      const data = await runRailwayApi<{ sandboxDestroy: RailwaySandboxRecord | null }>({
        cliCommand,
        signal,
        query: `mutation DestroySandbox($environmentId: String!, $id: String!) {
  sandboxDestroy(environmentId: $environmentId, id: $id) {
    id
    environmentId
    status
    networkIsolation
    idleTimeoutMinutes
    region
    createdAt
  }
}`,
        variables: input,
      });
      return data.sandboxDestroy;
    },
    async exec(input, signal) {
      const data = await runRailwayApi<{ sandboxExec: RailwayExecResult }>({
        cliCommand,
        signal,
        query: `mutation ExecSandbox($environmentId: String!, $id: String!, $command: String!, $timeoutSec: Int) {
  sandboxExec(environmentId: $environmentId, id: $id, command: $command, timeoutSec: $timeoutSec) {
    exitCode
    stdout
    stderr
    timedOut
    truncated
  }
}`,
        variables: input,
      });
      return data.sandboxExec;
    },
  };
}
