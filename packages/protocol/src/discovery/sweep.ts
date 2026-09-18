import os from 'node:os';
import { DEFAULT_API_PORT } from '../http/client.js';
import type { DiscoveredDevice } from '../model/types.js';
import { tcpReachable } from './probe.js';

/** IPv4 /24 subnets this machine is attached to, most-likely-LAN first. */
export function localSubnets(): string[] {
  const prefixes: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      // Only /24 or narrower is worth sweeping; anything wider is too many
      // hosts to scan politely.
      if (!addr.netmask.startsWith('255.255.255')) continue;
      const prefix = addr.address.split('.').slice(0, 3).join('.');
      if (!prefixes.includes(prefix)) prefixes.push(prefix);
    }
  }
  return prefixes;
}

export interface SweepOptions {
  /** Defaults to every local /24. */
  subnets?: string[];
  port?: number;
  concurrency?: number;
  /** Per-host TCP connect timeout. */
  hostTimeoutMs?: number;
  onDevice?: (device: DiscoveredDevice) => void;
  signal?: AbortSignal;
}

/**
 * Last-resort discovery: TCP-connect to the API port across the local subnet.
 *
 * Multicast fails on more home networks than anyone would like — mesh systems,
 * guest VLANs, "IoT isolation" toggles. When it does, the honest options are a
 * bounded sweep or telling the user to go find an IP address by hand. A /24 at
 * 64-way concurrency finishes in about two seconds, which is worth it to avoid
 * ever showing "no devices found" to someone whose lights are plainly on.
 *
 * Deliberately never the first rung: it is the rudest and the slowest.
 */
export async function sweepSubnets(
  opts: SweepOptions = {},
): Promise<DiscoveredDevice[]> {
  const subnets = opts.subnets ?? localSubnets();
  const port = opts.port ?? DEFAULT_API_PORT;
  const concurrency = opts.concurrency ?? 64;
  const hostTimeoutMs = opts.hostTimeoutMs ?? 500;

  const hosts: string[] = [];
  for (const prefix of subnets) {
    for (let i = 1; i <= 254; i++) hosts.push(`${prefix}.${i}`);
  }

  const found: DiscoveredDevice[] = [];
  let cursor = 0;

  const worker = async () => {
    while (cursor < hosts.length) {
      if (opts.signal?.aborted) return;
      const host = hosts[cursor++];
      if (!host) return;

      if (await tcpReachable(host, port, hostTimeoutMs)) {
        const device: DiscoveredDevice = { ip: host, port, source: 'sweep' };
        found.push(device);
        opts.onDevice?.(device);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, hosts.length) }, worker),
  );

  return found;
}
