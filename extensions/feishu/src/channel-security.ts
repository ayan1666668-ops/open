import { DEFAULT_ACCOUNT_ID, resolveAccountEntry } from "openclaw/plugin-sdk/account-resolution";
import { createScopedDmSecurityResolver } from "openclaw/plugin-sdk/channel-config-helpers";
import { readChannelIngressStoreAllowFromForDmPolicy } from "openclaw/plugin-sdk/channel-ingress-runtime";
import {
  createAllowlistProviderGroupPolicyWarningCollector,
  createConditionalWarningCollector,
} from "openclaw/plugin-sdk/channel-policy";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ChannelPlugin, ClawdbotConfig } from "../runtime-api.js";
import { resolveFeishuAccount } from "./accounts.js";
import { normalizeFeishuAllowEntry } from "./policy.js";
import { collectFeishuSecurityAuditFindings } from "./security-audit.js";
import { detectIdType } from "./targets.js";
import type { ResolvedFeishuAccount } from "./types.js";

const collectFeishuSecurityWarnings = createAllowlistProviderGroupPolicyWarningCollector<{
  cfg: ClawdbotConfig;
  accountId?: string | null;
}>({
  providerConfigPresent: (cfg) => cfg.channels?.feishu !== undefined,
  resolveGroupPolicy: ({ cfg, accountId }) =>
    resolveFeishuAccount({ cfg, accountId }).config?.groupPolicy,
  collect: ({ cfg, accountId, groupPolicy }) => {
    if (groupPolicy !== "open") {
      return [];
    }
    const account = resolveFeishuAccount({ cfg, accountId });
    return [
      `- Feishu[${account.accountId}] groups: groupPolicy="open" allows any member to trigger (mention-gated). Set channels.feishu.groupPolicy="allowlist" + channels.feishu.groupAllowFrom to restrict senders.`,
    ];
  },
});
const collectFeishuOpenGroupFindings = createConditionalWarningCollector.findings({
  collectWarnings: collectFeishuSecurityWarnings,
  checkId: "channels.feishu.groups.open",
  severity: "warn",
  title: "Feishu security warning",
});

const resolveFeishuDmPolicyBase = createScopedDmSecurityResolver<ResolvedFeishuAccount>({
  channelKey: "feishu",
  resolvePolicy: (account) => account.config.dmPolicy,
  // The shared audit checks wildcard access before normalizing finite principals.
  resolveAllowFrom: (account) =>
    account.config.allowFrom?.map((entry) => normalizeFeishuAllowEntry(String(entry))),
  policyPathSuffix: "dmPolicy",
  normalizeEntry: (raw) => {
    const normalized = normalizeFeishuAllowEntry(raw);
    // DM routing uses bare sender IDs; chat entries cannot admit a DM sender.
    return normalized.startsWith("user:") ? normalized.slice("user:".length) : "";
  },
});

function resolveFeishuDmFieldBasePath(params: {
  cfg: ClawdbotConfig;
  accountId?: string | null;
  field: "dmPolicy" | "allowFrom";
}): string {
  const accountId = params.accountId?.trim() || DEFAULT_ACCOUNT_ID;
  const channelConfig: unknown = params.cfg.channels?.feishu;
  const accounts = isRecord(channelConfig) ? channelConfig.accounts : undefined;
  const accountConfig = isRecord(accounts) ? resolveAccountEntry(accounts, accountId) : undefined;
  // Reuse canonical account selection, then recover its authored key so diagnostic paths point
  // at the actual config entry rather than the normalized runtime id.
  const configAccountId =
    isRecord(accounts) && isRecord(accountConfig)
      ? Object.keys(accounts).find((key) => accounts[key] === accountConfig)
      : undefined;
  if (
    configAccountId !== undefined &&
    isRecord(accountConfig) &&
    accountConfig[params.field] !== undefined
  ) {
    return `channels.feishu.accounts.${configAccountId}.`;
  }
  if (isRecord(channelConfig) && channelConfig[params.field] !== undefined) {
    return "channels.feishu.";
  }
  return configAccountId !== undefined
    ? `channels.feishu.accounts.${configAccountId}.`
    : "channels.feishu.";
}

const resolveFeishuDmPolicy = (params: Parameters<typeof resolveFeishuDmPolicyBase>[0]) => {
  const accountId = params.accountId ?? params.account.accountId;
  return {
    ...resolveFeishuDmPolicyBase(params),
    policyPath: `${resolveFeishuDmFieldBasePath({
      cfg: params.cfg,
      accountId,
      field: "dmPolicy",
    })}dmPolicy`,
    allowFromPath: resolveFeishuDmFieldBasePath({
      cfg: params.cfg,
      accountId,
      field: "allowFrom",
    }),
  };
};

export const feishuSecurity: NonNullable<ChannelPlugin<ResolvedFeishuAccount>["security"]> = {
  resolveDmPolicy: resolveFeishuDmPolicy,
  collectWarnings: async ({ cfg, accountId, account }) => {
    const findings = collectFeishuOpenGroupFindings({ cfg, accountId });
    const dmPolicy = account.config.dmPolicy ?? "pairing";
    if (dmPolicy === "disabled") {
      return findings;
    }
    const storeAllowFrom = await readChannelIngressStoreAllowFromForDmPolicy({
      provider: "feishu",
      accountId: account.accountId,
      dmPolicy,
    });
    const hasUserIdAlias = [...(account.config.allowFrom ?? []), ...storeAllowFrom].some(
      (entry) => {
        const normalized = normalizeFeishuAllowEntry(String(entry));
        return (
          normalized.startsWith("user:") &&
          detectIdType(normalized.slice("user:".length)) === "user_id"
        );
      },
    );
    if (hasUserIdAlias) {
      findings.push({
        checkId: `channels.feishu.dm.routing_unverified.${account.accountId}`,
        severity: "warn",
        title: "Feishu DM routing is unverified for user_id aliases",
        detail:
          "AllowFrom or pairing entries using user_id aliases cannot be mapped offline to sender open_ids, so exact DM bindings and session isolation cannot be verified for those senders.",
        remediation:
          "Use ou_ open_id values in allowFrom or pairing approvals and matching direct peer bindings when verifying DM session isolation.",
      });
    }
    return findings;
  },
  collectAuditFindings: ({ cfg }) => collectFeishuSecurityAuditFindings({ cfg }),
};
