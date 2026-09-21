import type { ConversationListItem, ConversationListResult } from "@openclaw/gateway-protocol";
import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { CronState } from "../../lib/cron/types.ts";
import { formatUiError } from "../../lib/format-error.ts";

// A separator that can never appear in an accountId/threadId pair.
const ROUTE_KEY_SEPARATOR = String.fromCharCode(0);

function conversationRouteKey(conversation: ConversationListItem): string {
  return `${conversation.accountId}${ROUTE_KEY_SEPARATOR}${conversation.threadId ?? ""}`;
}

/**
 * Resolves the configured account/thread route for a chosen delivery target.
 *
 * Returns undefined when the target is unknown or ambiguous (the same target
 * string resolves to more than one distinct account/thread route) -- the
 * caller keeps whatever route the operator already had rather than guessing.
 */
export function resolveDeliveryConversationRoute(
  conversations: ConversationListItem[],
  target: string,
  requestedAccountId: string | undefined,
  currentAccountId: string,
): { accountId: string; threadId?: string } | undefined {
  const accountId = (
    typeof requestedAccountId === "string" ? requestedAccountId : currentAccountId
  ).trim();
  const matches = conversations.filter(
    (conversation) =>
      conversation.target === target && (!accountId || conversation.accountId === accountId),
  );
  const routes = new Map(
    matches.map((conversation) => [conversationRouteKey(conversation), conversation]),
  );
  return routes.size === 1 ? routes.values().next().value : undefined;
}

/**
 * Filters a conversation directory down to targets with exactly one
 * account/thread route, scoped to an optional configured account.
 *
 * A target reachable through more than one route is dropped: suggesting it
 * would silently pick one of several possible destinations.
 */
function filterUnambiguousDeliveryConversations(
  conversations: ConversationListItem[],
  accountId: string,
): ConversationListItem[] {
  const eligible = conversations.filter(
    (conversation) => !accountId || conversation.accountId === accountId,
  );
  const routesByTarget = new Map<string, ConversationListItem[]>();
  for (const conversation of eligible) {
    const routes = routesByTarget.get(conversation.target) ?? [];
    routes.push(conversation);
    routesByTarget.set(conversation.target, routes);
  }
  return eligible.filter((conversation) => {
    const routes = new Set(
      (routesByTarget.get(conversation.target) ?? []).map(conversationRouteKey),
    );
    return routes.size === 1;
  });
}

export type DeliveryConversationsScope = {
  client: GatewayBrowserClient;
  /** Re-checked after the request settles: connection/agent/permission identity may have moved on. */
  isCurrent: () => boolean;
};

/**
 * Owns the "configured delivery targets" directory for the cron editor's
 * announce-mode recipient field: fetches `conversations.list`, keeps only
 * unambiguous account/thread routes, and discards any response that settles
 * after a newer request superseded it.
 */
export class DeliveryConversationsController implements ReactiveController {
  conversations: ConversationListItem[] = [];
  error: string | null = null;
  private requestId = 0;

  constructor(private readonly host: ReactiveControllerHost) {
    host.addController(this);
  }

  hostDisconnected() {
    this.reset();
  }

  reset() {
    this.requestId += 1;
    this.conversations = [];
    this.error = null;
  }

  async load(
    cronState: CronState,
    canManageCron: boolean,
    capture: () => DeliveryConversationsScope | null,
  ) {
    const requestId = ++this.requestId;
    this.conversations = [];
    this.error = null;
    this.host.requestUpdate();
    const mode = cronState.cronForm.deliveryMode;
    const channel = cronState.cronForm.deliveryChannel.trim();
    const agentId = cronState.cronForm.agentId.trim() || cronState.cronAgentId?.trim() || "";
    if (!canManageCron || mode !== "announce" || !agentId || channel === "last") {
      return;
    }
    const scope = capture();
    if (!scope) {
      return;
    }
    const isCurrent = () => requestId === this.requestId && scope.isCurrent();
    try {
      const result = await scope.client.request<ConversationListResult>("conversations.list", {
        agentId,
        channel,
        limit: 100,
      });
      if (isCurrent()) {
        this.conversations = filterUnambiguousDeliveryConversations(
          result.conversations,
          cronState.cronForm.deliveryAccountId.trim(),
        );
        this.error = null;
        this.host.requestUpdate();
      }
    } catch (error) {
      if (isCurrent()) {
        this.conversations = [];
        this.error = `Could not load recipient suggestions: ${formatUiError(error)}`;
        this.host.requestUpdate();
      }
    }
  }
}
