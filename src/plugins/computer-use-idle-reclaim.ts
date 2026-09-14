/**
 * Idle reclaim for a node-local Computer Use execution.
 *
 * A harness that builds the computer tool without a run-cleanup registrar cannot
 * send `__close_execution`, so without a backstop the first dispatch owns the host
 * until the node disconnects and every later `executionId` is refused. Dispatch
 * accounting keeps a long-running command from being interrupted: the window is
 * only armed while nothing is in flight.
 */

/** Reclaim window for an execution whose owner never closes it. */
export const COMPUTER_EXECUTION_IDLE_TIMEOUT_MS = 5 * 60_000;

export type ExecutionIdleReclaim = {
  /** Cancels a pending reclaim; used when a close already owns the execution. */
  clear: () => void;
  /**
   * Acquires the host, then runs one dispatch with the window suspended.
   *
   * A failed acquisition leaves the window untouched on purpose: a caller that is
   * refused the host did no work, so it must not postpone reclaiming the execution
   * that refused it. Otherwise a peer retrying faster than the window would keep an
   * abandoned execution alive forever.
   */
  run: <T, TAcquired>(
    acquire: () => Promise<TAcquired>,
    task: (acquired: TAcquired) => Promise<T>,
  ) => Promise<T>;
};

export function createExecutionIdleReclaim(
  onIdle: () => void,
  timeoutMs: number = COMPUTER_EXECUTION_IDLE_TIMEOUT_MS,
): ExecutionIdleReclaim {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = 0;

  const clear = (): void => {
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    timer = undefined;
  };
  const arm = (): void => {
    clear();
    if (inFlight > 0) {
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      if (inFlight === 0) {
        onIdle();
      }
    }, timeoutMs);
    timer.unref?.();
  };
  const run = async <T, TAcquired>(
    acquire: () => Promise<TAcquired>,
    task: (acquired: TAcquired) => Promise<T>,
  ): Promise<T> => {
    const acquired = await acquire();
    inFlight += 1;
    clear();
    try {
      return await task(acquired);
    } finally {
      inFlight -= 1;
      arm();
    }
  };
  return { clear, run };
}
