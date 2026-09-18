import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
  safeStorage: { isEncryptionAvailable: () => false },
  // Dialogs are the one part that genuinely needs a person; the logic under
  // test is the parsing and the batch write, so they are stubbed out.
  dialog: {
    showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  },
}));

const { parseEffectFile, copyEffectsBetween } = await import(
  '../src/main/effects/file-source.js'
);
const { simDevice } = await import('../../protocol/test/helpers.js');

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const FLOW = '027842e4-e1d6-4a4c-a731-be74a1ebd4cf';
const RHYTHM = 'bc6fe7e0-36d4-4f95-aa21-52a386daa9dc';

const effect = (animName: string, pluginUuid = FLOW) => ({
  animName,
  animType: 'plugin' as const,
  colorType: 'HSB' as const,
  pluginType: pluginUuid === RHYTHM ? ('rhythm' as const) : ('color' as const),
  pluginUuid,
  palette: [{ hue: 200, saturation: 100, brightness: 100 }],
  loop: true,
});

describe('parseEffectFile', () => {
  it('accepts a bare array, which is what we export', () => {
    expect(parseEffectFile([effect('A'), effect('B')])).toHaveLength(2);
  });

  it('accepts a single effect object', () => {
    expect(parseEffectFile(effect('Solo'))).toHaveLength(1);
  });

  it("accepts a device's own requestAll response, saved as-is", () => {
    // Someone dumping the raw API response to a file should not have to reshape
    // it by hand before importing.
    expect(parseEffectFile({ animations: [effect('A')] })).toHaveLength(1);
  });

  it('drops entries that are not effects rather than failing the whole file', () => {
    const parsed = parseEffectFile([effect('Good'), { animName: 'Junk' }, 42]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.animName).toBe('Good');
  });

  it('returns nothing for unrelated JSON', () => {
    expect(parseEffectFile({ hello: 'world' })).toEqual([]);
    expect(parseEffectFile(null)).toEqual([]);
  });
});

describe('copying effects between devices', () => {
  it('carries everything the target can render', async () => {
    const canvas = await simDevice('NL29');
    cleanups.push(canvas.cleanup);
    const panels = await simDevice('NL22');
    cleanups.push(panels.cleanup);

    await canvas.device.importEffect(effect('Sunset Drift'));
    const outcome = await copyEffectsBetween(canvas.device, panels.device);

    expect(outcome.imported).toContain('Sunset Drift');
    expect(outcome.skipped).toHaveLength(0);
    expect(panels.sim.info.effects.effectsList).toContain('Sunset Drift');
  });

  it('keeps going past an effect the target cannot render', async () => {
    const panels = await simDevice('NL22');
    cleanups.push(panels.cleanup);
    const canvas = await simDevice('NL29');
    cleanups.push(canvas.cleanup);

    // The Light Panels have a Rhythm module; the Canvas does not.
    await panels.device.importEffect(effect('Sunset Drift'));
    await panels.device.importEffect(effect('Beat Drop', RHYTHM));

    const outcome = await copyEffectsBetween(panels.device, canvas.device);

    // One bad effect in a batch must not abandon the rest.
    expect(outcome.imported).toContain('Sunset Drift');
    expect(outcome.skipped.map((s) => s.name)).toContain('Beat Drop');
    expect(outcome.skipped[0]?.reason).toMatch(/does not have/);
    expect(canvas.sim.info.effects.effectsList).not.toContain('Beat Drop');
  });
});
