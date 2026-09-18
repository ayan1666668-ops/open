import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";

// Reads saved nm -j outputs only. Does not execute a proof binary or native tool.
assert.equal(process.argv.length, 6);
const names = [
  "_AudioObjectGetPropertyData",
  "_AudioObjectGetPropertyDataSize",
  "_AudioObjectAddPropertyListenerBlock",
  "_AudioObjectRemovePropertyListenerBlock",
  "_AudioUnitSetProperty",
].sort();
const read = (path) => {
  assert(statSync(path).size <= 1024 * 1024);
  const rows = readFileSync(path, "utf8").split("\n").filter(Boolean);
  assert(rows.every((row) => /^\S+$/.test(row)), "expected nm -j symbol-only output");
  return new Set(rows);
};
const [ownerUndefined, stubDefined, executableDefined, executableUndefined] =
  process.argv.slice(2).map(read);
const audioBoundary = (set) => [...set]
  .filter((name) => /^_Audio(?:Object|Unit)/.test(name)).sort();
assert.deepEqual(audioBoundary(ownerUndefined), names,
  "complete owner's AudioObject/AudioUnit references must be exactly intercepted");
assert.deepEqual(audioBoundary(stubDefined), names);
assert.deepEqual(audioBoundary(executableDefined), names);
assert.deepEqual(audioBoundary(executableUndefined), []);
console.log(JSON.stringify({ kind: "static-symbol-check", matched: names, runtimeBindingVerified: false }));
