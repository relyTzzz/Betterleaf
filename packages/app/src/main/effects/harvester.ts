import { EventEmitter } from 'node:events';
import type { NanoleafDevice } from '@betterleaf/protocol';
import type { EffectLibrary, MergeResult } from './library.js';

export interface HarvestReport extends MergeResult {
  serialNo: string;
  deviceName: string;
}

type HarvesterEvents = {
  harvested: [HarvestReport];
  error: [Error];
};

interface Watched {
  device: NanoleafDevice;
  timer: NodeJS.Timeout;
  /** Effect names as of the last check, to spot adds and deletes cheaply. */
  lastNames: string[];
  /** The harvest currently running, if any. Callers join it rather than racing. */
  inFlight?: Promise<HarvestReport | undefined>;
}

export interface HarvesterOptions {
  /**
   * How often to check a device's effect list for changes.
   *
   * This is polling, which the rest of Betterleaf avoids — the event stream
   * carries state, effects and touch, but there is no event for "an effect was
   * added". A scene downloaded in the Nanoleaf app is therefore invisible until
   * something asks. The compromise is to ask for the *names* only, which is a
   * small response, at a low rate, and to pull full documents solely when the
   * list has actually changed.
   */
  pollMs?: number;
}

/**
 * Keeps the library in step with what is actually on the lights.
 *
 * The Discover marketplace delivers scenes to the devices, so the devices hold
 * everything the user has downloaded. Harvesting turns that into a durable local
 * archive that outlives the controller's own storage.
 */
export class EffectHarvester extends EventEmitter<HarvesterEvents> {
  readonly #library: EffectLibrary;
  readonly #pollMs: number;
  readonly #watched = new Map<string, Watched>();

  constructor(library: EffectLibrary, opts: HarvesterOptions = {}) {
    super();
    this.#library = library;
    this.#pollMs = opts.pollMs ?? 30_000;
  }

  /**
   * Harvest this device now, then keep watching it for changes.
   *
   * Returns the initial harvest so a caller that wants to know the outcome can
   * await it, rather than having to guess when it finished.
   */
  watch(device: NanoleafDevice): Promise<HarvestReport | undefined> {
    const existing = this.#watched.get(device.serialNo);
    if (existing) return existing.inFlight ?? Promise.resolve(undefined);

    const timer = setInterval(() => void this.#check(device.serialNo), this.#pollMs);
    timer.unref?.();

    this.#watched.set(device.serialNo, { device, timer, lastNames: [] });

    // Selecting an effect often accompanies adding one — applying a freshly
    // downloaded scene, for instance — so it is a useful free hint to look now
    // rather than waiting out the poll interval.
    device.on('effect', () => void this.#check(device.serialNo));

    return this.harvest(device.serialNo);
  }

  unwatch(serialNo: string): void {
    const watched = this.#watched.get(serialNo);
    if (!watched) return;
    clearInterval(watched.timer);
    this.#watched.delete(serialNo);
  }

  stop(): void {
    for (const serial of [...this.#watched.keys()]) this.unwatch(serial);
  }

  /** Check whether the effect list changed, and do a full harvest if so. */
  async #check(serialNo: string): Promise<void> {
    const watched = this.#watched.get(serialNo);
    if (!watched || watched.inFlight) return;

    try {
      const { effectsList } = await watched.device.fetchEffectList();
      const changed =
        effectsList.length !== watched.lastNames.length ||
        effectsList.some((name, i) => name !== watched.lastNames[i]);
      if (changed) await this.harvest(serialNo);
    } catch {
      // Unreachable devices are already reflected in connection status; a failed
      // poll is not separately interesting and must not produce noise.
    }
  }

  /**
   * Pull every effect off a device and fold it into the library.
   *
   * Concurrent calls join the harvest already running instead of returning
   * nothing: "harvest and tell me what changed" that silently answers
   * `undefined` because something else got there first is a trap.
   */
  harvest(serialNo: string): Promise<HarvestReport | undefined> {
    const watched = this.#watched.get(serialNo);
    if (!watched) return Promise.resolve(undefined);
    if (watched.inFlight) return watched.inFlight;

    const run = this.#harvest(watched, serialNo).finally(() => {
      watched.inFlight = undefined;
    });
    watched.inFlight = run;
    return run;
  }

  async #harvest(
    watched: Watched,
    serialNo: string,
  ): Promise<HarvestReport | undefined> {
    try {
      const effects = await watched.device.exportEffects();
      const result = await this.#library.merge(effects, serialNo);

      watched.lastNames = effects.map((e) => e.animName);

      const report: HarvestReport = {
        ...result,
        serialNo,
        deviceName: watched.device.name,
      };
      // Only announce when something actually changed, so a quiet poll loop
      // does not republish the whole snapshot every 30 seconds.
      if (result.added.length > 0 || result.updated.length > 0) {
        this.emit('harvested', report);
      }
      return report;
    } catch (err) {
      this.emit('error', err as Error);
      return undefined;
    }
  }

  /** Harvest every watched device. */
  async harvestAll(): Promise<HarvestReport[]> {
    const reports = await Promise.all(
      [...this.#watched.keys()].map((serial) => this.harvest(serial)),
    );
    return reports.filter((r): r is HarvestReport => r !== undefined);
  }

  /** The live device for a serial, if we are watching it. */
  deviceFor(serialNo: string): NanoleafDevice | undefined {
    return this.#watched.get(serialNo)?.device;
  }
}
