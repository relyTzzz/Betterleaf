import dgram from 'node:dgram';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { EventEmitter } from 'node:events';
import type { DeviceInfo, PanelColor, StreamVersion } from '@betterleaf/protocol';
import { decodeFrame } from './decode.js';
import { PROFILES, defaultEffectDocs, type ProfileName } from './profiles.js';

export interface SimulatorOptions {
  profile: ProfileName;
  /** 0 picks a free port, which is what tests want. */
  port?: number;
  /**
   * Interface to bind. Defaults to loopback so the test suite stays private.
   * Pass '0.0.0.0' when advertising over mDNS, or the address bonjour announces
   * (this machine's LAN address) will not be one the simulator answers on.
   */
  host?: string;
  /** Pre-issued token. Omit to require pairing. */
  token?: string;
  /** Start with the pairing window open. */
  pairingOpen?: boolean;
  /** Advertise over mDNS. Off by default so tests don't spam the LAN. */
  advertise?: boolean;
  /** Fixed UDP port for streaming; 0 picks a free one. */
  streamPort?: number;
  /** Report `streamControlPort` in the extControl response, like Light Panels do. */
  reportsStreamPort?: boolean;
  /** How often to send SSE keepalive traffic. 0 disables it, to exercise the client watchdog. */
  keepaliveMs?: number;
}

export interface ReceivedFrame {
  at: number;
  version: StreamVersion;
  panels: PanelColor[];
  bytes: Buffer;
}

export interface LoggedRequest {
  at: number;
  method: string;
  path: string;
  body: string;
}

type SimEvents = {
  frame: [ReceivedFrame];
  request: [LoggedRequest];
};

/**
 * A fake Nanoleaf controller.
 *
 * Exists so the whole stack — discovery, pairing, coalescing, SSE reconnection,
 * streaming — can be exercised in CI and during development without power-cycling
 * real hardware or being in the same room as it. It is not a perfect emulation;
 * it is an honest one about the parts Betterleaf depends on, including the
 * annoying ones (401 before pairing, an empty extControl body on Canvas, a
 * Rhythm pseudo-panel in the layout).
 */
export class NanoleafSimulator extends EventEmitter<SimEvents> {
  readonly profile;
  #info: DeviceInfo;
  #token: string;
  #pairingOpen: boolean;
  #server: http.Server;
  #udp: dgram.Socket | undefined;
  #bonjour: { destroy: () => void } | undefined;

  /**
   * Full effect documents, keyed by name. `info.effects.effectsList` holds only
   * the names, exactly as the real API does, so `requestAll` has somewhere to
   * read the bodies from.
   */
  #storedEffects = new Map<string, Record<string, unknown>>();

  #sseClients = new Set<http.ServerResponse>();
  #streamVersion: StreamVersion | undefined;
  #configuredStreamPort: number;
  #reportsStreamPort: boolean;

  readonly frames: ReceivedFrame[] = [];
  readonly requests: LoggedRequest[] = [];

  #port = 0;
  #udpPort = 0;
  #stopped = false;
  readonly #keepaliveMs: number;

  constructor(private readonly opts: SimulatorOptions) {
    super();
    // Copy, so one simulator instance can be reconfigured (or misconfigured by
    // a test) without corrupting the shared profile for every other instance.
    const template = PROFILES[opts.profile];
    this.profile = {
      ...template,
      streamVersions: [...template.streamVersions],
      plugins: [...template.plugins],
    };
    this.#info = this.profile.info();
    this.#token = opts.token ?? 'sim-token-' + Math.random().toString(36).slice(2, 10);
    this.#pairingOpen = opts.pairingOpen ?? false;
    this.#configuredStreamPort = opts.streamPort ?? 0;
    this.#reportsStreamPort = opts.reportsStreamPort ?? opts.profile === 'NL22';
    this.#keepaliveMs = opts.keepaliveMs ?? 15_000;
    // The factory effects need bodies, not just names, or requestAll comes
    // back empty on a device nobody has written to yet.
    for (const [name, doc] of Object.entries(
      defaultEffectDocs(this.#info.effects.effectsList),
    )) {
      this.#storedEffects.set(name, doc);
    }

    this.#server = http.createServer((req, res) => this.#handle(req, res));
  }

  get token(): string {
    return this.#token;
  }
  get port(): number {
    return this.#port;
  }
  get streamPort(): number {
    return this.#udpPort;
  }
  get url(): string {
    return `http://127.0.0.1:${this.#port}`;
  }
  get info(): DeviceInfo {
    return this.#info;
  }
  get serialNo(): string {
    return this.#info.serialNo;
  }
  get sseClientCount(): number {
    return this.#sseClients.size;
  }
  get streaming(): boolean {
    return this.#streamVersion !== undefined;
  }

  async start(): Promise<this> {
    const host = this.opts.host ?? '127.0.0.1';
    await new Promise<void>((resolve) =>
      this.#server.listen(this.opts.port ?? 0, host, resolve),
    );
    this.#port = (this.#server.address() as AddressInfo).port;

    this.#udp = dgram.createSocket('udp4');
    this.#udp.on('message', (msg) => this.#onDatagram(msg));
    await new Promise<void>((resolve) =>
      this.#udp!.bind(this.#configuredStreamPort, host, resolve),
    );
    this.#udpPort = this.#udp.address().port;

    if (this.opts.advertise) await this.#advertise();
    return this;
  }

  async #advertise(): Promise<void> {
    const { Bonjour } = await import('bonjour-service');
    const bonjour = new Bonjour();
    bonjour.publish({
      name: this.#info.name,
      type: this.profile.mdnsType,
      protocol: 'tcp',
      port: this.#port,
      txt: { md: this.#info.model, srcvers: this.#info.firmwareVersion },
    });
    this.#bonjour = bonjour;
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;

    for (const client of this.#sseClients) client.end();
    this.#sseClients.clear();
    this.#bonjour?.destroy();
    try {
      this.#udp?.close();
    } catch {
      /* already closed */
    }
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  // --- test controls --------------------------------------------------------

  openPairing(): void {
    this.#pairingOpen = true;
  }
  closePairing(): void {
    this.#pairingOpen = false;
  }

  /**
   * Invalidate the current token, as a factory reset or a token-table overflow
   * does. Every subsequent request gets 401 until the client re-pairs.
   */
  revokeToken(): void {
    this.#token = 'revoked-' + Math.random().toString(36).slice(2, 8);
    this.dropEventStreams();
  }

  /** Write arbitrary bytes into the event stream, to exercise the parser. */
  pushRaw(chunk: string): void {
    for (const client of this.#sseClients) client.write(chunk);
  }

  /** Drop every SSE client, as a device does when it reboots or Wi-Fi blips. */
  dropEventStreams(): void {
    for (const client of this.#sseClients) client.destroy();
    this.#sseClients.clear();
  }

  /** Change state as if something else did it (wall switch, HomeKit, the app). */
  pushStateEvent(attr: number, value: unknown): void {
    this.#applyStateAttr(attr, value);
    this.#broadcast(1, { events: [{ attr, value }] });
  }

  pushEffectEvent(name: string): void {
    this.#info.effects.select = name;
    this.#broadcast(3, { events: [{ attr: 1, value: name }] });
  }

  pushTouchEvent(gesture: number, panelId: number): void {
    this.#broadcast(4, { events: [{ gesture, panelId }] });
  }

  #applyStateAttr(attr: number, value: unknown): void {
    const s = this.#info.state;
    switch (attr) {
      case 1:
        s.on.value = Boolean(value);
        break;
      case 2:
        s.brightness.value = Number(value);
        break;
      case 3:
        s.hue.value = Number(value);
        break;
      case 4:
        s.sat.value = Number(value);
        break;
      case 5:
        s.ct.value = Number(value);
        break;
      case 6:
        s.colorMode = String(value);
        break;
    }
  }

  #broadcast(eventId: number, payload: unknown): void {
    const chunk = `id: ${eventId}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of this.#sseClients) client.write(chunk);
  }

  // --- UDP ------------------------------------------------------------------

  #onDatagram(msg: Buffer): void {
    const version = this.#streamVersion;
    if (!version) return; // not in external-control mode; the device would ignore it
    try {
      const frame: ReceivedFrame = {
        at: Date.now(),
        version,
        panels: decodeFrame(version, msg),
        bytes: Buffer.from(msg),
      };
      this.frames.push(frame);
      this.emit('frame', frame);
    } catch {
      /* malformed frame; a real device would just drop it */
    }
  }

  // --- HTTP -----------------------------------------------------------------

  #handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url ?? '/', 'http://localhost');
      this.requests.push({
        at: Date.now(),
        method: req.method ?? 'GET',
        path: url.pathname,
        body,
      });
      this.emit('request', this.requests[this.requests.length - 1]!);

      try {
        this.#route(req, res, url, body);
      } catch {
        this.#send(res, 500, { error: 'simulator failure' });
      }
    });
  }

  #route(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    body: string,
  ): void {
    const method = req.method ?? 'GET';
    const segments = url.pathname.split('/').filter(Boolean); // api, v1, <token>, ...

    if (segments[0] !== 'api' || segments[1] !== 'v1') {
      this.#send(res, 404, { error: 'not found' });
      return;
    }

    // POST /api/v1/new — only succeeds inside the pairing window.
    if (segments[2] === 'new' && method === 'POST') {
      if (!this.#pairingOpen) {
        this.#send(res, 401, { error: 'not in pairing mode' });
        return;
      }
      this.#pairingOpen = false;
      this.#send(res, 200, { auth_token: this.#token });
      return;
    }

    const token = segments[2];
    if (token !== this.#token) {
      this.#send(res, 401, { error: 'unauthorized' });
      return;
    }

    if (method === 'DELETE' && segments.length === 3) {
      this.#send(res, 204);
      return;
    }

    const rest = segments.slice(3);

    // GET /api/v1/<token>/
    if (method === 'GET' && rest.length === 0) {
      this.#send(res, 200, this.#info);
      return;
    }

    if (rest[0] === 'events' && method === 'GET') {
      this.#openEventStream(res);
      return;
    }

    if (rest[0] === 'panelLayout' && rest[1] === 'layout' && method === 'GET') {
      this.#send(res, 200, this.#info.panelLayout.layout);
      return;
    }

    if (rest[0] === 'identify' && method === 'PUT') {
      this.#send(res, 204);
      return;
    }

    if (rest[0] === 'state' && method === 'PUT') {
      this.#putState(res, body);
      return;
    }

    // GET /effects returns the selected effect and the list of names. It is the
    // cheap way to notice a scene arriving from the Nanoleaf app, and a real
    // device serves it; omitting it here made that polling path silently 404.
    if (rest[0] === 'effects' && method === 'GET') {
      this.#send(res, 200, {
        select: this.#info.effects.select,
        effectsList: this.#info.effects.effectsList,
      });
      return;
    }

    if (rest[0] === 'effects' && method === 'PUT') {
      this.#putEffects(res, body);
      return;
    }

    this.#send(res, 404, { error: 'not found' });
  }

  #putState(res: http.ServerResponse, body: string): void {
    let patch: Record<string, { value: unknown }>;
    try {
      patch = JSON.parse(body);
    } catch {
      this.#send(res, 400, { error: 'bad json' });
      return;
    }

    const attrs: Record<string, number> = {
      on: 1,
      brightness: 2,
      hue: 3,
      sat: 4,
      ct: 5,
      colorMode: 6,
    };

    for (const [key, wrapper] of Object.entries(patch)) {
      const attr = attrs[key];
      if (attr === undefined) continue;
      const value = wrapper?.value;
      this.#applyStateAttr(attr, value);
      // A real device reports back over the event stream, which is how the app
      // learns about changes it did not make itself.
      this.#broadcast(1, { events: [{ attr, value }] });
    }

    // Writing a colour takes the panels off whatever scene was playing and
    // onto a solid colour, which the device reports as a colour mode and as
    // the pseudo-scene `*Solid*` — one that is in no effects list and cannot
    // be selected. Without this, code that restores "the scene that was
    // showing" passes here and fails on hardware.
    // TODO(hardware): confirm both models announce `*Solid*` over the event
    // stream, not only in a fresh GET.
    const mode = 'hue' in patch || 'sat' in patch ? 'hs' : 'ct' in patch ? 'ct' : undefined;
    if (mode !== undefined && !('colorMode' in patch)) {
      this.#applyStateAttr(6, mode);
      this.#broadcast(1, { events: [{ attr: 6, value: mode }] });
    }
    if (mode !== undefined) {
      this.#streamVersion = undefined;
      this.#info.effects.select = '*Solid*';
      this.#broadcast(3, { events: [{ attr: 1, value: '*Solid*' }] });
    }

    this.#send(res, 204);
  }

  #putEffects(res: http.ServerResponse, body: string): void {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body);
    } catch {
      this.#send(res, 400, { error: 'bad json' });
      return;
    }

    if (typeof payload['select'] === 'string') {
      const name = payload['select'];
      this.#streamVersion = undefined;
      this.#info.effects.select = name;
      // Selecting a scene leaves solid-colour mode, the reverse of a colour write.
      if (this.#info.state.colorMode !== 'effect') {
        this.#applyStateAttr(6, 'effect');
        this.#broadcast(1, { events: [{ attr: 6, value: 'effect' }] });
      }
      this.#broadcast(3, { events: [{ attr: 1, value: name }] });
      this.#send(res, 204);
      return;
    }

    const write = payload['write'] as Record<string, unknown> | undefined;
    if (!write) {
      this.#send(res, 400, { error: 'missing write' });
      return;
    }

    if (write['command'] === 'display' && write['animType'] === 'extControl') {
      const version = write['extControlVersion'] as StreamVersion | undefined;
      if (!version || !this.profile.streamVersions.includes(version)) {
        // What a device does when asked for a protocol it doesn't speak.
        this.#send(res, 400, { error: `unsupported extControlVersion ${version}` });
        return;
      }
      this.#streamVersion = version;
      this.#info.effects.select = '*ExtControl*';

      // Light Panels answer with the streaming endpoint; Canvas returns nothing
      // and expects the client to use the well-known port.
      if (this.#reportsStreamPort) {
        this.#send(res, 200, {
          streamControlIpAddr: this.opts.host ?? '127.0.0.1',
          streamControlPort: this.#udpPort,
          streamControlProtocol: 'udp',
        });
      } else {
        this.#send(res, 200);
      }
      return;
    }

    if (write['command'] === 'requestAll') {
      this.#send(res, 200, { animations: [...this.#storedEffects.values()] });
      return;
    }

    if (write['command'] === 'request') {
      const stored = this.#storedEffects.get(String(write['animName'] ?? ''));
      if (!stored) {
        this.#send(res, 404, { error: 'no such effect' });
        return;
      }
      this.#send(res, 200, stored);
      return;
    }

    if (write['command'] === 'requestPlugins') {
      this.#send(res, 200, { plugins: this.profile.plugins });
      return;
    }

    if (write['command'] === 'add') {
      const name = String(write['animName'] ?? 'Unnamed');

      // A real device rejects an effect whose motion it does not have. This is
      // the failure the client's compatibility check exists to pre-empt, and it
      // is deliberately as unhelpful here as the hardware's is.
      const uuid = write['pluginUuid'];
      if (
        write['animType'] === 'plugin' &&
        typeof uuid === 'string' &&
        !this.profile.plugins.some((p) => p.uuid === uuid)
      ) {
        this.#send(res, 400, { error: 'bad request' });
        return;
      }

      const { command: _command, ...effect } = write;
      this.#storedEffects.set(name, effect);
      if (!this.#info.effects.effectsList.includes(name)) {
        this.#info.effects.effectsList.push(name);
      }
      this.#send(res, 204);
      return;
    }

    if (write['command'] === 'delete') {
      const name = String(write['animName'] ?? '');
      this.#storedEffects.delete(name);
      this.#info.effects.effectsList = this.#info.effects.effectsList.filter(
        (e) => e !== name,
      );
      this.#send(res, 204);
      return;
    }

    this.#send(res, 204);
  }

  #openEventStream(res: http.ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('\n');
    this.#sseClients.add(res);
    // Real controllers dribble keepalive traffic down an idle stream, which is
    // why the client watchdog treats total silence as a wedged socket. Without
    // this the simulator looks healthy but still trips that watchdog every 60s,
    // so a quiet device appears to flap between connected and reconnecting.
    const keepalive = this.#keepaliveMs > 0
      ? setInterval(() => {
          if (!res.writableEnded) res.write(': keepalive\n\n');
        }, this.#keepaliveMs)
      : undefined;
    keepalive?.unref?.();

    res.on('close', () => {
      if (keepalive) clearInterval(keepalive);
      this.#sseClients.delete(res);
    });
  }

  #send(res: http.ServerResponse, status: number, body?: unknown): void {
    if (body === undefined) {
      res.writeHead(status);
      res.end();
      return;
    }
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(text),
    });
    res.end(text);
  }
}

export async function startSimulator(
  opts: SimulatorOptions,
): Promise<NanoleafSimulator> {
  return new NanoleafSimulator(opts).start();
}
