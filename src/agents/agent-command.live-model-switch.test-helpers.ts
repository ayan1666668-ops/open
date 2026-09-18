import type { InternalSessionEntry } from "../config/sessions.js";
import { normalizeLegacySessionEntryDelivery } from "../infra/state-migrations.legacy-session-store.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";

export function makeSuccessResult(provider: string, model: string) {
  return {
    payloads: [{ text: "ok" }],
    meta: {
      durationMs: 100,
      aborted: false,
      stopReason: "end_turn",
      agentMeta: { provider, model },
    },
  };
}

export type CommandSessionEntryFixture = Partial<InternalSessionEntry> & {
  channel?: string;
  deliveryContext?: DeliveryContext;
  lastThreadId?: string | number;
};

export function createCommandSessionEntry(
  overrides: CommandSessionEntryFixture = {},
): InternalSessionEntry {
  return normalizeLegacySessionEntryDelivery({
    sessionId: "session-1",
    updatedAt: 1,
    ...overrides,
  } as InternalSessionEntry);
}

export function createCommandSessionFixture(
  overrides: CommandSessionEntryFixture = {},
  sessionKey = "agent:main:main",
): { entry: InternalSessionEntry; store: Record<string, InternalSessionEntry> } {
  const entry = createCommandSessionEntry({
    skillsSnapshot: { prompt: "", skills: [], version: 0 },
    ...overrides,
  });
  return { entry, store: { [sessionKey]: entry } };
}

export function createChannelModelRuntimeConfig({
  channel = "discord",
  matchKey = "channel-123",
  model = "openai/channel-model",
  additionalModels = {},
}: {
  channel?: string;
  matchKey?: string;
  model?: string;
  additionalModels?: Record<string, unknown>;
} = {}): Record<string, unknown> {
  return {
    agents: {
      defaults: {
        model: "anthropic/default-model",
        models: {
          "anthropic/default-model": {},
          [model]: {},
          ...additionalModels,
        },
      },
    },
    channels: { modelByChannel: { [channel]: { [matchKey]: model } } },
  };
}

export function createConfiguredModelCompatRuntimeConfig(allowlisted: boolean, excluded = false) {
  return {
    agents: {
      defaults: {
        model: { primary: "gmn/gpt-5.4" },
        ...(allowlisted ? { models: { "gmn/gpt-5.4": {} } } : {}),
        ...(excluded ? { modelPolicy: { allow: ["gmn/manual"] } } : {}),
      },
    },
    models: {
      providers: {
        gmn: {
          models: [
            {
              id: "gpt-5.4",
              name: "GPT 5.4 via GMN",
              reasoning: true,
              compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
            },
            ...(excluded ? [{ id: "manual", name: "Manual", reasoning: false }] : []),
          ],
        },
      },
    },
  };
}
