import { afterEach, describe, expect, it } from 'vitest';
import { NanoleafClient } from '../src/http/client.js';
import { StreamController } from '../src/stream/extcontrol.js';
import { STREAM_PORT_V2 } from '../src/model/capabilities.js';
import { simDevice, waitFor } from './helpers.js';
import { startSimulator, type NanoleafSimulator } from '../../../tools/simulator/src/index.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function track<T extends { stop: () => Promise<void> }>(sim: T): T {
  cleanups.push(() => sim.stop());
  return sim;
}

describe('external control on the Canvas (NL29, v2)', () => {
  it('streams frames the device decodes as sent', async () => {
    const { sim, device, cleanup } = await simDevice('NL29', {
      reportsStreamPort: true,
    });
    cleanups.push(cleanup);

    await device.startStream();
    expect(device.streamVersion).toBe('v2');
    expect(sim.streaming).toBe(true);

    device.sendFrame([
      { panelId: 374, r: 255, g: 0, b: 255, w: 0, transitionTime: 12 },
      { panelId: 401, r: 0, g: 128, b: 64, w: 0, transitionTime: 1 },
    ]);

    await waitFor(() => sim.frames.length >= 1, { label: 'a streamed frame' });

    const frame = sim.frames[0]!;
    expect(frame.version).toBe('v2');
    expect(frame.panels).toEqual([
      { panelId: 374, r: 255, g: 0, b: 255, w: 0, transitionTime: 12 },
      { panelId: 401, r: 0, g: 128, b: 64, w: 0, transitionTime: 1 },
    ]);
  });

  it('falls back to the well-known port when the device reports none', async () => {
    // Canvas answers the extControl request with an empty body and expects the
    // client to already know the port. Light Panels tell you. Both must work.
    const sim = track(await startSimulator({ profile: 'NL29', reportsStreamPort: false }));
    const client = new NanoleafClient({
      host: '127.0.0.1',
      port: sim.port,
      token: sim.token,
    });
    const controller = new StreamController({ client, preferredVersion: 'v2' });

    const session = await controller.start();
    expect(session).toMatchObject({ version: 'v2', port: STREAM_PORT_V2 });
    await controller.stop();
  });
});

describe('external control on the Light Panels (NL22, v1)', () => {
  it('streams v1 frames and uses the port the device advertises', async () => {
    const { sim, device, cleanup } = await simDevice('NL22');
    cleanups.push(cleanup);

    await device.startStream();
    expect(device.streamVersion).toBe('v1');

    device.sendFrame([
      { panelId: 96, r: 255, g: 0, b: 0, w: 0, transitionTime: 9 },
      { panelId: 135, r: 0, g: 255, b: 0, w: 0, transitionTime: 24 },
    ]);

    await waitFor(() => sim.frames.length >= 1, { label: 'a streamed frame' });

    const frame = sim.frames[0]!;
    expect(frame.version).toBe('v1');
    expect(frame.panels).toEqual([
      { panelId: 96, r: 255, g: 0, b: 0, w: 0, transitionTime: 9 },
      { panelId: 135, r: 0, g: 255, b: 0, w: 0, transitionTime: 24 },
    ]);
  });

  it('refuses panel ids a v1 frame cannot express', async () => {
    const { device, cleanup } = await simDevice('NL22');
    cleanups.push(cleanup);
    await device.startStream();

    const errors: Error[] = [];
    device.on('error', (e) => errors.push(e));

    // A Canvas-sized id on a v1 device. Silently truncating would light panel
    // 118 instead of 374, which is far worse than a visible failure.
    device.sendFrame([{ panelId: 374, r: 1, g: 2, b: 3 }]);
    await waitFor(() => errors.length > 0, { label: 'an encoding error' });
    expect(errors[0]!.message).toMatch(/panelId must be 0–255/);
  });
});

describe('protocol version negotiation', () => {
  it('falls back to v1 when the device rejects v2', async () => {
    // Model number is a poor predictor: some Light Panels firmware accepts v2,
    // some does not. So we ask, and remember the answer.
    const sim = track(await startSimulator({ profile: 'NL22' }));
    const client = new NanoleafClient({
      host: '127.0.0.1',
      port: sim.port,
      token: sim.token,
    });

    const controller = new StreamController({ client, preferredVersion: 'v2' });
    const session = await controller.start();

    expect(session.version).toBe('v1');
    await controller.stop();
  });

  it('remembers the version that worked, so the next start is one request', async () => {
    const { sim, device, cleanup } = await simDevice('NL22');
    cleanups.push(cleanup);

    await device.startStream();
    expect(device.toRecord().streamVersion).toBe('v1');

    const requestsAfterFirst = sim.requests.filter((r) =>
      r.path.endsWith('/effects'),
    ).length;

    await device.stopStream();
    await device.startStream();

    const requestsAfterSecond = sim.requests.filter((r) =>
      r.path.endsWith('/effects'),
    ).length;

    // Exactly one /effects call for the second start: no re-probing.
    expect(requestsAfterSecond - requestsAfterFirst).toBe(1);
  });

  it('reports a clear failure when no version is accepted', async () => {
    const sim = track(await startSimulator({ profile: 'NL29' }));
    // Pretend a device that speaks neither version.
    (sim.profile as { streamVersions: string[] }).streamVersions = [];

    const client = new NanoleafClient({
      host: '127.0.0.1',
      port: sim.port,
      token: sim.token,
    });
    const controller = new StreamController({ client });

    await expect(controller.start()).rejects.toThrow(
      /Could not enable external control/,
    );
  });
});

describe('frame rate', () => {
  it('holds the datagram rate near the cap instead of flooding', async () => {
    const { sim, device, cleanup } = await simDevice('NL29', {
      reportsStreamPort: true,
    });
    cleanups.push(cleanup);
    await device.startStream();

    // 200 sends as fast as the loop runs. The devices drop frames above ~10Hz,
    // so blasting them is worse than useless — it costs latency.
    for (let i = 0; i < 200; i++) {
      device.sendFrame([{ panelId: 374, r: i % 256, g: 0, b: 0 }]);
    }

    await new Promise((r) => setTimeout(r, 300));
    // ~10fps over 300ms is a handful of frames, not 200.
    expect(sim.frames.length).toBeLessThan(10);

    // And the newest state wins: frames are replaced, not queued behind a backlog.
    await waitFor(() => sim.frames.length >= 2, { label: 'a second frame' });
    expect(sim.frames.at(-1)!.panels[0]!.r).toBe(199 % 256);
  });

  it('stops cleanly and can restore the previous effect', async () => {
    const { sim, device, cleanup } = await simDevice('NL29', {
      reportsStreamPort: true,
    });
    cleanups.push(cleanup);

    await device.startStream();
    expect(sim.streaming).toBe(true);

    await device.stopStream('Forest');
    expect(sim.streaming).toBe(false);
    expect(sim.info.effects.select).toBe('Forest');
  });
});
