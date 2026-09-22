// Typed runtime preparation tests cover the runtime owners the prepare step restores.
import { describe, expect, it } from "vitest";
import { BUILD_ALL_STEPS, resolveBuildAllStep } from "../../scripts/build-all.mts";
import {
  buildTsgoCoreTestTypedRuntimeDist,
  listRestoredRuntimeSteps,
} from "../../scripts/lib/tsgo-core-test-dist-build.mts";

describe("typed runtime declaration preparation", () => {
  it("restores the cleaned runtime artifacts through their canonical owners", async () => {
    expect((await listRestoredRuntimeSteps()).map((step) => step.label)).toEqual([
      "plugins:assets:build",
      "tsdown-ai",
      "external-plugins:local-dist",
      "plugins:assets:copy",
      "runtime-postbuild",
    ]);
  });

  it("keeps every restored owner a step build-all still defines", async () => {
    for (const step of await listRestoredRuntimeSteps()) {
      expect(BUILD_ALL_STEPS).toContain(step);
    }
  });

  it("resolves the copied plugin assets through their node owner", async () => {
    const assetStep = (await listRestoredRuntimeSteps()).find(
      (step) => step.label === "plugins:assets:copy",
    );
    expect(assetStep).toBeDefined();
    if (!assetStep) {
      throw new Error("plugins:assets:copy owner is missing");
    }
    const resolved = resolveBuildAllStep(assetStep, {
      env: { OPENCLAW_BUILD_ALL_NO_PNPM: "1" },
    });
    expect(resolved.args.join(" ")).toContain("bundled-plugin-assets.mts");
  });

  it("exposes the preparation entry point for the shard runner", () => {
    expect(typeof buildTsgoCoreTestTypedRuntimeDist).toBe("function");
  });

  it("restores the assets build before the copy that reads its bundles", async () => {
    const labels = (await listRestoredRuntimeSteps()).map((step) => step.label);
    const buildIndex = labels.indexOf("plugins:assets:build");
    const copyIndex = labels.indexOf("plugins:assets:copy");
    // The copy phase runs each plugin's assetScripts.copy, which fails closed
    // with "Missing A2UI bundle assets" when the build phase has not written
    // them, so the producer has to come first.
    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(buildIndex).toBeLessThan(copyIndex);
    expect(copyIndex).toBeLessThan(labels.indexOf("runtime-postbuild"));
  });

  it("restores the package build before the postbuild verification loads it", async () => {
    const labels = (await listRestoredRuntimeSteps()).map((step) => step.label);
    const packageIndex = labels.indexOf("tsdown-ai");
    // runtime-postbuild verifies the built plugin control-plane modules, which
    // import @openclaw/ai/dist, so the package build has to come first.
    expect(packageIndex).toBeGreaterThanOrEqual(0);
    expect(packageIndex).toBeLessThan(labels.indexOf("runtime-postbuild"));
  });

  it("keeps build-all's own order for the shared asset steps", () => {
    const labels = BUILD_ALL_STEPS.map((step) => step.label);
    expect(labels.indexOf("plugins:assets:build")).toBeLessThan(labels.indexOf("tsdown"));
    expect(labels.indexOf("plugins:assets:copy")).toBeLessThan(labels.indexOf("runtime-postbuild"));
  });

  it("launches every preparation child without a shell and keeps CLI metadata", async () => {
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv; shell?: boolean }> = [];
    const fakeRunner = (async (params: {
      args: string[];
      env: NodeJS.ProcessEnv;
      shell?: boolean;
    }) => {
      calls.push(params);
      return 0;
    }) as unknown as typeof import("../../scripts/lib/managed-child-process.mts").runManagedCommand;

    const status = await buildTsgoCoreTestTypedRuntimeDist(
      { PATH: "/usr/bin" },
      "/repo",
      fakeRunner,
    );

    expect(status).toBe(0);
    // The compile, the five restored owners, and the declaration writer.
    expect(calls).toHaveLength(7);
    for (const call of calls) {
      // A Windows shell routes arguments through cmd.exe, which rejects the
      // percent-encoded file URLs of a checkout path containing spaces.
      expect(call.shell).toBe(false);
      // The absent bundle stays a failure; only the producer may satisfy it.
      expect(call.env.OPENCLAW_A2UI_SKIP_MISSING).toBeUndefined();
    }
    expect(calls[0]?.env).toMatchObject({
      OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1",
      OPENCLAW_PRESERVE_CLI_STARTUP_METADATA: "1",
    });
    expect(calls[1]?.args.join(" ")).toContain("bundled-plugin-assets.mts");
    expect(calls[1]?.args.join(" ")).toContain("build");
    expect(calls.at(-1)?.args.join(" ")).toContain("write-typed-runtime-entry-dts.ts");
  });

  it("stops before restoring owners when the compile fails", async () => {
    const calls: unknown[] = [];
    const failingRunner = (async (params: unknown) => {
      calls.push(params);
      return 7;
    }) as unknown as typeof import("../../scripts/lib/managed-child-process.mts").runManagedCommand;

    const status = await buildTsgoCoreTestTypedRuntimeDist({}, "/repo", failingRunner);

    expect(status).toBe(7);
    expect(calls).toHaveLength(1);
  });

  it("stops restoring owners after the first failing owner", async () => {
    const phases: string[] = [];
    const failingCopy = (async (params: { args: string[] }) => {
      const phase = params.args.join(" ");
      phases.push(phase);
      return phase.includes("bundled-plugin-assets.mts") && phase.includes("copy") ? 3 : 0;
    }) as unknown as typeof import("../../scripts/lib/managed-child-process.mts").runManagedCommand;

    const status = await buildTsgoCoreTestTypedRuntimeDist({}, "/repo", failingCopy);

    expect(status).toBe(3);
    expect(phases.at(-1)).toContain("copy");
    expect(phases.some((phase) => phase.includes("write-typed-runtime-entry-dts.ts"))).toBe(false);
  });
});
