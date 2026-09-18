import { afterEach, describe, expect, it } from 'vitest';
import { nextEvent, simDevice, waitFor } from './helpers.js';
import type { NanoleafDevice } from '../src/device/device.js';
import type { NanoleafSimulator } from '../../../tools/simulator/src/index.js';

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function setup(profile: 'NL22' | 'NL29' = 'NL29', flushMs?: number) {
  const ctx = await simDevice(profile, flushMs === undefined ? {} : { flushMs });
  cleanup = ctx.cleanup;
  return ctx as { sim: NanoleafSimulator; device: NanoleafDevice };
}

describe('device identity and capabilities', () => {
  it('derives capabilities from the model', async () => {
    const canvas = await setup('NL29');
    expect(canvas.device.capabilities).toMatchObject({
      family: 'canvas',
      touch: true,
      rhythm: false,
      preferredStreamVersion: 'v2',
    });
    await cleanup!();
    cleanup = undefined;

    const panels = await setup('NL22');
    expect(panels.device.capabilities).toMatchObject({
      family: 'light-panels',
      touch: false,
      rhythm: true,
      preferredStreamVersion: 'v1',
    });
  });

  it('persists a record keyed on serial number, not address', async () => {
    const { device, sim } = await setup();
    const record = device.toRecord();
    expect(record.serialNo).toBe(sim.serialNo);
    expect(record.lastIp).toBe('127.0.0.1');
    expect(record.lastPort).toBe(sim.port);
  });
});

describe('optimistic writes', () => {
  it('emits the new state before the request completes', async () => {
    const { device } = await setup();

    const seen: boolean[] = [];
    device.on('state', (s) => seen.push(s.on));

    const write = device.setPower(false);
    // Synchronously after the call, with no await: this is what makes a tap feel
    // instant rather than waiting on a round trip.
    expect(device.state.on).toBe(false);
    expect(seen).toContain(false);

    await write;
  });

  it('merges several properties changed together into one request', async () => {
    const { device, sim } = await setup('NL29', 20);

    const before = sim.requests.filter((r) => r.path.endsWith('/state')).length;
    await device.setHueSat(120, 55);

    const stateWrites = sim.requests.filter((r) => r.path.endsWith('/state'));
    expect(stateWrites.length - before).toBe(1);

    const body = JSON.parse(stateWrites.at(-1)!.body);
    expect(body).toMatchObject({ hue: { value: 120 }, sat: { value: 55 } });
  });

  it('collapses a slider drag into a handful of requests', async () => {
    const { device, sim } = await setup('NL29', 30);

    // 100 updates, as dragging a brightness slider produces.
    const writes: Promise<void>[] = [];
    for (let i = 1; i <= 100; i++) writes.push(device.setBrightness(i));
    await Promise.all(writes);
    await waitFor(() => device.state.brightness === 100, { label: 'final brightness' });

    const stateWrites = sim.requests.filter((r) => r.path.endsWith('/state'));
    expect(stateWrites.length).toBeLessThanOrEqual(4);

    // Whatever else got dropped, the value the finger ended on must land.
    const last = JSON.parse(stateWrites.at(-1)!.body);
    expect(last.brightness.value).toBe(100);
  });

  it('clamps values to the ranges the device accepts', async () => {
    const { device } = await setup();
    await device.setBrightness(500);
    expect(device.state.brightness).toBe(100);
    await device.setHue(-40);
    expect(device.state.hue).toBe(0);
    await device.setColorTemp(99_999);
    expect(device.state.ct).toBe(6500);
  });
});

describe('event-driven state', () => {
  it('picks up changes made by something else, without polling', async () => {
    const { device, sim } = await setup();
    await waitFor(() => sim.sseClientCount === 1, { label: 'event stream' });

    const requestsBefore = sim.requests.length;

    // As if someone used the wall switch, HomeKit, or the official app.
    sim.pushStateEvent(2, 17);
    await waitFor(() => device.state.brightness === 17, { label: 'brightness event' });

    // No extra HTTP traffic: the update arrived over the open event stream.
    const httpSince = sim.requests.length - requestsBefore;
    expect(httpSince).toBe(0);
  });

  it('reports effect changes', async () => {
    const { device, sim } = await setup();
    await waitFor(() => sim.sseClientCount === 1);

    const changed = nextEvent<string>(device, 'effect');
    sim.pushEffectEvent('Fireworks');
    expect(await changed).toBe('Fireworks');
    expect(device.currentEffect).toBe('Fireworks');
  });

  it('delivers Canvas touch gestures with their panel id', async () => {
    const { device, sim } = await setup('NL29');
    await waitFor(() => sim.sseClientCount === 1);

    const touch = nextEvent<{ gesture: string; panelId: number }>(device, 'touch');
    sim.pushTouchEvent(1, 374); // 1 = double tap
    expect(await touch).toEqual({ gesture: 'double-tap', panelId: 374 });
  });

  it('reports connected once the stream is open', async () => {
    const { device } = await setup();
    await waitFor(() => device.status === 'connected', { label: 'connected' });
    expect(device.status).toBe('connected');
  });
});

describe('effects', () => {
  it('applies an effect and reflects it immediately', async () => {
    const { device, sim } = await setup();
    await device.selectEffect('Forest');
    expect(device.currentEffect).toBe('Forest');
    await waitFor(() => sim.info.effects.select === 'Forest', { label: 'effect applied' });
  });

  it('saves a per-panel scene onto the device so it persists', async () => {
    const { device, sim } = await setup('NL29');

    await device.saveStaticEffect('Betterleaf Test', [
      { panelId: 374, r: 255, g: 0, b: 0 },
      { panelId: 401, r: 0, g: 255, b: 0 },
    ]);

    // The device now owns it — it survives Betterleaf quitting.
    expect(sim.info.effects.effectsList).toContain('Betterleaf Test');
    expect(device.effects).toContain('Betterleaf Test');

    const write = sim.requests.filter((r) => r.path.endsWith('/effects')).at(-1)!;
    const body = JSON.parse(write.body);
    expect(body.write.animType).toBe('static');
    expect(body.write.animData).toBe('2 374 1 255 0 0 0 0 401 1 0 255 0 0 0');
  });

  it('deletes an effect', async () => {
    const { device, sim } = await setup();
    await device.deleteEffect('Nemo');
    expect(sim.info.effects.effectsList).not.toContain('Nemo');
    expect(device.effects).not.toContain('Nemo');
  });
});

describe('address changes', () => {
  it('follows the device to a new address without losing identity', async () => {
    const { device, sim } = await setup();
    const serial = device.serialNo;

    const moved = nextEvent<{ ip: string; port: number }>(device, 'address');
    device.rebind('127.0.0.1', sim.port); // same address: no-op
    device.rebind('127.0.0.2', 16021);

    expect(await moved).toEqual({ ip: '127.0.0.2', port: 16021 });
    // Same object, same serial — the UI never sees a device disappear.
    expect(device.serialNo).toBe(serial);
    expect(device.toRecord().lastIp).toBe('127.0.0.2');
  });
});

describe('persistable record', () => {
  it('announces the negotiated stream version so it can be stored', async () => {
    const { device } = await setup('NL22');

    const records: { streamVersion?: string }[] = [];
    device.on('record', (r) => records.push(r));

    await device.startStream();

    // The version is learned by probing; without this event the probe would be
    // repeated on every launch forever.
    expect(records.at(-1)?.streamVersion).toBe('v1');
    await device.stopStream();
  });

  it('does not re-announce a version it already knew', async () => {
    const { device } = await setup('NL22');
    await device.startStream();

    const records: unknown[] = [];
    device.on('record', (r) => records.push(r));

    await device.stopStream();
    await device.startStream();

    expect(records).toHaveLength(0);
    await device.stopStream();
  });

  it('announces a new address', async () => {
    const { device } = await setup('NL29');
    const records: { lastIp: string }[] = [];
    device.on('record', (r) => records.push(r));

    device.rebind('127.0.0.2', 16021);

    expect(records.at(-1)?.lastIp).toBe('127.0.0.2');
  });
});

describe('token expiry', () => {
  it('reports needs-pairing when the device rejects the token', async () => {
    const { device, sim } = await setup('NL29', 10);
    await waitFor(() => sim.sseClientCount === 1);

    sim.revokeToken();

    await device.setBrightness(42).catch(() => {});
    await waitFor(() => device.status === 'needs-pairing', {
      label: 'needs-pairing status',
    });

    // An unreachable device is worth retrying; a revoked token never is. The
    // user has to press the button, and no amount of retrying substitutes.
    expect(device.status).toBe('needs-pairing');
  });

  it('does not retry a rejected token', async () => {
    const { device, sim } = await setup('NL29', 10);
    await waitFor(() => sim.sseClientCount === 1);

    sim.revokeToken();
    const before = sim.requests.filter((r) => r.path.endsWith('/state')).length;

    await device.setBrightness(42).catch(() => {});

    const attempts =
      sim.requests.filter((r) => r.path.endsWith('/state')).length - before;
    // Exactly one attempt: no backoff storm against a device that will never
    // say yes.
    expect(attempts).toBe(1);
  });
});
