// Telegram tests cover group migration plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { migrateTelegramGroupConfig } from "./group-migration.js";

function createTelegramGlobalGroupConfig(groups: Record<string, Record<string, unknown>>) {
  return {
    channels: {
      telegram: {
        groups,
      },
    },
  };
}

function createTelegramAccountGroupConfig(
  accountId: string,
  groups: Record<string, Record<string, unknown>>,
) {
  return {
    channels: {
      telegram: {
        accounts: {
          [accountId]: {
            groups,
          },
        },
      },
    },
  };
}

describe("migrateTelegramGroupConfig", () => {
  it("migrates global group ids", () => {
    const cfg = createTelegramGlobalGroupConfig({
      "-123": { requireMention: false },
    });

    const result = migrateTelegramGroupConfig({
      cfg,
      accountId: "default",
      oldChatId: "-123",
      newChatId: "-100123",
    });

    expect(result.migrated).toBe(true);
    expect(cfg.channels.telegram.groups).toEqual({
      "-100123": { requireMention: false },
    });
  });

  it("migrates account-scoped groups", () => {
    const cfg = createTelegramAccountGroupConfig("primary", {
      "-123": { requireMention: true },
    });

    const result = migrateTelegramGroupConfig({
      cfg,
      accountId: "primary",
      oldChatId: "-123",
      newChatId: "-100123",
    });

    expect(result.migrated).toBe(true);
    expect(result.scopes).toEqual(["account"]);
    expect(
      expectDefined(cfg.channels.telegram.accounts.primary, "primary Telegram account").groups,
    ).toEqual({
      "-100123": { requireMention: true },
    });
  });

  it("matches account ids case-insensitively", () => {
    const cfg = createTelegramAccountGroupConfig("Primary", {
      "-123": {},
    });

    const result = migrateTelegramGroupConfig({
      cfg,
      accountId: "primary",
      oldChatId: "-123",
      newChatId: "-100123",
    });

    expect(result.migrated).toBe(true);
    expect(
      expectDefined(cfg.channels.telegram.accounts.Primary, "Primary Telegram account").groups,
    ).toEqual({
      "-100123": {},
    });
  });

  it("skips migration when new id already exists", () => {
    const cfg = createTelegramGlobalGroupConfig({
      "-123": { requireMention: true },
      "-100123": { requireMention: false },
    });

    const result = migrateTelegramGroupConfig({
      cfg,
      accountId: "default",
      oldChatId: "-123",
      newChatId: "-100123",
    });

    expect(result.migrated).toBe(false);
    expect(result.skippedExisting).toBe(true);
    expect(cfg.channels.telegram.groups).toEqual({
      "-123": { requireMention: true },
      "-100123": { requireMention: false },
    });
  });

  it("no-ops when old and new group ids are the same", () => {
    const cfg = createTelegramGlobalGroupConfig({
      "-123": { requireMention: true },
    });
    const result = migrateTelegramGroupConfig({
      cfg,
      accountId: "default",
      oldChatId: "-123",
      newChatId: "-123",
    });
    expect(result).toEqual({ migrated: false, skippedExisting: false, scopes: [] });
    expect(cfg.channels.telegram.groups).toEqual({
      "-123": { requireMention: true },
    });
  });

  it("rejects an owned undefined source without moving it", () => {
    const cfg = createTelegramGlobalGroupConfig({});
    Object.defineProperty(cfg.channels.telegram.groups, "-123", {
      value: undefined,
      enumerable: true,
      configurable: true,
    });
    expect(() =>
      migrateTelegramGroupConfig({ cfg, oldChatId: "-123", newChatId: "-100123" }),
    ).toThrow("expected owned Telegram group config key to be defined");
    expect(Object.keys(cfg.channels.telegram.groups)).toEqual(["-123"]);
  });
});
