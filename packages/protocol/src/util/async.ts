export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Exponential backoff with full jitter.
 *
 * Full jitter (random between 0 and the ceiling) rather than a fixed delay
 * matters when several devices drop off at once — otherwise every reconnect
 * fires in lockstep and the router sees a thundering herd each cycle.
 */
export function backoffDelay(
  attempt: number,
  opts: { baseMs?: number; maxMs?: number; jitter?: boolean } = {},
): number {
  const base = opts.baseMs ?? 1_000;
  const max = opts.maxMs ?? 30_000;
  const ceiling = Math.min(max, base * 2 ** Math.max(0, attempt));
  return opts.jitter === false ? ceiling : Math.random() * ceiling;
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/** Resolves with the first promise to fulfil, ignoring rejections unless all reject. */
export async function firstFulfilled<T>(promises: Promise<T>[]): Promise<T> {
  const errors: unknown[] = [];
  return new Promise<T>((resolve, reject) => {
    let pending = promises.length;
    if (pending === 0) {
      reject(new Error('firstFulfilled called with no promises'));
      return;
    }
    for (const p of promises) {
      p.then(resolve, (err) => {
        errors.push(err);
        if (--pending === 0) reject(new AggregateError(errors, 'All promises rejected'));
      });
    }
  });
}
