import { EventEmitter } from 'node:events';
import {
  NanoleafDevice,
  pairDevice,
  probeDevice,
  runDiscoveryLadder,
  panelShapeKind,
  toRenderLayout,
  type DeviceRecord,
  type ProbeResult,
} from '@betterleaf/protocol';
import type {
  AppSnapshot,
  DeviceView,
  DiscoveryState,
  PairProgress,
  PairResult,
  UnpairedDeviceView,
} from '../shared/types.js';
import { DeviceStore } from './store.js';

type RegistryEvents = {
  snapshot: [AppSnapshot];
  pairProgress: [PairProgress];
};

/**
 * Owns every device for the lifetime of the app.
 *
 * Devices live here, in the main process, keyed by serial number. The renderer
 * only ever sees serialisable snapshots, so a window reload cannot drop a
 * connection and there is exactly one event stream per device no matter how
 * many views are open.
 */
export class DeviceRegistry extends EventEmitter<RegistryEvents> {
  readonly #store: DeviceStore;
  readonly #devices = new Map<string, NanoleafDevice>();

  #unpaired: UnpairedDeviceView[] = [];
  #discovery: DiscoveryState = { scanning: false };
  #pairAbort: AbortController | undefined;

  constructor(store = new DeviceStore()) {
    super();
    this.#store = store;
  }

  /**
   * Bring up everything we knew about last time, then look for the rest.
   *
   * Cached devices are adopted as soon as their address answers, so the window
   * is usable long before discovery finishes.
   */
  async start(): Promise<void> {
    const known = await this.#store.load();
    await this.scan(known);
  }

  async scan(known?: DeviceRecord[]): Promise<void> {
    if (this.#discovery.scanning) return;

    const records = known ?? (await this.#store.load());
    this.#unpaired = [];
    this.#discovery = { scanning: true };
    this.#publish();

    try {
      await runDiscoveryLadder({
        known: records,
        onRung: (rung) => {
          this.#discovery = { ...this.#discovery, rung };
          this.#publish();
        },
        onFound: (result) => void this.#adopt(result),
      });
    } finally {
      this.#discovery = { scanning: false, lastScanAt: Date.now() };
      this.#publish();
    }
  }

  /** Take a discovery result and turn it into a live device, or an offer to pair. */
  async #adopt(result: ProbeResult): Promise<void> {
    if (!result.info || !result.serialNo) {
      if (result.needsPairing) {
        // Belt and braces: a device we already control must never show up as
        // something to pair with, whatever the discovery layer reports.
        const live = [...this.#devices.values()].some(
          (d) => d.host === result.ip && d.port === result.port,
        );
        if (live) return;

        const entry: UnpairedDeviceView = {
          ip: result.ip,
          port: result.port,
          source: result.source,
        };
        if (result.model) entry.model = result.model;
        if (result.name) entry.name = result.name;
        this.#unpaired = [
          ...this.#unpaired.filter((u) => !(u.ip === entry.ip && u.port === entry.port)),
          entry,
        ];
        this.#publish();
      }
      return;
    }

    const existing = this.#devices.get(result.serialNo);
    if (existing) {
      // Already live. If it turned up somewhere new, follow it — same object,
      // same identity, no re-pairing and no flicker in the UI.
      existing.rebind(result.ip, result.port);
      this.#publish();
      return;
    }

    const stored = (await this.#store.load()).find(
      (r) => r.serialNo === result.serialNo,
    );
    if (!stored) return; // known to the network but not to us; needs pairing

    const record: DeviceRecord = {
      ...stored,
      lastIp: result.ip,
      lastPort: result.port,
      lastSeenAt: Date.now(),
    };

    const device = new NanoleafDevice({ record, info: result.info });
    this.#wire(device);
    this.#devices.set(result.serialNo, device);
    device.connect();

    await this.#store.upsert(record);
    this.#publish();
  }

  #wire(device: NanoleafDevice): void {
    // Any of these changes what the user sees, so all of them republish.
    device.on('state', () => this.#publish());
    device.on('status', () => this.#publish());
    device.on('effect', () => this.#publish());
    device.on('layout', () => this.#publish());
    device.on('record', (record) => void this.#store.upsert(record));
    device.on('error', () => {
      // Already reflected in `status`; swallow so an unhandled 'error' on an
      // EventEmitter cannot take the main process down.
    });
  }

  // --- control ---------------------------------------------------------------

  #device(serialNo: string): NanoleafDevice {
    const device = this.#devices.get(serialNo);
    if (!device) throw new Error(`No connected device with serial ${serialNo}`);
    return device;
  }

  setPower(serialNo: string, on: boolean): Promise<void> {
    return this.#device(serialNo).setPower(on);
  }
  setBrightness(serialNo: string, value: number): Promise<void> {
    return this.#device(serialNo).setBrightness(value);
  }
  setHueSat(serialNo: string, hue: number, sat: number): Promise<void> {
    return this.#device(serialNo).setHueSat(hue, sat);
  }
  setColorTemp(serialNo: string, kelvin: number): Promise<void> {
    return this.#device(serialNo).setColorTemp(kelvin);
  }
  selectEffect(serialNo: string, name: string): Promise<void> {
    return this.#device(serialNo).selectEffect(name);
  }
  identify(serialNo: string): Promise<void> {
    return this.#device(serialNo).identify();
  }

  async forget(serialNo: string): Promise<void> {
    const device = this.#devices.get(serialNo);
    if (device) {
      await device.close();
      this.#devices.delete(serialNo);
    }
    await this.#store.remove(serialNo);
    this.#publish();
  }

  // --- pairing ---------------------------------------------------------------

  /**
   * Pair with a device at a known address.
   *
   * Polls for the whole window so the user can start this and then walk over and
   * hold the button, rather than having to get the ordering right.
   */
  async pair(ip: string, port = 16021): Promise<PairResult> {
    this.#pairAbort?.abort();
    const controller = new AbortController();
    this.#pairAbort = controller;

    try {
      const token = await pairDevice({
        host: ip,
        port,
        signal: controller.signal,
        onTick: (msRemaining) =>
          this.emit('pairProgress', { ip, port, msRemaining }),
      });

      const probe = await probeDevice(ip, { port, token, timeoutMs: 3_000 });
      if (!probe?.info) {
        return { ok: false, error: 'Paired, but the device did not return its details.' };
      }

      const record: DeviceRecord = {
        serialNo: probe.info.serialNo,
        model: probe.info.model,
        name: probe.info.name,
        token,
        lastIp: ip,
        lastPort: port,
        lastSeenAt: Date.now(),
      };
      await this.#store.upsert(record);

      this.#unpaired = this.#unpaired.filter((u) => !(u.ip === ip && u.port === port));
      await this.#adopt(probe);

      return { ok: true, serialNo: record.serialNo, name: record.name };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    } finally {
      if (this.#pairAbort === controller) this.#pairAbort = undefined;
    }
  }

  cancelPair(): void {
    this.#pairAbort?.abort();
    this.#pairAbort = undefined;
  }

  // --- snapshot --------------------------------------------------------------

  snapshot(): AppSnapshot {
    return {
      devices: [...this.#devices.values()].map(toView),
      unpaired: this.#unpaired,
      discovery: this.#discovery,
    };
  }

  #publish(): void {
    this.emit('snapshot', this.snapshot());
  }

  async dispose(): Promise<void> {
    this.#pairAbort?.abort();
    await Promise.all([...this.#devices.values()].map((d) => d.close()));
    this.#devices.clear();
  }
}

function toView(device: NanoleafDevice): DeviceView {
  const render = toRenderLayout(device.layout);
  const view: DeviceView = {
    serialNo: device.serialNo,
    name: device.name,
    model: device.model,
    family: device.capabilities.family,
    host: device.host,
    port: device.port,
    status: device.status,
    state: device.state,
    effects: [...device.effects],
    currentEffect: device.currentEffect,
    capabilities: {
      touch: device.capabilities.touch,
      rhythm: device.capabilities.rhythm,
    },
    layout: {
      panels: render.panels.map((panel) => ({
        panelId: panel.panelId,
        screenX: panel.screenX,
        screenY: panel.screenY,
        sideLength: panel.sideLength,
        o: panel.o,
        shape: panelShapeKind(panel.shapeType),
      })),
      bounds: { width: render.bounds.width, height: render.bounds.height },
      sideLength: render.sideLength,
    },
  };
  if (device.streamVersion) view.streamVersion = device.streamVersion;
  return view;
}
