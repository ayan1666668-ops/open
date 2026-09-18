import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { buildCommandsMessagePaginated } from "./status.js";

const { listPluginCommands } = vi.hoisted(() => ({
  listPluginCommands: vi.fn(
    (_options?: {
      channel?: string;
    }): Array<{
      name: string;
      description: string;
      pluginId: string;
    }> => [],
  ),
}));

vi.mock("../plugins/commands.js", () => ({ listPluginCommands }));

afterEach(() => {
  listPluginCommands.mockReset();
  listPluginCommands.mockImplementation(() => []);
});

function collectPages(
  cfg: OpenClawConfig | undefined,
  options: Parameters<typeof buildCommandsMessagePaginated>[2],
): string {
  const firstPage = buildCommandsMessagePaginated(cfg, undefined, options);
  return Array.from(
    { length: firstPage.totalPages },
    (_, index) =>
      buildCommandsMessagePaginated(cfg, undefined, { ...options, page: index + 1 }).text,
  ).join("\n");
}

describe("buildCommandsMessagePaginated", () => {
  it.each([
    ["telegram", true],
    ["discord", false],
    ["slack", false],
  ] as const)("scopes native-only commands on %s", (surface, expected) => {
    const cfg = { commands: { config: false, debug: false, native: true } } as OpenClawConfig;
    const text = collectPages(cfg, { surface, page: 1, forcePaginatedList: true });
    expect(text.includes("/ignore - Keep one Telegram message out of the bot context.")).toBe(
      expected,
    );
  });

  it.each([
    ["provider", { channels: { telegram: { commands: { native: false } } } }],
    ["inherited", { commands: { native: false } }],
  ] as const)(
    "hides native-only commands when Telegram native commands are %s disabled",
    (_mode, cfg) => {
      expect(
        collectPages(cfg as OpenClawConfig, {
          surface: "telegram",
          page: 1,
          forcePaginatedList: true,
        }),
      ).not.toContain("/ignore - Keep one Telegram message out of the bot context.");
    },
  );

  it.each([
    { root: true, account: false, expected: false },
    { root: false, account: true, expected: true },
  ])(
    "uses the Telegram account native override ($root -> $account)",
    ({ root, account, expected }) => {
      const cfg = {
        channels: {
          telegram: {
            commands: { native: root },
            accounts: { work: { commands: { native: account } } },
          },
        },
      } as OpenClawConfig;
      const text = collectPages(cfg, {
        surface: "telegram",
        accountId: "work",
        page: 1,
        forcePaginatedList: true,
      });
      expect(text.includes("/ignore - Keep one Telegram message out of the bot context.")).toBe(
        expected,
      );
    },
  );

  it.each([
    ["root", { customCommands: [{ command: "ignore", description: "Custom ignore" }] }],
    [
      "account",
      {
        accounts: {
          work: { customCommands: [{ command: "/IGNORE", description: "Custom ignore" }] },
        },
      },
    ],
  ] as const)(
    "hides native /ignore semantics behind a Telegram %s custom shadow",
    (_mode, telegram) => {
      const text = collectPages({ channels: { telegram } } as unknown as OpenClawConfig, {
        surface: "telegram",
        accountId: "work",
        page: 1,
        forcePaginatedList: true,
      });
      expect(text).not.toContain("/ignore - Keep one Telegram message out of the bot context.");
      expect(text).toContain("/commands - List all slash commands.");
    },
  );

  it("formats telegram output with pages", () => {
    const result = buildCommandsMessagePaginated(
      { commands: { config: false, debug: false } } as OpenClawConfig,
      undefined,
      { surface: "telegram", page: 1, forcePaginatedList: true },
    );
    expect(result.text).toContain("ℹ️ Commands (1/");
    expect(result.text).toContain("Session");
    expect(result.text).toContain("/stop - Stop the current run.");
  });

  it("includes plugin commands in the paginated list", () => {
    const pluginCommands = [
      { name: "plugin_cmd", description: "Plugin command", pluginId: "demo-plugin" },
    ];
    listPluginCommands.mockImplementation(() => pluginCommands);
    expect(listPluginCommands()).toEqual(pluginCommands);
    const text = collectPages({ commands: { config: false, debug: false } } as OpenClawConfig, {
      surface: "telegram",
      page: 1,
      forcePaginatedList: true,
    });
    expect(text).toContain("Plugins");
    expect(text).toContain("/plugin_cmd (demo-plugin) - Plugin command");
  });

  it("hides built-in /ignore semantics when a Telegram plugin owns /ignore", () => {
    listPluginCommands.mockImplementation(() => [
      { name: "ignore", description: "Plugin-owned ignore", pluginId: "demo-plugin" },
    ]);
    const text = collectPages(undefined, {
      surface: "telegram",
      page: 1,
      forcePaginatedList: true,
    });
    expect(text).not.toContain("/ignore - Keep one Telegram message out of the bot context.");
    expect(text).toContain("/ignore (demo-plugin) - Plugin-owned ignore");
  });

  it("keeps built-in /ignore semantics when only another channel owns /ignore", () => {
    listPluginCommands.mockImplementation((options) =>
      options?.channel === "telegram"
        ? []
        : [{ name: "ignore", description: "Discord-only ignore", pluginId: "demo-plugin" }],
    );
    const result = buildCommandsMessagePaginated(undefined, undefined, {
      surface: "telegram",
      forcePaginatedList: false,
    });
    expect(listPluginCommands).toHaveBeenCalledWith({ channel: "telegram" });
    expect(result.text).toContain("/ignore - Keep one Telegram message out of the bot context.");
    expect(result.text).not.toContain("Discord-only ignore");
  });
});
