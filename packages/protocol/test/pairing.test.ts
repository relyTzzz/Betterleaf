import { afterEach, describe, expect, it } from 'vitest';
import { pairDevice } from '../src/device/pairing.js';
import { NanoleafPairingError } from '../src/model/errors.js';
import { startSimulator, type NanoleafSimulator } from '../../../tools/simulator/src/index.js';

const sims: NanoleafSimulator[] = [];
afterEach(async () => {
  for (const s of sims.splice(0)) await s.stop();
});

async function sim(opts: { pairingOpen?: boolean } = {}) {
  const s = await startSimulator({
    profile: 'NL29',
    ...(opts.pairingOpen !== undefined ? { pairingOpen: opts.pairingOpen } : {}),
  });
  sims.push(s);
  return s;
}

describe('pairDevice', () => {
  it('returns a token when the device is in pairing mode', async () => {
    const s = await sim({ pairingOpen: true });
    const token = await pairDevice({
      host: '127.0.0.1',
      port: s.port,
      windowMs: 3_000,
      pollIntervalMs: 100,
    });
    expect(token).toBe(s.token);
  });

  it('keeps polling so the button can be pressed after starting', async () => {
    // The device only accepts /new during a 30s window opened by holding the
    // power button. Demanding the user get that ordering right is a bad
    // experience, so we poll across the whole window instead.
    const s = await sim({ pairingOpen: false });

    const pairing = pairDevice({
      host: '127.0.0.1',
      port: s.port,
      windowMs: 5_000,
      pollIntervalMs: 100,
    });

    // User walks over and holds the button.
    setTimeout(() => s.openPairing(), 400);

    expect(await pairing).toBe(s.token);
  });

  it('reports remaining time so the UI can count down', async () => {
    const s = await sim({ pairingOpen: false });
    const ticks: number[] = [];

    await pairDevice({
      host: '127.0.0.1',
      port: s.port,
      windowMs: 2_000,
      pollIntervalMs: 100,
      onTick: (ms) => {
        ticks.push(ms);
        if (ticks.length === 3) s.openPairing();
      },
    });

    expect(ticks.length).toBeGreaterThanOrEqual(3);
    // Monotonically decreasing, so a countdown reads sensibly.
    expect(ticks[0]!).toBeGreaterThan(ticks[ticks.length - 1]!);
  });

  it('fails with actionable advice when nobody presses the button', async () => {
    const s = await sim({ pairingOpen: false });

    await expect(
      pairDevice({
        host: '127.0.0.1',
        port: s.port,
        windowMs: 700,
        pollIntervalMs: 100,
      }),
    ).rejects.toThrow(/Hold the controller power button for 5–7 seconds/);
  });

  it('fails cleanly when there is no device at the address', async () => {
    await expect(
      pairDevice({
        host: '127.0.0.1',
        port: 1,
        windowMs: 600,
        pollIntervalMs: 100,
      }),
    ).rejects.toBeInstanceOf(NanoleafPairingError);
  });

  it('can be cancelled', async () => {
    const s = await sim({ pairingOpen: false });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);

    await expect(
      pairDevice({
        host: '127.0.0.1',
        port: s.port,
        windowMs: 10_000,
        pollIntervalMs: 100,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/cancelled/);
  });

  it('consumes the pairing window, as the real device does', async () => {
    const s = await sim({ pairingOpen: true });
    await pairDevice({ host: '127.0.0.1', port: s.port, windowMs: 2_000, pollIntervalMs: 100 });

    // A second attempt without pressing the button again must fail.
    await expect(
      pairDevice({ host: '127.0.0.1', port: s.port, windowMs: 600, pollIntervalMs: 100 }),
    ).rejects.toBeInstanceOf(NanoleafPairingError);
  });
});
