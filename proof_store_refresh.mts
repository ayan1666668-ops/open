import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-proof-"));
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");
process.env.OPENCLAW_HOME = stateDir;
const { openOpenClawStateDatabase, closeOpenClawStateDatabaseForTest } =
  await import("./src/state/openclaw-state-db.js");
const {
  getSecretStoreMutationsVersion,
  readSecretStoreExecEnvironment,
  writeSecretStoreEntry,
  writeSecretStoreEntryWithRollback,
} = await import("./src/secrets/store/secret-store.js");

const database = {
  env: { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json") },
};
openOpenClawStateDatabase(database);

const scope = { kind: "team" } as const;

const before = readSecretStoreExecEnvironment({ includeSecretSentinels: true });
console.log(
  "[1] before write: META sentinel =",
  before.secretSentinels?.META_ADS_ACCESS_TOKEN ?? "(absent)",
);

const v0 = getSecretStoreMutationsVersion();
writeSecretStoreEntry({
  scope,
  name: "META_ADS_ACCESS_TOKEN",
  value: "EAAG-fixture-token-not-real-1234567890",
  kind: "secret",
  allowedHosts: ["graph.facebook.com"],
  updatedBy: "proof",
});
const v1 = getSecretStoreMutationsVersion();
const after = readSecretStoreExecEnvironment({ includeSecretSentinels: true });
console.log(
  `[2] after write: version ${v0} -> ${v1}; sentinel present = ${after.secretSentinels?.META_ADS_ACCESS_TOKEN?.startsWith("oc-sent-") ?? false}; allowedHosts = ${JSON.stringify(after.secretEgressBindings?.[0]?.allowedHosts)}`,
);

const staged = writeSecretStoreEntryWithRollback({
  scope,
  name: "PROVIDER_TOKEN",
  value: "staged-fixture-value-9876543210",
  kind: "secret",
  allowedHosts: ["api.provider.example"],
  updatedBy: "proof",
});
const v2 = getSecretStoreMutationsVersion();
const rolledBack = staged.rollback();
const v3 = getSecretStoreMutationsVersion();
const post = readSecretStoreExecEnvironment({ includeSecretSentinels: true });
console.log(`[3] rollback ok = ${rolledBack}; version ${v2} -> ${v3} (advanced = ${v3 > v2})`);
console.log(
  "[3] refreshed snapshot contains PROVIDER_TOKEN =",
  post.secretSentinels?.PROVIDER_TOKEN !== undefined ? "STILL PRESENT (BUG)" : "(absent - correct)",
);
console.log(
  "[4] META token still valid after unrelated rollback =",
  post.secretSentinels?.META_ADS_ACCESS_TOKEN?.startsWith("oc-sent-") ?? false,
);

closeOpenClawStateDatabaseForTest();
fs.rmSync(stateDir, { recursive: true, force: true });
console.log("[done] all steps real store, real reads, fixture values only");
