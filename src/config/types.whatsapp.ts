// Defines WhatsApp channel configuration types from the canonical schema.
import type { z } from "zod";
import type { WhatsAppConfigSchema } from "./zod-schema.providers-whatsapp.js";

type WhatsAppSchemaInput = z.input<typeof WhatsAppConfigSchema>;
type WhatsAppSchemaAccountConfig = NonNullable<
  NonNullable<WhatsAppSchemaInput["accounts"]>[string]
>;
type LegacyWhatsAppConfig = {
  /** @deprecated Doctor-only legacy input. */
  messagePrefix?: string;
};

export type WhatsAppGroupConfig = NonNullable<NonNullable<WhatsAppSchemaInput["groups"]>[string]>;
export type WhatsAppDirectConfig = NonNullable<NonNullable<WhatsAppSchemaInput["direct"]>[string]>;
export type WhatsAppAckReactionConfig = {
  emoji?: string;
  direct?: boolean;
  group?: "always" | "mentions" | "never";
};

type WhatsAppNarrowedConfig = {
  groups?: Record<string, WhatsAppGroupConfig>;
  direct?: Record<string, WhatsAppDirectConfig>;
  ackReaction?: WhatsAppAckReactionConfig;
};

export type WhatsAppAccountConfig = Omit<
  WhatsAppSchemaAccountConfig,
  keyof WhatsAppNarrowedConfig
> &
  WhatsAppNarrowedConfig &
  LegacyWhatsAppConfig;

export type WhatsAppConfig = Omit<WhatsAppSchemaInput, "accounts" | keyof WhatsAppNarrowedConfig> &
  WhatsAppNarrowedConfig &
  LegacyWhatsAppConfig & {
    accounts?: Record<string, WhatsAppAccountConfig>;
  };

export type WhatsAppActionConfig = NonNullable<WhatsAppConfig["actions"]>;
export type WhatsAppReactionLevel = NonNullable<WhatsAppConfig["reactionLevel"]>;
