import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Bind each cold provisioner process through the existing sealed-runtime DI seam. */
export function createPrivateHandoffStoreFixture(directory: string) {
  const fixtureRoot = realpathSync(directory);
  const root = join(fixtureRoot, ".local", "private-handoff");
  const storeRoot = join(root, "store");
  mkdirSync(storeRoot, { recursive: true, mode: 0o700 });
  assert.equal(realpathSync(storeRoot), storeRoot);
  const databasePath = join(storeRoot, "managed-update-handoffs.sqlite");
  const observations = join(root, "observations.jsonl");
  const preload = join(root, "preload.mjs");
  writeFileSync(observations, "");
  writeFileSync(
    preload,
    `
import assert from "node:assert/strict";
import { appendFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Git/GitHub stubs and the shell supervisor do not open handoff stores.
// The source provisioner does, via config write-lock admission.
const entry = process.argv[1];
if (entry?.endsWith("/scripts/pr-lib/worktree-provision.mts")) {
  const sourceRoot = path.resolve(path.dirname(realpathSync(entry)), "../..");
  const storeRoot = ${JSON.stringify(storeRoot)};
  const databasePath = ${JSON.stringify(databasePath)};
  const observations = ${JSON.stringify(observations)};
  assert.equal(realpathSync(storeRoot), storeRoot);
  const require = createRequire(path.join(sourceRoot, "package.json"));
  const { resolveSecureTempRoot } = require("@openclaw/fs-safe/temp");
  const { registerSealedRuntime } = await import(
    pathToFileURL(path.join(sourceRoot, "src/infra/sealed-runtime-registry.ts")).href
  );
  let preflight = true;
  const observe = (kind) => appendFileSync(observations, JSON.stringify({
    kind, pid: process.pid, sourceRoot, databasePath,
  }) + "\\n");
  registerSealedRuntime({
    json5: require("json5"),
    resolveSecureTempRoot(options) {
      const resolved = resolveSecureTempRoot({ ...options, preferredDir: storeRoot });
      assert.equal(resolved, storeRoot);
      assert.equal(realpathSync(resolved), storeRoot);
      if (!preflight) observe("resolved");
      return resolved;
    },
  });
  await import(pathToFileURL(path.join(sourceRoot, "scripts/tsx.mjs")).href);
  const { createManagedHandoffLeaseStore, resolveManagedUpdateLeaseDatabasePath } = await import(
    pathToFileURL(path.join(sourceRoot, "src/infra/update-managed-service-handoff-lease.ts")).href
  );
  assert.equal(resolveManagedUpdateLeaseDatabasePath(), databasePath);
  observe("injected");
  preflight = false;
  // Verify the actual production store in this helper, even when provisioning
  // does not need a config write. Explicit options cannot select a live fallback.
  const store = createManagedHandoffLeaseStore({
    databasePath: resolveManagedUpdateLeaseDatabasePath(),
    serviceManagerEnv: process.env,
  });
  store.assertSourceUnborrowed(path.join(storeRoot, "provisioner-preflight-config.json"));
  observe("store-verified");
}
`,
  );
  return {
    env: { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` },
    assertProvisionersVerified() {
      const rows = readFileSync(observations, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              kind: string;
              pid: number;
              sourceRoot: string;
              databasePath: string;
            },
        );
      const injected = rows.filter((row) => row.kind === "injected");
      assert.ok(injected.length > 0, "cold provisioner never received its private store");
      for (const row of rows) {
        assert.equal(row.databasePath, databasePath);
      }
      for (const row of injected) {
        assert.ok(
          rows.some((other) => other.pid === row.pid && other.kind === "store-verified"),
          "provisioner " + row.pid + " never verified its private store",
        );
        assert.ok(
          rows.some((other) => other.pid === row.pid && other.kind === "resolved"),
          `provisioner ${row.pid} never resolved its injected handoff store`,
        );
      }
      assert.equal(realpathSync(storeRoot), storeRoot);
    },
  };
}
