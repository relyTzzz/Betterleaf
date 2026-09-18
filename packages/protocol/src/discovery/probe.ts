import net from 'node:net';
import { DEFAULT_API_PORT } from '../http/client.js';
import { rawRequest } from '../http/transport.js';
import type { DeviceInfo, DiscoveredDevice } from '../model/types.js';

export interface ProbeResult extends DiscoveredDevice {
  /** Present only when a valid token let us read the device document. */
  info?: DeviceInfo;
  /** A Nanoleaf answered, but our token was rejected. */
  needsPairing?: boolean;
}

/**
 * Is there a Nanoleaf at this address, and is it *ours*?
 *
 * With a token we get the whole device document back, which includes the serial
 * number — the only identity Betterleaf trusts. Without one, a 401/403 is still
 * a positive result: something at that address speaks the Nanoleaf API and is
 * waiting to be paired.
 */
export async function probeDevice(
  host: string,
  opts: {
    port?: number;
    token?: string;
    timeoutMs?: number;
    source?: DiscoveredDevice['source'];
    signal?: AbortSignal;
  } = {},
): Promise<ProbeResult | undefined> {
  const port = opts.port ?? DEFAULT_API_PORT;
  const token = opts.token ?? 'betterleaf-probe';
  const source = opts.source ?? 'manual';

  let res;
  try {
    res = await rawRequest({
      host,
      port,
      method: 'GET',
      path: `/api/v1/${token}/`,
      // Short by design: this runs against every cached address at launch and
      // must not hold the UI up for a device that has been unplugged.
      timeoutMs: opts.timeoutMs ?? 800,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch {
    return undefined;
  }

  if (res.status === 401 || res.status === 403) {
    return { ip: host, port, source, needsPairing: true };
  }
  if (res.status < 200 || res.status >= 300) return undefined;

  try {
    const info = JSON.parse(res.body) as DeviceInfo;
    if (typeof info.serialNo !== 'string' || typeof info.model !== 'string') {
      return undefined;
    }
    return {
      ip: host,
      port,
      source,
      serialNo: info.serialNo,
      model: info.model,
      name: info.name,
      firmwareVersion: info.firmwareVersion,
      info,
    };
  } catch {
    return undefined;
  }
}

/**
 * Cheap liveness check: can we open a TCP connection to the API port?
 *
 * Used by the subnet sweep, where running a full HTTP probe against 254 hosts
 * would be needlessly slow. A successful connect is only a hint — the caller
 * still runs {@link probeDevice} to confirm it is really a Nanoleaf.
 */
export function tcpReachable(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;

    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}
