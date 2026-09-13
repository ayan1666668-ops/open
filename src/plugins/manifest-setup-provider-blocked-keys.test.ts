// A manifest's setup.providers[].id is user/plugin-controlled and later becomes a key
// in the secret env-var candidate buckets (src/secrets/provider-env-vars.ts), so
// prototype-named ids must be rejected the same way the sibling manifest normalizers do.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginManifest } from "./manifest.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

function makeTempDir() {
  return makeTrackedTempDir("openclaw-manifest-setup-providers", tempDirs);
}

function writeManifest(dir: string, setup: unknown): void {
  fs.writeFileSync(
    path.join(dir, "openclaw.plugin.json"),
    JSON.stringify({ id: "setup-providers", configSchema: { type: "object" }, setup }, null, 2),
    "utf-8",
  );
}

beforeEach(() => {
  clearPluginMetadataLifecycleCaches();
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTrackedTempDirs(tempDirs);
});

describe("plugin manifest setup provider ids", () => {
  it("keeps ordinary provider ids", () => {
    const dir = makeTempDir();
    writeManifest(dir, {
      providers: [{ id: "openai", envVars: ["OPENAI_API_KEY"] }],
    });

    const result = loadPluginManifest(dir, false);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.setup?.providers).toEqual([
        { id: "openai", envVars: ["OPENAI_API_KEY"] },
      ]);
    }
  });

  it("drops prototype-named provider ids instead of forwarding them downstream", () => {
    const dir = makeTempDir();
    writeManifest(dir, {
      providers: [
        { id: "__proto__", envVars: ["PROTO_KEY"] },
        { id: "constructor", envVars: ["CTOR_KEY"] },
        { id: "prototype", envVars: ["PROTOTYPE_KEY"] },
        { id: "openai", envVars: ["OPENAI_API_KEY"] },
      ],
    });

    const result = loadPluginManifest(dir, false);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.setup?.providers).toEqual([
        { id: "openai", envVars: ["OPENAI_API_KEY"] },
      ]);
    }
  });

  it("drops a manifest whose only provider id is prototype-named", () => {
    const dir = makeTempDir();
    writeManifest(dir, { providers: [{ id: "__proto__", envVars: ["PROTO_KEY"] }] });

    const result = loadPluginManifest(dir, false);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.setup?.providers).toBeUndefined();
    }
  });
});
