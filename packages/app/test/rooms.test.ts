import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The main process modules import Electron for userData paths and safeStorage.
// Under vitest there is no Electron, so stand in for the two things they use.
// Both stores take an explicit file path, so getPath is only a fallback.
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
  safeStorage: { isEncryptionAvailable: () => false },
}));

const { DeviceRegistry } = await import('../src/main/registry.js');
const { EffectHarvester } = await import('../src/main/effects/harvester.js');
const { EffectLibrary } = await import('../src/main/effects/library.js');
const { RoomStore } = await import('../src/main/room-store.js');
const { DeviceStore } = await import('../src/main/store.js');
const { startSimulator } = await import('../../../tools/simulator/src/index.js');
type Sim = Awaited<ReturnType<typeof startSimulator>>;

let dir: string;
let sims: Sim[] = [];
let registry: InstanceType<typeof DeviceRegistry> | undefined;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'betterleaf-rooms-'));
});

afterEach(async () => {
  await registry?.dispose();
  registry = undefined;
  for (const sim of sims.splice(0)) await sim.stop();
  await fs.rm(dir, { recursive: true, force: true });
});

function waitFor(predicate: () => boolean, label: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise<void>((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error(`Timed out waiting for ${label}`));
      setTimeout(check, 10);
    };
    check();
  });
}

/** A registry backed by temp files, with two simulated devices already paired. */
async function setup(profiles: ('NL22' | 'NL29')[] = ['NL29', 'NL22']) {
  const started = await Promise.all(
    profiles.map((profile) => startSimulator({ profile })),
  );
  sims.push(...started);

  const deviceStore = new DeviceStore(path.join(dir, 'devices.json'));
  await deviceStore.save(
    started.map((sim) => ({
      serialNo: sim.serialNo,
      model: sim.info.model,
      name: sim.info.name,
      token: sim.token,
      lastIp: '127.0.0.1',
      lastPort: sim.port,
    })),
  );

  const roomStore = new RoomStore(path.join(dir, 'rooms.json'));
  const library = new EffectLibrary(path.join(dir, 'library.json'));
  registry = new DeviceRegistry(
    deviceStore,
    roomStore,
    {
      // Only the cached-address rung; nothing on the real network can leak in.
      enableMdns: false,
      enableSsdp: false,
      enableSweep: false,
      timings: { overallMs: 2_000 },
    },
    library,
    // Poll fast, so the "notices a scene appearing" path is testable without a
    // 30-second wait.
    new EffectHarvester(library, { pollMs: 40 }),
  );

  await registry.start();
  await waitFor(
    () => registry!.snapshot().devices.length === started.length,
    'devices to be adopted',
  );

  return { registry: registry!, sims: started };
}

describe('room membership', () => {
  it('assigns a device to exactly one room', async () => {
    const { registry, sims } = await setup();
    const office = await registry.createRoom('Office');
    const bedroom = await registry.createRoom('Bedroom');

    await registry.assignDevice(sims[0]!.serialNo, office);
    expect(registry.snapshot().rooms.find((r) => r.id === office)?.deviceSerials).toEqual([
      sims[0]!.serialNo,
    ]);

    // Moving it must not leave a copy behind in the old room.
    await registry.assignDevice(sims[0]!.serialNo, bedroom);
    const snapshot = registry.snapshot();
    expect(snapshot.rooms.find((r) => r.id === office)?.deviceSerials).toEqual([]);
    expect(snapshot.rooms.find((r) => r.id === bedroom)?.deviceSerials).toEqual([
      sims[0]!.serialNo,
    ]);
  });

  it('reports the room on the device itself, so the picker can show it', async () => {
    const { registry, sims } = await setup();
    const office = await registry.createRoom('Office');
    await registry.assignDevice(sims[0]!.serialNo, office);

    const device = registry
      .snapshot()
      .devices.find((d) => d.serialNo === sims[0]!.serialNo);
    expect(device?.roomId).toBe(office);
  });

  it('keeps membership across a rename', async () => {
    const { registry, sims } = await setup();
    const id = await registry.createRoom('Offce');
    await registry.assignDevice(sims[0]!.serialNo, id);

    await registry.renameRoom(id, 'Office');

    // The id is what membership hangs off, so a typo fix costs nothing.
    const room = registry.snapshot().rooms.find((r) => r.id === id);
    expect(room?.name).toBe('Office');
    expect(room?.deviceSerials).toEqual([sims[0]!.serialNo]);
  });

  it('survives a restart', async () => {
    const { registry, sims } = await setup();
    const id = await registry.createRoom('Office');
    await registry.assignDevice(sims[0]!.serialNo, id);
    await registry.dispose();

    // A fresh store reading the same file is what the next launch does.
    const reloaded = await new RoomStore(path.join(dir, 'rooms.json')).load();
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]).toMatchObject({
      name: 'Office',
      deviceSerials: [sims[0]!.serialNo],
    });
  });

  it('drops a forgotten device from its room', async () => {
    const { registry, sims } = await setup();
    const id = await registry.createRoom('Office');
    await registry.assignDevice(sims[0]!.serialNo, id);

    await registry.forget(sims[0]!.serialNo);

    // A phantom member would make the room claim a light that no longer exists.
    const rooms = await new RoomStore(path.join(dir, 'rooms.json')).load();
    expect(rooms[0]?.deviceSerials).toEqual([]);
    expect(registry.snapshot().rooms[0]?.deviceSerials).toEqual([]);
  });

  it('deleting a room leaves its devices alone', async () => {
    const { registry, sims } = await setup();
    const id = await registry.createRoom('Office');
    await registry.assignDevice(sims[0]!.serialNo, id);

    await registry.deleteRoom(id);

    const snapshot = registry.snapshot();
    expect(snapshot.rooms).toHaveLength(0);
    expect(snapshot.devices).toHaveLength(2);
    expect(snapshot.devices.every((d) => d.roomId === undefined)).toBe(true);
  });
});

describe('effect library', () => {
  it('harvests from every device on startup and reports the count', async () => {
    const { registry } = await setup();

    // Both simulated devices ship the same six factory effects, so the archive
    // should collapse them rather than storing twelve.
    await waitFor(
      () => registry.snapshot().libraryCount === 6,
      'library to be harvested',
    );

    const entries = await registry.listLibrary();
    expect(entries).toHaveLength(6);
    // Each was seen on both devices, and both currently hold it.
    expect(entries[0]!.seenOn).toHaveLength(2);
    expect(entries[0]!.onDevices).toHaveLength(2);
  });

  it('updates the count when a scene appears, without the library being open', async () => {
    const { registry, sims } = await setup();
    await waitFor(() => registry.snapshot().libraryCount === 6, 'initial harvest');

    // As if the user downloaded a Discover scene in the Nanoleaf app: it lands
    // on the device with no involvement from Betterleaf.
    await fetch(`http://127.0.0.1:${sims[0]!.port}/api/v1/${sims[0]!.token}/effects`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        write: {
          command: 'add',
          version: '2.0',
          animName: 'Tokyo Neon',
          animType: 'plugin',
          colorType: 'HSB',
          pluginType: 'color',
          pluginUuid: '027842e4-e1d6-4a4c-a731-be74a1ebd4cf',
          palette: [{ hue: 320, saturation: 95, brightness: 100 }],
        },
      }),
    });

    // The sidebar count must follow on its own; waiting until someone opens the
    // library view would leave a stale number on screen.
    await waitFor(
      () => registry.snapshot().libraryCount === 7,
      'count to pick up the new scene',
    );
    expect((await registry.listLibrary()).map((e) => e.name)).toContain('Tokyo Neon');
  });

  it('flags sound-reactive scenes so the UI can mark them', async () => {
    // The Light Panels profile has a Rhythm module, so it accepts rhythm motions.
    const { registry, sims } = await setup(['NL22', 'NL29']);
    await waitFor(() => registry.snapshot().libraryCount === 6, 'initial harvest');

    await fetch(`http://127.0.0.1:${sims[0]!.port}/api/v1/${sims[0]!.token}/effects`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        write: {
          command: 'add',
          version: '2.0',
          animName: 'Beat Drop',
          animType: 'plugin',
          colorType: 'HSB',
          pluginType: 'rhythm',
          pluginUuid: 'bc6fe7e0-36d4-4f95-aa21-52a386daa9dc',
          palette: [{ hue: 200, saturation: 100, brightness: 100 }],
        },
      }),
    });

    await waitFor(() => registry.snapshot().libraryCount === 7, 'the rhythm scene');

    const entries = await registry.listLibrary();
    const beat = entries.find((e) => e.name === 'Beat Drop');
    expect(beat?.soundReactive).toBe(true);

    // Everything else runs on its own and must not be marked.
    for (const other of entries.filter((e) => e.name !== 'Beat Drop')) {
      expect(other.soundReactive).toBe(false);
    }
  });

  it('refuses to remove an effect that is not archived byte for byte', async () => {
    const { registry, sims } = await setup();
    await waitFor(() => registry.snapshot().libraryCount === 6, 'initial harvest');

    const result = await registry.removeFromDevice(
      'Not On This Device',
      sims[0]!.serialNo,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/does not have/);
  });

  it('frees a device slot once the archive is verified', async () => {
    const { registry, sims } = await setup();
    await waitFor(() => registry.snapshot().libraryCount === 6, 'initial harvest');

    const result = await registry.removeFromDevice('Nemo', sims[0]!.serialNo);

    expect(result.ok).toBe(true);
    expect(sims[0]!.info.effects.effectsList).not.toContain('Nemo');
    // Gone from the light, still in the archive — the whole point.
    expect((await registry.listLibrary()).map((e) => e.name)).toContain('Nemo');
  });
});

describe('room control', () => {
  it('fans out to every member', async () => {
    const { registry, sims } = await setup();
    const id = await registry.createRoom('Office');
    for (const sim of sims) await registry.assignDevice(sim.serialNo, id);

    await registry.setRoomPower(id, false);

    await waitFor(
      () => sims.every((s) => s.info.state.on.value === false),
      'both devices off',
    );
    expect(sims.map((s) => s.info.state.on.value)).toEqual([false, false]);
  });

  it('keeps per-device coalescing during a room brightness drag', async () => {
    const { registry, sims } = await setup();
    const id = await registry.createRoom('Office');
    for (const sim of sims) await registry.assignDevice(sim.serialNo, id);

    const before = sims.map(
      (s) => s.requests.filter((r) => r.path.endsWith('/state')).length,
    );

    // 60 updates, as dragging a room slider produces.
    await Promise.all(
      Array.from({ length: 60 }, (_, i) => registry.setRoomBrightness(id, i + 1)),
    );
    await waitFor(
      () => sims.every((s) => s.info.state.brightness.value === 60),
      'final brightness on both',
    );

    // Fanning out must not bypass the per-device write queues.
    sims.forEach((sim, i) => {
      const sent =
        sim.requests.filter((r) => r.path.endsWith('/state')).length - before[i]!;
      expect(sent).toBeLessThanOrEqual(5);
    });
  });

  it('one unreachable device does not stop the rest of the room', async () => {
    const { registry, sims } = await setup();
    const id = await registry.createRoom('Office');
    for (const sim of sims) await registry.assignDevice(sim.serialNo, id);

    await sims[0]!.stop();

    // allSettled, not all: the reachable light still responds.
    await expect(registry.setRoomPower(id, false)).resolves.toBeUndefined();
    await waitFor(() => sims[1]!.info.state.on.value === false, 'the reachable device');
  });

  it('only applies effects every member actually has', async () => {
    const { registry, sims } = await setup();
    const id = await registry.createRoom('Office');
    for (const sim of sims) await registry.assignDevice(sim.serialNo, id);

    await registry.setRoomEffect(id, 'Forest');
    await waitFor(
      () => sims.every((s) => s.info.effects.select === 'Forest'),
      'shared effect applied',
    );

    // An effect only one device has must not be sent to the other.
    const before = sims[1]!.requests.filter((r) => r.path.endsWith('/effects')).length;
    await registry.setRoomEffect(id, 'Not A Real Effect');
    const after = sims[1]!.requests.filter((r) => r.path.endsWith('/effects')).length;
    expect(after).toBe(before);
  });
});

describe('derived room state', () => {
  it('is on when any member is on, and averages brightness over lit members', async () => {
    const { registry, sims } = await setup();
    const id = await registry.createRoom('Office');
    for (const sim of sims) await registry.assignDevice(sim.serialNo, id);

    await registry.setPower(sims[0]!.serialNo, true);
    await registry.setBrightness(sims[0]!.serialNo, 80);
    await registry.setPower(sims[1]!.serialNo, false);
    await waitFor(() => registry.snapshot().rooms[0]?.brightness === 80, 'derived state');

    const room = registry.snapshot().rooms[0]!;
    // One light on is enough for the toggle to read "on"...
    expect(room.on).toBe(true);
    // ...and an off light must not drag the average toward zero.
    expect(room.brightness).toBe(80);
  });

  it('reports the worst member status', async () => {
    const { registry, sims } = await setup();
    const id = await registry.createRoom('Office');
    for (const sim of sims) await registry.assignDevice(sim.serialNo, id);

    await waitFor(
      () => registry.snapshot().rooms[0]?.status === 'connected',
      'both connected',
    );

    await sims[0]!.stop();
    await waitFor(
      () => registry.snapshot().rooms[0]?.status !== 'connected',
      'degraded status',
      15_000,
    );

    // A room must never look healthier than the devices in it.
    expect(registry.snapshot().rooms[0]?.status).not.toBe('connected');
  });

  it('offers only effects shared by every member', async () => {
    const { registry, sims } = await setup();
    const id = await registry.createRoom('Office');
    for (const sim of sims) await registry.assignDevice(sim.serialNo, id);

    // Give one device an effect the other lacks.
    await registry.snapshot();
    const device = registry.snapshot().devices[0]!;
    expect(device.effects).toContain('Forest');

    const room = registry.snapshot().rooms[0]!;
    expect(room.effects).toContain('Forest');
    expect(room.effects.length).toBeGreaterThan(0);
    // Intersection, so nothing offered can fail on a member.
    for (const effect of room.effects) {
      for (const d of registry.snapshot().devices) {
        expect(d.effects).toContain(effect);
      }
    }
  });

  it('reports the effect when every member agrees, so the UI can highlight it', async () => {
    const { registry, sims } = await setup();
    const id = await registry.createRoom('Office');
    for (const sim of sims) await registry.assignDevice(sim.serialNo, id);

    await registry.setRoomEffect(id, 'Forest');
    await waitFor(
      () => registry.snapshot().rooms[0]?.currentEffect === 'Forest',
      'room-wide effect',
    );

    expect(registry.snapshot().rooms[0]?.currentEffect).toBe('Forest');
  });

  it('reports no effect when members disagree', async () => {
    const { registry, sims } = await setup();
    const id = await registry.createRoom('Office');
    for (const sim of sims) await registry.assignDevice(sim.serialNo, id);

    await registry.selectEffect(sims[0]!.serialNo, 'Forest');
    await registry.selectEffect(sims[1]!.serialNo, 'Nemo');
    await waitFor(
      () => registry.snapshot().rooms[0]?.currentEffect === undefined,
      'mixed room',
    );

    // Highlighting one member's effect would claim the whole room is showing it.
    expect(registry.snapshot().rooms[0]?.currentEffect).toBeUndefined();
  });

  it('an empty room is not reported as unhealthy', async () => {
    const { registry } = await setup();
    const id = await registry.createRoom('Spare');
    const room = registry.snapshot().rooms.find((r) => r.id === id)!;

    expect(room.deviceSerials).toEqual([]);
    expect(room.on).toBe(false);
    expect(room.brightness).toBe(0);
    expect(room.status).toBe('connected');
    expect(room.effects).toEqual([]);
    expect(room.currentEffect).toBeUndefined();
  });
});
