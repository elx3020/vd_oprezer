// Concurrency limiter: at most `concurrency` tasks run at once, the rest
// wait in FIFO order.

export interface Limiter {
  /**
   * Runs `fn` when a slot is free. Aborting `signal` while it waits removes
   * it from the queue and rejects with the signal's reason.
   */
  run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  readonly running: number;
  readonly waiting: number;
}

export function createLimiter(concurrency: number): Limiter {
  let running = 0;
  const waiting: (() => void)[] = [];

  return {
    get running() {
      return running;
    },
    get waiting() {
      return waiting.length;
    },
    async run(fn, signal) {
      signal?.throwIfAborted();
      if (running < concurrency && waiting.length === 0) {
        running++;
      } else {
        await new Promise<void>((resolve, reject) => {
          // The slot is handed over (running++) right here, so nobody can jump the queue in between.
          const start = () => {
            signal?.removeEventListener("abort", onAbort);
            running++;
            resolve();
          };
          const onAbort = () => {
            waiting.splice(waiting.indexOf(start), 1);
            reject(signal?.reason as Error);
          };
          waiting.push(start);
          signal?.addEventListener("abort", onAbort, { once: true });
        });
      }
      try {
        return await fn();
      } finally {
        running--;
        waiting.shift()?.();
      }
    },
  };
}
