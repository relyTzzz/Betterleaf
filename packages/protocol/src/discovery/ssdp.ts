import dgram from 'node:dgram';
import { DEFAULT_API_PORT } from '../http/client.js';
import type { DiscoveredDevice } from '../model/types.js';

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;

/**
 * Search targets Nanoleaf devices answer to.
 *
 * The product-specific ones are matched by devices that ignore `ssdp:all`, and
 * `ssdp:all` catches anything Nanoleaf adds later. Sending all of them costs
 * three small datagrams.
 */
const SEARCH_TARGETS = [
  'nanoleaf_aurora:light', // Light Panels / Aurora
  'nanoleaf:nl29', // Canvas
  'ssdp:all',
] as const;

function mSearch(target: string, mx: number): Buffer {
  return Buffer.from(
    [
      'M-SEARCH * HTTP/1.1',
      `HOST: ${SSDP_ADDR}:${SSDP_PORT}`,
      'MAN: "ssdp:discover"',
      `MX: ${mx}`,
      `ST: ${target}`,
      '',
      '',
    ].join('\r\n'),
    'ascii',
  );
}

function parseHeaders(message: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of message.split(/\r?\n/).slice(1)) {
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    headers[line.slice(0, sep).trim().toLowerCase()] = line.slice(sep + 1).trim();
  }
  return headers;
}

export interface SsdpOptions {
  timeoutMs?: number;
  onDevice?: (device: DiscoveredDevice) => void;
  signal?: AbortSignal;
}

/**
 * Discover Nanoleaf devices over SSDP.
 *
 * This exists as a second opinion for networks where mDNS does not work — plenty
 * of consumer APs have "multicast optimisation" or client isolation that eats
 * mDNS specifically, and a user on one of those networks otherwise concludes the
 * app is broken. SSDP uses a different multicast group and often survives.
 */
export function discoverSsdp(opts: SsdpOptions = {}): Promise<DiscoveredDevice[]> {
  const timeoutMs = opts.timeoutMs ?? 3_000;
  const mx = Math.max(1, Math.floor(timeoutMs / 1000) - 1);

  return new Promise((resolve) => {
    const found = new Map<string, DiscoveredDevice>();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', finish);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve([...found.values()]);
    };

    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    opts.signal?.addEventListener('abort', finish, { once: true });

    socket.on('error', finish);

    socket.on('message', (msg, rinfo) => {
      const text = msg.toString('ascii');
      if (!/^HTTP\/1\.1 200 OK/i.test(text)) return;

      const headers = parseHeaders(text);
      const st = headers['st'] ?? '';
      const location = headers['location'] ?? '';

      // Only keep responses that are plausibly Nanoleaf: either the search
      // target names it, or the Location points at the Nanoleaf API port.
      const isNanoleaf =
        st.startsWith('nanoleaf') || location.includes(`:${DEFAULT_API_PORT}`);
      if (!isNanoleaf) return;

      let ip = rinfo.address;
      let port = DEFAULT_API_PORT;
      if (location) {
        try {
          const url = new URL(location);
          ip = url.hostname || ip;
          if (url.port) port = Number(url.port);
        } catch {
          /* keep the datagram's source address */
        }
      }

      const key = `${ip}:${port}`;
      if (found.has(key)) return;

      const device: DiscoveredDevice = { ip, port, source: 'ssdp' };
      const name = headers['nl-devicename'];
      if (name) device.name = name;
      found.set(key, device);
      opts.onDevice?.(device);
    });

    socket.bind(() => {
      try {
        socket.setBroadcast(true);
      } catch {
        /* not fatal */
      }
      for (const target of SEARCH_TARGETS) {
        const payload = mSearch(target, mx);
        socket.send(payload, SSDP_PORT, SSDP_ADDR, (err) => {
          if (err) {
            /* one failed target should not abort the search */
          }
        });
      }
    });
  });
}
