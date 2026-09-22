// Typed runtime preparation tests cover the runtime owners the prepare step restores.
import { describe, expect, it } from "vitest";
import { BUILD_ALL_STEPS, resolveBuildAllStep } from "../../scripts/build-all.mts";
import {
  buildTsgoCoreTestTypedRuntimeDist,
  listRestoredRuntimeSteps,
} from "../../scripts/lib/tsgo-core-test-dist-build.mts";

describe("typed runtime declaration preparation", () => {
  it("restores the cleaned runtime artifacts through their canonical owners", () => {
    expect(listRestoredRuntimeSteps().map((step) => step.label)).toEqual([
      "external-plugins:local-dist",
      "plugins:assets:copy",
      "runtime-postbuild",
    ]);
  });

  it("keeps every restored owner a step build-all still defines", () => {
    for (const step of listRestoredRuntimeSteps()) {
      expect(BUILD_ALL_STEPS).toContain(step);
    }
  });

  it("resolves the copied plugin assets through their node owner", () => {
    const assetStep = listRestoredRuntimeSteps().find(
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
});
