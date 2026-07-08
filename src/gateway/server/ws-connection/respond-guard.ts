import { ErrorCodes, errorShape } from "../../protocol/schema/error-codes.js";
import type { ErrorShape } from "../../protocol/schema/types.js";

export type GatewayRespondFn = (
  ok: boolean,
  payload?: unknown,
  error?: ErrorShape,
  meta?: Record<string, unknown>,
) => void;

/** Warn when a request has produced no response for this long. */
export const REQUEST_PENDING_WARN_MS = 60_000;
/**
 * Hard ceiling: fail the request so no client waits forever on a hung
 * handler. Legitimate long waits (agent.wait, exec approval waits) bound
 * themselves well below this via their own param timeouts.
 */
export const REQUEST_TIMEOUT_MS = 15 * 60_000;

/**
 * Wraps a raw respond function so that every request gets exactly one
 * response: duplicate responses are dropped, a pending warning fires after
 * `warnAfterMs`, and a timeout error response fires after `timeoutAfterMs`.
 */
export function createGuardedResponder(params: {
  respond: GatewayRespondFn;
  method: string;
  warnAfterMs?: number;
  timeoutAfterMs?: number;
  onWarn?: (pendingMs: number) => void;
  onDuplicate?: () => void;
}): GatewayRespondFn {
  const warnAfterMs = params.warnAfterMs ?? REQUEST_PENDING_WARN_MS;
  const timeoutAfterMs = params.timeoutAfterMs ?? REQUEST_TIMEOUT_MS;
  let responded = false;

  const warnTimer = setTimeout(() => {
    if (!responded) {
      params.onWarn?.(warnAfterMs);
    }
  }, warnAfterMs);
  warnTimer.unref?.();

  const guarded: GatewayRespondFn = (ok, payload, error, meta) => {
    if (responded) {
      params.onDuplicate?.();
      return;
    }
    responded = true;
    clearTimeout(warnTimer);
    clearTimeout(timeoutTimer);
    params.respond(ok, payload, error, meta);
  };

  const timeoutTimer = setTimeout(() => {
    guarded(
      false,
      undefined,
      errorShape(
        ErrorCodes.UNAVAILABLE,
        `request timed out after ${Math.round(timeoutAfterMs / 1000)}s: ${params.method}`,
        { retryable: true },
      ),
    );
  }, timeoutAfterMs);
  timeoutTimer.unref?.();

  return guarded;
}
