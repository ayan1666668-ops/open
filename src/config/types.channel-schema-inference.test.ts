import { describe, expect, it } from "vitest";
import type { GoogleChatAccountConfig } from "./types.googlechat.js";
import type {
  WhatsAppAccountConfig,
  WhatsAppConfig,
  WhatsAppReactionLevel,
} from "./types.whatsapp.js";

type WhatsAppReactionLevelContract = "off" | "ack" | "minimal" | "extensive";
type Equal<TLeft, TRight> = [TLeft] extends [TRight]
  ? [TRight] extends [TLeft]
    ? true
    : false
  : false;
type Assert<T extends true> = T;

type _GoogleChatAllowBots = Assert<
  Equal<NonNullable<GoogleChatAccountConfig["allowBots"]>, boolean>
>;
type _WhatsAppReactionLevel = Assert<Equal<WhatsAppReactionLevel, WhatsAppReactionLevelContract>>;
type _WhatsAppAccountReactionLevel = Assert<
  Equal<NonNullable<WhatsAppAccountConfig["reactionLevel"]>, WhatsAppReactionLevelContract>
>;
type _WhatsAppRootReactionLevel = Assert<
  Equal<NonNullable<WhatsAppConfig["reactionLevel"]>, WhatsAppReactionLevelContract>
>;

describe("schema-derived channel config types", () => {
  it("preserves channel-specific helper inference", () => {
    expect(true).toBe(true);
  });
});
