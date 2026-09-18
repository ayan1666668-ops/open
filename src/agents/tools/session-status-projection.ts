import { readStringValue } from "@openclaw/normalization-core/string-coerce";
import { Type } from "typebox";
import type { SessionEntry } from "../../config/sessions.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import type { listSessionStateEventsSince } from "../../sessions/session-state-events.js";
import {
  deliveryContextFromSession,
  normalizeDeliveryContext,
  sessionDeliveryOrigin,
  type DeliveryContext,
} from "../../utils/delivery-context.shared.js";
import {
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";

const SessionStatusOriginSchema = Type.Object(
  {
    provider: Type.Optional(Type.String()),
    accountId: Type.Optional(Type.String()),
    threadId: Type.Optional(Type.Union([Type.String(), Type.Number()])),
  },
  { additionalProperties: false },
);

const SessionStatusDeliveryContextSchema = Type.Object(
  {
    channel: Type.Optional(Type.String()),
    to: Type.Optional(Type.String()),
    accountId: Type.Optional(Type.String()),
    threadId: Type.Optional(Type.Union([Type.String(), Type.Number()])),
  },
  { additionalProperties: false },
);

const SessionStatusStateEventPayloadSchema = Type.Object(
  {
    outcome: Type.Optional(
      Type.Union([Type.Literal("error"), Type.Literal("timeout"), Type.Literal("cancelled")]),
    ),
    channel: Type.Optional(Type.String()),
    turns: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

const SessionStatusStateEventSchema = Type.Object(
  {
    sequence: Type.Integer(),
    kind: Type.String(),
    actorType: Type.Union([Type.Literal("human"), Type.Literal("agent"), Type.Literal("system")]),
    occurredAt: Type.Number(),
    summary: Type.String(),
    actorId: Type.Optional(Type.String()),
    runId: Type.Optional(Type.String()),
    payload: Type.Optional(SessionStatusStateEventPayloadSchema),
  },
  { additionalProperties: false },
);

export const SessionStatusOutputSchema = Type.Object(
  {
    ok: Type.Literal(true),
    sessionKey: Type.String(),
    agentId: Type.String(),
    changedModel: Type.Boolean(),
    stateVersion: Type.Integer(),
    statusText: Type.String(),
    stateChanges: Type.Optional(
      Type.Object(
        {
          events: Type.Array(SessionStatusStateEventSchema),
          truncated: Type.Boolean(),
          earliestAvailableSequence: Type.Integer(),
          historyGap: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
    ),
    model: Type.Optional(Type.String()),
    modelProvider: Type.Optional(Type.String()),
    modelOverride: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    origin: Type.Optional(SessionStatusOriginSchema),
    active: Type.Optional(SessionStatusDeliveryContextSchema),
    deliveryContext: Type.Optional(SessionStatusDeliveryContextSchema),
  },
  { additionalProperties: false },
);

type SessionStatusStateChanges = ReturnType<typeof listSessionStateEventsSince>;

function compactSessionStateEventPayload(
  payload: Record<string, unknown> | undefined,
): { outcome?: "error" | "timeout" | "cancelled"; channel?: string; turns?: number } | undefined {
  if (!payload) {
    return undefined;
  }
  const outcome =
    payload.outcome === "error" || payload.outcome === "timeout" || payload.outcome === "cancelled"
      ? payload.outcome
      : undefined;
  const channel = readStringValue(payload.channel);
  const turns =
    typeof payload.turns === "number" && Number.isSafeInteger(payload.turns) && payload.turns > 0
      ? payload.turns
      : undefined;
  return outcome || channel || turns !== undefined
    ? {
        ...(outcome ? { outcome } : {}),
        ...(channel ? { channel } : {}),
        ...(turns !== undefined ? { turns } : {}),
      }
    : undefined;
}

export function compactSessionStateChanges(stateChanges: SessionStatusStateChanges) {
  return {
    ...stateChanges,
    events: stateChanges.events.map((event) => {
      const payload = compactSessionStateEventPayload(event.payload);
      return {
        sequence: event.sequence,
        kind: event.kind,
        actorType: event.actorType,
        occurredAt: event.occurredAt,
        summary: event.summary,
        ...(event.actorId ? { actorId: event.actorId } : {}),
        ...(event.runId ? { runId: event.runId } : {}),
        ...(payload ? { payload } : {}),
      };
    }),
  };
}

type SessionStatusOriginDetails = {
  provider?: string;
  accountId?: string;
  threadId?: string | number;
};

type SessionStatusDeliveryContextDetails = {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
};

type SessionStatusRouteDetails = {
  origin?: SessionStatusOriginDetails;
  active?: SessionStatusDeliveryContextDetails;
  deliveryContext?: SessionStatusDeliveryContextDetails;
};

const INTERNAL_SESSION_KEY_ORIGIN_PREFIXES = new Set(["main", "cron", "subagent", "acp"]);

function readRouteThreadId(value: unknown): string | number | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

function compactOriginDetails(params: {
  provider?: string;
  accountId?: string;
  threadId?: string | number;
}): SessionStatusOriginDetails | undefined {
  const threadId = readRouteThreadId(params.threadId);
  const details: SessionStatusOriginDetails = {
    ...(params.provider ? { provider: params.provider } : {}),
    ...(params.accountId ? { accountId: params.accountId } : {}),
    ...(threadId !== undefined ? { threadId } : {}),
  };
  return Object.keys(details).length ? details : undefined;
}

function compactDeliveryContextDetails(params: {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
}): SessionStatusDeliveryContextDetails | undefined {
  const threadId = readRouteThreadId(params.threadId);
  const details: SessionStatusDeliveryContextDetails = {
    ...(params.channel ? { channel: params.channel } : {}),
    ...(params.to ? { to: params.to } : {}),
    ...(params.accountId ? { accountId: params.accountId } : {}),
    ...(threadId !== undefined ? { threadId } : {}),
  };
  return Object.keys(details).length ? details : undefined;
}

function normalizeStatusDeliveryContext(
  context?: DeliveryContext,
): SessionStatusDeliveryContextDetails | undefined {
  return compactDeliveryContextDetails({
    channel: readStringValue(context?.channel),
    to: readStringValue(context?.to),
    accountId: readStringValue(context?.accountId),
    threadId: context?.threadId,
  });
}

function normalizeActiveDeliveryContext(
  context?: DeliveryContext,
): SessionStatusDeliveryContextDetails | undefined {
  if (!context) {
    return undefined;
  }
  const normalized = normalizeDeliveryContext(context);
  const rawChannel = readStringValue(normalized?.channel) ?? readStringValue(context.channel);
  const channel = rawChannel ? (normalizeMessageChannel(rawChannel) ?? rawChannel) : undefined;
  return compactDeliveryContextDetails({
    channel,
    to: readStringValue(normalized?.to) ?? readStringValue(context.to),
    accountId: readStringValue(normalized?.accountId) ?? readStringValue(context.accountId),
    threadId: normalized?.threadId ?? context.threadId,
  });
}

function inferOriginProviderFromSessionKey(sessionKey: string): string | undefined {
  const parsed = parseAgentSessionKey(sessionKey);
  const head = readStringValue(parsed?.rest.split(":")[0]);
  if (!head || INTERNAL_SESSION_KEY_ORIGIN_PREFIXES.has(head.toLowerCase())) {
    return undefined;
  }
  const channel = normalizeMessageChannel(head);
  return channel && isDeliverableMessageChannel(channel) ? channel : undefined;
}

export function buildSessionStatusRouteDetails(params: {
  entry: SessionEntry;
  sessionKey: string;
  activeDeliveryContext?: DeliveryContext;
  isLiveRunSession?: boolean;
}): SessionStatusRouteDetails {
  const origin = compactOriginDetails({
    provider:
      readStringValue(sessionDeliveryOrigin(params.entry)?.provider) ??
      inferOriginProviderFromSessionKey(params.sessionKey),
    accountId: readStringValue(sessionDeliveryOrigin(params.entry)?.accountId),
    threadId: sessionDeliveryOrigin(params.entry)?.threadId,
  });
  const deliveryContext = normalizeStatusDeliveryContext(deliveryContextFromSession(params.entry));
  const active = params.isLiveRunSession
    ? normalizeActiveDeliveryContext(params.activeDeliveryContext)
    : undefined;

  return {
    ...(origin ? { origin } : {}),
    ...(active ? { active } : {}),
    ...(deliveryContext ? { deliveryContext } : {}),
  };
}

export function formatSessionStatusRouteContext(
  details: SessionStatusRouteDetails,
): string | undefined {
  if (Object.keys(details).length === 0) {
    return undefined;
  }
  return `Route context:
\`\`\`json
${JSON.stringify(details, null, 2)}
\`\`\``;
}

export function formatSessionStateChanges(details: {
  stateVersion: number;
  stateChanges: ReturnType<typeof compactSessionStateChanges>;
}): string {
  return `Session state changes:
\`\`\`json
${JSON.stringify(details, null, 2)}
\`\`\``;
}
