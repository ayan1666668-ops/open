// Defines Google Chat channel configuration types from the canonical schema.
import type { z } from "zod";
import type { GoogleChatConfigSchema } from "./zod-schema.providers-googlechat.js";

type GoogleChatSchemaInput = z.input<typeof GoogleChatConfigSchema>;
type GoogleChatAccountSchemaInput = Omit<GoogleChatSchemaInput, "accounts" | "defaultAccount">;

export type GoogleChatGroupConfig = NonNullable<
  NonNullable<GoogleChatAccountSchemaInput["groups"]>[string]
>;

export type GoogleChatAccountConfig = Omit<GoogleChatAccountSchemaInput, "groups"> & {
  groups?: Record<string, GoogleChatGroupConfig>;
};

export type GoogleChatConfig = Omit<GoogleChatSchemaInput, "accounts" | "groups"> &
  GoogleChatAccountConfig & {
    accounts?: Record<string, GoogleChatAccountConfig>;
  };

export type GoogleChatDmConfig = NonNullable<GoogleChatAccountConfig["dm"]>;
