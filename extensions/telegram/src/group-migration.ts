import { migrateScopedChannelConfigMap } from "openclaw/plugin-sdk/channel-config-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";

export function migrateTelegramGroupConfig(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  oldChatId: string;
  newChatId: string;
}) {
  return migrateScopedChannelConfigMap({
    root: params.cfg.channels?.telegram,
    accounts: params.cfg.channels?.telegram?.accounts,
    accountId: params.accountId,
    selectMap: (entry) => entry?.groups,
    mapSourceValue: (value) => expectDefined(value, "owned Telegram group config key"),
    oldId: params.oldChatId,
    newId: params.newChatId,
  });
}
