import { Bonjour, type Service } from 'bonjour-service';
import { DEFAULT_API_PORT } from '../http/client.js';
import type { DiscoveredDevice } from '../model/types.js';

/**
 * Nanoleaf advertises under two different service types depending on vintage.
 *
 * `_nanoleafapi._tcp` is the current one (Canvas, Shapes, Lines). Original
 * Light Panels / Aurora announce `_nanoleafms._tcp` instead, and a browser that
 * only knows the modern name simply never sees an NL22. Betterleaf browses both,
 * which is exactly the case that matters here since the target hardware is one
 * of each.
 */
export const MDNS_SERVICE_TYPES = ['nanoleafapi', 'nanoleafms'] as const;

export interface MdnsBrowseOptions {
  /** How long to keep listening. */
  timeoutMs?: number;
  onDevice?: (device: DiscoveredDevice) => void;
  signal?: AbortSignal;
}

function toDiscovered(service: Service): DiscoveredDevice | undefined {
  const address =
    service.addresses?.find((a) => a.includes('.')) ?? service.referer?.address;
  if (!address) return undefined;

  // TXT keys are lowercase by convention: md = model, srcvers = firmware.
  const txt = (service.txt ?? {}) as Record<string, string>;

  const device: DiscoveredDevice = {
    ip: address,
    port: service.port ?? DEFAULT_API_PORT,
    source: 'mdns',
  };
  if (service.name) device.name = service.name;
  if (txt['md']) device.model = txt['md'];
  if (txt['srcvers']) device.firmwareVersion = txt['srcvers'];
  return device;
}

/**
 * Browse for Nanoleaf devices over mDNS.
 *
 * Note that mDNS gives us an address and a model but never a serial number, so
 * results are candidates: the caller probes each one to establish identity.
 */
export function browseMdns(
  opts: MdnsBrowseOptions = {},
): Promise<DiscoveredDevice[]> {
  const timeoutMs = opts.timeoutMs ?? 3_000;

  return new Promise((resolve) => {
    const found = new Map<string, DiscoveredDevice>();
    const bonjour = new Bonjour();
    const browsers = MDNS_SERVICE_TYPES.map((type) =>
      bonjour.find({ type, protocol: 'tcp' }, (service) => {
        const device = toDiscovered(service);
        if (!device) return;
        const key = `${device.ip}:${device.port}`;
        if (found.has(key)) return;
        found.set(key, device);
        opts.onDevice?.(device);
      }),
    );

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', finish);
      for (const browser of browsers) browser.stop();
      bonjour.destroy();
      resolve([...found.values()]);
    };

    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    opts.signal?.addEventListener('abort', finish, { once: true });
  });
}
