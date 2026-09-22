import type { ConversationListItem, ConversationListResult } from "@openclaw/gateway-protocol";
import type { CronFormState, CronState } from "../../lib/cron/types.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { GatewayConnectionScope } from "../../lib/gateway-connection-lifecycle.ts";

/**
 * Drops a delivery topic that the incoming patch has orphaned.
 *
 * A topic only means anything for the exact route it was authored against, so
 * changing any part of that route -- the mode, the channel, the sending
 * account, the agent, or the recipient itself -- invalidates it unless the
 * same patch supplies a replacement.
 */
export function invalidateStaleDeliveryRoute(
  current: CronFormState,
  patch: Partial<CronFormState>,
): Partial<CronFormState> {
  const deliveryIdentityChanged =
    ("deliveryMode" in patch && patch.deliveryMode !== current.deliveryMode) ||
    ("deliveryChannel" in patch && patch.deliveryChannel !== current.deliveryChannel) ||
    ("deliveryAccountId" in patch && patch.deliveryAccountId !== current.deliveryAccountId) ||
    ("deliveryTo" in patch && patch.deliveryTo !== current.deliveryTo) ||
    ("agentId" in patch && patch.agentId !== current.agentId);
  return deliveryIdentityChanged && patch.deliveryThreadId === undefined
    ? { ...patch, deliveryThreadId: undefined }
    : patch;
}

/**
 * Reports whether a form change invalidates the cached directory itself.
 *
 * Only the fields the `conversations.list` request is keyed on qualify. The
 * sending account is applied to the cached rows locally, so editing it must
 * never re-read the Gateway -- otherwise every keystroke in the Account ID
 * field launches another directory discovery across configured accounts.
 */
export function requiresDirectoryReload(current: CronFormState, next: CronFormState): boolean {
  return (
    next.deliveryMode !== current.deliveryMode ||
    next.deliveryChannel !== current.deliveryChannel ||
    next.agentId !== current.agentId
  );
}

export type DeliveryConversationsHost = {
  /** The page state that currently owns the editor. */
  currentCronState: () => CronState;
  /** Admin access is revalidated per request because it can drop mid-flight. */
  canManage: () => boolean;
  captureConnection: () => GatewayConnectionScope | null;
  isCurrentConnection: (scope: GatewayConnectionScope) => boolean;
  /** Re-render the page for the state that published the change. */
  notify: (cronState: CronState) => void;
};

/**
 * Owns the Automations editor's recipient directory: the cached conversations,
 * the published error, and the request generation. This state is page-owned
 * rather than CronState-owned, so a continuation that outlived the editor it
 * started in must prove ownership before clearing the cache or reading again.
 *
 * The directory is a bounded read, so it is only ever a source of **target**
 * suggestions. Account and topic routing stay operator-authored; nothing here
 * infers them.
 */
export class DeliveryConversationsController {
  conversations: ConversationListItem[] = [];
  error: string | null = null;
  private requestId = 0;
  /**
   * Identifies the editor session that owns the cache. A continuation captures
   * it before awaiting and presents it back, which is the only way to tell "my
   * editor exited" from "a replacement editor owns discovery now": the page,
   * the connection, and the admin scope all survive an editor swap.
   */
  private editorGeneration = 0;

  constructor(private readonly host: DeliveryConversationsHost) {}

  /** Retire every in-flight read and drop the cached suggestions and error. */
  clear(cronState: CronState = this.host.currentCronState()) {
    this.requestId += 1;
    this.conversations = [];
    this.error = null;
    this.host.notify(cronState);
  }

  /** The generation a deferred continuation must present back to own the cache. */
  get generation(): number {
    return this.editorGeneration;
  }

  /** An editor session ended: retire its directory and stop answering for it. */
  retireEditor(cronState: CronState = this.host.currentCronState()) {
    this.editorGeneration += 1;
    this.clear(cronState);
  }

  /** An editor session began: it owns discovery from here, so read for it. */
  openEditor() {
    this.editorGeneration += 1;
    void this.load();
  }

  /**
   * Retire the directory for a continuation whose own editor confirmed its
   * exit. A continuation that no longer owns the cache — replaced page,
   * dropped connection, lost admin access, or a replacement editor — leaves it
   * alone rather than retiring someone else's in-flight read.
   */
  retireExitedEditor(
    cronState: CronState,
    connectionScope: GatewayConnectionScope | null,
    editorGeneration: number,
  ) {
    if (this.ownedBy(cronState, connectionScope, editorGeneration)) {
      this.retireEditor(cronState);
    }
  }

  /**
   * Resettle the directory after a save. A save that still owns discovery
   * drops the cache it read against, then reads again only when its editor
   * stayed open; a create hands off to the overview instead.
   */
  afterSave(
    cronState: CronState,
    connectionScope: GatewayConnectionScope | null,
    editorGeneration: number,
    stillEditing: boolean,
  ) {
    if (!this.ownedBy(cronState, connectionScope, editorGeneration)) {
      return;
    }
    this.clear(cronState);
    if (stillEditing) {
      void this.load(cronState);
    } else {
      this.editorGeneration += 1;
    }
  }

  /**
   * A continuation owns the directory only while its page, its connection, its
   * admin access, and the editor session it started in all survive.
   */
  ownedBy(
    cronState: CronState,
    connectionScope: GatewayConnectionScope | null,
    editorGeneration?: number,
  ): boolean {
    return (
      this.host.currentCronState() === cronState &&
      connectionScope !== null &&
      this.host.isCurrentConnection(connectionScope) &&
      this.host.canManage() &&
      (editorGeneration === undefined || this.editorGeneration === editorGeneration)
    );
  }

  async load(cronState: CronState = this.host.currentCronState()) {
    const requestId = ++this.requestId;
    this.conversations = [];
    this.error = null;
    this.host.notify(cronState);
    const client = cronState.client;
    const mode = cronState.cronForm.deliveryMode;
    const channel = cronState.cronForm.deliveryChannel.trim();
    const agentId = cronState.cronForm.agentId.trim() || cronState.cronAgentId?.trim() || "";
    if (
      !this.host.canManage() ||
      !client ||
      mode !== "announce" ||
      !agentId ||
      channel === "last"
    ) {
      return;
    }
    const connectionScope = this.host.captureConnection();
    if (!connectionScope) {
      return;
    }
    const isCurrent = () =>
      requestId === this.requestId && this.ownedBy(cronState, connectionScope);
    try {
      const result = await client.request<ConversationListResult>("conversations.list", {
        agentId,
        channel,
        limit: 100,
      });
      if (isCurrent()) {
        // The directory is bounded, so it is authoritative only as a source of
        // target suggestions. Never infer hidden account or topic routing from it.
        this.conversations = result.conversations;
        this.error = null;
        this.host.notify(cronState);
      }
    } catch (error) {
      if (isCurrent()) {
        this.conversations = [];
        this.error = `Could not load recipient suggestions: ${formatUiError(error)}`;
        this.host.notify(cronState);
      }
    }
  }
}
