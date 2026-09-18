import { afterEach, describe, expect, it } from 'vitest';
import { probeDevice } from '../src/discovery/probe.js';
import { runDiscoveryLadder } from '../src/discovery/ladder.js';
import type { DeviceRecord } from '../src/model/types.js';
import { startSimulator, type NanoleafSimulator } from '../../../tools/simulator/src/index.js';

const sims: NanoleafSimulator[] = [];
afterEach(async () => {
  for (const s of sims.splice(0)) await s.stop();
});

async function sim(profile: 'NL22' | 'NL29') {
  const s = await startSimulator({ profile });
  sims.push(s);
  return s;
}

function recordFor(s: NanoleafSimulator, overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    serialNo: s.serialNo,
    model: s.info.model,
    name: s.info.name,
    token: s.token,
    lastIp: '127.0.0.1',
    lastPort: s.port,
    ...overrides,
  };
}

// Discovery rungs that touch the real network (mDNS, SSDP, sweep) are exercised
// against live hardware, not here — a CI box has no Nanoleaf and multicast
// behaviour varies too much between machines to assert on. What is tested here
// is the logic those rungs feed: identification, de-duplication, drift healing
// and the early exit that makes launch feel instant.
const LOCAL_ONLY = {
  enableMdns: false,
  enableSsdp: false,
  enableSweep: false,
  timings: { overallMs: 2_000 },
};

describe('probeDevice', () => {
  it('returns the full device document for a valid token', async () => {
    const s = await sim('NL29');
    const result = await probeDevice('127.0.0.1', { port: s.port, token: s.token });

    expect(result).toMatchObject({
      ip: '127.0.0.1',
      port: s.port,
      serialNo: s.serialNo,
      model: 'NL29',
    });
    expect(result?.info?.panelLayout.layout.positionData.length).toBeGreaterThan(0);
  });

  it('flags a Nanoleaf that rejects our token as pairable, not absent', async () => {
    const s = await sim('NL22');
    const result = await probeDevice('127.0.0.1', { port: s.port, token: 'wrong' });

    // A 401 is a positive result: something there speaks the Nanoleaf API.
    // Reporting "no device found" here is how the official app makes people
    // think their lights are broken.
    expect(result).toMatchObject({ needsPairing: true, ip: '127.0.0.1' });
    expect(result?.serialNo).toBeUndefined();
  });

  it('refuses to run once its signal has already aborted', async () => {
    const s = await sim('NL29');
    const controller = new AbortController();
    controller.abort();

    const before = s.requests.length;
    const result = await probeDevice('127.0.0.1', {
      port: s.port,
      token: s.token,
      signal: controller.signal,
    });

    // An abort listener never fires on a signal that aborted before the request
    // was created. Without an up-front check the request goes out anyway, and a
    // cancelled discovery probe reports a paired device as needing pairing.
    expect(result).toBeUndefined();
    expect(s.requests.length).toBe(before);
  });

  it('returns undefined when nothing is listening', async () => {
    // Port 1 on loopback: reliably refused.
    const result = await probeDevice('127.0.0.1', { port: 1, timeoutMs: 300 });
    expect(result).toBeUndefined();
  });
});

describe('discovery ladder', () => {
  it('finds a known device from its cached address almost immediately', async () => {
    const s = await sim('NL29');
    const started = Date.now();

    const found = await runDiscoveryLadder({
      known: [recordFor(s)],
      ...LOCAL_ONLY,
    });

    // The whole point of the cache rung: a returning user is controlling their
    // lights before any discovery protocol has had time to answer.
    expect(Date.now() - started).toBeLessThan(500);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ serialNo: s.serialNo, source: 'cache' });
  });

  it('finds both devices and keeps them distinct', async () => {
    const canvas = await sim('NL29');
    const panels = await sim('NL22');

    const found = await runDiscoveryLadder({
      known: [recordFor(canvas), recordFor(panels)],
      ...LOCAL_ONLY,
    });

    expect(found.map((f) => f.serialNo).sort()).toEqual(
      [canvas.serialNo, panels.serialNo].sort(),
    );
    expect(found.map((f) => f.model).sort()).toEqual(['NL22', 'NL29']);
  });

  it('recognises a device that moved to a new address', async () => {
    const s = await sim('NL29');

    // The cached address is stale — as after a DHCP lease change. The device is
    // really somewhere else, and the user (or another rung) supplies it.
    const stale = recordFor(s, { lastPort: 1 });

    const found = await runDiscoveryLadder({
      known: [stale],
      manualAddresses: [{ ip: '127.0.0.1', port: s.port }],
      ...LOCAL_ONLY,
    });

    expect(found).toHaveLength(1);
    // Same serial: this is the same light, not a new one. That identity is what
    // lets it reconnect without re-pairing.
    expect(found[0]!.serialNo).toBe(s.serialNo);
    expect(found[0]!.port).toBe(s.port);
  });

  it('does not report the same device twice when two rungs find it', async () => {
    const s = await sim('NL29');

    const found = await runDiscoveryLadder({
      known: [recordFor(s)],
      // Same device, reachable via both the cache and a manual entry.
      manualAddresses: [{ ip: '127.0.0.1', port: s.port }],
      ...LOCAL_ONLY,
    });

    expect(found).toHaveLength(1);
  });

  it('reports each device as soon as it is identified', async () => {
    const canvas = await sim('NL29');
    const panels = await sim('NL22');

    const progressive: string[] = [];
    await runDiscoveryLadder({
      known: [recordFor(canvas), recordFor(panels)],
      onFound: (r) => progressive.push(r.serialNo ?? r.ip),
      ...LOCAL_ONLY,
    });

    // The UI fills in as devices answer rather than after the slowest one.
    expect(progressive).toHaveLength(2);
  });

  it('surfaces an unpaired device found by address', async () => {
    const s = await sim('NL22');

    const found = await runDiscoveryLadder({
      manualAddresses: [{ ip: '127.0.0.1', port: s.port }],
      ...LOCAL_ONLY,
    });

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ needsPairing: true, source: 'manual' });
  });

  it('does not report a paired device as needing pairing after cancellation', async () => {
    const s = await sim('NL29');

    // Reachable at two addresses; the ladder stops as soon as the first answers,
    // cancelling the in-flight probe of the second.
    const found = await runDiscoveryLadder({
      known: [recordFor(s)],
      manualAddresses: [{ ip: '127.0.0.1', port: s.port }],
      ...LOCAL_ONLY,
    });

    expect(found).toHaveLength(1);
    expect(found[0]!.needsPairing).toBeFalsy();
    expect(found[0]!.serialNo).toBe(s.serialNo);
  });

  it('returns empty rather than hanging when nothing is out there', async () => {
    const found = await runDiscoveryLadder({
      manualAddresses: [{ ip: '127.0.0.1', port: 1 }],
      ...LOCAL_ONLY,
    });
    expect(found).toEqual([]);
  });
});
