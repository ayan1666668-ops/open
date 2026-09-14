import type { ReplyPayload } from "../../shared/reply-payload.types.js";

export type BlockReplySource = {
  readonly complete: boolean;
  readonly pending: boolean;
  setComplete: (complete: boolean) => void;
  run: <T>(send: () => Promise<T>) => Promise<T | undefined>;
  recover: (payload: ReplyPayload) => Promise<ReplyPayload>;
};
