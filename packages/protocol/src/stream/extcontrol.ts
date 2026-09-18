import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import type { NanoleafClient } from '../http/client.js';
import { defaultPortForVersion } from '../model/capabilities.js';
import { NanoleafError } from '../model/errors.js';
import type {
  PanelColor,
  StreamControlInfo,
  StreamVersion,
} from '../model/types.js';
import { encodeFrameV1 } from './frame-v1.js';
import { encodeFrameV2 } from './frame-v2.js';

export interface StreamSession {
  version: StreamVersion;
  host: string;
  port: number;
}

export interface StreamControllerOptions {
  client: NanoleafClient;
  /**
   * Version to attempt first. A wrong guess is cheap — we fall back — but a
   * remembered value makes every later start a single round trip.
   */
  preferredVersion?: StreamVersion;
  /** Hard ceiling on datagram rate. The devices drop frames above ~10Hz. */
  maxFps?: number;
  /**
   * Resend the last frame this often when idle. Without it the controller times
   * out of external-control mode and reverts to its previous effect.
   */
  keepaliveMs?: number;
}

export function encodeFrame(
  version: StreamVersion,
  panels: readonly PanelColor[],
): Buffer {
  return version === 'v1' ? encodeFrameV1(panels) : encodeFrameV2(panels);
}

/** Body that puts a device into external-control mode. */
export function extControlRequest(version: StreamVersion): unknown {
  return {
    write: {
      command: 'display',
      animType: 'extControl',
      extControlVersion: version,
    },
  };
}

type StreamEvents = {
  started: [StreamSession];
  stopped: [];
  error: [Error];
};

/**
 * Drives one device's external-control (UDP streaming) session.
 *
 * Streaming is how Betterleaf does anything the device's own animation engine
 * can't: live per-panel painting, and later music and screen sync. The tradeoff
 * is that it only lasts while we keep sending, which is why effects can also be
 * written to the device permanently (see device/effects.ts).
 */
export class StreamController extends EventEmitter<StreamEvents> {
  readonly #client: NanoleafClient;
  readonly #preferred: StreamVersion | undefined;
  readonly #minIntervalMs: number;
  readonly #keepaliveMs: number;

  #socket: dgram.Socket | undefined;
  #session: StreamSession | undefined;
  #lastFrame: Buffer | undefined;
  #pending: readonly PanelColor[] | undefined;
  #lastSentAt = 0;
  #sendTimer: NodeJS.Timeout | undefined;
  #keepaliveTimer: NodeJS.Timeout | undefined;

  constructor(opts: StreamControllerOptions) {
    super();
    this.#client = opts.client;
    this.#preferred = opts.preferredVersion;
    this.#minIntervalMs = 1000 / (opts.maxFps ?? 10);
    this.#keepaliveMs = opts.keepaliveMs ?? 1_000;
  }

  get session(): StreamSession | undefined {
    return this.#session;
  }

  get active(): boolean {
    return this.#session !== undefined;
  }

  /**
   * Enable external control, probing the protocol version if we don't already
   * know it.
   *
   * Model is a poor predictor here — Light Panels on recent firmware accept v2
   * — so we try the preferred version and fall back rather than hardcoding by
   * model. The caller should persist {@link StreamSession.version} so the next
   * start is a single request.
   */
  async start(): Promise<StreamSession> {
    if (this.#session) return this.#session;

    const order: StreamVersion[] =
      this.#preferred === 'v1' ? ['v1', 'v2'] : ['v2', 'v1'];

    const failures: string[] = [];
    for (const version of order) {
      try {
        const session = await this.#enable(version);
        this.#session = session;
        this.#socket = dgram.createSocket('udp4');
        this.#socket.on('error', (err) => this.emit('error', err));
        this.emit('started', session);
        return session;
      } catch (err) {
        failures.push(`${version}: ${(err as Error).message}`);
      }
    }

    throw new NanoleafError(
      `Could not enable external control on ${this.#client.host} (${failures.join('; ')})`,
    );
  }

  async #enable(version: StreamVersion): Promise<StreamSession> {
    const res = await this.#client.put<StreamControlInfo>(
      '/effects',
      extControlRequest(version),
      { noRetry: true },
    );

    // Light Panels answer with the address to stream to; Canvas returns an
    // empty body and expects the well-known port for the version.
    const port = res?.streamControlPort ?? defaultPortForVersion(version);

    // Some firmware reports 0.0.0.0 here, which is not a destination. The
    // device's own API address is always right.
    const advertised = res?.streamControlIpAddr;
    const host =
      advertised && advertised !== '0.0.0.0' ? advertised : this.#client.host;

    return { version, host, port };
  }

  /**
   * Queue a frame.
   *
   * Frames are rate-limited rather than dropped: calling faster than `maxFps`
   * replaces the pending frame, so the panels always converge on the newest
   * state instead of playing back a backlog.
   */
  send(panels: readonly PanelColor[]): void {
    if (!this.#session) throw new NanoleafError('Stream is not started');

    this.#pending = panels;

    const elapsed = Date.now() - this.#lastSentAt;
    if (elapsed >= this.#minIntervalMs) {
      this.#flush();
      return;
    }
    if (!this.#sendTimer) {
      this.#sendTimer = setTimeout(() => {
        this.#sendTimer = undefined;
        this.#flush();
      }, this.#minIntervalMs - elapsed);
    }
  }

  #flush(): void {
    const session = this.#session;
    const panels = this.#pending;
    if (!session || !panels || !this.#socket) return;

    this.#pending = undefined;

    let frame: Buffer;
    try {
      frame = encodeFrame(session.version, panels);
    } catch (err) {
      this.emit('error', err as Error);
      return;
    }

    this.#lastFrame = frame;
    this.#lastSentAt = Date.now();
    this.#socket.send(frame, session.port, session.host, (err) => {
      if (err) this.emit('error', err);
    });

    this.#armKeepalive();
  }

  #armKeepalive(): void {
    if (this.#keepaliveTimer) clearTimeout(this.#keepaliveTimer);
    if (this.#keepaliveMs <= 0) return;

    this.#keepaliveTimer = setTimeout(() => {
      const session = this.#session;
      if (!session || !this.#lastFrame || !this.#socket) return;
      this.#lastSentAt = Date.now();
      this.#socket.send(this.#lastFrame, session.port, session.host, (err) => {
        if (err) this.emit('error', err);
      });
      this.#armKeepalive();
    }, this.#keepaliveMs);
    this.#keepaliveTimer.unref?.();
  }

  /**
   * End the session. Pass an effect name to restore it — otherwise the panels
   * hold the last streamed frame until something else claims them.
   */
  async stop(restoreEffect?: string): Promise<void> {
    if (this.#sendTimer) clearTimeout(this.#sendTimer);
    if (this.#keepaliveTimer) clearTimeout(this.#keepaliveTimer);
    this.#sendTimer = undefined;
    this.#keepaliveTimer = undefined;
    this.#pending = undefined;
    this.#lastFrame = undefined;

    this.#socket?.close();
    this.#socket = undefined;
    this.#session = undefined;

    if (restoreEffect) {
      await this.#client.put('/effects', { select: restoreEffect });
    }
    this.emit('stopped');
  }
}
