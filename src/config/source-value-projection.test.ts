// Covers stack-safe projection of runtime edits onto deeply nested sources.
import { describe, expect, it } from "vitest";
import { projectRuntimeChangesOntoSource } from "./source-value-projection.js";

function buildNestedObject(depth: number, leaf: Record<string, unknown>): Record<string, unknown> {
  let value: Record<string, unknown> = leaf;
  for (let i = 0; i < depth; i += 1) {
    value = { level: value };
  }
  return value;
}

function readDeepLeaf(value: unknown, depth: number): unknown {
  let current = value;
  for (let i = 0; i < depth; i += 1) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>).level;
  }
  return current;
}

describe("projectRuntimeChangesOntoSource", () => {
  it("projects a deep leaf edit without a call-stack overflow", () => {
    const depth = 2_000;
    const source = buildNestedObject(depth, { leaf: "old" });
    const runtime = buildNestedObject(depth, { leaf: "old" });
    const next = buildNestedObject(depth, { leaf: "new" });
    const projected = projectRuntimeChangesOntoSource(source, runtime, next);
    expect(readDeepLeaf(projected, depth)).toEqual({ leaf: "new" });
  });

  it("clones an unchanged deep document without a call-stack overflow", () => {
    const depth = 2_000;
    const source = buildNestedObject(depth, { leaf: "value" });
    const projected = projectRuntimeChangesOntoSource(source, source, source) as Record<
      string,
      unknown
    >;
    // Avoid vitest's own recursive toEqual on the full tree; assert shape
    // through the iterative walker instead.
    expect(projected).not.toBe(source);
    expect(Object.keys(projected)).toEqual(["level"]);
    expect(readDeepLeaf(projected, depth)).toEqual({ leaf: "value" });
  });
});
