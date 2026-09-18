// Runtime session types describe the store hooks shared across config, gateway, and channels.
import type {
  RecordInboundSessionMetaParams,
  UpdateSessionLastRouteParams,
} from "./session-accessor.entry-mutation.js";
import type { SessionEntry } from "./types.js";

/** Runtime hook for reading a session store entry timestamp. */
export type ReadSessionUpdatedAt = (params: {
  storePath: string;
  sessionKey: string;
}) => number | undefined;
export type RecordSessionMetaFromInbound = (
  params: RecordInboundSessionMetaParams,
) => Promise<SessionEntry | null>;

export type UpdateLastRoute = (
  params: UpdateSessionLastRouteParams,
) => Promise<SessionEntry | null>;
