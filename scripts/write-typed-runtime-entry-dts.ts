// Publishes the base declaration partition that owns the typed runtime entries.
//
// The dist-dependent core-test type-check shard resolves the e2e's
// `../../dist/*.js` specifiers, so those .d.ts files must exist before the
// checker runs. Preparing them through the canonical declaration writer stages
// each group privately and publishes only the partition it built.
//
// The writer prunes whatever the caller reports as its previous inventory, so the
// inventory here is scoped to this partition's own declared entry outputs. Passing
// the whole declaration tree instead would prune the plugin SDK and extension
// partitions, which is the failure this preparation is being repaired for.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { TSDOWN_UNIFIED_DTS_CONFIG_GROUPS } from "./lib/tsdown-config-groups.mts";
import { writeTsdownDeclarations } from "./lib/tsdown-declaration-writer.mts";

// The base declaration partition owns the typed runtime entries (index plus the
// e2e-typed runtime names in tsdown.config.ts); it is the first unified DTS group.
const group = TSDOWN_UNIFIED_DTS_CONFIG_GROUPS[0];
const root = fs.realpathSync.native(process.cwd());
const { default: configs }: { default: Array<{ name?: string; entry?: unknown }> } = await import(
  pathToFileURL(path.join(root, "tsdown.config.ts")).href
);
const config = configs.find((candidate) => candidate.name === group);
if (!config?.entry || typeof config.entry !== "object" || Array.isArray(config.entry)) {
  throw new Error(`Missing canonical declaration group ${group}`);
}
const owned = Object.keys(config.entry)
  .map((entry) => `dist/${entry}.d.ts`)
  .filter((file) => fs.existsSync(path.join(root, file)));

await writeTsdownDeclarations(
  [group],
  "tsdown-typed-runtime",
  () => owned,
  "scripts/write-typed-runtime-entry-dts.ts",
);
