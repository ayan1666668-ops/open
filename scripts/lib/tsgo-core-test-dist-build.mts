// Builds the typed runtime dist entries a core-test type-check shard needs.
//
// A first-party e2e (embedded-agent-runner.retry-after-failover) imports built
// runtime declarations from dist/. The tsgo core-test shard that owns that test
// resolves those `../../dist/*.js` specifiers, so their .d.ts must exist before
// the checker runs or every import reports TS2307. The full runtime build is
// far more than this needs, so build only the unified runtime graph plus the
// base declaration partition (which owns these entries); that emits the four
// .js/.d.ts pairs in about a minute instead of the full multi-minute build.
import path from "node:path";
import { distArtifactEntryArgs } from "./dist-artifact-ownership.mts";
import { runManagedCommand } from "./managed-child-process.mts";
import {
  TSDOWN_UNIFIED_CONFIG_GROUP,
  TSDOWN_UNIFIED_DTS_CONFIG_GROUPS,
} from "./tsdown-config-groups.mts";

// The base declaration partition owns the typed runtime entries (index plus the
// e2e-typed runtime names in tsdown.config.ts); it is the first unified DTS group.
const TYPED_RUNTIME_DTS_GROUP = TSDOWN_UNIFIED_DTS_CONFIG_GROUPS[0];

/**
 * Build the unified runtime and its base declaration partition so the typed
 * runtime dist entries (both .js and .d.ts) exist for the type-check shard.
 */
export async function buildTsgoCoreTestTypedRuntimeDist(
  env: NodeJS.ProcessEnv,
  repoRoot: string,
): Promise<number> {
  console.error(
    "[tsgo core test] building typed runtime dist entries before dist-dependent shards",
  );
  return runManagedCommand({
    bin: process.execPath,
    // Launched through the dist-artifact entry so it inherits the shard runner's
    // checkout ownership instead of blocking forever on the same lock.
    args: distArtifactEntryArgs(path.join(repoRoot, "scripts/tsdown-build.mts"), [
      "--config",
      "tsdown.config.ts",
      "--filter",
      TSDOWN_UNIFIED_CONFIG_GROUP,
      "--filter",
      TYPED_RUNTIME_DTS_GROUP,
    ]),
    cwd: repoRoot,
    // Declarations must be emitted even when a caller set the skip flag for its
    // own runtime-only build; the .d.ts are the reason this build exists.
    env: { ...env, OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "0" },
    requireProcessTreeExit: process.platform !== "win32",
  });
}
