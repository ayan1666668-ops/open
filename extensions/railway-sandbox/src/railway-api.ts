import type { RailwaySandboxResources } from "./config.js";

const RAILWAY_API_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_ERROR_PREVIEW_CHARS = 1200;

export type RailwaySandboxRecord = {
  id: string;
  environmentId: string;
  status: string;
  networkIsolation: string;
  idleTimeoutMinutes: number | null;
  region: string;
  createdAt?: string;
};

export type RailwaySandboxPage = {
  items: RailwaySandboxRecord[];
  pageInfo: {
    hasNextPage: boolean;
    endCursor?: string | null;
  };
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
  listActiveSandboxes(input: {
    environmentId: string;
    first?: number;
    after?: string | null;
  }, signal?: AbortSignal): Promise<RailwaySandboxPage>;
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

type RailwayClientOptions = {
  apiToken: string;
  apiEndpoint: string;
  fetchImpl?: typeof globalThis.fetch;
};

function formatGraphQlErrors(errors: Array<{ message?: string }> | undefined): string {
  return errors?.map((error) => error.message || "unknown GraphQL error").join("; ") || "unknown GraphQL error";
}

function sanitizeRailwayError(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [redacted]")
    .replace(/(token|api[-_]?key|authorization)\s*[:=]\s*[^\s,;}]+/giu, "$1=[redacted]")
    .slice(0, MAX_ERROR_PREVIEW_CHARS);
}

function timeoutSignal(signal: AbortSignal | undefined): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(RAILWAY_API_TIMEOUT_MS)]) : AbortSignal.timeout(RAILWAY_API_TIMEOUT_MS);
}

async function runRailwayApi<T>(params: {
  apiEndpoint: string;
  apiToken: string;
  fetchImpl?: typeof globalThis.fetch;
  query: string;
  variables: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<T> {
  const fetchImpl = params.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("Railway API unavailable; runtime fetch transport is not available and no CLI fallback is allowed");
  }
  try {
    const response = await fetchImpl(params.apiEndpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${params.apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query: params.query, variables: params.variables }),
      signal: timeoutSignal(params.signal),
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${sanitizeRailwayError(body)}`);
    }
    const parsed = JSON.parse(body) as RailwayCliGraphQlResponse<T>;
    if (parsed.errors?.length) {
      throw new Error(`Railway GraphQL error: ${sanitizeRailwayError(formatGraphQlErrors(parsed.errors))}`);
    }
    if (parsed.data === undefined) {
      throw new Error("Railway GraphQL response did not include data");
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Railway API unavailable; no local fallback was attempted: ${sanitizeRailwayError(error.message)}`);
    }
    throw new Error("Railway API unavailable; no local fallback was attempted");
  }
}

const SANDBOX_FIELDS = `
    id
    environmentId
    status
    networkIsolation
    idleTimeoutMinutes
    region
    createdAt`;

export function createRailwaySandboxClient(options: RailwayClientOptions): RailwaySandboxClient {
  const run = <T>(params: { query: string; variables: Record<string, unknown>; signal?: AbortSignal }) =>
    runRailwayApi<T>({
      apiEndpoint: options.apiEndpoint,
      apiToken: options.apiToken,
      fetchImpl: options.fetchImpl,
      query: params.query,
      variables: params.variables,
      signal: params.signal,
    });

  return {
    async createSandbox(input, signal) {
      const data = await run<{ sandboxCreate: RailwaySandboxRecord }>({
        signal,
        query: `mutation CreateSandbox($input: SandboxCreateInput!) {
  sandboxCreate(input: $input) {${SANDBOX_FIELDS}
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
      const data = await run<{ sandbox: RailwaySandboxRecord | null }>({
        signal,
        query: `query GetSandbox($environmentId: String!, $id: String!) {
  sandbox(environmentId: $environmentId, id: $id) {${SANDBOX_FIELDS}
  }
}`,
        variables: input,
      });
      return data.sandbox;
    },
    async listActiveSandboxes(input, signal) {
      const data = await run<{
        sandboxes: {
          edges: Array<{ node: RailwaySandboxRecord }>;
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        };
      }>({
        signal,
        query: `query ListSandboxes($environmentId: String!, $active: Boolean, $first: Int, $after: String) {
  sandboxes(environmentId: $environmentId, active: $active, first: $first, after: $after) {
    edges {
      node {${SANDBOX_FIELDS}
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`,
        variables: { environmentId: input.environmentId, active: true, first: input.first ?? 50, after: input.after ?? null },
      });
      return {
        items: data.sandboxes.edges.map((edge) => edge.node),
        pageInfo: {
          hasNextPage: data.sandboxes.pageInfo?.hasNextPage === true,
          endCursor: data.sandboxes.pageInfo?.endCursor ?? null,
        },
      };
    },
    async destroySandbox(input, signal) {
      const data = await run<{ sandboxDestroy: RailwaySandboxRecord | null }>({
        signal,
        query: `mutation DestroySandbox($environmentId: String!, $id: String!) {
  sandboxDestroy(environmentId: $environmentId, id: $id) {${SANDBOX_FIELDS}
  }
}`,
        variables: input,
      });
      return data.sandboxDestroy;
    },
    async exec(input, signal) {
      const data = await run<{ sandboxExec: RailwayExecResult }>({
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
