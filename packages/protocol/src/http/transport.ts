import http from 'node:http';
import { NanoleafNetworkError, NanoleafTimeoutError } from '../model/errors.js';

export interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface RawRequestOptions {
  host: string;
  port: number;
  method: string;
  path: string;
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export const DEFAULT_TIMEOUT_MS = 2_000;

/**
 * One HTTP request against a Nanoleaf controller.
 *
 * Deliberately `node:http` rather than `fetch`: we need the raw socket for the
 * SSE stream anyway (see events/sse.ts), and this gives an explicit deadline
 * that covers connect *and* body read rather than just headers.
 *
 * Content-Length is set explicitly because the embedded server on older Aurora
 * firmware mishandles chunked request bodies.
 */
export function rawRequest(opts: RawRequestOptions): Promise<RawResponse> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<RawResponse>((resolve, reject) => {
    // `addEventListener('abort')` never fires on a signal that has already
    // aborted, so without this check a request issued after cancellation runs
    // to completion and its result is treated as live. That is how a cancelled
    // discovery probe ends up reporting a paired device as needing pairing.
    if (opts.signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    let settled = false;
    const headers: Record<string, string> = { Connection: 'close' };

    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(opts.body, 'utf8'));
    }

    const req = http.request({
      host: opts.host,
      port: opts.port,
      method: opts.method,
      path: opts.path,
      headers,
    });

    const cleanup = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      req.destroy();
      reject(err);
    };

    const timer = setTimeout(
      () => fail(new NanoleafTimeoutError(timeoutMs)),
      timeoutMs,
    );

    const onAbort = () => fail(new DOMException('Aborted', 'AbortError'));
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    req.on('error', (err) =>
      fail(new NanoleafNetworkError(`Request to ${opts.host}:${opts.port} failed: ${err.message}`, err)),
    );

    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('error', (err) =>
        fail(new NanoleafNetworkError(`Response read failed: ${err.message}`, err)),
      );
      res.on('end', () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });

    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}
