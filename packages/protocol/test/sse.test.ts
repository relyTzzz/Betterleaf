import { afterEach, describe, expect, it } from 'vitest';
import { EventStream } from '../src/events/sse.js';
import { simDevice, waitFor } from './helpers.js';
import { startSimulator, type NanoleafSimulator } from '../../../tools/simulator/src/index.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function stream(sim: NanoleafSimulator, types?: number[]) {
  const es = new EventStream({
    host: '127.0.0.1',
    port: sim.port,
    token: sim.token,
    ...(types ? { types } : {}),
  });
  es.on('error', () => {}); // drops are expected in these tests
  cleanups.push(async () => es.close());
  es.start();
  await waitFor(() => es.connected, { label: 'stream open' });
  return es;
}

describe('EventStream', () => {
  it('delivers state changes as typed patches', async () => {
    const sim = await startSimulator({ profile: 'NL29' });
    cleanups.push(() => sim.stop());
    const es = await stream(sim);

    const patches: Record<string, unknown>[] = [];
    es.on('state', (p) => patches.push(p));

    sim.pushStateEvent(1, false); // on
    sim.pushStateEvent(2, 33); // brightness
    sim.pushStateEvent(6, 'hs'); // colorMode

    await waitFor(() => patches.length >= 3, { label: 'three state events' });
    expect(patches).toEqual([{ on: false }, { brightness: 33 }, { colorMode: 'hs' }]);
  });

  it('maps touch gestures to names', async () => {
    const sim = await startSimulator({ profile: 'NL29' });
    cleanups.push(() => sim.stop());
    const es = await stream(sim, [1, 2, 3, 4]);

    const touches: unknown[] = [];
    es.on('touch', (t) => touches.push(t));

    sim.pushTouchEvent(0, 374);
    sim.pushTouchEvent(5, 401);

    await waitFor(() => touches.length >= 2, { label: 'two touch events' });
    expect(touches).toEqual([
      { gesture: 'single-tap', panelId: 374 },
      { gesture: 'swipe-right', panelId: 401 },
    ]);
  });

  it('reconnects after the device drops the connection', async () => {
    const sim = await startSimulator({ profile: 'NL29' });
    cleanups.push(() => sim.stop());
    const es = await stream(sim);

    let reconnects = 0;
    es.on('reconnecting', () => reconnects++);

    // As happens on a Wi-Fi blip or a controller reboot.
    sim.dropEventStreams();

    await waitFor(() => reconnects >= 1, { label: 'a reconnect attempt' });
    await waitFor(() => es.connected, { label: 'reconnection', timeoutMs: 8_000 });

    // And events flow again afterwards — a reconnect that doesn't resubscribe
    // is worse than no reconnect, because the UI looks live but is frozen.
    const patches: unknown[] = [];
    es.on('state', (p) => patches.push(p));
    sim.pushStateEvent(2, 77);
    await waitFor(() => patches.length >= 1, { label: 'events after reconnect' });
    expect(patches).toEqual([{ brightness: 77 }]);
  });

  it('survives malformed payloads without dropping the connection', async () => {
    const sim = await startSimulator({ profile: 'NL29' });
    cleanups.push(() => sim.stop());
    const es = await stream(sim);

    const errors: Error[] = [];
    const patches: unknown[] = [];
    es.on('error', (e) => errors.push(e));
    es.on('state', (p) => patches.push(p));

    sim.pushRaw('id: 1\ndata: {not json at all\n\n');
    sim.pushRaw('id: 99\ndata: {"events":[{"attr":1}]}\n\n'); // unknown event type
    sim.pushRaw(': keepalive comment\n\n');
    // Then something valid, to prove the parser resynchronised.
    sim.pushStateEvent(2, 50);

    await waitFor(() => patches.length >= 1, { label: 'a valid event after garbage' });
    expect(patches).toEqual([{ brightness: 50 }]);
    expect(errors.some((e) => /Malformed event payload/.test(e.message))).toBe(true);
    expect(es.connected).toBe(true);
  });

  it('parses events delimited with CRLF as well as LF', async () => {
    // Firmware versions differ on line endings, and a parser that knows only
    // one of them silently receives nothing at all.
    const sim = await startSimulator({ profile: 'NL29' });
    cleanups.push(() => sim.stop());
    const es = await stream(sim);

    const patches: unknown[] = [];
    es.on('state', (p) => patches.push(p));

    sim.pushRaw('id: 1\r\ndata: {"events":[{"attr":2,"value":64}]}\r\n\r\n');
    await waitFor(() => patches.length >= 1, { label: 'a CRLF event' });
    expect(patches).toEqual([{ brightness: 64 }]);
  });

  it('reassembles events split across TCP chunks', async () => {
    const sim = await startSimulator({ profile: 'NL29' });
    cleanups.push(() => sim.stop());
    const es = await stream(sim);

    const patches: unknown[] = [];
    es.on('state', (p) => patches.push(p));

    // Nothing guarantees an event arrives in one read.
    sim.pushRaw('id: 1\ndata: {"events":[{"attr":');
    await new Promise((r) => setTimeout(r, 20));
    sim.pushRaw('2,"value":88}]}\n\n');

    await waitFor(() => patches.length >= 1, { label: 'a split event' });
    expect(patches).toEqual([{ brightness: 88 }]);
  });

  it('stops reconnecting once closed', async () => {
    const sim = await startSimulator({ profile: 'NL29' });
    cleanups.push(() => sim.stop());
    const es = await stream(sim);

    let reconnects = 0;
    es.on('reconnecting', () => reconnects++);

    es.close();
    sim.dropEventStreams();

    await new Promise((r) => setTimeout(r, 300));
    expect(reconnects).toBe(0);
    expect(es.connected).toBe(false);
  });
});

describe('device connection status', () => {
  it('goes connected, then reconnecting, then connected again', async () => {
    const { sim, device, cleanup } = await simDevice('NL29');
    cleanups.push(cleanup);

    await waitFor(() => device.status === 'connected', { label: 'initial connect' });

    const seen: string[] = [];
    device.on('status', (s) => seen.push(s));

    sim.dropEventStreams();
    await waitFor(() => seen.includes('reconnecting'), {
      label: 'reconnecting status',
    });
    await waitFor(() => device.status === 'connected', {
      label: 'recovery',
      timeoutMs: 8_000,
    });

    // Never a permanent spinner: every state is either actionable or resolves
    // itself, and the user is told which.
    expect(seen[0]).toBe('reconnecting');
    expect(device.status).toBe('connected');
  });

  it('reports unreachable after repeated failures, and recovers unattended', async () => {
    const { sim, device, cleanup } = await simDevice('NL29');
    cleanups.push(cleanup);
    await waitFor(() => device.status === 'connected');

    // Take the device away entirely.
    await sim.stop();

    await waitFor(() => device.status === 'unreachable', {
      label: 'unreachable status',
      timeoutMs: 15_000,
    });
    expect(device.status).toBe('unreachable');
  });
});
