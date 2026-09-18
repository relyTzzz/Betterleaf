interface QueuedJob {
  key: string;
  run: () => Promise<void>;
  settle: (err?: unknown) => void;
}

export interface WriteQueueOptions {
  /**
   * Trailing coalesce window. After a write completes, wait this long before
   * sending the next one so a burst collapses into a single request.
   */
  flushMs?: number;
  onError?: (err: unknown, key: string) => void;
}

/**
 * Serialises writes to one device and collapses bursts.
 *
 * A brightness slider emits ~60 events/second. Sending 60 PUTs makes an Aurora
 * stutter and fall seconds behind the UI — the single most visible "flaky"
 * symptom in the official app. The fix has two halves:
 *
 *   Leading edge  — the first write goes out immediately, so a tap feels instant.
 *   Trailing edge — writes arriving during the flush window collapse *by key*,
 *                   so only the newest brightness survives. Old values are never
 *                   sent; the light goes where your finger ended up, not on a
 *                   tour of everywhere it has been.
 *
 * At most one request is ever in flight, so the device is never asked to queue.
 */
export class WriteQueue {
  readonly #pending = new Map<string, QueuedJob>();
  readonly #flushMs: number;
  readonly #onError: ((err: unknown, key: string) => void) | undefined;

  #inFlight = false;
  #timer: NodeJS.Timeout | undefined;
  #closed = false;

  /** Requests actually sent. Exposed so tests can assert coalescing works. */
  #dispatched = 0;

  constructor(opts: WriteQueueOptions = {}) {
    this.#flushMs = opts.flushMs ?? 60;
    this.#onError = opts.onError;
  }

  get dispatchedCount(): number {
    return this.#dispatched;
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  get idle(): boolean {
    return !this.#inFlight && this.#pending.size === 0;
  }

  /**
   * Queue a write under `key`, replacing any pending write with the same key.
   *
   * The returned promise resolves when this write completes *or* when a newer
   * write for the same key supersedes it — a superseded write is not a failure,
   * its intent was subsumed by the newer value.
   */
  enqueue(key: string, run: () => Promise<void>): Promise<void> {
    if (this.#closed) return Promise.reject(new Error('WriteQueue is closed'));

    return new Promise<void>((resolve, reject) => {
      // Map.set on an existing key keeps the original insertion position, so a
      // rapidly-updated key doesn't starve one queued behind it.
      this.#pending.get(key)?.settle();

      this.#pending.set(key, {
        key,
        run,
        settle: (err?: unknown) => (err ? reject(err) : resolve()),
      });

      this.#schedule(true);
    });
  }

  /** Resolves once everything queued has been sent. */
  async drain(): Promise<void> {
    while (!this.idle) {
      await new Promise((r) => setTimeout(r, this.#flushMs / 2));
    }
  }

  close(): void {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    for (const job of this.#pending.values()) job.settle();
    this.#pending.clear();
  }

  #schedule(allowLeading: boolean): void {
    if (this.#closed || this.#inFlight || this.#timer) return;
    if (this.#pending.size === 0) return;

    // Leading edge: nothing in flight and no cooldown pending, so go now.
    if (allowLeading) {
      void this.#flush();
      return;
    }

    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#flush();
    }, this.#flushMs);
  }

  async #flush(): Promise<void> {
    if (this.#closed || this.#inFlight) return;

    const next = this.#pending.entries().next();
    if (next.done) return;
    const [key, job] = next.value;
    this.#pending.delete(key);

    this.#inFlight = true;
    this.#dispatched++;

    try {
      await job.run();
      job.settle();
    } catch (err) {
      job.settle(err);
      this.#onError?.(err, key);
    } finally {
      this.#inFlight = false;
      // Trailing edge for whatever piled up while this was in flight.
      this.#schedule(false);
    }
  }
}
