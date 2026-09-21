// Keyed async queue helpers serialize async plugin work by key while preserving parallelism.
/** Optional lifecycle hooks fired around each queued task. */
export type KeyedAsyncQueueHooks = {
  onEnqueue?: () => void;
  onSettle?: () => void;
};

/** Serialize async work per key while allowing unrelated keys to run concurrently. */
export function enqueueKeyedTask<T>(params: {
  tails: Map<string, Promise<void>>;
  key: string;
  task: () => Promise<T>;
  hooks?: KeyedAsyncQueueHooks;
  /** Cancels admission only; an admitted task owns its execution and settlement. */
  signal?: AbortSignal;
}): Promise<T> {
  params.hooks?.onEnqueue?.();
  const previous = params.tails.get(params.key) ?? Promise.resolve();
  const signal = params.signal;
  const current = previous
    .catch(() => undefined)
    .then(
      signal
        ? () => {
            signal.removeEventListener("abort", onAbort);
            signal.throwIfAborted();
            return params.task();
          }
        : params.task,
    )
    .finally(() => {
      params.hooks?.onSettle?.();
    });
  const tail = current.then(
    () => undefined,
    () => undefined,
  );
  params.tails.set(params.key, tail);
  const cleanup = () => {
    if (params.tails.get(params.key) === tail) {
      params.tails.delete(params.key);
    }
  };
  tail.then(cleanup, cleanup);
  if (!signal) {
    return current;
  }
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const onAbort = () => {
    signal.removeEventListener("abort", onAbort);
    reject(signal.reason);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  // The queue retains the skipped entry until its predecessor settles, preserving FIFO.
  current.then(resolve, reject);
  if (signal.aborted) {
    onAbort();
  }
  return promise;
}

/** Small per-key async queue wrapper for plugin runtimes that need serialized work. */
export class KeyedAsyncQueue {
  private readonly tails = new Map<string, Promise<void>>();

  /**
   * @deprecated Retained for shipped Plugin SDK compatibility. New callers must
   * not depend on queue storage; remove in a declared Plugin SDK breaking window.
   */
  getTailMapForTesting(): Map<string, Promise<void>> {
    return this.tails;
  }

  enqueue<T>(
    key: string,
    task: () => Promise<T>,
    hooks?: KeyedAsyncQueueHooks,
    signal?: AbortSignal,
  ): Promise<T> {
    return enqueueKeyedTask({
      tails: this.tails,
      key,
      task,
      ...(hooks ? { hooks } : {}),
      ...(signal ? { signal } : {}),
    });
  }
}
