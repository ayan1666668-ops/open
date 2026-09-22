// Verifies runtime channel capabilities derived from channel account config.
import { describe, expect, it } from "vitest";
import { collectRuntimeChannelCapabilities } from "./runtime-capabilities.js";

describe("collectRuntimeChannelCapabilities", () => {
  it("advertises markdown details when the browser handshake includes the flag", () => {
    expect(
      collectRuntimeChannelCapabilities({
        channel: "webchat",
        clientCaps: ["tool-events", "markdown-details"],
      }),
    ).toEqual(["markdownDetails"]);
  });

  it("does not advertise markdown details when an explicit capability list omits the flag", () => {
    expect(
      collectRuntimeChannelCapabilities({
        channel: "webchat",
        clientCaps: ["tool-events", "inline-widgets"],
      }),
    ).toBeUndefined();
  });

  it("keeps disclosure guidance for a legacy webchat client that sends no capability list", () => {
    expect(collectRuntimeChannelCapabilities({ channel: "webchat" })).toEqual(["markdownDetails"]);
    expect(
      collectRuntimeChannelCapabilities({
        channel: "webchat",
        clientCaps: [],
      }),
    ).toEqual(["markdownDetails"]);
    expect(
      collectRuntimeChannelCapabilities({
        channel: "webchat",
        clientCaps: null,
      }),
    ).toEqual(["markdownDetails"]);
  });

  it("does not advertise markdown details for a plugin-less non-webchat channel", () => {
    expect(collectRuntimeChannelCapabilities({ channel: "heartbeat" })).toBeUndefined();
    expect(
      collectRuntimeChannelCapabilities({
        channel: "heartbeat",
        clientCaps: [],
      }),
    ).toBeUndefined();
  });

  it("adds thread-bound spawn capabilities when the channel account allows unified spawns", () => {
    const capabilities = collectRuntimeChannelCapabilities({
      channel: "discord",
      accountId: "default",
      cfg: {
        session: {
          threadBindings: {
            spawnSessions: true,
          },
        },
      },
    });

    expect(capabilities).toEqual(["threadbound-subagent-spawn", "threadbound-acp-spawn"]);
  });

  it("omits thread-bound spawn capabilities when unified spawns are disabled", () => {
    const capabilities = collectRuntimeChannelCapabilities({
      channel: "discord",
      accountId: "default",
      cfg: {
        session: {
          threadBindings: {
            spawnSessions: false,
          },
        },
      },
    });

    expect(capabilities).toBeUndefined();
  });
});
