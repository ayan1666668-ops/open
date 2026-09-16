// Sandbox config tests cover resolved agent sandbox settings after config
// normalization and timer-safe clamping.
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveSandboxConfigForAgent } from "./config.js";

describe("sandbox config", () => {
  it("tracks whether tmpfs came from defaults or explicit config", () => {
    expect(resolveSandboxConfigForAgent().dockerTmpfsSource).toBe("default");
    expect(
      resolveSandboxConfigForAgent({
        agents: {
          defaults: {
            sandbox: {
              docker: { tmpfs: ["/run"] },
            },
          },
        },
      }).dockerTmpfsSource,
    ).toBe("configured");
  });

  it("resolves capAdd only for a non-empty capability grant", () => {
    // Absent: the resolved config carries no capAdd, so an unchanged config keeps
    // its pre-change container hash instead of forcing needless recreation.
    expect(resolveSandboxConfigForAgent().docker.capAdd).toBeUndefined();

    // Explicit empty array canonicalizes to undefined for the same reason.
    expect(
      resolveSandboxConfigForAgent({
        agents: { defaults: { sandbox: { docker: { capAdd: [] } } } },
      }).docker.capAdd,
    ).toBeUndefined();

    // A real grant is preserved so it reaches --cap-add and invalidates reuse.
    expect(
      resolveSandboxConfigForAgent({
        agents: { defaults: { sandbox: { docker: { capAdd: ["NET_RAW"] } } } },
      }).docker.capAdd,
    ).toEqual(["NET_RAW"]);
  });

  it("caps browser autostart timeout to a timer-safe delay", () => {
    // Browser startup timeouts flow into Node timers; huge config values must
    // not overflow or become immediate delays.
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: {
            browser: {
              autoStartTimeoutMs: Number.MAX_SAFE_INTEGER,
            },
          },
        },
      },
    };

    expect(resolveSandboxConfigForAgent(cfg, "main").browser.autoStartTimeoutMs).toBe(
      MAX_TIMER_TIMEOUT_MS,
    );
  });
});
