/**
 * Old-store upgrade and supported-rollback proof for PR #126924.
 *
 * Run:
 *   git worktree add ../openclaw-126924-baseline <this PR's merge base>
 *   (cd ../openclaw-126924-baseline && pnpm install --frozen-lockfile && pnpm build)
 *   pnpm tsx scripts/proof-126924-store-upgrade-rollback.ts \
 *     --baseline-root ../openclaw-126924-baseline
 *
 * WHY THIS SCRIPT EXISTS
 * The branch persists two new subagent-run observations (`waitExpiryObservedAt`,
 * `waitExpiryAnnouncedAt`) plus an optional `execution.outcome.disposition` /
 * `timeoutDisposition`. `docs/reference/database-schemas/storage-changes.md`
 * requires compatibility evidence for changed durable interpretations even
 * without a schema-version bump, and a same-build SQLite reopen test cannot
 * supply it: it never has a store an OLDER writer actually produced.
 *
 * WHAT THIS DOES INSTEAD
 * Four real Gateway processes take turns over ONE shared `OPENCLAW_STATE_DIR`:
 *
 *   A. pre-change writer  — the baseline build (this PR's merge base, which has
 *      no wait-expiry code at all) writes real `subagent_runs` rows.
 *   B. upgrade            — the branch build opens that same store, must start
 *      clean, must leave the pre-change rows byte-identical, and must be able to
 *      write the new observations onto NEW rows.
 *   C. rollback           — the baseline build opens the now-mixed store, must
 *      start clean, must keep every row, and must keep operating.
 *   D. re-upgrade         — the branch build opens it once more and must still
 *      start clean with every row intact.
 *
 * WHAT IS REAL
 * Two real builds, four real Gateway boots, one real SQLite store, the real
 * subagent registry restore/persist paths, the real `sessions_spawn` tool and
 * real child runs. The script never writes to the store itself; it only reads it
 * read-only between phases.
 *
 * WHAT IS STUBBED, AND ONLY THIS
 * The repository's loopback OpenAI provider, shared by both builds.
 *
 * THE COMPATIBILITY FACT THIS PINS
 * The new observations are keys inside the existing `payload_json` blob; the
 * branch adds no DDL. `subagent-registry.store.sqlite.ts` projects them with
 * `json_extract`-style accessors, and `subagent-registry-state.ts` writes the
 * payload from an explicit whitelist. So:
 *   - Upgrade is a no-op for old rows: the keys are absent, read back as
 *     `undefined`, and the branch treats those runs exactly as before.
 *   - Rollback is supported and lossy-by-design in one direction only: the older
 *     writer's whitelist has no entry for the new keys, so the next time it
 *     rewrites such a row the keys are dropped and the run reverts to the
 *     pre-change interpretation. Nothing else is lost, and nothing fails.
 * The assertions below check each of those claims against the real store rather
 * than restating them.
 *
 * NEGATIVE CONTROL
 * Revert the `if (!isTerminalWaitTimeout) { … reportSubagentWaitExpiry … }`
 * branch in `subagent-registry-run-wait.ts`, rebuild, and re-run: phase B can no
 * longer write any new observation and the script fails at "the branch build
 * must be able to record the new observation on a store an older writer made".
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { applyMockOpenAiModelConfig } from "./e2e/lib/fixtures/mock-openai-config.mjs";
import { createGatewayWsClient } from "./lib/gateway-ws-client.ts";

const branchRoot = process.env.PROOF_REPO_ROOT ?? process.cwd();

function resolveBaselineRoot(): string {
  const flagIndex = process.argv.indexOf("--baseline-root");
  const raw =
    (flagIndex >= 0 ? process.argv[flagIndex + 1] : undefined) ??
    process.env.PROOF_126924_BASELINE_ROOT;
  if (!raw) {
    throw new Error(
      "--baseline-root <path> (or PROOF_126924_BASELINE_ROOT) is required: this proof needs a " +
        "built checkout of this PR's merge base to act as the older writer. A same-build reopen " +
        "would not establish compatibility with an older released writer, which is exactly the " +
        "gap this script exists to close.",
    );
  }
  const resolved = path.resolve(raw);
  const baselineEntry = path.join(resolved, "dist", "entry.js");
  if (!fs.existsSync(baselineEntry)) {
    throw new Error(`baseline build not found at ${baselineEntry}; run \`pnpm build\` there first`);
  }
  return resolved;
}

const BURST = Number(process.env.PROOF_126924_BURST ?? "6");
const RUN_TIMEOUT_SECONDS = 1;
const CHILD_RESPONSE_DELAY_MS = 500;
const CHILD_TASK_MARKER = "PROOF126924STORECOMPAT";
const PARENT_PROMPT_PREFIX = "Delegate the long task to a subagent.";

const log = (message: string) => process.stdout.write(`${message}\n`);

function buildSpawnFunctionCallEvents(args: Record<string, unknown>, tag: string) {
  const serialized = JSON.stringify(args);
  const item = {
    type: "function_call",
    id: `fc_proof126924_${tag}`,
    call_id: `call_proof126924_${tag}`,
    name: "sessions_spawn",
    arguments: serialized,
  };
  return [
    {
      type: "response.output_item.added",
      item: {
        type: "function_call",
        id: `fc_proof126924_${tag}`,
        call_id: `call_proof126924_${tag}`,
        name: "sessions_spawn",
        arguments: "",
      },
    },
    { type: "response.function_call_arguments.delta", delta: serialized },
    { type: "response.output_item.done", item },
    {
      type: "response.completed",
      response: {
        id: `resp_proof126924_${tag}`,
        status: "completed",
        output: [item],
        usage: {
          input_tokens: 64,
          output_tokens: 16,
          total_tokens: 80,
          input_tokens_details: { cached_tokens: 0 },
        },
      },
    },
  ];
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function captureOutput(child: ChildProcessWithoutNullStreams) {
  let buffer = "";
  const append = (chunk: Buffer) => {
    buffer = `${buffer}${chunk.toString()}`.slice(-512 * 1024);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  return () => buffer;
}

const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-proof-126924-store-"));
const statePath = path.join(stateRoot, "state", "state", "openclaw.sqlite");
const responseControlPath = path.join(stateRoot, "mock-responses.json");
const configPath = path.join(stateRoot, "openclaw.json");

let mock: ChildProcessWithoutNullStreams | undefined;
let gateway: ChildProcessWithoutNullStreams | undefined;
let readGatewayOutput: () => string = () => "";
let exitCode = 0;

/** The raw persisted rows, exactly as the writing build left them. */
function readRawRows(): Array<{ runId: string; payload: string }> {
  if (!fs.existsSync(statePath)) {
    return [];
  }
  const db = new DatabaseSync(statePath, { readOnly: true });
  try {
    return (
      db.prepare("select run_id, payload_json from subagent_runs order by run_id").all() as Array<{
        run_id: string;
        payload_json: string;
      }>
    ).map((row) => ({ runId: row.run_id, payload: row.payload_json }));
  } catch {
    return [];
  } finally {
    db.close();
  }
}

function rowsCarryingNewObservations(rows: Array<{ runId: string; payload: string }>): string[] {
  return rows
    .filter((row) => {
      const parsed = JSON.parse(row.payload) as Record<string, unknown>;
      return (
        typeof parsed.waitExpiryObservedAt === "number" ||
        typeof parsed.waitExpiryAnnouncedAt === "number"
      );
    })
    .map((row) => row.runId);
}

async function waitFor(
  description: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 250,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await delay(intervalMs);
  }
  throw new Error(`timed out waiting for: ${description}`);
}

try {
  const baselineRoot = resolveBaselineRoot();
  const [gatewayPort, mockPort] = await Promise.all([freePort(), freePort()]);

  const writeControl = (phase: string) => {
    fs.writeFileSync(
      responseControlPath,
      JSON.stringify({
        scriptVersion: `proof-126924-store-${phase}`,
        responses: Array.from({ length: BURST }, (_unused, index) => ({
          events: buildSpawnFunctionCallEvents(
            {
              task: `${CHILD_TASK_MARKER} ${phase}: take your time and then report back.`,
              label: `proof-126924 store ${phase}`,
              mode: "run",
              cleanup: "keep",
              runTimeoutSeconds: RUN_TIMEOUT_SECONDS,
            },
            `${phase}-${index}`,
          ),
        })),
        default: {
          text: `PROOF126924 store-compat child finished (${phase}).`,
          chunkDelayMs: CHILD_RESPONSE_DELAY_MS,
        },
      }),
    );
  };

  const config: Record<string, unknown> = {
    browser: { enabled: false },
    gateway: {
      mode: "local",
      bind: "loopback",
      auth: { mode: "none" },
      controlUi: { enabled: false, sessionObserver: false },
      tailscale: { mode: "off" },
    },
    agents: { defaults: { utilityModel: "" } },
    plugins: { enabled: false },
  };
  applyMockOpenAiModelConfig(config, { mockPort, modelRef: "openai/gpt-5.6-luna" });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  writeControl("seed");

  mock = spawn(
    process.execPath,
    [path.join(branchRoot, "scripts", "e2e", "mock-openai-server.mjs")],
    {
      cwd: branchRoot,
      env: {
        PATH: process.env.PATH,
        LANG: process.env.LANG ?? "en_US.UTF-8",
        MOCK_PORT: String(mockPort),
        MOCK_RESPONSE_CONTROL: responseControlPath,
      },
    },
  );
  captureOutput(mock);
  await waitFor(
    "the mock provider to listen",
    async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${mockPort}/v1/models`);
        return res.ok || res.status === 404;
      } catch {
        return false;
      }
    },
    30_000,
  );

  const startGateway = async (root: string, label: string) => {
    gateway = spawn(
      process.execPath,
      [
        path.join(root, "dist", "entry.js"),
        "gateway",
        "run",
        "--port",
        String(gatewayPort),
        "--bind",
        "loopback",
        "--auth",
        "none",
        "--tailscale",
        "off",
        "--allow-unconfigured",
      ],
      {
        cwd: root,
        env: {
          CI: "1",
          PATH: process.env.PATH,
          LANG: process.env.LANG ?? "en_US.UTF-8",
          HOME: stateRoot,
          NO_COLOR: "1",
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_HOME: stateRoot,
          OPENCLAW_STATE_DIR: path.join(stateRoot, "state"),
          OPENCLAW_NO_RESPAWN: "1",
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_TEST_DISABLE_UPDATE_CHECK: "1",
          OPENAI_API_KEY: "proof-126924-store-upgrade-rollback",
        },
      },
    );
    readGatewayOutput = captureOutput(gateway);
    await waitFor(
      `the ${label} gateway to report ready on the shared store`,
      async () => {
        try {
          const res = await fetch(`http://127.0.0.1:${gatewayPort}/readyz`);
          return res.status === 200;
        } catch {
          return false;
        }
      },
      180_000,
    );
    log(`[boot] ${label} gateway ready on the shared store`);
  };

  const stopGateway = async () => {
    gateway?.kill("SIGTERM");
    await delay(3_000);
    gateway?.kill("SIGKILL");
    gateway = undefined;
    // Let SQLite's WAL settle before the next build opens the same file.
    await delay(1_000);
  };

  /** One real burst of delegated work against whichever build is running. */
  const runBurst = async (phase: string) => {
    writeControl(phase);
    const protocol = (await import(
      pathToFileURL(path.join(branchRoot, "dist", "gateway", "protocol", "index.js")).href
    )) as { PROTOCOL_VERSION: number };
    const client = createGatewayWsClient({ url: `ws://127.0.0.1:${gatewayPort}` });
    await client.waitOpen();
    const send = async (method: string, params: unknown, timeoutMs = 180_000) => {
      const response = await client.request(method, params, timeoutMs);
      if (!response.ok) {
        throw new Error(`${method} failed: ${JSON.stringify(response.error)}`);
      }
      return response.payload as Record<string, unknown>;
    };
    await send("connect", {
      minProtocol: protocol.PROTOCOL_VERSION,
      maxProtocol: protocol.PROTOCOL_VERSION,
      client: {
        id: "gateway-client",
        displayName: "proof-126924-store-upgrade-rollback",
        version: "1.0.0",
        platform: process.platform,
        mode: "backend",
      },
      role: "operator",
      scopes: ["operator.read", "operator.write", "operator.admin"],
      caps: [],
    });
    const turns = Array.from({ length: BURST }, (_unused, index) =>
      send("agent", {
        sessionKey: `agent:main:proof-126924-store-${phase}-parent-${index}`,
        message: `${PARENT_PROMPT_PREFIX} (${phase}-${index})`,
        deliver: false,
        idempotencyKey: randomUUID(),
      }).catch((error: unknown) => ({ parentTurnError: String(error) })),
    );
    await waitFor(
      `phase ${phase}: the real sessions_spawn tool to create registry rows`,
      () => readRawRows().length > 0,
      120_000,
      100,
    );
    // Give the children their full budget plus the announcement window.
    await delay((RUN_TIMEOUT_SECONDS + 12) * 1_000);
    await Promise.all(turns);
    client.close();
  };

  // ------------------------------------------------ phase A: pre-change writer
  await startGateway(baselineRoot, "baseline (pre-change)");
  await runBurst("seed");
  await stopGateway();
  const preChangeRows = readRawRows();
  assert.ok(
    preChangeRows.length > 0,
    "the pre-change build must have written real subagent_runs rows",
  );
  assert.deepEqual(
    rowsCarryingNewObservations(preChangeRows),
    [],
    "the pre-change build must not have written any of the new observations",
  );
  const preChangeById = new Map(preChangeRows.map((row) => [row.runId, row.payload]));
  log(
    `[A] pre-change writer: ${preChangeRows.length} real subagent_runs rows written by the ` +
      `baseline build, none carrying waitExpiryObservedAt or waitExpiryAnnouncedAt`,
  );

  // -------------------------------------------------------- phase B: upgrade
  await startGateway(branchRoot, "branch (upgrade)");
  const afterUpgradeOpen = readRawRows();
  for (const [runId, payload] of preChangeById) {
    const current = afterUpgradeOpen.find((row) => row.runId === runId);
    assert.ok(current, `the branch build dropped pre-change row ${runId} on open`);
    assert.equal(
      current.payload,
      payload,
      `the branch build rewrote pre-change row ${runId} on open; an upgrade must not ` +
        `reinterpret rows an older writer produced`,
    );
  }
  log(
    `[B1] upgrade: the branch build started clean on the pre-change store and left all ` +
      `${preChangeById.size} pre-change rows byte-identical`,
  );
  await runBurst("upgraded");
  const afterUpgradeWrite = readRawRows();
  const newObservationRows = rowsCarryingNewObservations(afterUpgradeWrite);
  assert.ok(
    newObservationRows.length > 0,
    "the branch build must be able to record the new observation on a store an older writer made",
  );
  for (const [runId, payload] of preChangeById) {
    const current = afterUpgradeWrite.find((row) => row.runId === runId);
    if (current) {
      assert.equal(
        current.payload,
        payload,
        `the branch build rewrote pre-change row ${runId} while writing new rows`,
      );
    }
  }
  await stopGateway();
  log(
    `[B2] upgrade: the branch build then wrote ${newObservationRows.length} row(s) carrying the ` +
      `new observations onto that same store, with the pre-change rows untouched`,
  );

  // ------------------------------------------------------- phase C: rollback
  const beforeRollback = readRawRows();
  const beforeRollbackIds = new Set(beforeRollback.map((row) => row.runId));
  await startGateway(baselineRoot, "baseline (rollback)");
  const afterRollbackOpen = readRawRows();
  assert.ok(
    afterRollbackOpen.length >= beforeRollback.length,
    `the older build lost rows on rollback (${beforeRollback.length} -> ${afterRollbackOpen.length})`,
  );
  for (const runId of beforeRollbackIds) {
    assert.ok(
      afterRollbackOpen.some((row) => row.runId === runId),
      `the older build dropped row ${runId} when reading a store the branch had written`,
    );
  }
  // The older build must keep working, not merely survive the open.
  await runBurst("rolledback");
  const afterRollbackWork = readRawRows();
  assert.ok(
    afterRollbackWork.length > afterRollbackOpen.length,
    "the older build must still be able to register new runs after the rollback",
  );
  const survivingObservations = rowsCarryingNewObservations(afterRollbackWork);
  await stopGateway();
  log(
    `[C] rollback: the baseline build started clean on the branch-written store, kept all ` +
      `${beforeRollbackIds.size} existing rows, and registered new work. ` +
      `${survivingObservations.length} of the ${newObservationRows.length} rows carrying the new ` +
      `observations still carry them; the older writer's payload whitelist drops the keys only ` +
      `when it rewrites such a row, and the run then reverts to the pre-change interpretation.`,
  );

  // ---------------------------------------------------- phase D: re-upgrade
  const beforeReupgrade = readRawRows();
  await startGateway(branchRoot, "branch (re-upgrade)");
  const afterReupgrade = readRawRows();
  for (const row of beforeReupgrade) {
    assert.ok(
      afterReupgrade.some((candidate) => candidate.runId === row.runId),
      `the branch build dropped row ${row.runId} on re-upgrade`,
    );
  }
  await stopGateway();
  log(
    `[D] re-upgrade: the branch build started clean again on the rolled-back store with all ` +
      `${beforeReupgrade.length} rows intact`,
  );
  log("");
  log("All store upgrade/rollback assertions passed.");
} catch (error) {
  exitCode = 1;
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.stderr.write(`--- gateway output tail ---\n${readGatewayOutput().slice(-8_000)}\n`);
} finally {
  gateway?.kill("SIGKILL");
  mock?.kill("SIGKILL");
  fs.rmSync(stateRoot, { recursive: true, force: true });
}
process.exit(exitCode);
