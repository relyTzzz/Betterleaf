import { DEFAULT_API_PORT } from '../http/client.js';
import type { DeviceRecord, DiscoveredDevice } from '../model/types.js';
import { sleep } from '../util/async.js';
import { browseMdns } from './mdns.js';
import { probeDevice, type ProbeResult } from './probe.js';
import { discoverSsdp } from './ssdp.js';
import { sweepSubnets } from './sweep.js';

export interface LadderTimings {
  /** Deadline for a cached-address probe. Kept tight: it runs at t=0. */
  cacheProbeMs: number;
  /** How long to listen for mDNS announcements. */
  mdnsWindowMs: number;
  /** Delay before escalating to SSDP. */
  ssdpAfterMs: number;
  /** Delay before escalating to a subnet sweep. */
  sweepAfterMs: number;
  /** Hard stop for the whole ladder. */
  overallMs: number;
}

export const DEFAULT_TIMINGS: LadderTimings = {
  cacheProbeMs: 800,
  mdnsWindowMs: 4_000,
  ssdpAfterMs: 1_500,
  sweepAfterMs: 3_000,
  overallMs: 8_000,
};

export interface LadderOptions {
  /** Previously paired devices. Their addresses are tried first and their tokens identify candidates. */
  known?: DeviceRecord[];
  /** Fires as soon as each device is identified, so the UI can fill in progressively. */
  onFound?: (result: ProbeResult) => void;
  /** Fires when a rung starts, for diagnostics. */
  onRung?: (rung: 'cache' | 'mdns' | 'ssdp' | 'sweep') => void;
  timings?: Partial<LadderTimings>;
  /**
   * Individual rungs can be turned off — for a locked-down network where a
   * subnet sweep is unwelcome, or for tests that must not depend on whatever
   * happens to be advertising on the LAN.
   */
  enableMdns?: boolean;
  enableSsdp?: boolean;
  /** The sweep is the rudest rung; callers can opt out. */
  enableSweep?: boolean;
  /**
   * Addresses the user typed in by hand. Probed at t=0 alongside the cache.
   *
   * No discovery scheme survives every network, so there is always a way to say
   * "it is at this address" and have it work.
   */
  manualAddresses?: { ip: string; port?: number }[];
  signal?: AbortSignal;
}

/**
 * Establish which device is at an address by trying known tokens.
 *
 * Only a valid token yields a serial number, so identity costs one request per
 * known device in the worst case — negligible for a household, and it is what
 * lets a device that moved to a new IP be recognised rather than treated as new.
 */
async function identify(
  candidate: DiscoveredDevice,
  tokens: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ProbeResult | undefined> {
  for (const token of tokens) {
    if (signal?.aborted) return undefined;
    const result = await probeDevice(candidate.ip, {
      port: candidate.port,
      token,
      timeoutMs,
      source: candidate.source,
      ...(signal ? { signal } : {}),
    });
    if (result?.info) return result;
  }

  // No token fit. A 401 still confirms a pairable Nanoleaf is sitting there —
  // but only conclude that if we actually finished asking. A cancelled run has
  // not established anything.
  if (signal?.aborted) return undefined;
  const unauth = await probeDevice(candidate.ip, {
    port: candidate.port,
    timeoutMs,
    source: candidate.source,
    ...(signal ? { signal } : {}),
  });
  if (!unauth) return undefined;

  if (candidate.name && !unauth.name) unauth.name = candidate.name;
  if (candidate.model && !unauth.model) unauth.model = candidate.model;
  return unauth;
}

/**
 * Find Nanoleaf devices, fastest path first.
 *
 * The rungs run concurrently rather than in sequence, and results stream out via
 * `onFound` as they land. The point is that a returning user's devices are
 * already usable at roughly t=50ms — a direct probe of the address they were at
 * last time — while the slower, more thorough rungs carry on underneath for the
 * cases where something moved.
 *
 * The ladder finishes early once every known device has answered. A first run
 * with nothing cached necessarily waits out the discovery windows, because
 * there is no way to know whether one more device is about to announce itself.
 */
export async function runDiscoveryLadder(
  opts: LadderOptions = {},
): Promise<ProbeResult[]> {
  const timings = { ...DEFAULT_TIMINGS, ...opts.timings };
  const known = opts.known ?? [];
  const tokens = [...new Set(known.map((k) => k.token))];

  const results = new Map<string, ProbeResult>();
  const pendingSerials = new Set(known.map((k) => k.serialNo));
  const seenAddresses = new Set<string>();

  const controller = new AbortController();
  const signal = controller.signal;
  opts.signal?.addEventListener('abort', () => controller.abort(), { once: true });

  let resolveDone: () => void;
  const allKnownFound = new Promise<void>((r) => {
    resolveDone = r;
  });

  const record = (result: ProbeResult) => {
    // Key on serial when we have one so the same device found by two different
    // rungs collapses into one entry rather than appearing twice.
    const key = result.serialNo ?? `${result.ip}:${result.port}`;
    if (results.has(key)) return;
    results.set(key, result);
    opts.onFound?.(result);

    if (result.serialNo) pendingSerials.delete(result.serialNo);
    if (known.length > 0 && pendingSerials.size === 0) resolveDone();
  };

  const consider = async (candidate: DiscoveredDevice) => {
    const address = `${candidate.ip}:${candidate.port}`;
    if (seenAddresses.has(address)) return;
    seenAddresses.add(address);

    const result = await identify(candidate, tokens, timings.cacheProbeMs, signal);
    if (result) record(result);
  };

  // --- Rung 1 (t=0): every cached address, in parallel -----------------------
  opts.onRung?.('cache');
  const cacheProbes = known.map(async (rec) => {
    const address = `${rec.lastIp}:${rec.lastPort}`;
    seenAddresses.add(address);
    const result = await probeDevice(rec.lastIp, {
      port: rec.lastPort,
      token: rec.token,
      timeoutMs: timings.cacheProbeMs,
      source: 'cache',
      signal,
    });
    if (result?.info) record(result);
  });

  // --- Rung 1b (t=0): anything the user typed in by hand ---------------------
  const manualProbes = (opts.manualAddresses ?? []).map((addr) =>
    consider({
      ip: addr.ip,
      port: addr.port ?? DEFAULT_API_PORT,
      source: 'manual',
    }),
  );

  // --- Rung 2 (t=0): mDNS, both service types -------------------------------
  const mdnsBrowse = (async () => {
    if (opts.enableMdns === false) return [];
    opts.onRung?.('mdns');
    return browseMdns({
      timeoutMs: timings.mdnsWindowMs,
      signal,
      onDevice: (device) => void consider(device),
    });
  })();

  // --- Rung 3 (t=1.5s): SSDP, if anything is still missing ------------------
  const ssdpRung = (async () => {
    if (opts.enableSsdp === false) return;
    await sleep(timings.ssdpAfterMs, signal).catch(() => {});
    if (signal.aborted || (known.length > 0 && pendingSerials.size === 0)) return;
    opts.onRung?.('ssdp');
    await discoverSsdp({
      timeoutMs: Math.max(1_000, timings.overallMs - timings.ssdpAfterMs),
      signal,
      onDevice: (device) => void consider(device),
    });
  })();

  // --- Rung 4 (t=3s): bounded subnet sweep ----------------------------------
  const sweepRung = (async () => {
    if (opts.enableSweep === false) return;
    await sleep(timings.sweepAfterMs, signal).catch(() => {});
    if (signal.aborted || (known.length > 0 && pendingSerials.size === 0)) return;
    // Only sweep when we have genuinely come up empty — this is the rung that
    // touches every host on the network, and it should feel like a last resort.
    if (results.size > 0 && pendingSerials.size === 0) return;
    opts.onRung?.('sweep');
    await sweepSubnets({
      signal,
      onDevice: (device) => void consider(device),
    });
  })();

  const rungs = Promise.allSettled([
    ...cacheProbes,
    ...manualProbes,
    mdnsBrowse,
    ssdpRung,
    sweepRung,
  ]);

  await Promise.race([
    rungs,
    allKnownFound,
    sleep(timings.overallMs, signal).catch(() => {}),
  ]);

  controller.abort();
  return [...results.values()];
}
