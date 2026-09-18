import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
  safeStorage: { isEncryptionAvailable: () => false },
  dialog: {
    showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  },
}));

const { EffectLibrary, effectHash } = await import('../src/main/effects/library.js');
const { EffectHarvester } = await import('../src/main/effects/harvester.js');
const { simDevice } = await import('../../protocol/test/helpers.js');
import type { NanoleafEffect } from '@betterleaf/protocol';

const FLOW = '027842e4-e1d6-4a4c-a731-be74a1ebd4cf';
const WHEEL = '6970681a-20b5-4c5e-8813-bdaebc4ee4fa';

function scene(animName: string, hue = 200, pluginUuid = FLOW): NanoleafEffect {
  return {
    animName,
    animType: 'plugin',
    colorType: 'HSB',
    pluginType: 'color',
    pluginUuid,
    pluginOptions: [{ name: 'transTime', value: 20 }],
    palette: [{ hue, saturation: 100, brightness: 100 }],
  };
}

let dir: string;
const cleanups: (() => Promise<void>)[] = [];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'betterleaf-lib-'));
});
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  await fs.rm(dir, { recursive: true, force: true });
});

const newLibrary = () => new EffectLibrary(path.join(dir, 'library.json'));

describe('effect identity', () => {
  it('ignores the name, so renaming does not fork the archive', () => {
    expect(effectHash(scene('Sunset'))).toBe(effectHash(scene('Dusk')));
  });

  it('changes when the content changes', () => {
    expect(effectHash(scene('Sunset', 200))).not.toBe(effectHash(scene('Sunset', 300)));
  });

  it('ignores key order, which firmware does not guarantee', () => {
    const a = scene('Sunset');
    const reordered = JSON.parse(
      JSON.stringify({
        palette: a.palette,
        animName: a.animName,
        pluginUuid: a.pluginUuid,
        animType: a.animType,
        pluginOptions: a.pluginOptions,
        colorType: a.colorType,
        pluginType: a.pluginType,
      }),
    ) as NanoleafEffect;
    expect(effectHash(reordered)).toBe(effectHash(a));
  });
});

describe('library merging', () => {
  it('archives effects harvested from a device', async () => {
    const lib = newLibrary();
    const result = await lib.merge([scene('Ocean'), scene('Forest', 120)], 'SERIAL-A');

    expect(result.added.sort()).toEqual(['Forest', 'Ocean']);
    expect((await lib.entries()).map((e) => e.name)).toEqual(['Forest', 'Ocean']);
  });

  it('collapses the same scene held by two devices into one entry', async () => {
    const lib = newLibrary();
    await lib.merge([scene('Ocean')], 'SERIAL-A');
    const second = await lib.merge([scene('Ocean')], 'SERIAL-B');

    // Downloading the same Discover scene to both walls should not archive it twice.
    expect(second.added).toEqual([]);
    expect(second.unchanged).toEqual(['Ocean']);

    const entries = await lib.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.seenOn.sort()).toEqual(['SERIAL-A', 'SERIAL-B']);
  });

  it('updates in place when a scene is edited', async () => {
    const lib = newLibrary();
    await lib.merge([scene('Ocean', 200)], 'SERIAL-A');
    const second = await lib.merge([scene('Ocean', 340)], 'SERIAL-A');

    expect(second.updated).toEqual(['Ocean']);
    const entries = await lib.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.effect.palette?.[0]?.hue).toBe(340);
  });

  it('survives a restart', async () => {
    const file = path.join(dir, 'library.json');
    await new EffectLibrary(file).merge([scene('Ocean')], 'SERIAL-A');

    const reloaded = await new EffectLibrary(file).entries();
    expect(reloaded.map((e) => e.name)).toEqual(['Ocean']);
  });

  it('keeps a scene after it is gone from every device', async () => {
    // The whole point: the controller has limited storage, the archive does not.
    const lib = newLibrary();
    await lib.merge([scene('Ocean')], 'SERIAL-A');
    await lib.merge([], 'SERIAL-A'); // device wiped

    expect((await lib.entries()).map((e) => e.name)).toEqual(['Ocean']);
  });
});

describe('archive verification', () => {
  it('confirms an exact match', async () => {
    const lib = newLibrary();
    await lib.merge([scene('Ocean')], 'SERIAL-A');
    expect(await lib.isArchived(scene('Ocean'))).toBe(true);
  });

  it('refuses a same-named scene with different content', async () => {
    // The gate before deleting from a device. Matching on name alone would
    // destroy a version the archive does not hold.
    const lib = newLibrary();
    await lib.merge([scene('Ocean', 200)], 'SERIAL-A');
    expect(await lib.isArchived(scene('Ocean', 340))).toBe(false);
  });

  it('refuses something never archived', async () => {
    expect(await newLibrary().isArchived(scene('Ocean'))).toBe(false);
  });
});

describe('harvesting from a device', () => {
  it('pulls everything the device holds', async () => {
    const { device, cleanup } = await simDevice('NL29');
    cleanups.push(cleanup);

    const lib = newLibrary();
    const harvester = new EffectHarvester(lib, { pollMs: 50 });
    cleanups.unshift(async () => harvester.stop()); // before the simulator stops

    harvester.watch(device);
    const report = await harvester.harvest(device.serialNo);

    // The simulator ships six factory effects, as real hardware does.
    expect(report?.added).toHaveLength(6);
    expect((await lib.entries()).length).toBe(6);
  });

  it('notices a scene arriving from outside Betterleaf', async () => {
    const { device, sim, cleanup } = await simDevice('NL29');
    cleanups.push(cleanup);

    const lib = newLibrary();
    const harvester = new EffectHarvester(lib, { pollMs: 40 });
    cleanups.unshift(async () => harvester.stop()); // before the simulator stops

    const harvested: string[] = [];
    harvester.on('harvested', (r) => harvested.push(...r.added));

    harvester.watch(device);
    await harvester.harvest(device.serialNo);

    // As if the user downloaded a scene in the Nanoleaf app: it appears on the
    // device without Betterleaf doing anything.
    await device.importEffect(scene('Downloaded Scene', 60, WHEEL));

    await new Promise((r) => setTimeout(r, 300));

    expect(harvested).toContain('Downloaded Scene');
    expect((await lib.get('Downloaded Scene'))?.effect.pluginUuid).toBe(WHEEL);
    expect(sim.info.effects.effectsList).toContain('Downloaded Scene');
  });

  it('stays quiet when nothing changed', async () => {
    const { device, cleanup } = await simDevice('NL29');
    cleanups.push(cleanup);

    const lib = newLibrary();
    const harvester = new EffectHarvester(lib, { pollMs: 40 });
    cleanups.unshift(async () => harvester.stop()); // before the simulator stops

    harvester.watch(device);
    await harvester.harvest(device.serialNo);

    let announcements = 0;
    harvester.on('harvested', () => announcements++);
    await new Promise((r) => setTimeout(r, 300));

    // A quiet poll loop must not republish the whole snapshot every interval.
    expect(announcements).toBe(0);
  });

  it('stops polling once unwatched', async () => {
    const { device, sim, cleanup } = await simDevice('NL29');
    cleanups.push(cleanup);

    const harvester = new EffectHarvester(newLibrary(), { pollMs: 30 });
    cleanups.unshift(async () => harvester.stop());
    harvester.watch(device);
    await harvester.harvest(device.serialNo);
    harvester.unwatch(device.serialNo);

    const before = sim.requests.length;
    await new Promise((r) => setTimeout(r, 200));
    expect(sim.requests.length).toBe(before);
  });
});
