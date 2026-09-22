import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import { feishuPlugin } from "./channel.js";

describe("feishuPlugin.security.collectWarnings", () => {
  it("records an intentional open groupPolicy as a non-blocking posture advisory", async () => {
    const cfg = {
      channels: {
        feishu: {
          groupPolicy: "open",
          accounts: {
            default: {
              appId: "app-id",
              appSecret: "app-secret",
            },
          },
        },
      },
    } as OpenClawConfig;
    const account = feishuPlugin.config.resolveAccount(cfg, "default");

    expect(
      await feishuPlugin.security?.collectWarnings?.({
        cfg,
        accountId: "default",
        account,
      }),
    ).toEqual([
      {
        checkId: "channels.feishu.groups.open",
        severity: "warn",
        title: "Feishu security warning",
        detail:
          'Feishu[default] groups: groupPolicy="open" allows any member to trigger (mention-gated). Set channels.feishu.groupPolicy="allowlist" + channels.feishu.groupAllowFrom to restrict senders.',
      },
    ]);
  });
});

describe("feishuPlugin security", () => {
  it("exposes account-scoped DM policy to security audits", () => {
    const cfg = {
      channels: {
        feishu: {
          allowFrom: ["*", "feishu:user:ou_owner"],
          accounts: {
            ops: {
              appId: "cli_ops",
              appSecret: "secret_ops",
              dmPolicy: "open",
            },
          },
        },
      },
    } as OpenClawConfig;
    const resolveDmPolicy = feishuPlugin.security?.resolveDmPolicy;
    if (!resolveDmPolicy) {
      throw new Error("feishu security.resolveDmPolicy unavailable");
    }

    const result = resolveDmPolicy({
      cfg,
      accountId: "ops",
      account: feishuPlugin.config.resolveAccount(cfg, "ops"),
    });

    expect(result).toMatchObject({
      policy: "open",
      allowFrom: ["*", "user:ou_owner"],
      policyPath: "channels.feishu.accounts.ops.dmPolicy",
      allowFromPath: "channels.feishu.",
    });
    expect(result?.normalizeEntry?.("feishu:user:ou_owner")).toBe("ou_owner");
    expect(result?.normalizeEntry?.("feishu:user:u123")).toBe("u123");
    expect(result?.normalizeEntry?.("feishu:user:u123", "config")).toBe("u123");
    expect(result?.normalizeEntry?.("u123", "store")).toBe("u123");
  });

  it("tracks a root DM policy separately from an account allowlist", () => {
    const cfg = {
      channels: {
        feishu: {
          dmPolicy: "open",
          accounts: {
            ops: {
              appId: "cli_ops",
              appSecret: "secret_ops",
              allowFrom: ["*"],
            },
          },
        },
      },
    } as OpenClawConfig;
    const resolveDmPolicy = feishuPlugin.security?.resolveDmPolicy;
    if (!resolveDmPolicy) {
      throw new Error("feishu security.resolveDmPolicy unavailable");
    }

    const result = resolveDmPolicy({
      cfg,
      accountId: "ops",
      account: feishuPlugin.config.resolveAccount(cfg, "ops"),
    });

    expect(result).toMatchObject({
      policy: "open",
      allowFrom: ["*"],
      policyPath: "channels.feishu.dmPolicy",
      allowFromPath: "channels.feishu.accounts.ops.",
    });
  });

  it("preserves the authored account key in audit paths after normalized lookup", () => {
    const cfg = {
      channels: {
        feishu: {
          accounts: {
            " Ops ": {
              appId: "cli_ops",
              appSecret: "secret_ops",
              dmPolicy: "open",
              allowFrom: ["*"],
            },
          },
        },
      },
    } as OpenClawConfig;
    const resolveDmPolicy = feishuPlugin.security?.resolveDmPolicy;
    if (!resolveDmPolicy) {
      throw new Error("feishu security.resolveDmPolicy unavailable");
    }

    const result = resolveDmPolicy({
      cfg,
      accountId: "ops",
      account: feishuPlugin.config.resolveAccount(cfg, "ops"),
    });

    expect(result).toMatchObject({
      policy: "open",
      allowFrom: ["*"],
      policyPath: "channels.feishu.accounts. Ops .dmPolicy",
      allowFromPath: "channels.feishu.accounts. Ops .",
    });
  });
});
