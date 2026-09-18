import http from 'node:http';
import { EventEmitter } from 'node:events';
import type { StatePatch } from '../model/types.js';
import { backoffDelay } from '../util/async.js';

/** Event stream ids, per the OpenAPI `/events?id=` query. */
export const EventType = {
  State: 1,
  Layout: 2,
  Effects: 3,
  Touch: 4,
} as const;

/** `attr` values inside a state event. */
const STATE_ATTR: Record<number, keyof StatePatch> = {
  1: 'on',
  2: 'brightness',
  3: 'hue',
  4: 'sat',
  5: 'ct',
  6: 'colorMode',
};

export type TouchGesture =
  | 'single-tap'
  | 'double-tap'
  | 'swipe-up'
  | 'swipe-down'
  | 'swipe-left'
  | 'swipe-right'
  | 'unknown';

const GESTURES: readonly TouchGesture[] = [
  'single-tap',
  'double-tap',
  'swipe-up',
  'swipe-down',
  'swipe-left',
  'swipe-right',
];

export interface TouchEvent {
  gesture: TouchGesture;
  panelId: number;
}

export interface EventStreamOptions {
  host: string;
  port: number;
  token: string;
  /** Defaults to state + layout + effects. Add Touch for Canvas. */
  types?: number[];
  /**
   * Reconnect if not a single byte arrives in this long. Nanoleaf sends
   * keepalive whitespace, so silence means the socket is wedged even though TCP
   * still believes it is open.
   */
  idleTimeoutMs?: number;
  maxBackoffMs?: number;
}

type EventStreamEvents = {
  open: [];
  state: [StatePatch];
  effect: [string];
  /** Layout changed; the caller should re-fetch it. */
  layout: [];
  touch: [TouchEvent];
  /** Transport dropped; reconnect scheduled. Carries the attempt number. */
  reconnecting: [number];
  error: [Error];
  closed: [];
};

/**
 * A long-lived Server-Sent Events subscription to one device.
 *
 * This is the backbone of Betterleaf's responsiveness. Polling a Nanoleaf for
 * state is both slow and wrong: slow because you wait up to a poll interval to
 * notice a change, wrong because changes made from a wall switch, HomeKit or the
 * official app never show up in between. One event stream gives instant truth
 * and, as a bonus, its health *is* the connection status — if events flow, the
 * device is genuinely reachable, which no amount of optimistic UI can fake.
 *
 * Nanoleaf's stream is not clean enough for the browser `EventSource`
 * (inconsistent retry semantics, no reconnection on silent stalls), so this
 * parses the wire format directly and supervises the socket itself.
 */
export class EventStream extends EventEmitter<EventStreamEvents> {
  readonly #opts: Required<Omit<EventStreamOptions, 'types'>> & { types: number[] };

  #req: http.ClientRequest | undefined;
  #res: http.IncomingMessage | undefined;
  #buffer = '';
  #lastByteAt = 0;
  #attempt = 0;
  #watchdog: NodeJS.Timeout | undefined;
  #retryTimer: NodeJS.Timeout | undefined;
  #closed = false;
  #connected = false;

  constructor(opts: EventStreamOptions) {
    super();
    this.#opts = {
      host: opts.host,
      port: opts.port,
      token: opts.token,
      types: opts.types ?? [EventType.State, EventType.Layout, EventType.Effects],
      idleTimeoutMs: opts.idleTimeoutMs ?? 60_000,
      maxBackoffMs: opts.maxBackoffMs ?? 30_000,
    };
  }

  get connected(): boolean {
    return this.#connected;
  }

  start(): void {
    if (this.#closed) throw new Error('EventStream is closed');
    this.#connect();
  }

  /** Point at a new address (the device moved) and reconnect immediately. */
  rebind(host: string, port: number): void {
    this.#opts.host = host;
    this.#opts.port = port;
    this.#attempt = 0;
    this.#teardown();
    if (!this.#closed) this.#connect();
  }

  close(): void {
    this.#closed = true;
    this.#teardown();
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    this.emit('closed');
  }

  #connect(): void {
    const { host, port, token, types } = this.#opts;
    const path = `/api/v1/${token}/events?id=${types.join(',')}`;

    const req = http.request({
      host,
      port,
      path,
      method: 'GET',
      headers: { Accept: 'text/event-stream', Connection: 'keep-alive' },
    });
    this.#req = req;

    req.on('error', (err) => this.#onDrop(err));

    req.on('response', (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        this.#onDrop(
          new Error(`Event stream rejected with HTTP ${res.statusCode}`),
        );
        return;
      }

      this.#res = res;
      this.#connected = true;
      this.#attempt = 0;
      this.#buffer = '';
      this.#markAlive();
      this.#armWatchdog();
      this.emit('open');

      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        this.#markAlive();
        this.#buffer += chunk;
        this.#drainBuffer();
      });
      res.on('end', () => this.#onDrop(new Error('Event stream ended')));
      res.on('error', (err) => this.#onDrop(err));
    });

    req.end();
  }

  #markAlive(): void {
    this.#lastByteAt = Date.now();
  }

  #armWatchdog(): void {
    if (this.#watchdog) clearInterval(this.#watchdog);
    const check = Math.max(1_000, Math.floor(this.#opts.idleTimeoutMs / 4));
    this.#watchdog = setInterval(() => {
      if (Date.now() - this.#lastByteAt > this.#opts.idleTimeoutMs) {
        this.#onDrop(
          new Error(`No event traffic for ${this.#opts.idleTimeoutMs}ms`),
        );
      }
    }, check);
    this.#watchdog.unref?.();
  }

  /**
   * Split the buffer on blank lines and parse each complete event.
   *
   * Handles both \n and \r\n; firmware versions differ and a parser that only
   * knows one of them silently receives nothing.
   */
  #drainBuffer(): void {
    const parts = this.#buffer.split(/\r?\n\r?\n/);
    // The tail is whatever hasn't been terminated yet.
    this.#buffer = parts.pop() ?? '';

    for (const block of parts) {
      if (block.trim() === '') continue;
      this.#handleBlock(block);
    }
  }

  #handleBlock(block: string): void {
    let eventId: number | undefined;
    const dataLines: string[] = [];

    for (const rawLine of block.split(/\r?\n/)) {
      const line = rawLine.trimStart();
      if (line === '' || line.startsWith(':')) continue;

      const sep = line.indexOf(':');
      const field = sep === -1 ? line : line.slice(0, sep);
      const value = sep === -1 ? '' : line.slice(sep + 1).trim();

      if (field === 'id') eventId = Number(value);
      else if (field === 'data') dataLines.push(value);
    }

    if (eventId === undefined || dataLines.length === 0) return;

    let payload: { events?: unknown[] };
    try {
      payload = JSON.parse(dataLines.join('\n')) as { events?: unknown[] };
    } catch (err) {
      this.emit('error', new Error(`Malformed event payload: ${String(err)}`));
      return;
    }

    for (const entry of payload.events ?? []) {
      this.#dispatch(eventId, entry as Record<string, unknown>);
    }
  }

  #dispatch(eventId: number, entry: Record<string, unknown>): void {
    switch (eventId) {
      case EventType.State: {
        const key = STATE_ATTR[Number(entry['attr'])];
        if (!key) return;
        this.emit('state', { [key]: entry['value'] } as StatePatch);
        return;
      }
      case EventType.Layout:
        this.emit('layout');
        return;
      case EventType.Effects: {
        const value = entry['value'];
        if (typeof value === 'string') this.emit('effect', value);
        return;
      }
      case EventType.Touch: {
        const idx = Number(entry['gesture']);
        this.emit('touch', {
          gesture: GESTURES[idx] ?? 'unknown',
          panelId: Number(entry['panelId']),
        });
        return;
      }
      default:
        return;
    }
  }

  #teardown(): void {
    if (this.#watchdog) clearInterval(this.#watchdog);
    this.#watchdog = undefined;
    this.#connected = false;

    // Destroying a socket emits ECONNRESET on the request. Swap the real
    // handlers for a sink *before* destroying, or that error escapes as an
    // uncaught exception — teardown is routine here (every reconnect, every
    // rebind, every close) and must never be able to take the process down.
    const res = this.#res;
    if (res) {
      res.removeAllListeners();
      res.on('error', () => {});
      res.destroy();
    }
    this.#res = undefined;

    const req = this.#req;
    if (req) {
      req.removeAllListeners();
      req.on('error', () => {});
      req.destroy();
    }
    this.#req = undefined;
  }

  #onDrop(err: Error): void {
    if (this.#closed) return;
    const wasConnected = this.#connected;
    this.#teardown();
    if (wasConnected || this.#attempt === 0) this.emit('error', err);

    const delay = backoffDelay(this.#attempt, {
      baseMs: 1_000,
      maxMs: this.#opts.maxBackoffMs,
    });
    this.#attempt++;
    this.emit('reconnecting', this.#attempt);

    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      if (!this.#closed) this.#connect();
    }, delay);
    this.#retryTimer.unref?.();
  }
}
