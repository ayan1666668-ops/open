import type {
  TelegramReactionApi,
  TelegramStatusReactionController,
} from "./bot-message-context.feedback.js";
import type { buildTelegramInboundContextPayload } from "./bot-message-context.session.js";
import type { BuildTelegramMessageContextParams } from "./bot-message-context.types.js";
import type { resolveTelegramThreadSpec } from "./bot/helpers.js";
import type { resolveTelegramConversationRoute } from "./conversation-route.js";

type TelegramMessageContextPayload = Awaited<ReturnType<typeof buildTelegramInboundContextPayload>>;

export type TelegramMessageContext = {
  cfg: BuildTelegramMessageContextParams["cfg"];
  ctxPayload: TelegramMessageContextPayload["ctxPayload"];
  turn: TelegramMessageContextPayload["turn"];
  primaryCtx: BuildTelegramMessageContextParams["primaryCtx"];
  msg: BuildTelegramMessageContextParams["primaryCtx"]["message"];
  chatId: BuildTelegramMessageContextParams["primaryCtx"]["message"]["chat"]["id"];
  isGroup: boolean;
  groupConfig?: ReturnType<
    BuildTelegramMessageContextParams["resolveTelegramGroupConfig"]
  >["groupConfig"];
  topicConfig?: ReturnType<
    BuildTelegramMessageContextParams["resolveTelegramGroupConfig"]
  >["topicConfig"];
  resolvedThreadId?: number;
  threadSpec: ReturnType<typeof resolveTelegramThreadSpec>;
  replyThreadId?: number;
  isForum: boolean;
  historyKey?: string;
  historyLimit: BuildTelegramMessageContextParams["historyLimit"];
  groupHistories: BuildTelegramMessageContextParams["groupHistories"];
  route: ReturnType<typeof resolveTelegramConversationRoute>["route"];
  skillFilter: TelegramMessageContextPayload["skillFilter"];
  sendTyping: () => Promise<void>;
  sendRecordVoice: () => Promise<void>;
  sendChatActionHandler: BuildTelegramMessageContextParams["sendChatActionHandler"];
  initialTypingCueSent?: boolean;
  isInitialFeedbackStarted?: () => boolean;
  startInitialFeedback?: () => void;
  ackReactionPromise: Promise<boolean> | null;
  reactionApi: TelegramReactionApi | null;
  statusReactionController: TelegramStatusReactionController | null;
  accountId: string;
};
