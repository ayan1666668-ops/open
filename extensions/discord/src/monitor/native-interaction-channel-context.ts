// Discord plugin module implements native interaction channel context behavior.
import { normalizeOptionalStringifiedId } from "openclaw/plugin-sdk/string-coerce-runtime";
import { ChannelType } from "../internal/discord.js";
import type { DiscordChannelInfoClient } from "./message-channel-info.js";
import { resolveDiscordThreadLikeChannelContext } from "./thread-channel-context.js";

type DiscordInteractionChannel = {
  id?: string;
  type?: ChannelType;
};

type DiscordNativeInteractionChannelContext = {
  channelType?: ChannelType;
  isDirectMessage: boolean;
  isGroupDm: boolean;
  isThreadChannel: boolean;
  channelName?: string;
  channelSlug: string;
  rawChannelId: string;
  threadParentId?: string;
  threadParentName?: string;
  threadParentSlug: string;
};

export function resolveDiscordNativeInteractionChannelIdFallback(rawData: unknown): string {
  if (!rawData || typeof rawData !== "object") {
    return "";
  }
  // SAFETY: The loose shape is normalized from unknown before it can affect authorization.
  const record = rawData as {
    channel_id?: unknown;
    channelId?: unknown;
    message?: { channel_id?: unknown; channelId?: unknown };
  };
  return (
    normalizeOptionalStringifiedId(record.channel_id) ??
    normalizeOptionalStringifiedId(record.channelId) ??
    normalizeOptionalStringifiedId(record.message?.channel_id) ??
    normalizeOptionalStringifiedId(record.message?.channelId) ??
    ""
  );
}

export async function resolveDiscordNativeInteractionChannelContext(params: {
  channel: DiscordInteractionChannel | null | undefined;
  client: DiscordChannelInfoClient;
  hasGuild: boolean;
  channelIdFallback: string;
}): Promise<DiscordNativeInteractionChannelContext> {
  const channelContext = await resolveDiscordThreadLikeChannelContext({
    client: params.client,
    channel: params.channel,
    channelIdFallback: params.channelIdFallback,
  });
  const channelType = channelContext.channelType;
  const isDirectMessage = channelType === ChannelType.DM;
  const isGroupDm = channelType === ChannelType.GroupDM;

  return {
    channelType,
    isDirectMessage,
    isGroupDm,
    isThreadChannel: channelContext.isThreadChannel,
    channelName: channelContext.channelName,
    channelSlug: channelContext.channelSlug,
    rawChannelId: channelContext.channelId,
    threadParentId: params.hasGuild ? channelContext.threadParentId : undefined,
    threadParentName: params.hasGuild ? channelContext.threadParentName : undefined,
    threadParentSlug: params.hasGuild ? channelContext.threadParentSlug : "",
  };
}
