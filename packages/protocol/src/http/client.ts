import {
  NanoleafAuthError,
  NanoleafHttpError,
  isTransient,
} from '../model/errors.js';
import { backoffDelay, isAbortError, sleep } from '../util/async.js';
import { DEFAULT_TIMEOUT_MS, rawRequest } from './transport.js';

export const DEFAULT_API_PORT = 16021;

export interface NanoleafClientOptions {
  host: string;
  port?: number;
  /** Omit for the unauthenticated pairing call. */
  token?: string;
  timeoutMs?: number;
  /** Retries *in addition to* the first attempt. Transient failures only. */
  maxRetries?: number;
}

export interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Skip retries for calls where a duplicate would be wrong. */
  noRetry?: boolean;
}

/**
 * Authenticated REST client for one Nanoleaf controller.
 *
 * The address is mutable on purpose: when a device turns up at a new IP with the
 * same serial number, the registry rewrites it here and every in-flight
 * abstraction above keeps working. Devices are identified by serial, not address.
 */
export class NanoleafClient {
  #host: string;
  #port: number;
  #token: string | undefined;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;

  constructor(opts: NanoleafClientOptions) {
    this.#host = opts.host;
    this.#port = opts.port ?? DEFAULT_API_PORT;
    this.#token = opts.token;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxRetries = opts.maxRetries ?? 2;
  }

  get host(): string {
    return this.#host;
  }

  get port(): number {
    return this.#port;
  }

  get token(): string | undefined {
    return this.#token;
  }

  get baseUrl(): string {
    return `http://${this.#host}:${this.#port}`;
  }

  /** Follow a device to a new address without losing its identity. */
  setAddress(host: string, port = DEFAULT_API_PORT): void {
    this.#host = host;
    this.#port = port;
  }

  setToken(token: string): void {
    this.#token = token;
  }

  /** Path under `/api/v1/<token>`, e.g. `/state` or `/effects`. */
  apiPath(path: string): string {
    if (!this.#token) {
      throw new Error('NanoleafClient has no auth token; pair the device first');
    }
    return `/api/v1/${this.#token}${path}`;
  }

  async get<T>(path: string, opts?: RequestOptions): Promise<T> {
    return (await this.#json<T>('GET', this.apiPath(path), undefined, opts)) as T;
  }

  /** Most Nanoleaf PUTs answer 204 with no body, hence `T | undefined`. */
  async put<T = void>(
    path: string,
    body: unknown,
    opts?: RequestOptions,
  ): Promise<T | undefined> {
    return this.#json<T>('PUT', this.apiPath(path), body, opts);
  }

  /** Unauthenticated: used by pairing against `/api/v1/new`. */
  async postRaw<T>(
    path: string,
    body?: unknown,
    opts?: RequestOptions,
  ): Promise<T | undefined> {
    return this.#json<T>('POST', path, body, opts);
  }

  /** Unauthenticated path form; used to revoke a token at `/api/v1/<token>`. */
  async deleteRaw<T>(path: string, opts?: RequestOptions): Promise<T | undefined> {
    return this.#json<T>('DELETE', path, undefined, opts);
  }

  async #json<T>(
    method: string,
    path: string,
    body: unknown,
    opts?: RequestOptions,
  ): Promise<T | undefined> {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const attempts = opts?.noRetry ? 1 : this.#maxRetries + 1;
    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) {
        // Short, jittered backoff. A Nanoleaf that just refused a connection is
        // usually busy rendering, not gone — 150ms then 300ms is plenty.
        await sleep(backoffDelay(attempt - 1, { baseMs: 150, maxMs: 1_000 }), opts?.signal);
      }

      try {
        const res = await rawRequest({
          host: this.#host,
          port: this.#port,
          method,
          path,
          body: encoded,
          timeoutMs: opts?.timeoutMs ?? this.#timeoutMs,
          signal: opts?.signal,
        });

        if (res.status === 401 || res.status === 403) {
          // Terminal: no amount of retrying revives a revoked token.
          throw new NanoleafAuthError(res.status);
        }
        if (res.status < 200 || res.status >= 300) {
          throw new NanoleafHttpError(res.status, res.body);
        }

        const text = res.body.trim();
        if (text === '') return undefined;
        try {
          return JSON.parse(text) as T;
        } catch {
          // A 2xx with a non-JSON body is success with nothing to report.
          return undefined;
        }
      } catch (err) {
        if (isAbortError(err)) throw err;
        lastError = err;
        if (!isTransient(err)) throw err;
      }
    }

    throw lastError;
  }
}
