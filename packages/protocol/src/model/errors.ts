/**
 * Error taxonomy.
 *
 * The distinction that matters most: {@link NanoleafAuthError} is terminal and
 * must never be retried (the token is gone; only re-pairing fixes it), while
 * timeouts and network errors are transient and safe to retry. Conflating the
 * two is how an app ends up hammering a device it will never be allowed to talk
 * to.
 */
export class NanoleafError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** 401/403 — the stored auth token is no longer valid. Terminal. */
export class NanoleafAuthError extends NanoleafError {
  constructor(readonly status: number) {
    super(`Nanoleaf rejected the auth token (HTTP ${status}); re-pairing required`);
  }
}

/** Any other non-2xx response. */
export class NanoleafHttpError extends NanoleafError {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Nanoleaf returned HTTP ${status}: ${body.slice(0, 200)}`);
  }
}

/** The request did not complete within its deadline. Transient. */
export class NanoleafTimeoutError extends NanoleafError {
  constructor(readonly timeoutMs: number) {
    super(`Nanoleaf request timed out after ${timeoutMs}ms`);
  }
}

/** Socket-level failure: refused, unreachable, reset. Transient. */
export class NanoleafNetworkError extends NanoleafError {}

/** No device entered pairing mode within the window. */
export class NanoleafPairingError extends NanoleafError {}

/** True when retrying could plausibly succeed. */
export function isTransient(err: unknown): boolean {
  if (err instanceof NanoleafAuthError) return false;
  if (err instanceof NanoleafTimeoutError) return true;
  if (err instanceof NanoleafNetworkError) return true;
  // 5xx can be transient; 4xx means we asked for something wrong.
  if (err instanceof NanoleafHttpError) return err.status >= 500;
  return false;
}
