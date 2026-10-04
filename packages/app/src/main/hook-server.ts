import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FireOutcome } from './hooks.js';

/** What the listener asks of the rest of the app. */
export interface HookHandler {
  fire(slug: string, source: string): FireOutcome;
  release(source: string): void;
  list(): { slug: string; name: string; enabled: boolean }[];
}

export { DEFAULT_HOOK_PORT } from '../shared/hooks.js';

/**
 * How much of a request body is kept.
 *
 * Only the caller's id is read from it, and Claude Code bodies can be large: a
 * PostToolUse after a file write carries the whole file. The id is the first
 * field, so the start of the body is enough, and the rest is read and dropped
 * rather than refused — refusing would lose the report along with the bulk.
 */
const BODY_KEEP_BYTES = 64 * 1024;

const MAX_SOURCE_LENGTH = 200;

/**
 * Who is calling, so reports from different callers can be told apart.
 *
 * An explicit `?source=` wins, for scripts and anything else that wants to be
 * counted separately. Otherwise Claude Code's `session_id` from the body, which
 * it sends with every hook, so each session is its own caller without any
 * configuration. Neither present: the anonymous caller, where the latest report
 * simply wins.
 */
export function sourceOf(query: URLSearchParams, body: string, complete: boolean): string {
  const explicit = query.get('source');
  if (explicit) return explicit.slice(0, MAX_SOURCE_LENGTH);
  if (body.trim() === '') return '';

  if (complete) {
    try {
      const parsed = JSON.parse(body) as { session_id?: unknown } | null;
      return typeof parsed?.session_id === 'string'
        ? parsed.session_id.slice(0, MAX_SOURCE_LENGTH)
        : '';
    } catch {
      // Not JSON after all; fall through to looking for the field by eye.
    }
  }
  const match = /"session_id"\s*:\s*"((?:[^"\\]|\\.){1,200})"/.exec(body);
  if (!match) return '';
  try {
    return (JSON.parse(`"${match[1]}"`) as string).slice(0, MAX_SOURCE_LENGTH);
  } catch {
    return '';
  }
}

/**
 * Should this request be refused before it is even routed?
 *
 * The listener is on loopback, so only programs on this machine can reach it —
 * but a web page open in a browser on this machine is one of those. Two checks
 * keep pages out:
 *
 * - **No `Origin`, and no cross-site `Sec-Fetch-Site`.** Browsers attach these
 *   to every POST a page makes, same-site or not. curl, PowerShell and Claude
 *   Code send neither.
 * - **`Host` must be a loopback name.** A page on a domain that has been
 *   re-pointed at 127.0.0.1 (DNS rebinding) is same-origin as far as the
 *   browser knows, but still sends its own name as the host.
 *
 * There is deliberately no token. Anything that can run a program here could
 * read a token from Betterleaf's settings just as easily, so it would add a
 * step to every caller's setup and keep no one out.
 */
export function refusal(req: http.IncomingMessage, port: number): string | undefined {
  if (req.headers.origin !== undefined) return 'Requests from web pages are refused.';
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'none') return 'Requests from web pages are refused.';

  const host = (req.headers.host ?? '').toLowerCase();
  const loopback = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  if (!loopback.includes(host)) return 'Only loopback addresses are answered.';
  return undefined;
}

/** A listen failure, in words someone can act on. */
export function describeListenError(err: unknown, port: number): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EADDRINUSE') {
    return `Port ${port} is already in use by another program. Pick another.`;
  }
  if (code === 'EACCES') return `Windows would not let Betterleaf use port ${port}. Pick another.`;
  return (err as Error | undefined)?.message ?? 'Could not start listening.';
}

function reply(res: http.ServerResponse, status: number, text?: string): void {
  res.statusCode = status;
  res.setHeader('Cache-Control', 'no-store');
  if (text === undefined) {
    res.end();
    return;
  }
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(`${text}\n`);
}

/**
 * Betterleaf's hook listener: HTTP on loopback only.
 *
 * Firing a hook answers 204 with an empty body, straight away. Straight away
 * because the lights are settled afterwards, so a slow or missing light never
 * holds up the caller — Claude Code waits on every hook it runs. Empty because
 * Claude Code reads a hook's response body as instructions, and a PermissionRequest
 * hook that answered with JSON could be taken as deciding the permission.
 */
export class HookServer {
  readonly #handler: HookHandler;
  #server: http.Server | undefined;
  #port = 0;

  constructor(handler: HookHandler) {
    this.#handler = handler;
  }

  get listening(): boolean {
    return this.#server !== undefined;
  }

  /** The bound port, which differs from the one asked for only when that was 0. */
  get port(): number {
    return this.#port;
  }

  /** Rejects with the listen error, so the caller can say why. */
  async start(port: number): Promise<void> {
    await this.stop();
    const server = http.createServer((req, res) => this.#handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      // Loopback only, never all interfaces: anything on the network could
      // otherwise change your lights.
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    // Once bound, an error belongs to one connection, not to the listener.
    server.on('error', () => {});
    this.#server = server;
    this.#port = (server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    if (!server) return;
    this.#server = undefined;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Keep-alive connections would otherwise hold `close` open for seconds.
      server.closeAllConnections();
    });
  }

  #handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const refused = refusal(req, this.#port);
    if (refused) {
      // Drain without keeping anything, so the socket closes cleanly.
      req.resume();
      reply(res, 403, refused);
      return;
    }

    const chunks: Buffer[] = [];
    let kept = 0;
    let complete = true;
    req.on('data', (chunk: Buffer) => {
      if (kept >= BODY_KEEP_BYTES) {
        complete = false;
        return;
      }
      const take = chunk.subarray(0, BODY_KEEP_BYTES - kept);
      chunks.push(take);
      kept += take.length;
      if (take.length < chunk.length) complete = false;
    });
    req.on('error', () => {});
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        this.#route(req, res, new URL(req.url ?? '/', 'http://127.0.0.1'), body, complete);
      } catch {
        reply(res, 500, 'Betterleaf could not handle that request.');
      }
    });
  }

  #route(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    body: string,
    complete: boolean,
  ): void {
    const method = req.method ?? 'GET';
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/hooks') {
      if (method !== 'GET') return void reply(res, 405, 'Use GET to list hooks.');
      res.statusCode = 200;
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(this.#handler.list()));
      return;
    }

    const fire = /^\/hooks\/([^/]+)$/.exec(path);
    if (fire) {
      // POST only. A GET that changed the lights could be triggered by any
      // page with an <img> tag pointing here, and those send no Origin.
      if (method !== 'POST') return void reply(res, 405, 'Use POST to fire a hook.');
      let slug: string;
      try {
        slug = decodeURIComponent(fire[1] ?? '').toLowerCase();
      } catch {
        return void reply(res, 404, 'No hook at that address.');
      }
      const outcome = this.#handler.fire(slug, sourceOf(url.searchParams, body, complete));
      if (outcome === 'unknown') return void reply(res, 404, 'No hook at that address.');
      if (outcome === 'disabled') return void reply(res, 409, 'That hook is paused.');
      return void reply(res, 204);
    }

    if (path === '/release') {
      if (method !== 'POST') return void reply(res, 405, 'Use POST to release.');
      this.#handler.release(sourceOf(url.searchParams, body, complete));
      return void reply(res, 204);
    }

    if (path === '/') {
      return void reply(res, 200, 'Betterleaf is listening for hooks. POST /hooks/<address> to fire one.');
    }

    reply(res, 404, 'Nothing here. Hooks are at /hooks/<address>.');
  }
}
