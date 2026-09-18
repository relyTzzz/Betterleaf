import { NanoleafClient, DEFAULT_API_PORT } from '../http/client.js';
import { NanoleafPairingError } from '../model/errors.js';
import { sleep } from '../util/async.js';

export interface PairOptions {
  host: string;
  port?: number;
  /**
   * How long to keep trying. Nanoleaf opens a 30s pairing window when the power
   * button is held for 5–7 seconds; we poll across it so the user can press the
   * button after starting the pairing, not before.
   */
  windowMs?: number;
  pollIntervalMs?: number;
  /** Called on each attempt with the seconds remaining, to drive a countdown. */
  onTick?: (msRemaining: number) => void;
  signal?: AbortSignal;
}

interface NewTokenResponse {
  auth_token?: string;
}

/**
 * Acquire an auth token from a device in pairing mode.
 *
 * `POST /api/v1/new` only succeeds during the pairing window, and returns 401
 * otherwise. Rather than demand the user get the timing right, we poll for the
 * whole window: they can start this, then walk over and hold the button.
 */
export async function pairDevice(opts: PairOptions): Promise<string> {
  const port = opts.port ?? DEFAULT_API_PORT;
  const windowMs = opts.windowMs ?? 35_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 1_000;

  const client = new NanoleafClient({
    host: opts.host,
    port,
    timeoutMs: 2_000,
    maxRetries: 0,
  });

  const deadline = Date.now() + windowMs;

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) {
      throw new NanoleafPairingError('Pairing cancelled');
    }
    opts.onTick?.(deadline - Date.now());

    try {
      const res = await client.postRaw<NewTokenResponse>('/api/v1/new', undefined, {
        noRetry: true,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      if (res?.auth_token) return res.auth_token;
    } catch {
      // 401 until the button is held; anything else is likely transient too.
      // Either way the right move is to keep trying until the window closes.
    }

    await sleep(pollIntervalMs, opts.signal).catch(() => {});
  }

  throw new NanoleafPairingError(
    `No device at ${opts.host}:${port} entered pairing mode within ${Math.round(windowMs / 1000)}s. ` +
      'Hold the controller power button for 5–7 seconds until its LED flashes, then try again.',
  );
}

/**
 * Release a token. Courtesy only — Nanoleaf controllers hold a limited number of
 * tokens, and an app that never cleans up eventually exhausts them.
 */
export async function unpairDevice(
  host: string,
  token: string,
  port = DEFAULT_API_PORT,
): Promise<void> {
  const client = new NanoleafClient({ host, port, token, maxRetries: 0 });
  await client.deleteRaw(`/api/v1/${token}`, { noRetry: true }).catch(() => {});
}
