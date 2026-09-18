import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveManifestModelIdNormalizationPoliciesMock = vi.hoisted(() => vi.fn());
const normalizeProviderModelIdWithRuntimeMock = vi.hoisted(() => vi.fn());

vi.mock("../plugins/manifest-model-id-normalization.js", () => ({
  resolveManifestModelIdNormalizationPolicies: resolveManifestModelIdNormalizationPoliciesMock,
}));

vi.mock("../agents/provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: normalizeProviderModelIdWithRuntimeMock,
}));

describe("statusSummaryRuntime configured model normalization", () => {
  beforeEach(() => {
    vi.resetModules();
    resolveManifestModelIdNormalizationPoliciesMock.mockReset();
    normalizeProviderModelIdWithRuntimeMock.mockReset();
  });

  it("skips manifest and plugin model normalization for configured model refs", async () => {
    const { statusSummaryRuntime } = await import("../status/summary.runtime.js");

    expect(
      statusSummaryRuntime.resolveConfiguredStatusModelRef({
        cfg: {
          agents: {
            defaults: {
              model: { primary: "openai-codex/gpt-5.5" },
            },
          },
        } as never,
        defaultProvider: "openai",
        defaultModel: "gpt-5.5",
      }),
    ).toEqual({
      provider: "openai-codex",
      model: "gpt-5.5",
    });

    expect(
      statusSummaryRuntime.resolveConfiguredStatusModelRef({
        cfg: {
          agents: {
            defaults: {
              model: { primary: "fast-codex" },
              models: {
                "openai-codex/gpt-5.5": { alias: "fast-codex" },
              },
            },
          },
        } as never,
        defaultProvider: "openai",
        defaultModel: "gpt-5.5",
      }),
    ).toEqual({
      provider: "openai-codex",
      model: "gpt-5.5",
    });

    expect(resolveManifestModelIdNormalizationPoliciesMock).not.toHaveBeenCalled();
    expect(normalizeProviderModelIdWithRuntimeMock).not.toHaveBeenCalled();
  });

  it("skips manifest and plugin normalization when projecting accepted and deferred selections", async () => {
    const { statusSummaryRuntime } = await import("../status/summary.runtime.js");
    const configured = { provider: "anthropic", model: "claude-sonnet-4-6" };

    normalizeProviderModelIdWithRuntimeMock.mockReturnValue("runtime-normalized-opus");

    expect(
      statusSummaryRuntime.resolveSessionModelRef(configured, {
        executionSelection: {
          state: "accepted",
          selection: {
            model: { provider: "anthropic", id: "opus-4.6" },
            executor: { kind: "harness", id: "openclaw" },
          },
          fallbackPermission: "explicit",
        },
      }),
    ).toEqual({
      provider: "anthropic",
      model: "opus-4.6",
    });

    expect(
      statusSummaryRuntime.resolveSessionModelRef(configured, {
        model: "fallback-runtime-model",
        executionSelection: {
          state: "deferred",
          request: { model: { provider: "anthropic", id: "opus-4.6" } },
          fallbackPermission: "explicit",
        },
      }),
    ).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });

    expect(
      statusSummaryRuntime.resolveStatusModelComparisonLabel({
        provider: "anthropic",
        model: "opus-4.6",
        defaultProvider: "anthropic",
      }),
    ).toBe("anthropic/claude-opus-4-6");
    expect(
      statusSummaryRuntime.resolveStatusModelLookupRef({
        provider: "anthropic",
        model: "opus-4.6",
        defaultProvider: "anthropic",
      }),
    ).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-6",
    });

    expect(resolveManifestModelIdNormalizationPoliciesMock).not.toHaveBeenCalled();
    expect(normalizeProviderModelIdWithRuntimeMock).not.toHaveBeenCalled();
  });
});
