import { describe, expectTypeOf, it } from "vitest";
import {
  resolveMemorySearchConfig,
  resolveMemorySearchSyncConfig,
  type ResolvedMemorySearchConfig,
} from "./memory-core-host-engine-foundation.js";

type IsOptional<T, K extends keyof T> = Pick<T, K> extends Required<Pick<T, K>> ? false : true;

describe("memory core host engine foundation contracts", () => {
  it("preserves the released resolved-config authoring shapes", () => {
    expectTypeOf<IsOptional<ResolvedMemorySearchConfig, "inputType">>().toEqualTypeOf<true>();
    expectTypeOf<IsOptional<ResolvedMemorySearchConfig, "queryInputType">>().toEqualTypeOf<true>();
    expectTypeOf<
      IsOptional<ResolvedMemorySearchConfig, "documentInputType">
    >().toEqualTypeOf<true>();
    expectTypeOf<
      IsOptional<ResolvedMemorySearchConfig, "outputDimensionality">
    >().toEqualTypeOf<true>();
    expectTypeOf<
      IsOptional<ResolvedMemorySearchConfig["local"], "modelPath">
    >().toEqualTypeOf<true>();
    expectTypeOf<
      IsOptional<ResolvedMemorySearchConfig["store"]["vector"], "extensionPath">
    >().toEqualTypeOf<true>();
    expectTypeOf<
      ResolvedMemorySearchConfig["sync"]["embeddingBatchTimeoutSeconds"]
    >().toEqualTypeOf<number | undefined>();
    // The producer always sets both keys, so the SDK-authoring shape must keep the
    // new one optional: a released v2026.9.4 consumer lacks it entirely.
    expectTypeOf<
      IsOptional<ResolvedMemorySearchConfig["sync"], "embeddingTimeoutSeconds">
    >().toEqualTypeOf<true>();
    const releasedShapedSync: Pick<
      ResolvedMemorySearchConfig["sync"],
      "embeddingBatchTimeoutSeconds" | "embeddingTimeoutSeconds"
    > = { embeddingBatchTimeoutSeconds: 5 };
    expectTypeOf(releasedShapedSync).toMatchTypeOf<
      Pick<ResolvedMemorySearchConfig["sync"], "embeddingBatchTimeoutSeconds">
    >();

    const local: ResolvedMemorySearchConfig["local"] = {};
    const vector: ResolvedMemorySearchConfig["store"]["vector"] = { enabled: true };
    expectTypeOf(local).toMatchTypeOf<ResolvedMemorySearchConfig["local"]>();
    expectTypeOf(vector).toMatchTypeOf<ResolvedMemorySearchConfig["store"]["vector"]>();
  });

  it("preserves the released resolver return contracts", () => {
    expectTypeOf<
      ReturnType<typeof resolveMemorySearchConfig>
    >().toEqualTypeOf<ResolvedMemorySearchConfig | null>();
    expectTypeOf<ReturnType<typeof resolveMemorySearchSyncConfig>>().toEqualTypeOf<
      ResolvedMemorySearchConfig["sync"] | null
    >();

    expectTypeOf<
      NonNullable<ReturnType<typeof resolveMemorySearchConfig>>["local"]["contextSize"]
    >().toEqualTypeOf<number | "auto" | undefined>();
    expectTypeOf<
      NonNullable<ReturnType<typeof resolveMemorySearchSyncConfig>>["embeddingBatchTimeoutSeconds"]
    >().toEqualTypeOf<number | undefined>();
  });
});
