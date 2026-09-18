import { afterEach, describe, expect, it } from 'vitest';
import {
  BUILTIN_MOTIONS,
  buildEffectWrite,
  buildStaticEffectWrite,
  effectCompatibility,
  isNanoleafEffect,
  motionByUuid,
  type NanoleafEffect,
} from '../src/device/effects.js';
import { simDevice } from './helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const FLOW = '027842e4-e1d6-4a4c-a731-be74a1ebd4cf';
const RHYTHM_MOTION = 'bc6fe7e0-36d4-4f95-aa21-52a386daa9dc';

function flowEffect(name = 'Test Flow'): NanoleafEffect {
  return {
    animName: name,
    animType: 'plugin',
    colorType: 'HSB',
    pluginType: 'color',
    pluginUuid: FLOW,
    pluginOptions: [
      { name: 'transTime', value: 20 },
      { name: 'linDirection', value: 'left' },
      { name: 'loop', value: true },
    ],
    palette: [
      { hue: 200, saturation: 100, brightness: 100 },
      { hue: 280, saturation: 90, brightness: 60, probability: 0 },
    ],
    loop: true,
  };
}

describe('built-in motions', () => {
  it('lists the six documented motions with distinct uuids', () => {
    expect(BUILTIN_MOTIONS).toHaveLength(6);
    const uuids = new Set(BUILTIN_MOTIONS.map((m) => m.uuid));
    expect(uuids.size).toBe(6);
  });

  it('looks a motion up by uuid, which is how an imported effect is named', () => {
    // An effect arriving from elsewhere carries a uuid and no label; being able
    // to name it is what makes a compatibility failure readable.
    expect(motionByUuid(FLOW)?.label).toBe('Flow');
    expect(motionByUuid('not-a-uuid')).toBeUndefined();
  });
});

describe('buildEffectWrite', () => {
  it('sends version 2.0 by default', () => {
    const body = buildEffectWrite(flowEffect()) as { write: Record<string, unknown> };
    expect(body.write['version']).toBe('2.0');
    expect(body.write['command']).toBe('add');
  });

  it('keeps an effect on its own version, so a round trip is lossless', () => {
    const body = buildEffectWrite({ ...flowEffect(), version: '1.0' }) as {
      write: Record<string, unknown>;
    };
    expect(body.write['version']).toBe('1.0');
  });

  it('omits plugin fields for a static effect rather than sending empty ones', () => {
    const body = buildEffectWrite({
      animName: 'Painted',
      animType: 'static',
      animData: '1 374 1 255 0 0 0 0',
    }) as { write: Record<string, unknown> };

    expect(body.write['animData']).toBe('1 374 1 255 0 0 0 0');
    expect('pluginUuid' in body.write).toBe(false);
    expect('pluginOptions' in body.write).toBe(false);
  });

  it('leaves the existing static-effect payload untouched', () => {
    // The paint-and-save path is already proven against hardware; adding the
    // general builder must not quietly change what it sends.
    const body = buildStaticEffectWrite({
      name: 'Betterleaf Test',
      panels: [
        { panelId: 374, r: 255, g: 0, b: 0 },
        { panelId: 401, r: 0, g: 255, b: 0 },
      ],
    }) as { write: Record<string, unknown> };

    expect(body.write['animData']).toBe('2 374 1 255 0 0 0 0 401 1 0 255 0 0 0');
    expect('version' in body.write).toBe(false);
  });
});

describe('fidelity against a real device', () => {
  // Read off a physical NL22 (firmware 3.2.4). Verbatim, because the whole
  // point is that the model must not quietly reshape what hardware stores.
  const REAL = {
    version: '2.0',
    animName: 'Japanese Streets',
    animType: 'plugin',
    colorType: 'HSB',
    palette: [
      { hue: 171, saturation: 70, brightness: 100, probability: 0 },
      { hue: 307, saturation: 99, brightness: 87, probability: 0 },
    ],
    pluginType: 'color',
    pluginUuid: '6970681a-20b5-4c5e-8813-bdaebc4ee4fa',
    rhythmFeatureSource: 1,
    pluginOptions: [
      { name: 'linDirection', value: 'right' },
      { name: 'loop', value: true },
      { name: 'nColorsPerFrame', value: 2 },
      { name: 'transTime', value: 24 },
    ],
    hasOverlay: false,
  } as unknown as NanoleafEffect;

  it('accepts what the hardware actually returns', () => {
    expect(isNanoleafEffect(REAL)).toBe(true);
  });

  it('preserves every field, including ones the model does not name', () => {
    const { write } = buildEffectWrite(REAL) as { write: Record<string, unknown> };

    // rhythmFeatureSource appears on hardware and in no documentation. A
    // whitelist builder dropped it silently, so a copied effect rendered
    // differently from the original with nothing to explain why.
    expect(write['rhythmFeatureSource']).toBe(1);

    for (const [key, value] of Object.entries(REAL)) {
      expect(write[key]).toEqual(value);
    }
    expect(write['command']).toBe('add');
  });

  it('does not invent a top-level loop the device never had', () => {
    // Real effects keep loop inside pluginOptions.
    const { write } = buildEffectWrite(REAL) as { write: Record<string, unknown> };
    expect('loop' in write).toBe(false);
  });

  it('keeps the documented Wheel uuid the hardware confirmed', () => {
    expect(motionByUuid('6970681a-20b5-4c5e-8813-bdaebc4ee4fa')?.label).toBe('Wheel');
  });
});

describe('isNanoleafEffect', () => {
  it('accepts a well-formed plugin effect', () => {
    expect(isNanoleafEffect(flowEffect())).toBe(true);
  });

  it('rejects things that are not effects', () => {
    for (const value of [null, undefined, 42, 'Flow', {}, []]) {
      expect(isNanoleafEffect(value)).toBe(false);
    }
  });

  it('rejects a plugin effect with no motion', () => {
    const { pluginUuid: _dropped, ...noMotion } = flowEffect();
    expect(isNanoleafEffect(noMotion)).toBe(false);
  });

  it('rejects a static effect with no pixels', () => {
    expect(isNanoleafEffect({ animName: 'Empty', animType: 'static' })).toBe(false);
  });
});

describe('effectCompatibility', () => {
  it('passes an effect whose motion the device has', () => {
    expect(effectCompatibility(flowEffect(), [FLOW])).toBeUndefined();
  });

  it('names the missing motion rather than failing opaquely', () => {
    const reason = effectCompatibility(flowEffect(), ['some-other-uuid']);
    expect(reason).toMatch(/does not have the "Flow" motion/);
    expect(reason).toMatch(/Test Flow/);
  });

  it('never blocks a static effect, which needs no motion', () => {
    expect(
      effectCompatibility(
        { animName: 'Painted', animType: 'static', animData: '1 1 1 0 0 0 0 0' },
        [],
      ),
    ).toBeUndefined();
  });

  it('lets the device decide when it did not report its plugins', () => {
    // Older firmware may not answer requestPlugins. An empty list means
    // "unknown", not "none" — refusing everything would be worse than trying.
    expect(effectCompatibility(flowEffect(), [])).toBeUndefined();
  });
});

describe('export and import against a device', () => {
  it('round-trips an effect through the device', async () => {
    const { device, cleanup } = await simDevice('NL29');
    cleanups.push(cleanup);

    await device.importEffect(flowEffect('Round Trip'));
    const exported = await device.exportEffects();

    const found = exported.find((e) => e.animName === 'Round Trip');
    expect(found).toBeDefined();
    expect(found).toMatchObject({
      animType: 'plugin',
      pluginUuid: FLOW,
      pluginType: 'color',
    });
    // Palette and options are the whole substance of a plugin effect; losing
    // them would export something that looks right and renders wrong.
    expect(found?.palette).toEqual(flowEffect().palette);
    expect(found?.pluginOptions).toEqual(flowEffect().pluginOptions);
  });

  it('exports a single effect by name', async () => {
    const { device, cleanup } = await simDevice('NL29');
    cleanups.push(cleanup);

    await device.importEffect(flowEffect('Just One'));
    const one = await device.exportEffect('Just One');
    expect(one?.animName).toBe('Just One');
    expect(await device.exportEffect('Never Existed')).toBeUndefined();
  });

  it('lists the plugins the device actually has', async () => {
    const canvas = await simDevice('NL29');
    cleanups.push(canvas.cleanup);
    const panels = await simDevice('NL22');
    cleanups.push(panels.cleanup);

    const canvasPlugins = await canvas.device.listPlugins();
    const panelPlugins = await panels.device.listPlugins();

    expect(canvasPlugins).toContain(FLOW);
    // Only the Light Panels have a Rhythm module.
    expect(canvasPlugins).not.toContain(RHYTHM_MOTION);
    expect(panelPlugins).toContain(RHYTHM_MOTION);
  });

  it('refuses a rhythm effect on a device with no Rhythm module', async () => {
    const { device, sim, cleanup } = await simDevice('NL29');
    cleanups.push(cleanup);

    const rhythm: NanoleafEffect = {
      ...flowEffect('Beat Drop'),
      pluginType: 'rhythm',
      pluginUuid: RHYTHM_MOTION,
    };

    const before = sim.requests.filter((r) => r.path.endsWith('/effects')).length;
    await expect(device.importEffect(rhythm)).rejects.toThrow(
      /does not have motion|does not have the/,
    );

    // The point of the pre-flight check: no write is attempted at all, so the
    // user gets a readable reason instead of a bare HTTP 400.
    const writes = sim.requests
      .slice(before)
      .filter((r) => r.path.endsWith('/effects') && r.body.includes('"add"'));
    expect(writes).toHaveLength(0);
    expect(sim.info.effects.effectsList).not.toContain('Beat Drop');
  });

  it('moves an effect from one device to another', async () => {
    const canvas = await simDevice('NL29');
    cleanups.push(canvas.cleanup);
    const panels = await simDevice('NL22');
    cleanups.push(panels.cleanup);

    // Author on the Canvas, then copy to the Light Panels — the case that makes
    // export/import worth having with two devices and no cloud.
    await canvas.device.importEffect(flowEffect('Shared Scene'));
    const [exported] = (await canvas.device.exportEffects()).filter(
      (e) => e.animName === 'Shared Scene',
    );
    expect(exported).toBeDefined();

    await panels.device.importEffect(exported!);
    expect(panels.sim.info.effects.effectsList).toContain('Shared Scene');
    expect(panels.device.effects).toContain('Shared Scene');
  });

  it('rejects malformed input before it reaches the device', async () => {
    const { device, sim, cleanup } = await simDevice('NL29');
    cleanups.push(cleanup);

    const before = sim.requests.length;
    await expect(
      device.importEffect({ animName: 'Junk' } as unknown as NanoleafEffect),
    ).rejects.toThrow(/does not look like a Nanoleaf effect/);
    expect(sim.requests.length).toBe(before);
  });
});
