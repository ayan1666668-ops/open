import { setTimeout as delay } from "node:timers/promises";
import { expect, it, type Mock } from "vitest";

type ChannelPostHandler = (ctx: Record<string, unknown>) => Promise<void>;
const MEDIA_GROUP_FLUSH_MS = 20;

function createChannelPostContext(params: {
  messageId: number;
  mediaGroupId: string;
  ignore?: boolean;
}) {
  return {
    channelPost: {
      chat: { id: -100777111222, type: "channel", title: "Wake Channel" },
      message_id: params.messageId,
      date: 1_736_380_800 + params.messageId,
      media_group_id: params.mediaGroupId,
      caption: params.ignore ? "/ignore hidden" : "private album detail",
      ...(params.ignore
        ? { caption_entities: [{ type: "bot_command", offset: 0, length: 7 }] }
        : {}),
      photo: [{ file_id: `photo-${params.messageId}` }],
    },
    me: { id: 7, username: "openclaw_bot" },
    getFile: async () => ({ file_path: `photos/${params.messageId}.jpg` }),
  };
}

export function addIgnoreAlbumTests(
  loadConfig: Mock,
  getChannelPostHandler: () => ChannelPostHandler,
  outputSpies: readonly unknown[],
): void {
  it.each(["first", "later"] as const)(
    "suppresses an album when /ignore arrives as the %s member",
    async (position) => {
      loadConfig.mockReturnValue({
        commands: { native: true },
        channels: {
          telegram: {
            groupPolicy: "open",
            groups: { "-100777111222": { enabled: true, requireMention: false } },
          },
        },
      });
      const handler = getChannelPostHandler();
      const albumId = `channel-ignore-${position}`;
      const ignore = createChannelPostContext({
        messageId: 211,
        mediaGroupId: albumId,
        ignore: true,
      });
      const ordinary = createChannelPostContext({ messageId: 212, mediaGroupId: albumId });

      for (const update of position === "first" ? [ignore, ordinary] : [ordinary, ignore]) {
        await handler(update);
      }
      await delay(MEDIA_GROUP_FLUSH_MS + 25);

      for (const spy of outputSpies) {
        expect(spy).not.toHaveBeenCalled();
      }
    },
  );
}
