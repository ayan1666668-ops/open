import fs from "node:fs/promises";
import { expect, it } from "vitest";
import { readCodexPluginConfig, resolveCodexAppServerNativeHookRelay } from "./config.js";

export function registerNativeHookRelayConfigTests() {
  it("parses the native hook relay toggle", () => {
    expect(
      readCodexPluginConfig({ appServer: { nativeHookRelay: { enabled: false } } }).appServer
        ?.nativeHookRelay,
    ).toEqual({ enabled: false });
    expect(
      readCodexPluginConfig({ appServer: { nativeHookRelay: { enabled: true } } }).appServer
        ?.nativeHookRelay,
    ).toEqual({ enabled: true });
  });

  it("rejects an unknown native hook relay key", () => {
    // Defense in depth: the manifest schema (`additionalProperties: false`) is the
    // first line and rejects a typo at load with a config issue naming the key, so
    // this parser path is normally unreachable for hand-written config. It stays
    // strict for configs that bypass manifest validation — and note the blast
    // radius if it ever fires: `readCodexPluginConfig` returns {} for any parse
    // failure, discarding the rest of the codex plugin config with it.
    expect(
      readCodexPluginConfig({
        appServer: { approvalPolicy: "on-request", nativeHookRelay: { enabeld: false } },
      }),
    ).toStrictEqual({});
    // The same is true for the `events` key this surface no longer exposes.
    expect(
      readCodexPluginConfig({
        appServer: { nativeHookRelay: { enabled: false, events: ["post_tool_use"] } },
      }),
    ).toStrictEqual({});
  });

  it("reads the native hook relay kill-switch without applying any approval policy", () => {
    // Parse layer is policy-free: the guard runs in the run paths once the
    // effective approval policy is known.
    expect(resolveCodexAppServerNativeHookRelay(undefined)).toStrictEqual({ enabled: true });
    expect(resolveCodexAppServerNativeHookRelay({ appServer: {} })).toStrictEqual({
      enabled: true,
    });
    expect(
      resolveCodexAppServerNativeHookRelay({ appServer: { nativeHookRelay: { enabled: true } } }),
    ).toStrictEqual({ enabled: true });
    expect(
      resolveCodexAppServerNativeHookRelay({ appServer: { nativeHookRelay: { enabled: false } } }),
    ).toStrictEqual({ enabled: false });
    // A configured approval policy does not change anything here. "untrusted" is
    // not in this set because it is no longer configurable at all: the parser
    // rejects it outright ("rejects the retired untrusted approval policy at
    // runtime"), so it can never reach this resolver from operator config.
    for (const approvalPolicy of ["never", "on-request"] as const) {
      expect(
        resolveCodexAppServerNativeHookRelay({
          appServer: { approvalPolicy, nativeHookRelay: { enabled: false } },
        }),
      ).toStrictEqual({ enabled: false });
    }
  });

  it("keeps the plugin manifest configSchema in sync for appServer.nativeHookRelay", async () => {
    const manifest = JSON.parse(
      await fs.readFile(new URL("../../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as {
      configSchema: {
        properties: {
          appServer: {
            properties: Record<
              string,
              {
                additionalProperties?: unknown;
                properties?: Record<string, { items?: { enum?: string[] } }>;
              }
            >;
          };
        };
      };
    };
    const relay = manifest.configSchema.properties.appServer.properties.nativeHookRelay;
    if (!relay) {
      throw new Error("nativeHookRelay missing from codex plugin manifest configSchema");
    }
    expect(Object.keys(relay.properties ?? {}).toSorted()).toStrictEqual(["enabled"]);
    // Manifest validation runs before the runtime parser, so it must reject the
    // same unknown keys the strict zod object does (see schema-validator.test.ts).
    expect(relay.additionalProperties).toBe(false);
  });
}
