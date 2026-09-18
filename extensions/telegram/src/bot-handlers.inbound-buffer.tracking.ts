import type { Message } from "grammy/types";
import type {
  PendingBufferedMessageIgnore,
  TelegramDebounceEntry,
  TextFragmentMessage,
} from "./bot-handlers.inbound-buffer.types.js";

type BufferedMessageOwner = TelegramDebounceEntry | TextFragmentMessage;

export function createTelegramBufferedMessageTracker() {
  const debounceEntriesByMessage = new Map<string, Set<TelegramDebounceEntry>>();
  const textFragmentsByMessage = new Map<string, Set<TextFragmentMessage>>();
  const bufferedMessageKey = (msg: Message) => `${msg.chat.id}:${msg.message_id}`;

  const track = <T extends BufferedMessageOwner>(
    ownersByMessage: Map<string, Set<T>>,
    owner: T,
  ) => {
    const key = bufferedMessageKey(owner.msg);
    const owners = ownersByMessage.get(key) ?? new Set<T>();
    owners.add(owner);
    ownersByMessage.set(key, owners);
  };
  const forget = <T extends BufferedMessageOwner>(
    ownersByMessage: Map<string, Set<T>>,
    owner: T,
  ) => {
    const key = bufferedMessageKey(owner.msg);
    const owners = ownersByMessage.get(key);
    owners?.delete(owner);
    if (owners?.size === 0) {
      ownersByMessage.delete(key);
    }
  };

  const beginPendingBufferedMessageIgnore = (
    msg: Message,
  ): PendingBufferedMessageIgnore | undefined => {
    const key = bufferedMessageKey(msg);
    const owners: BufferedMessageOwner[] = [
      ...(debounceEntriesByMessage.get(key) ?? []),
      ...(textFragmentsByMessage.get(key) ?? []),
    ];
    if (owners.length === 0) {
      return undefined;
    }
    let resolveSettlement!: () => void;
    const settlement = new Promise<void>((resolve) => {
      resolveSettlement = resolve;
    });
    for (const owner of owners) {
      owner.pendingIgnoreSettlements.add(settlement);
    }
    let settled = false;
    return {
      settle: (authorized) => {
        if (settled) {
          return true;
        }
        settled = true;
        for (const owner of owners) {
          if (authorized && owner.dispatchAdmission === "pending") {
            owner.cancelled = true;
            owner.dispatchAdmission = "cancelled";
            for (const controller of owner.dispatchAbortControllers) {
              controller.abort("skipped");
            }
          }
          owner.pendingIgnoreSettlements.delete(settlement);
        }
        resolveSettlement();
        return true;
      },
    };
  };

  return {
    registerDebounceEntry: (entry: TelegramDebounceEntry) => track(debounceEntriesByMessage, entry),
    forgetDebounceEntry: (entry: TelegramDebounceEntry) => forget(debounceEntriesByMessage, entry),
    registerTextFragment: (fragment: TextFragmentMessage) =>
      track(textFragmentsByMessage, fragment),
    forgetTextFragment: (fragment: TextFragmentMessage) => forget(textFragmentsByMessage, fragment),
    waitForPendingIgnore: async (owner: BufferedMessageOwner) => {
      while (owner.pendingIgnoreSettlements.size > 0) {
        await Promise.all(owner.pendingIgnoreSettlements);
      }
    },
    beginPendingBufferedMessageIgnore,
  };
}
