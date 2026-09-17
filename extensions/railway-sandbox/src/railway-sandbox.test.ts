import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRegistryFixture } from "openclaw/plugin-sdk/plugin-test-contracts";
import railwaySandboxPlugin from "../index.js";
import { evaluateHeavyLocalWorkBoundary } from "./policy.js";
import { assessLocalCommand, classifyHeavyCommand } from "./shell-classifier.js";
import {
  createRailwayExecTool,
  createRailwayFileTool,
  createRailwaySandboxTool,
} from "./tools.js";
import type { RailwaySandboxClient, RailwaySandboxRecord, RailwayExecResult, RailwaySandboxPage } from "./railway-api.js";
import type {
  GlobalAdmissionResult,
  RailwayGlobalAdmissionRecord,
  RailwayOperationRecord,
  RailwayOperationStore,
} from "./state.js";

const FIVE_SEATS = ["main", "ada", "codeops", "editor", "writer"];
const OWNER_CTX = { agentId: "codeops", sessionKey: "session-1" };

function testConfig() {
  return {
    environmentId: "env-test",
    apiToken: "resolved-fixture-token",
    enforceAgents: FIVE_SEATS,
    enforceHeavyLocalExec: true,
    defaultIdleTimeoutMinutes: 6,
    defaultResources: { cpu: 1, memoryGB: 1 },
  };
}

function parseToolJson(result: Awaited<ReturnType<ReturnType<typeof createRailwayExecTool>["execute"]>>) {
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  return JSON.parse(text);
}

function admissionFromRecord(record: RailwayOperationRecord): RailwayGlobalAdmissionRecord {
  return {
    version: 1,
    operationId: record.operationId,
    ownerAgentId: record.ownerAgentId ?? "codeops",
    ownerSessionKey: record.ownerSessionKey ?? "session-1",
    environmentId: record.environmentId,
    state: record.state,
    ...(record.sandboxId ? { sandboxId: record.sandboxId } : {}),
    updatedAt: record.updatedAt,
  };
}

function createMemoryStore(): RailwayOperationStore {
  const records = new Map<string, RailwayOperationRecord>();
  let globalAdmission: RailwayGlobalAdmissionRecord | undefined;
  let globalRevision = 0;
  const openStates = new Set(["creating", "running", "create_uncertain", "destroying", "cleanup_uncertain"]);
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
    async acquireGlobalAdmission(record): Promise<GlobalAdmissionResult> {
      if (globalAdmission && openStates.has(globalAdmission.state)) {
        return globalAdmission.operationId === record.operationId
          ? { status: "held", admission: structuredClone(globalAdmission) }
          : { status: "blocked", admission: structuredClone(globalAdmission) };
      }
      globalAdmission = admissionFromRecord(record);
      globalRevision += 1;
      return { status: "acquired", admission: structuredClone(globalAdmission) };
    },
    async updateGlobalAdmission(record) {
      globalAdmission = admissionFromRecord(record);
      globalRevision += 1;
    },
    async releaseGlobalAdmission(record) {
      if (!globalAdmission || globalAdmission.operationId !== record.operationId) {
        return false;
      }
      globalAdmission = undefined;
      globalRevision += 1;
      return true;
    },
    async loadGlobalAdmission() {
      void globalRevision;
      return globalAdmission ? structuredClone(globalAdmission) : undefined;
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

function page(items: RailwaySandboxRecord[], hasNextPage = false, endCursor: string | null = null): RailwaySandboxPage {
  return { items, pageInfo: { hasNextPage, endCursor } };
}

function createFakeClient(overrides: Partial<RailwaySandboxClient> = {}) {
  const execResults: RailwayExecResult[] = [];
  const client: RailwaySandboxClient = {
    createSandbox: vi.fn(async () => sandbox()),
    getSandbox: vi.fn(async ({ id }) => sandbox(id, "RUNNING")),
    listActiveSandboxes: vi.fn(async () => page([])),
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
  return { pluginConfig: config, runtime: { state: { openKeyedStore: vi.fn() } } } as never;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Railway sandbox plugin registration", () => {
  it("registers remote tools and the trusted enforcement policy", () => {
    const tools: string[] = [];
    const policies: string[] = [];
    const api = createTestPluginApi({
      pluginConfig: testConfig(),
      registerTool: (_factory, opts) => {
        if (opts?.name) tools.push(opts.name);
      },
      registerTrustedToolPolicy: (policy) => policies.push(policy.id),
    });

    railwaySandboxPlugin.register(api);

    expect(tools).toEqual(["railway_sandbox", "railway_exec", "railway_file"]);
    expect(policies).toEqual(["heavy-local-work-boundary"]);
  });

  it("reads registered pluginConfig through the real registry and registered trusted policy", async () => {
    const { config, registry } = createPluginRegistryFixture({
      plugins: {
        entries: {
          "railway-sandbox": {
            enabled: true,
            config: testConfig(),
          },
        },
      },
    } as never);
    const record: Parameters<typeof registry.createApi>[0] = {
      id: "railway-sandbox",
      name: "Railway Sandbox",
      version: "test",
      description: "Railway Sandbox",
      source: "/virtual/railway-sandbox/index.ts",
      rootDir: "/virtual/railway-sandbox",
      enabled: true,
      status: "loaded",
      origin: "bundled",
      kind: "module",
      diagnostics: [],
      packageName: "@openclaw/railway-sandbox-plugin",
      toolNames: [],
      hookNames: [],
      channelIds: [],
      cliBackendIds: [],
      providerIds: [],
      embeddingProviderIds: [],
      speechProviderIds: [],
      realtimeTranscriptionProviderIds: [],
      realtimeVoiceProviderIds: [],
      mediaUnderstandingProviderIds: [],
      transcriptSourceProviderIds: [],
      imageGenerationProviderIds: [],
      videoGenerationProviderIds: [],
      musicGenerationProviderIds: [],
      webFetchProviderIds: [],
      webSearchProviderIds: [],
      migrationProviderIds: [],
      agentHarnessIds: [],
      cliCommands: [],
      services: [],
      gatewayDiscoveryServiceIds: [],
      commands: [],
      httpRoutes: 0,
      hookCount: 0,
      configSchema: false,
      contracts: { trustedToolPolicies: ["heavy-local-work-boundary"], tools: ["railway_sandbox", "railway_exec", "railway_file"] },
    };
    registry.registry.plugins.push(record);
    railwaySandboxPlugin.register(
      registry.createApi(record, { config, pluginConfig: testConfig() }),
    );

    const policy = registry.registry.trustedToolPolicies.find((entry) => entry.policy.id === "heavy-local-work-boundary");
    expect(policy).toBeDefined();
    const decision = await policy!.policy.evaluate(
      { toolName: "exec", params: { command: "pnpm install" } },
      { toolName: "exec", agentId: "codeops" } as never,
    );
    expect(decision).toMatchObject({ block: true, blockReason: expect.stringContaining("pnpm install") });
  });
});

describe("heavy local work boundary", () => {
  it.each(FIVE_SEATS)("blocks arbitrary code/build execution for %s on local exec", (agentId) => {
    const decision = evaluateHeavyLocalWorkBoundary(
      { pluginConfig: testConfig() } as never,
      { toolName: "exec", params: { command: "node --test" } },
      { agentId },
    );

    expect(decision).toMatchObject({ block: true });
    expect(decision?.blockReason).toContain("railway_exec");
  });

  it("allows only explicit safe host read/maintenance and explicit remote node exec", () => {
    expect(
      evaluateHeavyLocalWorkBoundary(
        { pluginConfig: testConfig() } as never,
        { toolName: "exec", params: { command: "git status --short" } },
        { agentId: "codeops" },
      ),
    ).toBeUndefined();
    expect(
      evaluateHeavyLocalWorkBoundary(
        { pluginConfig: testConfig() } as never,
        { toolName: "exec", params: { command: "pnpm install", host: "node" } },
        { agentId: "codeops" },
      ),
    ).toBeUndefined();
    expect(
      evaluateHeavyLocalWorkBoundary(
        { pluginConfig: testConfig() } as never,
        { toolName: "exec", params: { command: "git clone https://example.invalid/repo" } },
        { agentId: "codeops" },
      ),
    ).toMatchObject({ block: true });
  });

  it("fails closed for wrappers, package aliases, Python subprocesses, and dynamic shell", () => {
    for (const command of [
      "node scripts/run-vitest.mjs",
      "scripts/build.sh",
      "python -c 'import subprocess; subprocess.run([\"npm\",\"test\"])'",
      "command pnpm install",
      "nice npm test",
      "timeout 30s node --test",
      "sudo pnpm install",
      "pnpm -C packages/app install",
      "npm t",
      "bash -lc 'echo $(npm test)'",
      "git worktree add /tmp/wt",
    ]) {
      expect(assessLocalCommand(command), command).toMatchObject({ allowed: false });
    }
  });

  it("retains heavy classification details for diagnostics without using it as the policy boundary", () => {
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
        { pluginConfig: testConfig() } as never,
        { toolName: "write", params: { path: "node_modules/pkg/index.js" } },
        { agentId: "codeops" },
      ),
    ).toMatchObject({ block: true });
    expect(
      evaluateHeavyLocalWorkBoundary(
        { pluginConfig: testConfig() } as never,
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
    const tool = createRailwaySandboxTool(apiWithConfig(), OWNER_CTX, { store, client });

    const first = parseToolJson(
      await tool.execute("tool-1", { action: "create", operation_id: "op-1" }),
    );
    const second = parseToolJson(
      await tool.execute("tool-2", { action: "create", operation_id: "op-1" }),
    );

    expect(client.createSandbox).toHaveBeenCalledTimes(1);
    expect(first.operation.sandboxId).toBe("sandbox-1");
    expect(first.ready).toBe(true);
    expect(second).toMatchObject({ reused: true, operation: { sandboxId: "sandbox-1" } });
  });

  it("enforces a durable global one-active-operation admission", async () => {
    const store = createMemoryStore();
    const { client } = createFakeClient();
    const tool = createRailwaySandboxTool(apiWithConfig(), OWNER_CTX, { store, client });

    await tool.execute("tool-1", { action: "create", operation_id: "op-1" });
    await expect(
      tool.execute("tool-2", { action: "create", operation_id: "op-2" }),
    ).rejects.toThrow(/global capacity is held/);
    expect(client.createSandbox).toHaveBeenCalledTimes(1);
  });

  it("fails closed instead of repeating an indeterminate create", async () => {
    const store = createMemoryStore();
    await store.registerCreateIntent({
      ...runningRecord("op-pending"),
      state: "creating",
      sandboxId: undefined,
      sandboxStatus: undefined,
    });
    await store.acquireGlobalAdmission({
      ...runningRecord("op-pending"),
      state: "creating",
      sandboxId: undefined,
      sandboxStatus: undefined,
    });
    const { client } = createFakeClient();
    const tool = createRailwaySandboxTool(apiWithConfig(), OWNER_CTX, { store, client });

    await expect(
      tool.execute("tool-1", { action: "create", operation_id: "op-pending" }),
    ).rejects.toThrow(/will not be repeated or adopted/);
    expect(client.createSandbox).not.toHaveBeenCalled();
  });

  it("preserves exact sandbox id custody when storage fails after vendor create", async () => {
    const base = createMemoryStore();
    let failed = false;
    const store: RailwayOperationStore = {
      ...base,
      async save(record) {
        if (!failed && record.sandboxId === "sandbox-lost") {
          failed = true;
          throw new Error("disk full");
        }
        await base.save(record);
      },
    };
    const { client } = createFakeClient({ createSandbox: vi.fn(async () => sandbox("sandbox-lost")) });
    const tool = createRailwaySandboxTool(apiWithConfig(), OWNER_CTX, { store, client });

    await expect(tool.execute("tool-1", { action: "create", operation_id: "op-lost" })).rejects.toThrow(
      /exact sandbox id sandbox-lost/,
    );
    await expect(base.load("op-lost")).resolves.toMatchObject({ state: "create_uncertain", sandboxId: "sandbox-lost" });
    await expect(base.loadGlobalAdmission()).resolves.toMatchObject({ operationId: "op-lost", sandboxId: "sandbox-lost" });
  });

  it("does not label a CREATING sandbox as ready", async () => {
    const store = createMemoryStore();
    const { client } = createFakeClient({ createSandbox: vi.fn(async () => sandbox("sandbox-new", "CREATING")) });
    const tool = createRailwaySandboxTool(apiWithConfig(), OWNER_CTX, { store, client });

    const result = parseToolJson(await tool.execute("tool-1", { action: "create", operation_id: "op-creating" }));

    expect(result).toMatchObject({ created: true, ready: false, operation: { state: "creating", sandboxId: "sandbox-new" } });
  });

  it("enforces operation ownership for status, exec, file, and destroy", async () => {
    const store = createMemoryStore();
    await store.save(runningRecord("op-owned"));
    await store.acquireGlobalAdmission(runningRecord("op-owned"));
    const { client } = createFakeClient();

    await expect(
      createRailwaySandboxTool(apiWithConfig(), { agentId: "ada", sessionKey: "session-1" }, { store, client }).execute(
        "tool-1",
        { action: "status", operation_id: "op-owned" },
      ),
    ).rejects.toThrow(/owned by another agent\/session/);
    await expect(
      createRailwayExecTool(apiWithConfig(), { agentId: "codeops", sessionKey: "other-session" }, { store, client }).execute(
        "tool-2",
        { operation_id: "op-owned", command: "echo nope" },
      ),
    ).rejects.toThrow(/owned by another agent\/session/);
    await expect(
      createRailwayFileTool(apiWithConfig(), undefined, { store, client }).execute(
        "tool-3",
        { action: "list", operation_id: "op-owned", path: "." },
      ),
    ).rejects.toThrow(/anonymous custody/);
    await expect(
      createRailwaySandboxTool(apiWithConfig(), { agentId: "writer", sessionKey: "session-1" }, { store, client }).execute(
        "tool-4",
        { action: "destroy", operation_id: "op-owned" },
      ),
    ).rejects.toThrow(/owned by another agent\/session/);
  });

  it("marks cleanup proof after destroy and complete active inventory verification", async () => {
    const store = createMemoryStore();
    await store.save(runningRecord("op-clean"));
    await store.acquireGlobalAdmission(runningRecord("op-clean"));
    const { client } = createFakeClient({
      getSandbox: vi.fn(async ({ id }) => sandbox(id, "DESTROYED")),
      listActiveSandboxes: vi.fn(async () => page([])),
    });
    const tool = createRailwaySandboxTool(apiWithConfig(), OWNER_CTX, { store, client });

    const result = parseToolJson(
      await tool.execute("tool-1", { action: "destroy", operation_id: "op-clean" }),
    );

    expect(client.destroySandbox).not.toHaveBeenCalled();
    expect(result.operation).toMatchObject({
      state: "destroyed",
      destroyProof: { status: "DESTROYED", activeInventoryCompleted: true, verifiedDestroyed: true },
    });
    await expect(store.loadGlobalAdmission()).resolves.toBeUndefined();
  });

  it("fails closed when exact-id destroy proof contradicts active inventory", async () => {
    const store = createMemoryStore();
    await store.save(runningRecord("op-contradict"));
    await store.acquireGlobalAdmission(runningRecord("op-contradict"));
    const { client } = createFakeClient({
      getSandbox: vi.fn(async ({ id }) => sandbox(id, "RUNNING")),
      destroySandbox: vi.fn(async ({ id }) => sandbox(id, "DESTROYING")),
      listActiveSandboxes: vi.fn(async () => page([])),
    });
    const tool = createRailwaySandboxTool(apiWithConfig(), OWNER_CTX, { store, client });

    const result = parseToolJson(
      await tool.execute("tool-1", { action: "destroy", operation_id: "op-contradict" }),
    );

    expect(result.operation).toMatchObject({
      state: "cleanup_uncertain",
      destroyProof: { status: "RUNNING", verifiedDestroyed: false, contradiction: expect.stringContaining("RUNNING") },
    });
    await expect(store.loadGlobalAdmission()).resolves.toMatchObject({ operationId: "op-contradict", state: "cleanup_uncertain" });
  });

  it("completes active inventory pagination before accepting absence as destroy proof", async () => {
    const store = createMemoryStore();
    await store.save(runningRecord("op-paged"));
    await store.acquireGlobalAdmission(runningRecord("op-paged"));
    const { client } = createFakeClient({
      getSandbox: vi.fn(async () => null),
      destroySandbox: vi.fn(async ({ id }) => sandbox(id, "DESTROYING")),
      listActiveSandboxes: vi
        .fn()
        .mockResolvedValueOnce(page([], true, "cursor-1"))
        .mockResolvedValueOnce(page([sandbox("sandbox-1", "RUNNING")], false))
        .mockResolvedValueOnce(page([], true, "cursor-1"))
        .mockResolvedValueOnce(page([sandbox("sandbox-1", "RUNNING")], false)),
    });
    const tool = createRailwaySandboxTool(apiWithConfig(), OWNER_CTX, { store, client });

    const result = parseToolJson(
      await tool.execute("tool-1", { action: "destroy", operation_id: "op-paged" }),
    );

    expect(client.listActiveSandboxes).toHaveBeenCalledTimes(4);
    expect(result.operation).toMatchObject({
      state: "cleanup_uncertain",
      destroyProof: { activeInventoryCompleted: true, activeInventoryHasSandbox: true, verifiedDestroyed: false },
    });
  });
});

describe("railway_exec and railway_file tools", () => {
  it("runs bounded commands only through the recorded Railway sandbox", async () => {
    const store = createMemoryStore();
    await store.save(runningRecord("op-exec"));
    const { client, execResults } = createFakeClient();
    execResults.push({ exitCode: 7, stdout: "remote-out", stderr: "remote-err", timedOut: false, truncated: false });
    const tool = createRailwayExecTool(apiWithConfig(), OWNER_CTX, { store, client });

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
    const tool = createRailwayExecTool(apiWithConfig(), OWNER_CTX, { store: createMemoryStore(), client });

    await expect(
      tool.execute("tool-1", { operation_id: "missing", command: "npm install" }),
    ).rejects.toThrow(/No local fallback/);
    expect(client.exec).not.toHaveBeenCalled();
  });

  it("writes and reads byte-exact UTF-8 files through sandboxExec", async () => {
    const store = createMemoryStore();
    await store.save(runningRecord("op-file"));
    const content = "  hello unicode 🧪\n\n";
    const { client, execResults } = createFakeClient();
    execResults.push(
      { exitCode: 0, stdout: `${Buffer.byteLength(content, "utf8")}\n`, stderr: "", timedOut: false, truncated: false },
      { exitCode: 0, stdout: Buffer.from(content, "utf8").toString("base64"), stderr: "", timedOut: false, truncated: false },
    );
    const tool = createRailwayFileTool(apiWithConfig(), OWNER_CTX, { store, client });

    const writeResult = parseToolJson(
      await tool.execute("tool-1", { action: "write", operation_id: "op-file", path: "tmp/hello.txt", content }),
    );
    const readResult = parseToolJson(
      await tool.execute("tool-2", { action: "read", operation_id: "op-file", path: "tmp/hello.txt" }),
    );

    expect(client.exec).toHaveBeenCalledTimes(2);
    expect(writeResult).toMatchObject({ action: "write", path: "tmp/hello.txt", exitCode: 0 });
    expect(readResult).toMatchObject({ action: "read", content, exitCode: 0 });
    expect((client.exec as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].command).toContain("base64 -d");
  });

  it("preserves empty file writes", async () => {
    const store = createMemoryStore();
    await store.save(runningRecord("op-empty"));
    const { client, execResults } = createFakeClient();
    execResults.push({ exitCode: 0, stdout: "0\n", stderr: "", timedOut: false, truncated: false });
    const tool = createRailwayFileTool(apiWithConfig(), OWNER_CTX, { store, client });

    const result = parseToolJson(
      await tool.execute("tool-1", { action: "write", operation_id: "op-empty", path: "empty.txt", content: "" }),
    );

    expect(result).toMatchObject({ action: "write", exitCode: 0 });
    expect((client.exec as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].command).toContain("OPENCLAW_RAILWAY_FILE_B64");
  });

  it("allows root list while keeping traversal blocked", async () => {
    const store = createMemoryStore();
    await store.save(runningRecord("op-list"));
    const { client, execResults } = createFakeClient();
    execResults.push({ exitCode: 0, stdout: "d .\nf ./README.md\n", stderr: "", timedOut: false, truncated: false });
    const tool = createRailwayFileTool(apiWithConfig(), OWNER_CTX, { store, client });

    const result = parseToolJson(
      await tool.execute("tool-1", { action: "list", operation_id: "op-list", path: "." }),
    );

    expect(result.stdout).toContain("README.md");
    await expect(
      tool.execute("tool-2", { action: "read", operation_id: "op-list", path: "../secret" }),
    ).rejects.toThrow(/stay inside/);
  });

  it("refuses to decode truncated file reads", async () => {
    const store = createMemoryStore();
    await store.save(runningRecord("op-truncated"));
    const { client, execResults } = createFakeClient();
    execResults.push({ exitCode: 0, stdout: Buffer.from("hello", "utf8").toString("base64").slice(0, 3), stderr: "", timedOut: false, truncated: true });
    const tool = createRailwayFileTool(apiWithConfig(), OWNER_CTX, { store, client });

    await expect(
      tool.execute("tool-1", { action: "read", operation_id: "op-truncated", path: "hello.txt" }),
    ).rejects.toThrow(/truncated/);
    expect((await store.load("op-truncated"))?.lastFile).toMatchObject({ truncated: true });
  });
});
