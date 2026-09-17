import { describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import railwaySandboxPlugin from "../index.js";
import { evaluateHeavyLocalWorkBoundary } from "./policy.js";
import { classifyHeavyCommand } from "./shell-classifier.js";
import {
  createRailwayExecTool,
  createRailwayFileTool,
  createRailwaySandboxTool,
} from "./tools.js";
import type { RailwaySandboxClient, RailwaySandboxRecord, RailwayExecResult } from "./railway-api.js";
import type { RailwayOperationRecord, RailwayOperationStore } from "./state.js";

const FIVE_SEATS = ["main", "ada", "codeops", "editor", "writer"];

function testConfig() {
  return {
    railwaySandbox: {
      environmentId: "env-test",
      enforceAgents: FIVE_SEATS,
      enforceHeavyLocalExec: true,
      defaultIdleTimeoutMinutes: 6,
      defaultResources: { cpu: 1, memoryGB: 1 },
    },
  };
}

function parseToolJson(result: Awaited<ReturnType<ReturnType<typeof createRailwayExecTool>["execute"]>>) {
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  return JSON.parse(text);
}

function createMemoryStore(): RailwayOperationStore {
  const records = new Map<string, RailwayOperationRecord>();
  return {
    async registerCreateIntent(record) {
      if (records.has(record.operationId)) {
        return false;
      }
      records.set(record.operationId, structuredClone(record));
      return true;
    },
    async load(operationId) {
      const record = records.get(operationId);
      return record ? structuredClone(record) : undefined;
    },
    async save(record) {
      records.set(record.operationId, structuredClone(record));
    },
    async list() {
      return [...records.values()].map((record) => structuredClone(record));
    },
  };
}

function runningRecord(operationId = "op-1"): RailwayOperationRecord {
  return {
    version: 1,
    operationId,
    ownerAgentId: "codeops",
    ownerSessionKey: "session-1",
    environmentId: "env-test",
    state: "running",
    sandboxId: "sandbox-1",
    sandboxStatus: "RUNNING",
    networkIsolation: "ISOLATED",
    idleTimeoutMinutes: 6,
    resources: { cpu: 1, memoryGB: 1 },
    createdAt: 1,
    updatedAt: 1,
  };
}

function sandbox(id = "sandbox-1", status = "RUNNING"): RailwaySandboxRecord {
  return {
    id,
    environmentId: "env-test",
    status,
    networkIsolation: "ISOLATED",
    idleTimeoutMinutes: 6,
    region: "us-west2",
    createdAt: "2026-09-17T00:00:00Z",
  };
}

function createFakeClient(overrides: Partial<RailwaySandboxClient> = {}) {
  const execResults: RailwayExecResult[] = [];
  const client: RailwaySandboxClient = {
    createSandbox: vi.fn(async () => sandbox()),
    getSandbox: vi.fn(async ({ id }) => sandbox(id, "RUNNING")),
    listActiveSandboxes: vi.fn(async () => []),
    destroySandbox: vi.fn(async ({ id }) => sandbox(id, "DESTROYING")),
    exec: vi.fn(async () => execResults.shift() ?? {
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      timedOut: false,
      truncated: false,
    }),
    ...overrides,
  };
  return { client, execResults };
}

function apiWithConfig(config = testConfig()) {
  return { config, runtime: { state: { openKeyedStore: vi.fn() } } } as never;
}

describe("Railway sandbox plugin registration", () => {
  it("registers remote tools and the trusted enforcement policy", () => {
    const tools: string[] = [];
    const policies: string[] = [];
    const api = createTestPluginApi({
      registerTool: (_factory, opts) => {
        if (opts?.name) tools.push(opts.name);
      },
      registerTrustedToolPolicy: (policy) => policies.push(policy.id),
    });

    railwaySandboxPlugin.register(api);

    expect(tools).toEqual(["railway_sandbox", "railway_exec", "railway_file"]);
    expect(policies).toEqual(["heavy-local-work-boundary"]);
  });
});

describe("heavy local work boundary", () => {
  it.each(FIVE_SEATS)("blocks dependency installs for %s on local exec", (agentId) => {
    const decision = evaluateHeavyLocalWorkBoundary(
      { config: testConfig() } as never,
      { toolName: "exec", params: { command: "npm install" } },
      { agentId },
    );

    expect(decision).toMatchObject({ block: true });
    expect(decision?.blockReason).toContain("railway_exec");
  });

  it("does not block ordinary host maintenance or explicit remote node exec", () => {
    expect(
      evaluateHeavyLocalWorkBoundary(
        { config: testConfig() } as never,
        { toolName: "exec", params: { command: "git status --short" } },
        { agentId: "codeops" },
      ),
    ).toBeUndefined();
    expect(
      evaluateHeavyLocalWorkBoundary(
        { config: testConfig() } as never,
        { toolName: "exec", params: { command: "pnpm install", host: "node" } },
        { agentId: "codeops" },
      ),
    ).toBeUndefined();
  });

  it("classifies quoted shell wrappers instead of relying on a literal regex", () => {
    expect(classifyHeavyCommand("bash -lc 'pnpm install && pnpm test'")).toMatchObject({
      heavy: true,
      reason: "pnpm install",
    });
    expect(classifyHeavyCommand("env FOO=bar python -m pip install pytest")).toMatchObject({
      heavy: true,
      reason: "python -m pip install",
    });
  });

  it("blocks generated dependency/build tree writes while preserving source edits", () => {
    expect(
      evaluateHeavyLocalWorkBoundary(
        { config: testConfig() } as never,
        { toolName: "write", params: { path: "node_modules/pkg/index.js" } },
        { agentId: "codeops" },
      ),
    ).toMatchObject({ block: true });
    expect(
      evaluateHeavyLocalWorkBoundary(
        { config: testConfig() } as never,
        { toolName: "apply_patch", params: {}, derivedPaths: ["src/index.ts"] },
        { agentId: "codeops" },
      ),
    ).toBeUndefined();
  });
});

describe("railway_sandbox tool", () => {
  it("records create intent before allocation and reuses the exact recorded sandbox id", async () => {
    const store = createMemoryStore();
    const { client } = createFakeClient();
    const tool = createRailwaySandboxTool(apiWithConfig(), { agentId: "codeops", sessionKey: "s1" }, { store, client });

    const first = parseToolJson(
      await tool.execute("tool-1", { action: "create", operation_id: "op-1" }),
    );
    const second = parseToolJson(
      await tool.execute("tool-2", { action: "create", operation_id: "op-1" }),
    );

    expect(client.createSandbox).toHaveBeenCalledTimes(1);
    expect(first.operation.sandboxId).toBe("sandbox-1");
    expect(second).toMatchObject({ reused: true, operation: { sandboxId: "sandbox-1" } });
  });

  it("fails closed instead of repeating an indeterminate create", async () => {
    const store = createMemoryStore();
    await store.registerCreateIntent({
      ...runningRecord("op-pending"),
      state: "creating",
      sandboxId: undefined,
      sandboxStatus: undefined,
    });
    const { client } = createFakeClient();
    const tool = createRailwaySandboxTool(apiWithConfig(), undefined, { store, client });

    await expect(
      tool.execute("tool-1", { action: "create", operation_id: "op-pending" }),
    ).rejects.toThrow(/will not be repeated or adopted/);
    expect(client.createSandbox).not.toHaveBeenCalled();
  });

  it("marks cleanup proof after destroy and active inventory verification", async () => {
    const store = createMemoryStore();
    await store.save(runningRecord("op-clean"));
    const { client } = createFakeClient({
      getSandbox: vi.fn(async ({ id }) => sandbox(id, "DESTROYED")),
      listActiveSandboxes: vi.fn(async () => []),
    });
    const tool = createRailwaySandboxTool(apiWithConfig(), undefined, { store, client });

    const result = parseToolJson(
      await tool.execute("tool-1", { action: "destroy", operation_id: "op-clean" }),
    );

    expect(client.destroySandbox).toHaveBeenCalledWith(
      { environmentId: "env-test", id: "sandbox-1" },
      undefined,
    );
    expect(result.operation).toMatchObject({
      state: "destroyed",
      destroyProof: { status: "DESTROYED", activeInventoryEmpty: true },
    });
  });
});

describe("railway_exec and railway_file tools", () => {
  it("runs bounded commands only through the recorded Railway sandbox", async () => {
    const store = createMemoryStore();
    await store.save(runningRecord("op-exec"));
    const { client, execResults } = createFakeClient();
    execResults.push({ exitCode: 7, stdout: "remote-out", stderr: "remote-err", timedOut: false, truncated: false });
    const tool = createRailwayExecTool(apiWithConfig(), undefined, { store, client });

    const result = parseToolJson(
      await tool.execute("tool-1", { operation_id: "op-exec", command: "node --version", timeout_sec: 12 }),
    );

    expect(client.exec).toHaveBeenCalledWith(
      { environmentId: "env-test", id: "sandbox-1", command: "node --version", timeoutSec: 12 },
      undefined,
    );
    expect(result).toMatchObject({ exitCode: 7, stdout: "remote-out", stderr: "remote-err" });
    expect((await store.load("op-exec"))?.lastExec).toMatchObject({ exitCode: 7, commandHash: expect.any(String) });
  });

  it("fails instead of running locally when there is no recorded sandbox", async () => {
    const { client } = createFakeClient();
    const tool = createRailwayExecTool(apiWithConfig(), undefined, { store: createMemoryStore(), client });

    await expect(
      tool.execute("tool-1", { operation_id: "missing", command: "npm install" }),
    ).rejects.toThrow(/No local fallback/);
    expect(client.exec).not.toHaveBeenCalled();
  });

  it("writes and reads files through sandboxExec", async () => {
    const store = createMemoryStore();
    await store.save(runningRecord("op-file"));
    const { client, execResults } = createFakeClient();
    execResults.push(
      { exitCode: 0, stdout: "5\n", stderr: "", timedOut: false, truncated: false },
      { exitCode: 0, stdout: Buffer.from("hello", "utf8").toString("base64"), stderr: "", timedOut: false, truncated: false },
    );
    const tool = createRailwayFileTool(apiWithConfig(), undefined, { store, client });

    const writeResult = parseToolJson(
      await tool.execute("tool-1", { action: "write", operation_id: "op-file", path: "tmp/hello.txt", content: "hello" }),
    );
    const readResult = parseToolJson(
      await tool.execute("tool-2", { action: "read", operation_id: "op-file", path: "tmp/hello.txt" }),
    );

    expect(client.exec).toHaveBeenCalledTimes(2);
    expect(writeResult).toMatchObject({ action: "write", path: "tmp/hello.txt", exitCode: 0 });
    expect(readResult).toMatchObject({ action: "read", content: "hello", exitCode: 0 });
    expect((client.exec as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].command).toContain("base64 -d");
  });
});
