import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ModelManifestNormalizationContext } from "../model-ref-shared.js";
import {
  resolveConfiguredDefaultAuthProfileId,
  resolveEffectiveDefaultDisposition,
} from "./model-selection-owner.js";

const DEFAULT_PROVIDER = "openai";
const DEFAULT_MODEL = "gpt-6-astra";

const noopContext: ModelManifestNormalizationContext = { manifestPlugins: [] };

function baseConfig(overrides: Partial<OpenClawConfig> = {}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`,
      },
    },
    ...overrides,
  } as OpenClawConfig;
}

function disposition(
  overrides: {
    config?: OpenClawConfig;
    opts?: { provider?: string; model?: string };
    sessionEntry?: {
      modelOverrideSource?: string;
      modelOverride?: string;
      providerOverride?: string;
      parentSessionKey?: string;
    };
    sessionStore?: Record<string, unknown>;
    sessionKey?: string;
    defaultProvider?: string;
    defaultModel?: string;
    allowPluginNormalization?: boolean;
  } = {},
) {
  return resolveEffectiveDefaultDisposition({
    cfg: overrides.config ?? baseConfig(),
    agentId: "main",
    opts: overrides.opts ?? {},
    sessionEntry: overrides.sessionEntry as never,
    sessionStore: overrides.sessionStore as never,
    sessionKey: overrides.sessionKey,
    defaultProvider: overrides.defaultProvider ?? DEFAULT_PROVIDER,
    defaultModel: overrides.defaultModel ?? DEFAULT_MODEL,
    allowPluginNormalization: overrides.allowPluginNormalization ?? false,
    modelManifestContext: noopContext,
  });
}

describe("resolveConfiguredDefaultAuthProfileId", () => {
  it("extracts the trailing auth-profile suffix from the agent's effective default model", () => {
    const profile = resolveConfiguredDefaultAuthProfileId(
      { agents: { defaults: { model: "anthropic/claude@anthropic:verified" } } } as never,
      "main",
    );
    expect(profile).toBe("anthropic:verified");
  });

  it("returns undefined when the default model has no auth-profile suffix", () => {
    const profile = resolveConfiguredDefaultAuthProfileId(
      { agents: { defaults: { model: "anthropic/claude" } } } as never,
      "main",
    );
    expect(profile).toBeUndefined();
  });
});

describe("resolveEffectiveDefaultDisposition (single owner)", () => {
  it("returns true with no override (default model, the codex reproduce case)", () => {
    const result = disposition();
    expect(result.effectiveIsDefault).toBe(true);
    expect(result.effectiveProvider).toBe(DEFAULT_PROVIDER);
    expect(result.effectiveModel).toBe(DEFAULT_MODEL);
  });

  it("returns true when the explicit provider/model equals the defaults", () => {
    expect(
      disposition({ opts: { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL } })
        .effectiveIsDefault,
    ).toBe(true);
  });

  it("returns true when only an explicit model equals the default model", () => {
    expect(disposition({ opts: { model: DEFAULT_MODEL } }).effectiveIsDefault).toBe(true);
  });

  it("returns false when an explicit provider leaves the default", () => {
    expect(disposition({ opts: { provider: "anthropic" } }).effectiveIsDefault).toBe(false);
  });

  it("returns false when an explicit model-ref carries a different provider", () => {
    expect(
      disposition({ opts: { model: "anthropic/claude@anthropic:verified" } }).effectiveIsDefault,
    ).toBe(false);
  });

  it("returns false when an explicit model leaves the default", () => {
    expect(disposition({ opts: { model: "openai/gpt-5" } }).effectiveIsDefault).toBe(false);
  });

  it("treats a stored override that is allowed but not the default as non-default", () => {
    const result = disposition({
      sessionEntry: {
        modelOverrideSource: "user",
        modelOverride: "gpt-5",
        providerOverride: DEFAULT_PROVIDER,
      },
    });
    // allowAny -> gpt-5 is allowed and different from the default -> not default.
    expect(result.effectiveIsDefault).toBe(false);
    expect(result.effectiveModel).toBe("gpt-5");
  });

  it("treats a stored override that literally equals the default as default", () => {
    expect(
      disposition({
        sessionEntry: {
          modelOverrideSource: "user",
          modelOverride: DEFAULT_MODEL,
          providerOverride: DEFAULT_PROVIDER,
        },
      }).effectiveIsDefault,
    ).toBe(true);
  });

  it("repairs a stored override that the visibility policy no longer allows back to the default (P1 repair)", () => {
    // allowlist only permits the default; the stored override is now disallowed,
    // so execution would repair it back to the default. The owner must agree.
    const cfg = baseConfig({
      agents: {
        defaults: {
          model: `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`,
          modelPolicy: { allow: [`${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`] },
        },
      },
    });
    const result = disposition({
      config: cfg,
      sessionEntry: {
        modelOverrideSource: "user",
        modelOverride: "gpt-5",
        providerOverride: DEFAULT_PROVIDER,
      },
    });
    expect(result.effectiveIsDefault).toBe(true);
    expect(result.effectiveProvider).toBe(DEFAULT_PROVIDER);
    expect(result.effectiveModel).toBe(DEFAULT_MODEL);
  });

  it("keeps an allowed stored override as non-default under an allowlist", () => {
    const cfg = baseConfig({
      agents: {
        defaults: {
          model: `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`,
          modelPolicy: { allow: [`${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`, "openai/gpt-5"] },
        },
      },
    });
    const result = disposition({
      config: cfg,
      sessionEntry: {
        modelOverrideSource: "user",
        modelOverride: "gpt-5",
        providerOverride: DEFAULT_PROVIDER,
      },
    });
    expect(result.effectiveIsDefault).toBe(false);
    expect(result.effectiveModel).toBe("gpt-5");
  });

  it("keeps the default implicit-allowed under an exact allowlist, matching execution", () => {
    // Visibility policy implicitly allows the configured default model even
    // when an exact allowlist omits it. The owner must agree with execution
    // (both share createModelVisibilityPolicy), so the default stays effective.
    const cfg = baseConfig({
      agents: {
        defaults: {
          model: `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`,
          modelPolicy: { allow: ["anthropic/claude"] },
        },
      },
    });
    const result = disposition({ config: cfg });
    expect(result.effectiveIsDefault).toBe(true);
  });

  it("resolves a stored alias to the default when it resolves back to the default", () => {
    // A stored alias that resolves to the default model should be treated as
    // default (full alias resolution, not conservative comparison).
    const result = disposition({
      sessionEntry: {
        modelOverrideSource: "user",
        modelOverride: `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`,
        providerOverride: DEFAULT_PROVIDER,
      },
    });
    expect(result.effectiveIsDefault).toBe(true);
  });

  it("reports the effective selection as default when auto-fallback probes back to the primary (P1-A)", () => {
    // A session that auto-fell-back with primary-origin metadata causes execution
    // to probe the configured primary (= default) before inference, so the
    // default-bound profile is required. The owner must report the default.
    const result = disposition({
      sessionEntry: {
        modelOverrideSource: "auto",
        providerOverride: DEFAULT_PROVIDER,
        modelOverride: "gpt-5",
        modelOverrideFallbackOriginProvider: DEFAULT_PROVIDER,
        modelOverrideFallbackOriginModel: DEFAULT_MODEL,
      } as never,
    });
    expect(result.effectiveIsDefault).toBe(true);
    expect(result.effectiveProvider).toBe(DEFAULT_PROVIDER);
    expect(result.effectiveModel).toBe(DEFAULT_MODEL);
  });

  it("keeps a non-primary-origin auto-fallback as non-default (no probe back to primary)", () => {
    // The fallback origin differs from the configured primary, so execution does
    // not probe back; the stored fallback stays effective and non-default.
    const result = disposition({
      sessionEntry: {
        modelOverrideSource: "auto",
        providerOverride: DEFAULT_PROVIDER,
        modelOverride: "gpt-5",
        modelOverrideFallbackOriginProvider: "anthropic",
        modelOverrideFallbackOriginModel: "claude",
      } as never,
    });
    expect(result.effectiveIsDefault).toBe(false);
  });

  it("returns configuredDefaultAuthProfileId from the default model suffix", () => {
    const cfg = baseConfig({
      agents: {
        defaults: {
          model: `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}@openai:verified`,
        },
      },
    });
    const result = disposition({ config: cfg });
    expect(result.configuredDefaultAuthProfileId).toBe("openai:verified");
  });
});
