// Publishes the base declaration partition that owns the typed runtime entries.
//
// The dist-dependent core-test type-check shard resolves the e2e's
// `../../dist/*.js` specifiers, so those .d.ts files must exist before the
// checker runs. Preparing them through the canonical declaration writer stages
// each group privately and publishes only the partition it built.
//
// The staged publisher deletes every previous output the caller reports that it
// did not just publish. This entry therefore claims no previous inventory: the
// base partition writes its own entries unconditionally, and reporting the
// checkout's whole declaration tree would prune the plugin SDK and extension
// partitions this preparation exists to leave alone. Reading the group's own
// entry list to scope that inventory is not available here either, because the
// generator-closure check rejects an unresolved dynamic module edge for the
// config import it would need.
import { TSDOWN_UNIFIED_DTS_CONFIG_GROUPS } from "./lib/tsdown-config-groups.mts";
import { writeTsdownDeclarations } from "./lib/tsdown-declaration-writer.mts";

// The base declaration partition owns the typed runtime entries (index plus the
// e2e-typed runtime names in tsdown.config.ts); it is the first unified DTS group.
await writeTsdownDeclarations(
  [TSDOWN_UNIFIED_DTS_CONFIG_GROUPS[0]],
  "tsdown-typed-runtime",
  () => [],
  "scripts/write-typed-runtime-entry-dts.ts",
);
