import { migrateScopedChannelConfigMap } from "openclaw/plugin-sdk/channel-config-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

export function migrateSlackChannelConfig(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  oldChannelId: string;
  newChannelId: string;
}) {
  return migrateScopedChannelConfigMap({
    root: params.cfg.channels?.slack,
    accounts: params.cfg.channels?.slack?.accounts,
    accountId: params.accountId,
    selectMap: (entry) => entry?.channels,
    mapSourceValue: (value) => value || undefined,
    oldId: params.oldChannelId,
    newId: params.newChannelId,
  });
}
