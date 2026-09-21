import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DecisionOutcome, DecisionRuntimeV1 } from "openclaw/plugin-sdk/decisions";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import plugin from "../index.js";

function judgment(probabilities: Record<string, number> = {}): DecisionOutcome {
  return {
    status: "ok",
    provenance: { providerId: "typesafe", rubricVersion: "1", runtimeGeneration: "test" },
    result: {
      model: "jev-test",
      answers: Object.fromEntries(
        ["exfiltration", "destruction", "security_bypass", "needs_review"].map((id) => [
          id,
          { type: "boolean", probabilityTrue: probabilities[id] ?? 0.01 },
        ]),
      ),
    },
  };
}

function register(pluginConfig: Record<string, unknown> = { toolSafety: { enabled: true } }) {
  const evaluate = vi.fn<DecisionRuntimeV1["evaluate"]>().mockResolvedValue(judgment());
  const registerTrustedToolPolicy = vi.fn<OpenClawPluginApi["registerTrustedToolPolicy"]>();
  const api = createTestPluginApi({
    id: "typesafe",
    pluginConfig,
    runtime: createPluginRuntimeMock({
      config: { current: () => ({ plugins: { entries: { typesafe: { config: pluginConfig } } } }) },
      decisions: { evaluate },
    }),
    registerTrustedToolPolicy,
  });
  plugin.register(api);
  return {
    evaluate,
    registerTrustedToolPolicy,
    policy() {
      const registration = registerTrustedToolPolicy.mock.calls[0]?.[0];
      if (!registration) {
        throw new Error("Expected the enabled plugin to register tool safety");
      }
      return registration;
    },
  };
}

function toolCall(params: Record<string, unknown> = { command: "git status --short" }) {
  return { toolName: "exec", params };
}

function context(signal = new AbortController().signal) {
  return { toolName: "exec", agentId: "research", abortSignal: signal };
}

describe("registered TypeSafe tool safety policy", () => {
  it("keeps safety screening opt-in", () => {
    for (const config of [{}, { toolSafety: { enabled: false } }]) {
      const fixture = register(config);
      expect(fixture.registerTrustedToolPolicy).not.toHaveBeenCalled();
      expect(fixture.evaluate).not.toHaveBeenCalled();
    }
  });

  it("leaves low-risk calls to existing permissions and uses the owning agent's decision runtime", async () => {
    const fixture = register();
    const ctx = context();
    expect(fixture.registerTrustedToolPolicy).toHaveBeenCalledTimes(1);
    await expect(fixture.policy().evaluate(toolCall(), ctx)).resolves.toBeUndefined();
    expect(fixture.evaluate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ state: expect.objectContaining({ toolName: "exec" }) }),
      expect.objectContaining({
        agentId: "research",
        signal: ctx.abortSignal,
        purpose: "typesafe.tool-safety",
        timeoutMs: 10000,
      }),
    );
  });

  it.each(["exfiltration", "destruction", "security_bypass"])(
    "blocks when %s alone reaches the block threshold",
    async (risk) => {
      const fixture = register();
      fixture.evaluate.mockResolvedValue(judgment({ [risk]: 0.85 }));
      await expect(fixture.policy().evaluate(toolCall(), context())).resolves.toMatchObject({
        block: true,
        blockReason: expect.stringContaining("Tool safety blocked"),
      });
    },
  );

  it.each([
    { name: "uncertain risk", outcome: judgment({ destruction: 0.25 }) },
    { name: "missing material context", outcome: judgment({ needs_review: 0.9 }) },
    {
      name: "unavailable provider",
      outcome: { status: "unavailable", reason: "deadline" } as const,
    },
  ])("requests one-call review for $name", async ({ outcome }) => {
    const fixture = register();
    fixture.evaluate.mockResolvedValue(outcome);
    await expect(fixture.policy().evaluate(toolCall(), context())).resolves.toMatchObject({
      requireApproval: { allowedDecisions: ["allow-once", "deny"], severity: "warning" },
    });
  });

  it("rejects missing cancellation ownership before evaluating", async () => {
    const fixture = register();
    await expect(
      fixture.policy().evaluate(toolCall(), { toolName: "exec", agentId: "research" }),
    ).resolves.toMatchObject({ block: true });
    expect(fixture.evaluate).not.toHaveBeenCalled();
  });

  it.each(["before", "during"])("preserves cancellation %s evaluation", async (stage) => {
    const fixture = register();
    const controller = new AbortController();
    const reason = new Error("Owning tool call cancelled");
    if (stage === "before") {
      controller.abort(reason);
    } else {
      fixture.evaluate.mockImplementation(async () => {
        controller.abort(reason);
        return judgment();
      });
    }
    await expect(fixture.policy().evaluate(toolCall(), context(controller.signal))).rejects.toBe(
      reason,
    );
    expect(fixture.evaluate).toHaveBeenCalledTimes(stage === "before" ? 0 : 1);
  });

  it("blocks oversized or cyclic arguments without sending them for assessment", async () => {
    const fixture = register();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const params of [{ text: "界".repeat(12000) }, cyclic]) {
      await expect(fixture.policy().evaluate(toolCall(params), context())).resolves.toMatchObject({
        block: true,
      });
    }
    expect(fixture.evaluate).not.toHaveBeenCalled();
  });

  it("preserves configured and built-in redaction in provider and approval evidence even with logging redaction off", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "openclaw-typesafe-redaction-"));
    const configPath = path.join(directory, "openclaw.json");
    writeFileSync(
      configPath,
      JSON.stringify({ logging: { redactSensitive: "off", redactPatterns: ["/internal-\\d+/g"] } }),
    );
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    try {
      const fixture = register({
        toolSafety: { enabled: true, policy: "Protect internal-12345." },
      });
      fixture.evaluate.mockResolvedValue(judgment({ needs_review: 0.9 }));
      const params = {
        command: "inspect internal-12345 settings",
        apiKey: "synthetic-api-credential-for-redaction-test",
        nested: { password: "synthetic-password-for-redaction-test" },
      };
      const original = structuredClone(params);
      const result = await fixture.policy().evaluate(toolCall(params), context());
      const submitted = JSON.stringify(fixture.evaluate.mock.calls[0]?.[0]);
      expect(submitted).toContain("inspect");
      expect(submitted).not.toContain("internal-12345");
      expect(submitted).not.toContain(params.apiKey);
      expect(submitted).not.toContain(params.nested.password);
      expect(params).toEqual(original);
      if (!result || !("requireApproval" in result) || !result.requireApproval) {
        throw new Error("Expected review for a call that fits the approval display");
      }
      const description = result.requireApproval.description;
      expect(description).toContain("exec");
      expect(description).toContain("inspect");
      expect(description).not.toContain("internal-12345");
      expect(description).not.toContain(params.apiKey);
      expect(description).not.toContain(params.nested.password);
      expect(description.length).toBeLessThanOrEqual(512);
    } finally {
      vi.unstubAllEnvs();
      unlinkSync(configPath);
      rmdirSync(directory);
    }
  });

  it("blocks review when the full call cannot fit the approval display", async () => {
    const fixture = register();
    fixture.evaluate.mockResolvedValue(judgment({ needs_review: 0.9 }));
    const result = await fixture
      .policy()
      .evaluate(
        toolCall({ command: `${"echo bounded-output; ".repeat(40)}delete-important-data` }),
        context(),
      );
    expect(fixture.evaluate).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      block: true,
      blockReason: expect.stringContaining("Split it into smaller calls"),
    });
    expect(result).not.toHaveProperty("requireApproval");
  });

  it("uses operator thresholds and rejects invalid ordering or out-of-range configuration", async () => {
    const fixture = register({
      toolSafety: { enabled: true, reviewThreshold: 0.1, blockThreshold: 0.4 },
    });
    fixture.evaluate.mockResolvedValue(judgment({ exfiltration: 0.4 }));
    await expect(fixture.policy().evaluate(toolCall(), context())).resolves.toMatchObject({
      block: true,
    });
    for (const thresholds of [
      { reviewThreshold: 0.9, blockThreshold: 0.8 },
      { reviewThreshold: 0.5, blockThreshold: 0.5 },
      { reviewThreshold: -0.1 },
      { blockThreshold: 1.1 },
    ]) {
      expect(() => register({ toolSafety: { enabled: true, ...thresholds } })).toThrow();
    }
  });
});
