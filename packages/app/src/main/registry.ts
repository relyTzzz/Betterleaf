import { EventEmitter } from 'node:events';
import {
  NanoleafDevice,
  pairDevice,
  probeDevice,
  runDiscoveryLadder,
  BUILTIN_MOTIONS,
  motionByUuid,
  panelShapeKind,
  toRenderLayout,
  type ConnectionStatus,
  type DeviceRecord,
  type LadderOptions,
  type ProbeResult,
} from '@betterleaf/protocol';
import type {
  AppSnapshot,
  DeviceView,
  DiscoveryState,
  PairProgress,
  LibraryEntryView,
  MotionView,
  PairResult,
  Room,
  RoomView,
  UnpairedDeviceView,
} from '../shared/types.js';
import {
  copyEffectsBetween,
  exportEffectsToFile,
  importEffectsFromFile,
  type ExportOutcome,
  type ImportOutcome,
} from './effects/file-source.js';
import { EffectHarvester } from './effects/harvester.js';
import { EffectLibrary, effectHash } from './effects/library.js';
import { RoomStore } from './room-store.js';
import { DeviceStore } from './store.js';

/**
 * Worst-first ranking, so a room's status is the one that most needs attention.
 * A room must never look healthier than the devices in it.
 */
const STATUS_SEVERITY: Record<ConnectionStatus, number> = {
  connected: 0,
  reconnecting: 1,
  unreachable: 2,
  'needs-pairing': 3,
};

/** Unknown statuses sort as worst, so a room never flatters an unfamiliar state. */
function severity(status: ConnectionStatus): number {
  return STATUS_SEVERITY[status] ?? Number.MAX_SAFE_INTEGER;
}

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
  readonly #rooms: RoomStore;
  readonly #library: EffectLibrary;
  readonly #harvester: EffectHarvester;
  readonly #devices = new Map<string, NanoleafDevice>();

  #unpaired: UnpairedDeviceView[] = [];
  #discovery: DiscoveryState = { scanning: false };
  #pairAbort: AbortController | undefined;
  /**
   * In-memory mirror of the room store, so `snapshot()` stays synchronous.
   * Every mutation refreshes it from the store rather than editing it directly,
   * so disk and memory cannot drift apart.
   */
  #roomList: Room[] = [];

  /**
   * Which discovery rungs to use. Exists so a user on a network where a subnet
   * sweep is unwelcome can turn it off, and so tests can avoid depending on
   * whatever happens to be advertising on the real network.
   */
  readonly #discoveryOptions: Pick<
    LadderOptions,
    'enableMdns' | 'enableSsdp' | 'enableSweep' | 'timings'
  >;

  constructor(
    store = new DeviceStore(),
    rooms = new RoomStore(),
    discoveryOptions: Pick<
      LadderOptions,
      'enableMdns' | 'enableSsdp' | 'enableSweep' | 'timings'
    > = {},
    library = new EffectLibrary(),
    harvester?: EffectHarvester,
  ) {
    super();
    this.#store = store;
    this.#rooms = rooms;
    this.#discoveryOptions = discoveryOptions;
    this.#library = library;
    this.#harvester = harvester ?? new EffectHarvester(library);

    // A harvest means the archive grew. The count is part of every snapshot, so
    // it has to be recomputed here — waiting until someone opens the library
    // view leaves the sidebar showing a stale number.
    this.#harvester.on('harvested', () => void this.#refreshLibraryCount());
    this.#harvester.on('error', () => {
      // Already visible as connection status; a failed harvest is not separately
      // actionable and must not produce noise.
    });
  }

  #libraryCount = 0;
  #soundReactiveNames: string[] = [];

  /**
   * Bring up everything we knew about last time, then look for the rest.
   *
   * Cached devices are adopted as soon as their address answers, so the window
   * is usable long before discovery finishes.
   */
  async start(): Promise<void> {
    const known = await this.#store.load();
    this.#roomList = await this.#rooms.load();
    await this.#refreshLibrarySummaryQuietly();
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
        ...this.#discoveryOptions,
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

    // Everything the user has ever downloaded from Discover is sitting on the
    // device. Read it off and keep a copy.
    this.#harvester.watch(device);

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
      this.#harvester.unwatch(serialNo);
      await device.close();
      this.#devices.delete(serialNo);
    }
    await this.#store.remove(serialNo);
    // A forgotten device must not linger as a phantom member of a room.
    await this.#rooms.pruneDevice(serialNo);
    this.#roomList = await this.#rooms.load();
    this.#publish();
  }

  // --- library ---------------------------------------------------------------

  /**
   * The archive, annotated with which devices currently hold each effect.
   *
   * Presence is computed here rather than stored: the devices are the authority
   * on their own contents, and a cached answer goes stale as soon as someone
   * uses the Nanoleaf app.
   */
  async listLibrary(): Promise<LibraryEntryView[]> {
    const entries = await this.#library.entries();
    this.#libraryCount = entries.length;

    // Hash every device's effects once, rather than per entry.
    const onDevices = new Map<string, string[]>();
    for (const [serial, device] of this.#devices) {
      for (const name of device.effects) {
        onDevices.set(name, [...(onDevices.get(name) ?? []), serial]);
      }
    }

    return entries.map((entry) => {
      const view: LibraryEntryView = {
        name: entry.name,
        soundReactive: entry.effect.pluginType === 'rhythm',
        paletteColors: (entry.effect.palette ?? []).map((c) => ({
          hue: c.hue,
          saturation: c.saturation,
          brightness: c.brightness,
        })),
        favourite: entry.favourite === true,
        firstSeenAt: entry.firstSeenAt,
        onDevices: onDevices.get(entry.name) ?? [],
        seenOn: entry.seenOn,
      };
      if (entry.effect.pluginUuid) {
        view.motionUuid = entry.effect.pluginUuid;
        const motion = motionByUuid(entry.effect.pluginUuid);
        if (motion) view.motion = motion.label;
      }
      return view;
    });
  }

  async refreshLibrary(): Promise<void> {
    await this.#harvester.harvestAll();
    await this.#refreshLibraryCount();
  }

  /**
   * Derive the archive facts every snapshot carries, without publishing.
   *
   * Separate from the publishing version so startup can populate them before
   * the first snapshot goes out, rather than emitting one that is briefly wrong.
   */
  async #refreshLibrarySummaryQuietly(): Promise<void> {
    const entries = await this.#library.entries();
    this.#libraryCount = entries.length;
    this.#soundReactiveNames = entries
      .filter((e) => e.effect.pluginType === 'rhythm')
      .map((e) => e.name);
  }

  /** Recompute what every snapshot carries about the archive, and republish. */
  async #refreshLibraryCount(): Promise<void> {
    await this.#refreshLibrarySummaryQuietly();
    this.#publish();
  }

  /** Write an archived effect to a device and switch to it. */
  async applyLibraryEffect(name: string, serialNo: string): Promise<ImportOutcome> {
    const outcome = await this.pushLibraryEffect(name, serialNo);
    if (outcome.imported.length > 0) {
      await this.#device(serialNo).selectEffect(name);
    }
    return outcome;
  }

  /** Write an archived effect to a device without switching to it. */
  async pushLibraryEffect(name: string, serialNo: string): Promise<ImportOutcome> {
    const entry = await this.#library.get(name);
    if (!entry) {
      return { imported: [], skipped: [{ name, reason: 'Not in the library.' }] };
    }

    try {
      await this.#device(serialNo).importEffect(entry.effect);
      this.#publish();
      return { imported: [name], skipped: [] };
    } catch (err) {
      return { imported: [], skipped: [{ name, reason: (err as Error).message }] };
    }
  }

  /**
   * Delete an effect from a device to free a slot.
   *
   * Refuses unless the archive holds that exact effect, content and all. An
   * archive that merely has *a* scene by the same name is not good enough: if
   * the device's copy differs, deleting it destroys something we cannot restore.
   */
  async removeFromDevice(
    name: string,
    serialNo: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const device = this.#device(serialNo);

    let onDevice;
    try {
      onDevice = await device.exportEffect(name);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    if (!onDevice) return { ok: false, error: `${device.name} does not have "${name}".` };

    const entry = await this.#library.get(name);
    if (!entry) {
      return { ok: false, error: `"${name}" is not archived yet, so it cannot be removed.` };
    }
    if (entry.contentHash !== effectHash(onDevice)) {
      return {
        ok: false,
        error:
          `The copy on ${device.name} differs from the archived one, so removing it ` +
          'would lose that version. Refresh the library first.',
      };
    }

    await device.deleteEffect(name);
    this.#publish();
    return { ok: true };
  }

  /** Forget an archived effect. Does not touch any device. */
  async forgetLibraryEffect(name: string): Promise<void> {
    await this.#library.remove(name);
    await this.#refreshLibraryCount();
  }

  async setFavourite(name: string, favourite: boolean): Promise<void> {
    await this.#library.setFavourite(name, favourite);
    this.#publish();
  }

  // --- effects ---------------------------------------------------------------

  exportEffects(serialNo: string): Promise<ExportOutcome> {
    return exportEffectsToFile(this.#device(serialNo));
  }

  async importEffects(serialNo: string): Promise<ImportOutcome> {
    const outcome = await importEffectsFromFile(this.#device(serialNo));
    if (outcome.imported.length > 0) this.#publish();
    return outcome;
  }

  async copyEffects(fromSerialNo: string, toSerialNo: string): Promise<ImportOutcome> {
    const outcome = await copyEffectsBetween(
      this.#device(fromSerialNo),
      this.#device(toSerialNo),
    );
    if (outcome.imported.length > 0) this.#publish();
    return outcome;
  }

  /**
   * The built-in motions, marked with whether this device actually has each one.
   *
   * Authoring against a motion the device lacks would produce an effect it
   * cannot render, so the UI needs to know before offering the choice.
   */
  async listMotions(serialNo: string): Promise<MotionView[]> {
    const available = await this.#device(serialNo).listPlugins();
    return BUILTIN_MOTIONS.map((motion) => ({
      id: motion.id,
      label: motion.label,
      uuid: motion.uuid,
      pluginType: motion.pluginType,
      description: motion.description,
      // An empty list means the device did not answer, not that it has nothing.
      available: available.length === 0 || available.includes(motion.uuid),
    }));
  }

  // --- rooms -----------------------------------------------------------------

  async createRoom(name: string): Promise<string> {
    const room = await this.#rooms.create(name);
    await this.#refreshRooms();
    return room.id;
  }

  async renameRoom(roomId: string, name: string): Promise<void> {
    await this.#rooms.rename(roomId, name);
    await this.#refreshRooms();
  }

  async deleteRoom(roomId: string): Promise<void> {
    await this.#rooms.remove(roomId);
    await this.#refreshRooms();
  }

  async reorderRooms(roomIds: string[]): Promise<void> {
    await this.#rooms.reorder(roomIds);
    await this.#refreshRooms();
  }

  async assignDevice(serialNo: string, roomId: string | null): Promise<void> {
    await this.#rooms.assign(serialNo, roomId);
    await this.#refreshRooms();
  }

  async #refreshRooms(): Promise<void> {
    this.#roomList = await this.#rooms.load();
    this.#publish();
  }

  /** Connected members of a room, in the order the room lists them. */
  #membersOf(roomId: string): NanoleafDevice[] {
    const room = this.#roomList.find((r) => r.id === roomId);
    if (!room) return [];
    return room.deviceSerials.flatMap((serial) => {
      const device = this.#devices.get(serial);
      return device ? [device] : [];
    });
  }

  /**
   * Apply an operation to every member of a room.
   *
   * Fans out to each device's own WriteQueue rather than introducing a queue of
   * its own, so per-device coalescing still applies and dragging a room
   * brightness slider is still a handful of requests per device.
   *
   * `allSettled`, not `all`: one unreachable device must not stop the rest of
   * the room from responding.
   */
  async #fanOut(
    roomId: string,
    op: (device: NanoleafDevice) => Promise<void>,
  ): Promise<void> {
    await Promise.allSettled(this.#membersOf(roomId).map(op));
  }

  setRoomPower(roomId: string, on: boolean): Promise<void> {
    return this.#fanOut(roomId, (d) => d.setPower(on));
  }

  setRoomBrightness(roomId: string, value: number): Promise<void> {
    return this.#fanOut(roomId, (d) => d.setBrightness(value));
  }

  setRoomEffect(roomId: string, name: string): Promise<void> {
    // Only shared effects are offered, but guard anyway: a device can gain or
    // lose effects while the UI is open.
    return this.#fanOut(roomId, async (d) => {
      if (d.effects.includes(name)) await d.selectEffect(name);
    });
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
    const roomOf = new Map<string, string>();
    for (const room of this.#roomList) {
      for (const serial of room.deviceSerials) roomOf.set(serial, room.id);
    }

    return {
      devices: [...this.#devices.values()].map((device) =>
        toView(device, roomOf.get(device.serialNo)),
      ),
      libraryCount: this.#libraryCount,
      soundReactiveEffects: this.#soundReactiveNames,
      rooms: this.#roomList.map((room) => this.#toRoomView(room)),
      unpaired: this.#unpaired,
      discovery: this.#discovery,
    };
  }

  #toRoomView(room: Room): RoomView {
    const members = this.#membersOf(room.id);
    const lit = members.filter((d) => d.state.on);

    // Only claim a room-wide effect when every member agrees on it.
    const first = members[0]?.currentEffect;
    const agreed =
      members.length > 0 && members.every((d) => d.currentEffect === first)
        ? first
        : undefined;

    const view: RoomView = {
      id: room.id,
      name: room.name,
      order: room.order,
      deviceSerials: members.map((d) => d.serialNo),
      on: lit.length > 0,
      brightness:
        lit.length > 0
          ? Math.round(
              lit.reduce((sum, d) => sum + d.state.brightness, 0) / lit.length,
            )
          : 0,
      status: members.reduce<ConnectionStatus>(
        (worst, d) => (severity(d.status) > severity(worst) ? d.status : worst),
        'connected',
      ),
      // Intersection: an effect only one member has cannot be applied room-wide,
      // so offering it would give a partial, confusing result.
      effects: members.reduce<string[]>(
        (shared, d, i) =>
          i === 0 ? [...d.effects] : shared.filter((e) => d.effects.includes(e)),
        [],
      ),
    };
    if (agreed !== undefined) view.currentEffect = agreed;
    return view;
  }

  #publish(): void {
    this.emit('snapshot', this.snapshot());
  }

  async dispose(): Promise<void> {
    this.#pairAbort?.abort();
    this.#harvester.stop();
    await Promise.all([...this.#devices.values()].map((d) => d.close()));
    this.#devices.clear();
  }
}

function toView(device: NanoleafDevice, roomId?: string): DeviceView {
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
      soundReactive: device.capabilities.soundReactive,
      rhythmModule: device.capabilities.rhythmModule,
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
  if (roomId) view.roomId = roomId;
  return view;
}
