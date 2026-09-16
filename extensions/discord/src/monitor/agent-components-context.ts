// Discord plugin module implements agent components context behavior.
import { ChannelType } from "discord-api-types/v10";
import { logError } from "openclaw/plugin-sdk/logging-core";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import type {
  AgentComponentContext,
  AgentComponentInteraction,
  AgentComponentMessageInteraction,
  ComponentInteractionContext,
  DiscordChannelContext,
} from "./agent-components.types.js";
import { normalizeDiscordDisplaySlug } from "./allow-list.js";
import { resolveDiscordThreadLikeChannelContext } from "./thread-channel-context.js";

function formatUsername(user: { username: string; discriminator?: string | null }): string {
  if (user.discriminator && user.discriminator !== "0") {
    return `${user.username}#${user.discriminator}`;
  }
  return user.username;
}

export function resolveAgentComponentRoute(params: {
  ctx: AgentComponentContext;
  rawGuildId: string | undefined;
  memberRoleIds: string[];
  isDirectMessage: boolean;
  isGroupDm: boolean;
  userId: string;
  channelId: string;
  parentId: string | undefined;
}) {
  return resolveAgentRoute({
    cfg: params.ctx.cfg,
    channel: "discord",
    accountId: params.ctx.accountId,
    guildId: params.rawGuildId,
    memberRoleIds: params.memberRoleIds,
    peer: {
      kind: params.isDirectMessage ? "direct" : params.isGroupDm ? "group" : "channel",
      id: params.isDirectMessage ? params.userId : params.channelId,
    },
    parentPeer: params.parentId ? { kind: "channel", id: params.parentId } : undefined,
  });
}

export async function ackComponentInteraction(params: {
  interaction: AgentComponentInteraction;
  replyOpts: { ephemeral?: boolean };
  label: string;
}) {
  try {
    await params.interaction.reply({
      content: "✓",
      ...params.replyOpts,
    });
  } catch (err) {
    logError(`${params.label}: failed to acknowledge interaction: ${String(err)}`);
  }
}

export async function replyUnavailableComponentInteraction(
  interaction: AgentComponentInteraction,
  content: string,
): Promise<void> {
  try {
    await interaction.reply({ content, ephemeral: true });
  } catch {
    // The interaction may have expired before its failure reply could be delivered.
  }
}

async function resolveDiscordChannelContext(
  interaction: AgentComponentInteraction,
): Promise<DiscordChannelContext> {
  // Discord can send channel_id without a hydrated channel object; the raw id still
  // resolves the channel type and thread parent used for allowlists and routing.
  const channelContext = await resolveDiscordThreadLikeChannelContext({
    client: interaction.client,
    channel: interaction.channel,
    channelIdFallback: interaction.rawData.channel_id,
  });
  const { channelName, channelSlug, channelType, isThreadChannel } = channelContext;

  return {
    channelName,
    channelSlug,
    displayChannelSlug: channelName ? normalizeDiscordDisplaySlug(channelName) : "",
    channelType,
    isThread: isThreadChannel,
    parentId: channelContext.threadParentId,
    parentName: channelContext.threadParentName,
    parentSlug: channelContext.threadParentSlug,
  };
}

export async function resolveComponentInteractionContext(params: {
  interaction: AgentComponentInteraction;
  label: string;
  defer?: boolean;
}): Promise<ComponentInteractionContext | null> {
  const { interaction, label } = params;
  const channelId = interaction.rawData.channel_id;
  if (!channelId) {
    logError(`${label}: missing channel_id in interaction`);
    return null;
  }

  const user = interaction.user;
  if (!user) {
    logError(`${label}: missing user in interaction`);
    return null;
  }

  const shouldDefer = params.defer !== false && "defer" in interaction;
  let didDefer = false;
  if (shouldDefer) {
    try {
      await (interaction as AgentComponentMessageInteraction).defer({ ephemeral: true });
      didDefer = true;
    } catch (err) {
      logError(`${label}: failed to defer interaction: ${String(err)}`);
    }
  }
  const replyOpts = didDefer ? {} : { ephemeral: true };

  const username = formatUsername(user);
  const userId = user.id;
  const rawGuildId = interaction.rawData.guild_id;
  const channelCtx = await resolveDiscordChannelContext(interaction);
  const channelType = channelCtx.channelType;
  const isGroupDm = channelType === ChannelType.GroupDM;
  const isDirectMessage =
    channelType === ChannelType.DM || (!rawGuildId && !isGroupDm && channelType == null);
  const memberRoleIds = Array.isArray(interaction.rawData.member?.roles)
    ? interaction.rawData.member.roles.map((roleId: string) => roleId)
    : [];

  return {
    channelId,
    user,
    username,
    userId,
    replyOpts,
    rawGuildId,
    isDirectMessage,
    isGroupDm,
    memberRoleIds,
    channelCtx,
  };
}
