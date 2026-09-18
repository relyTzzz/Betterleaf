import { EventEmitter } from 'node:events';
import { EventStream, EventType, type TouchEvent } from '../events/sse.js';
import { NanoleafClient, DEFAULT_API_PORT } from '../http/client.js';
import { WriteQueue } from '../http/write-queue.js';
import {
  deriveCapabilities,
  type DeviceCapabilities,
} from '../model/capabilities.js';
import { NanoleafAuthError, NanoleafHttpError } from '../model/errors.js';
import {
  flattenState,
  type ConnectionStatus,
  type DeviceInfo,
  type DeviceRecord,
  type PanelColor,
  type PanelLayout,
  type RhythmInfo,
  type StatePatch,
  type StateSnapshot,
  type StreamVersion,
} from '../model/types.js';
import { StreamController } from '../stream/extcontrol.js';
import {
  buildDeleteEffect,
  buildEffectWrite,
  buildRequestAllEffects,
  buildRequestEffect,
  buildRequestPlugins,
  buildSelectEffect,
  buildStaticEffectWrite,
  effectCompatibility,
  isNanoleafEffect,
  type NanoleafEffect,
} from './effects.js';

/** After this many failed reconnects we stop claiming to be merely reconnecting. */
const UNREACHABLE_AFTER_ATTEMPTS = 3;

type DeviceEvents = {
  state: [StateSnapshot];
  status: [ConnectionStatus];
  effect: [string];
  layout: [PanelLayout];
  touch: [TouchEvent];
  /** The device answered at a new address; persist it. */
  address: [{ ip: string; port: number }];
  /**
   * Something worth persisting changed (address, negotiated stream version).
   * Consumers should write `toRecord()` to their store on this.
   */
  record: [DeviceRecord];
  error: [Error];
};

export interface DeviceOptions {
  record: DeviceRecord;
  info: DeviceInfo;
  /** Coalescing window for writes. */
  flushMs?: number;
}

/**
 * One paired Nanoleaf controller.
 *
 * Holds the live view of a device and is the only thing the app above talks to.
 * Three behaviours here are what make control feel immediate:
 *
 *  - **Optimistic writes.** A change is applied to the local snapshot and
 *    emitted before the request is even sent, so the UI never waits on a round
 *    trip. The event stream supplies the truth a moment later and corrects it if
 *    the device disagreed.
 *  - **Coalesced writes.** Bursts collapse per property (see WriteQueue), and
 *    state properties merge into a single PUT — dragging brightness and hue at
 *    once is one request, not two streams of them.
 *  - **Event-driven truth.** Nothing polls. Changes made from the wall switch,
 *    HomeKit or the official app show up here just as fast as our own.
 */
export class NanoleafDevice extends EventEmitter<DeviceEvents> {
  readonly serialNo: string;
  readonly model: string;
  readonly capabilities: DeviceCapabilities;

  readonly #client: NanoleafClient;
  readonly #queue: WriteQueue;

  #name: string;
  #state: StateSnapshot;
  #layout: PanelLayout;
  #effects: string[];
  #currentEffect: string;
  // Starts pending, not connected. We have a snapshot from the probe, but the
  // event stream is what makes the status meaningful — claiming 'connected'
  // before it is open is exactly the kind of lie this app exists to avoid.
  #status: ConnectionStatus = 'reconnecting';
  #streamVersion: StreamVersion | undefined;
  #rhythm: RhythmInfo | undefined;

  #events: EventStream | undefined;
  #stream: StreamController | undefined;
  /** Merged state body for the next flush; mutated in place so writes combine. */
  #pendingState: Record<string, unknown> = {};
  #closed = false;

  constructor(opts: DeviceOptions) {
    super();
    const { record, info } = opts;

    this.serialNo = info.serialNo;
    this.model = info.model;
    this.capabilities = deriveCapabilities(info);
    this.#name = info.name;
    this.#state = flattenState(info.state);
    this.#layout = info.panelLayout.layout;
    this.#effects = info.effects.effectsList ?? [];
    this.#currentEffect = info.effects.select;
    this.#streamVersion = record.streamVersion;
    this.#rhythm = info.rhythm;

    this.#client = new NanoleafClient({
      host: record.lastIp,
      port: record.lastPort,
      token: record.token,
    });

    this.#queue = new WriteQueue({
      flushMs: opts.flushMs ?? 60,
      onError: (err) => this.#onWriteError(err),
    });
  }

  // --- read-only view -------------------------------------------------------

  get name(): string {
    return this.#name;
  }
  get host(): string {
    return this.#client.host;
  }
  get port(): number {
    return this.#client.port;
  }
  get state(): StateSnapshot {
    return { ...this.#state };
  }
  get layout(): PanelLayout {
    return this.#layout;
  }
  get effects(): readonly string[] {
    return this.#effects;
  }
  get currentEffect(): string {
    return this.#currentEffect;
  }
  get status(): ConnectionStatus {
    return this.#status;
  }
  /**
   * What the device says about its Rhythm module, if anything.
   *
   * Distinct from `capabilities.rhythm`, which only says the model *can*
   * take one. Whether a module is actually plugged in is a different question
   * and only the device can answer it.
   */
  get rhythm(): RhythmInfo | undefined {
    return this.#rhythm;
  }
  get streamVersion(): StreamVersion | undefined {
    return this.#streamVersion;
  }

  /** What should be persisted for this device. */
  toRecord(): DeviceRecord {
    const record: DeviceRecord = {
      serialNo: this.serialNo,
      model: this.model,
      name: this.#name,
      token: this.#client.token ?? '',
      lastIp: this.#client.host,
      lastPort: this.#client.port,
      lastSeenAt: Date.now(),
    };
    if (this.#streamVersion) record.streamVersion = this.#streamVersion;
    return record;
  }

  // --- lifecycle ------------------------------------------------------------

  /** Open the event stream. Until this is called the device state is a snapshot. */
  connect(): void {
    if (this.#events || this.#closed) return;

    const types: number[] = [EventType.State, EventType.Layout, EventType.Effects];
    if (this.capabilities.touch) types.push(EventType.Touch);

    const events = new EventStream({
      host: this.#client.host,
      port: this.#client.port,
      token: this.#client.token ?? '',
      types,
    });

    events.on('open', () => this.#setStatus('connected'));
    events.on('state', (patch) => this.#applyPatch(patch));
    events.on('effect', (name) => {
      this.#currentEffect = name;
      this.emit('effect', name);
    });
    events.on('layout', () => void this.refreshLayout());
    events.on('touch', (touch) => this.emit('touch', touch));
    events.on('reconnecting', (attempt) => {
      this.#setStatus(
        attempt >= UNREACHABLE_AFTER_ATTEMPTS ? 'unreachable' : 'reconnecting',
      );
    });
    events.on('error', (err) => this.emit('error', err));

    this.#events = events;
    events.start();
  }

  /**
   * Follow the device to a new address.
   *
   * Called when discovery finds this serial number somewhere else. Everything
   * above keeps its object identity, so the UI does not flicker and no
   * re-pairing is needed — the whole point of keying on serial rather than IP.
   */
  rebind(ip: string, port = DEFAULT_API_PORT): void {
    if (ip === this.#client.host && port === this.#client.port) return;
    this.#client.setAddress(ip, port);
    this.#events?.rebind(ip, port);
    this.emit('address', { ip, port });
    this.emit('record', this.toRecord());
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#queue.close();
    this.#events?.close();
    this.#events = undefined;
    await this.#stream?.stop().catch(() => {});
    this.#stream = undefined;
  }

  // --- state ----------------------------------------------------------------

  /** Re-read everything from the device. Used on reconnect, not on a timer. */
  async refresh(): Promise<void> {
    const info = await this.#client.get<DeviceInfo>('/');
    this.#name = info.name;
    this.#layout = info.panelLayout.layout;
    this.#effects = info.effects.effectsList ?? [];
    this.#currentEffect = info.effects.select;
    this.#state = flattenState(info.state);
    this.emit('state', this.state);
    this.emit('layout', this.#layout);
    // Deliberately does not set 'connected'. Status means "events are flowing",
    // and a successful one-off GET does not prove that. The event stream owns
    // the status; refresh only corrects the data.
  }

  async refreshLayout(): Promise<void> {
    try {
      const res = await this.#client.get<{ layout: PanelLayout }>(
        '/panelLayout/layout',
      );
      // Firmware differs on whether this is wrapped in `layout`.
      const layout = (res as unknown as PanelLayout).positionData
        ? (res as unknown as PanelLayout)
        : res.layout;
      if (layout?.positionData) {
        this.#layout = layout;
        this.emit('layout', layout);
      }
    } catch (err) {
      this.emit('error', err as Error);
    }
  }

  setPower(on: boolean): Promise<void> {
    return this.#writeState({ on }, { on: { value: on } });
  }

  setBrightness(value: number, durationSec?: number): Promise<void> {
    const clamped = clamp(value, 0, 100);
    const body: Record<string, unknown> = { value: clamped };
    if (durationSec !== undefined) body['duration'] = durationSec;
    return this.#writeState({ brightness: clamped }, { brightness: body });
  }

  setHue(value: number): Promise<void> {
    const clamped = clamp(value, 0, 360);
    return this.#writeState(
      { hue: clamped, colorMode: 'hs' },
      { hue: { value: clamped } },
    );
  }

  setSaturation(value: number): Promise<void> {
    const clamped = clamp(value, 0, 100);
    return this.#writeState(
      { sat: clamped, colorMode: 'hs' },
      { sat: { value: clamped } },
    );
  }

  /** Hue 0–360, saturation 0–100 — mismatched ranges are a classic colour bug. */
  setHueSat(hue: number, sat: number): Promise<void> {
    const h = clamp(hue, 0, 360);
    const s = clamp(sat, 0, 100);
    return this.#writeState(
      { hue: h, sat: s, colorMode: 'hs' },
      { hue: { value: h }, sat: { value: s } },
    );
  }

  setColorTemp(kelvin: number): Promise<void> {
    const clamped = clamp(kelvin, 1200, 6500);
    return this.#writeState(
      { ct: clamped, colorMode: 'ct' },
      { ct: { value: clamped } },
    );
  }

  /** Flash the panels, so the user can tell which physical device this is. */
  async identify(): Promise<void> {
    await this.#client.put('/identify', {});
  }

  /**
   * Apply locally, then send.
   *
   * The optimistic half is why a tap feels instant; the queue is why a drag
   * doesn't drown the device. Body fragments merge into `#pendingState`, so
   * several properties changed in one gesture leave as one PUT.
   */
  #writeState(patch: StatePatch, body: Record<string, unknown>): Promise<void> {
    this.#applyPatch(patch);
    Object.assign(this.#pendingState, body);

    return this.#queue.enqueue('state', async () => {
      const payload = this.#pendingState;
      this.#pendingState = {};
      if (Object.keys(payload).length === 0) return;
      await this.#client.put('/state', payload);
    });
  }

  #applyPatch(patch: StatePatch): void {
    let changed = false;
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (this.#state[key as keyof StateSnapshot] !== value) {
        (this.#state as unknown as Record<string, unknown>)[key] = value;
        changed = true;
      }
    }
    if (changed) this.emit('state', this.state);
  }

  // --- effects --------------------------------------------------------------

  async selectEffect(name: string): Promise<void> {
    const previous = this.#currentEffect;
    this.#currentEffect = name;
    this.emit('effect', name);
    try {
      await this.#queue.enqueue('effect', async () => {
        await this.#client.put('/effects', buildSelectEffect(name));
      });
    } catch (err) {
      this.#currentEffect = previous;
      this.emit('effect', previous);
      throw err;
    }
  }

  /**
   * Write a per-panel scene onto the device so it persists.
   *
   * Same colour model as {@link sendFrame}: paint live over UDP, then commit the
   * result here and it survives Betterleaf quitting and a power cycle.
   */
  async saveStaticEffect(
    name: string,
    panels: readonly PanelColor[],
  ): Promise<void> {
    await this.#client.put('/effects', buildStaticEffectWrite({ name, panels }));
    if (!this.#effects.includes(name)) this.#effects = [...this.#effects, name];
  }

  async deleteEffect(name: string): Promise<void> {
    await this.#client.put('/effects', buildDeleteEffect(name));
    this.#effects = this.#effects.filter((e) => e !== name);
  }

  /**
   * Just the names of the effects on this device, and which is selected.
   *
   * Deliberately separate from `exportEffects`: checking whether anything has
   * changed should not cost pulling every effect document down. There is no
   * event for "an effect was added", so noticing a scene downloaded from the
   * Nanoleaf app means asking, and this keeps that as cheap as possible.
   */
  async fetchEffectList(): Promise<{ select: string; effectsList: string[] }> {
    const res = await this.#client.get<{ select: string; effectsList: string[] }>(
      '/effects',
    );
    const effectsList = Array.isArray(res?.effectsList) ? res.effectsList : [];
    this.#effects = effectsList;
    if (typeof res?.select === 'string') this.#currentEffect = res.select;
    return { select: res?.select ?? this.#currentEffect, effectsList };
  }

  /**
   * Every effect stored on this device, in the device's own format.
   *
   * The same shape `importEffect` accepts, so this is both a backup and the way
   * an effect moves from one device to another.
   */
  async exportEffects(): Promise<NanoleafEffect[]> {
    const res = await this.#client.put<unknown>('/effects', buildRequestAllEffects());
    return extractEffects(res);
  }

  /** One effect by name, or undefined if the device does not have it. */
  async exportEffect(name: string): Promise<NanoleafEffect | undefined> {
    let res: unknown;
    try {
      res = await this.#client.put<unknown>('/effects', buildRequestEffect(name));
    } catch (err) {
      // Asking for an effect that is not there is an answer, not a failure, and
      // firmware differs on how it says so. An auth error is a different kind
      // of thing and still propagates: NanoleafAuthError is not an HttpError.
      if (err instanceof NanoleafHttpError) return undefined;
      throw err;
    }
    if (isNanoleafEffect(res)) return res;
    return extractEffects(res).find((e) => e.animName === name);
  }

  /**
   * The motion plugin uuids this device actually has.
   *
   * Returns an empty list if the device does not answer the question — older
   * firmware may not — which callers treat as "unknown", not "none".
   */
  async listPlugins(): Promise<string[]> {
    try {
      const res = await this.#client.put<unknown>('/effects', buildRequestPlugins());
      return extractPluginUuids(res);
    } catch {
      return [];
    }
  }

  /**
   * Write an effect onto this device.
   *
   * Checks the device's plugin list first. Writing an effect whose motion the
   * device lacks otherwise fails as a bare HTTP 400, which says nothing about
   * which motion was missing or that the model is the problem.
   */
  async importEffect(effect: NanoleafEffect): Promise<void> {
    if (!isNanoleafEffect(effect)) {
      throw new Error('That does not look like a Nanoleaf effect.');
    }

    const incompatible = effectCompatibility(effect, await this.listPlugins());
    if (incompatible) throw new Error(incompatible);

    await this.#client.put('/effects', buildEffectWrite(effect));
    if (!this.#effects.includes(effect.animName)) {
      this.#effects = [...this.#effects, effect.animName];
    }
  }

  // --- streaming ------------------------------------------------------------

  /** Enter external-control mode, remembering which protocol version worked. */
  async startStream(): Promise<void> {
    if (this.#stream?.active) return;

    const controller = new StreamController({
      client: this.#client,
      preferredVersion:
        this.#streamVersion ?? this.capabilities.preferredStreamVersion,
    });
    controller.on('error', (err) => this.emit('error', err));

    const session = await controller.start();
    // Persist the version that actually worked so the next start is one request
    // and never re-probes.
    const learned = this.#streamVersion !== session.version;
    this.#streamVersion = session.version;
    this.#stream = controller;
    if (learned) this.emit('record', this.toRecord());
  }

  sendFrame(panels: readonly PanelColor[]): void {
    if (!this.#stream?.active) {
      throw new Error('Stream not started; call startStream() first');
    }
    this.#stream.send(panels);
  }

  async stopStream(restoreEffect?: string): Promise<void> {
    await this.#stream?.stop(restoreEffect);
    this.#stream = undefined;
  }

  // --- internals ------------------------------------------------------------

  #setStatus(status: ConnectionStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    this.emit('status', status);
  }

  #onWriteError(err: unknown): void {
    if (err instanceof NanoleafAuthError) {
      this.#setStatus('needs-pairing');
      this.emit('error', err);
      return;
    }
    this.emit('error', err as Error);
    // The optimistic snapshot may now be a lie. Ask the device what is true.
    void this.refresh().catch(() => this.#setStatus('unreachable'));
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

/**
 * Pull effects out of a `requestAll` / `request` response.
 *
 * Firmware versions disagree on the wrapper — some return `{animations: [...]}`,
 * some a bare array, some a single object — so accept all three rather than
 * guessing which one this unit speaks.
 */
function extractEffects(res: unknown): NanoleafEffect[] {
  if (Array.isArray(res)) return res.filter(isNanoleafEffect);
  if (typeof res === 'object' && res !== null) {
    const wrapper = res as Record<string, unknown>;
    for (const key of ['animations', 'effects']) {
      const value = wrapper[key];
      if (Array.isArray(value)) return value.filter(isNanoleafEffect);
    }
    if (isNanoleafEffect(res)) return [res];
  }
  return [];
}

/** Plugin uuids from a `requestPlugins` response, tolerating the same variation. */
function extractPluginUuids(res: unknown): string[] {
  const list = Array.isArray(res)
    ? res
    : typeof res === 'object' && res !== null
      ? ((res as Record<string, unknown>)['plugins'] ?? [])
      : [];
  if (!Array.isArray(list)) return [];

  return list.flatMap((entry) => {
    if (typeof entry === 'string') return [entry];
    if (typeof entry === 'object' && entry !== null) {
      const uuid = (entry as Record<string, unknown>)['uuid'];
      if (typeof uuid === 'string') return [uuid];
    }
    return [];
  });
}
