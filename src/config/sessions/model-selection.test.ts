import { describe, expect, it } from "vitest";
import {
  MODEL_SELECTION_EXTENSION_NAMESPACE,
  normalizeSessionModelSelection,
  resolveSessionModelSelectionFromExtensions,
} from "./model-selection.js";

describe("session model-selection projection", () => {
  it("accepts a supported mode and sanitizes decision metadata", () => {
    expect(
      normalizeSessionModelSelection({
        mode: "auto",
        lastDecision: {
          model: "  openai/gpt-5.6-luna\n",
          reason: "complex \u0000 task",
          at: 1234,
          ignored: "not projected",
        },
      }),
    ).toEqual({
      mode: "auto",
      lastDecision: {
        model: "openai/gpt-5.6-luna",
        reason: "complex task",
        at: 1234,
      },
    });
  });

  it("rejects invalid modes and invalid decision fields", () => {
    expect(
      normalizeSessionModelSelection({
        mode: "enabled",
        lastDecision: { model: "ignored", at: -1 },
      }),
    ).toBeUndefined();
    expect(
      normalizeSessionModelSelection({
        mode: "shadow",
        lastDecision: { model: "", reason: "\u0000", at: Number.NaN },
      }),
    ).toEqual({ mode: "shadow" });
  });

  it("projects only the active namespaced extension", () => {
    expect(
      resolveSessionModelSelectionFromExtensions([
        { namespace: "other", value: { mode: "auto" } },
        {
          namespace: MODEL_SELECTION_EXTENSION_NAMESPACE,
          value: { mode: "off", lastDecision: { model: "openai/gpt-5.6-sol" } },
        },
      ]),
    ).toEqual({
      mode: "off",
      lastDecision: { model: "openai/gpt-5.6-sol" },
    });
    expect(resolveSessionModelSelectionFromExtensions(undefined)).toBeUndefined();
  });
});
