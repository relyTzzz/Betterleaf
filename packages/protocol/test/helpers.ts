import { NanoleafDevice } from '../src/device/device.js';
import type { DeviceInfo, DeviceRecord } from '../src/model/types.js';
import {
  startSimulator,
  type NanoleafSimulator,
} from '../../../tools/simulator/src/index.js';
import type { ProfileName } from '../../../tools/simulator/src/profiles.js';

export async function simDevice(
  profile: ProfileName,
  opts: {
    connect?: boolean;
    flushMs?: number;
    /** Report streamControlPort so UDP frames reach the simulator's random port. */
    reportsStreamPort?: boolean;
  } = {},
): Promise<{ sim: NanoleafSimulator; device: NanoleafDevice; cleanup: () => Promise<void> }> {
  const sim = await startSimulator({
    profile,
    ...(opts.reportsStreamPort !== undefined
      ? { reportsStreamPort: opts.reportsStreamPort }
      : {}),
  });

  const record: DeviceRecord = {
    serialNo: sim.serialNo,
    model: sim.info.model,
    name: sim.info.name,
    token: sim.token,
    lastIp: '127.0.0.1',
    lastPort: sim.port,
  };

  const device = new NanoleafDevice({
    record,
    info: sim.info as DeviceInfo,
    ...(opts.flushMs !== undefined ? { flushMs: opts.flushMs } : {}),
  });

  // Swallow expected transport noise so an unhandled 'error' doesn't kill the run.
  device.on('error', () => {});

  if (opts.connect !== false) device.connect();

  return {
    sim,
    device,
    cleanup: async () => {
      await device.close();
      await sim.stop();
    },
  };
}

export function waitFor(
  predicate: () => boolean,
  opts: { timeoutMs?: number; label?: string } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) {
        return reject(new Error(`Timed out waiting for ${opts.label ?? 'condition'}`));
      }
      setTimeout(check, 10);
    };
    check();
  });
}

export function nextEvent<T>(
  emitter: { once: (name: string, fn: (arg: T) => void) => unknown },
  name: string,
  timeoutMs = 5_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for '${name}'`)),
      timeoutMs,
    );
    emitter.once(name, (arg: T) => {
      clearTimeout(timer);
      resolve(arg);
    });
  });
}
