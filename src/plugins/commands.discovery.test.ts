import { afterEach, describe, expect, it } from "vitest";
import { clearPluginCommands, listPluginCommands, registerPluginCommand } from "./commands.js";

afterEach(() => {
  clearPluginCommands();
});

describe("plugin command discovery", () => {
  it("filters command discovery by channel scope", () => {
    for (const command of [
      { name: "global", description: "Global command" },
      { name: "discord_only", description: "Discord command", channels: ["discord"] },
      {
        name: "telegram_only",
        description: "Telegram command",
        channels: ["telegram"],
        nativeNames: { telegram: "ignore" },
      },
    ]) {
      expect(
        registerPluginCommand("demo-plugin", {
          ...command,
          handler: async () => ({ text: "ok" }),
        }),
      ).toEqual({ ok: true });
    }

    expect(listPluginCommands({ channel: "telegram" }).map((command) => command.name)).toEqual([
      "global",
      "ignore",
    ]);
    expect(listPluginCommands({ channel: "discord" }).map((command) => command.name)).toEqual([
      "global",
      "discord_only",
    ]);
    expect(listPluginCommands().map((command) => command.name)).toEqual([
      "global",
      "discord_only",
      "telegram_only",
    ]);
  });
});
