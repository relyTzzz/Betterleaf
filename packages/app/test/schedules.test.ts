import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The main process modules import Electron for userData paths and safeStorage.
// Under vitest there is no Electron, so stand in for the two things they use.
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
  safeStorage: { isEncryptionAvailable: () => false },
}));

const { DeviceRegistry } = await import('../src/main/registry.js');
const { EffectHarvester } = await import('../src/main/effects/harvester.js');
const { EffectLibrary } = await import('../src/main/effects/library.js');
const { RoomStore } = await import('../src/main/room-store.js');
const { ScheduleStore } = await import('../src/main/schedule-store.js');
const { Scheduler, mostRecentOccurrence, nextOccurrence } = await import(
  '../src/main/scheduler.js'
);
const { DeviceStore } = await import('../src/main/store.js');
const { startSimulator } = await import('../../../tools/simulator/src/index.js');

type Sim = Awaited<ReturnType<typeof startSimulator>>;
type ScheduleTarget = import('../src/shared/types.js').ScheduleTarget;
type ScheduleAction = import('../src/shared/types.js').ScheduleAction;

let dir: string;
let sims: Sim[] = [];
let registry: InstanceType<typeof DeviceRegistry> | undefined;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'betterleaf-sched-'));
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

/** Local-time epoch ms, so tests read the same way the scheduler thinks. */
function at(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

// 2024-03-06 was a Wednesday.
const WED_9AM = at(2024, 3, 6, 9);

describe('when a schedule is due', () => {
  const everyDay = { timeMinutes: 7 * 60, days: [0, 1, 2, 3, 4, 5, 6] };

  it('finds this morning as the most recent slot', () => {
    expect(mostRecentOccurrence(everyDay, WED_9AM)).toBe(at(2024, 3, 6, 7));
  });

  it('falls back to yesterday before the time has come round', () => {
    const wed6am = at(2024, 3, 6, 6);
    expect(mostRecentOccurrence(everyDay, wed6am)).toBe(at(2024, 3, 5, 7));
  });

  it('looks back across a whole week for a once-weekly schedule', () => {
    // Sundays only, asked on a Wednesday: the last one was three days ago.
    const sundays = { timeMinutes: 7 * 60, days: [0] };
    expect(mostRecentOccurrence(sundays, WED_9AM)).toBe(at(2024, 3, 3, 7));
  });

  it('never fires a schedule with no days', () => {
    const noDays = { timeMinutes: 7 * 60, days: [] };
    expect(mostRecentOccurrence(noDays, WED_9AM)).toBeUndefined();
    expect(nextOccurrence(noDays, WED_9AM)).toBeUndefined();
  });

  it('reports the next slot as strictly in the future', () => {
    // Exactly on the minute: the slot happening right now counts as past, so
    // "next" must be tomorrow rather than this same instant.
    const wed7am = at(2024, 3, 6, 7);
    expect(mostRecentOccurrence(everyDay, wed7am)).toBe(wed7am);
    expect(nextOccurrence(everyDay, wed7am)).toBe(at(2024, 3, 7, 7));
  });

  it('keeps the wall-clock hour across a spring-forward boundary', () => {
    // US DST began 2024-03-10. A 07:00 schedule is at 07:00 local on both
    // sides of it, which is only true because slots are built from local date
    // components rather than by subtracting 24 hours.
    const monAfter = at(2024, 3, 11, 9);
    const slot = mostRecentOccurrence(everyDay, monAfter);
    expect(new Date(slot!).getHours()).toBe(7);
    expect(new Date(slot!).getDate()).toBe(11);
  });
});

describe('the scheduler', () => {
  /** A scheduler over a temp store, recording what it would have applied. */
  async function scheduler(nowRef: { value: number }) {
    const store = new ScheduleStore(path.join(dir, 'schedules.json'));
    const applied: { target: ScheduleTarget; action: ScheduleAction }[] = [];
    let fail: string | undefined;

    const engine = new Scheduler(
      store,
      async (target, action) => {
        if (fail) throw new Error(fail);
        applied.push({ target, action });
      },
      { now: () => nowRef.value, graceMs: 120_000 },
    );
    return { store, engine, applied, failWith: (msg?: string) => (fail = msg) };
  }

  const target: ScheduleTarget = { kind: 'device', serialNo: 'ABC123' };

  async function addSchedule(
    store: InstanceType<typeof ScheduleStore>,
    timeMinutes: number,
    createdAt: number,
  ) {
    const created = await store.create({
      name: 'Morning',
      enabled: true,
      target,
      timeMinutes,
      days: [0, 1, 2, 3, 4, 5, 6],
      action: { power: true, effect: 'Nemo' },
    });
    // `create` claims the current slot using the real clock; rewrite it to the
    // test's clock so the fixture is not at the mercy of when it runs.
    await store.recordRun(created.id, createdAt, 'ok');
    return created.id;
  }

  it('fires a schedule once its time arrives', async () => {
    const now = { value: at(2024, 3, 6, 6, 50) };
    const { store, engine, applied } = await scheduler(now);
    await addSchedule(store, 7 * 60, at(2024, 3, 5, 7));

    await engine.tick();
    expect(applied).toHaveLength(0); // 06:50, not yet

    now.value = at(2024, 3, 6, 7, 0);
    await engine.tick();
    expect(applied).toHaveLength(1);
    expect(applied[0]?.action).toEqual({ power: true, effect: 'Nemo' });
  });

  it('does not fire the same slot twice, however often it ticks', async () => {
    const now = { value: at(2024, 3, 6, 7, 0) };
    const { store, engine, applied } = await scheduler(now);
    await addSchedule(store, 7 * 60, at(2024, 3, 5, 7));

    await engine.tick();
    now.value = at(2024, 3, 6, 7, 1);
    await engine.tick();
    now.value = at(2024, 3, 6, 8, 0);
    await engine.tick();

    expect(applied).toHaveLength(1);
  });

  it('fires again the next day', async () => {
    const now = { value: at(2024, 3, 6, 7, 0) };
    const { store, engine, applied } = await scheduler(now);
    await addSchedule(store, 7 * 60, at(2024, 3, 5, 7));

    await engine.tick();
    now.value = at(2024, 3, 7, 7, 0);
    await engine.tick();

    expect(applied).toHaveLength(2);
  });

  it('records a slot it slept through as missed instead of firing it late', async () => {
    // The machine was off overnight and came back at 11am. Turning the lights
    // on four hours late is the wrong answer, not a late right one.
    const now = { value: at(2024, 3, 6, 11, 0) };
    const { store, engine, applied } = await scheduler(now);
    const id = await addSchedule(store, 7 * 60, at(2024, 3, 5, 7));

    await engine.tick();

    expect(applied).toHaveLength(0);
    const saved = (await store.load()).find((s) => s.id === id);
    expect(saved?.lastResult).toBe('missed');
    // The slot is claimed, so it is not retried on every tick for the rest of
    // the day.
    expect(saved?.lastRunAt).toBe(at(2024, 3, 6, 7));
  });

  it('still fires when it is only slightly late', async () => {
    const now = { value: at(2024, 3, 6, 7, 1) };
    const { store, engine, applied } = await scheduler(now);
    await addSchedule(store, 7 * 60, at(2024, 3, 5, 7));

    await engine.tick();
    expect(applied).toHaveLength(1);
  });

  it('survives a restart without re-firing what already ran', async () => {
    const now = { value: at(2024, 3, 6, 7, 0) };
    const first = await scheduler(now);
    await addSchedule(first.store, 7 * 60, at(2024, 3, 5, 7));
    await first.engine.tick();
    expect(first.applied).toHaveLength(1);

    // A second scheduler over the same file, as if the app had been restarted.
    now.value = at(2024, 3, 6, 7, 1);
    const second = await scheduler(now);
    await second.engine.tick();
    expect(second.applied).toHaveLength(0);
  });

  it('skips a paused schedule and resumes without back-firing', async () => {
    const now = { value: at(2024, 3, 6, 6, 0) };
    const { store, engine, applied } = await scheduler(now);
    const id = await addSchedule(store, 7 * 60, at(2024, 3, 5, 7));

    await store.setEnabled(id, false);
    now.value = at(2024, 3, 6, 7, 0);
    await engine.tick();
    expect(applied).toHaveLength(0);

    // Re-enabled at 9am: this morning's slot is already gone and must not fire
    // retroactively the moment the switch flips.
    now.value = at(2024, 3, 6, 9, 0);
    await store.setEnabled(id, true);
    await engine.tick();
    expect(applied).toHaveLength(0);
  });

  it('records why a firing failed rather than claiming it worked', async () => {
    const now = { value: at(2024, 3, 6, 7, 0) };
    const { store, engine, failWith } = await scheduler(now);
    const id = await addSchedule(store, 7 * 60, at(2024, 3, 5, 7));

    failWith('That light is not connected.');
    await engine.tick();

    const saved = (await store.load()).find((s) => s.id === id);
    expect(saved?.lastResult).toBe('That light is not connected.');
    // The slot is still claimed: retrying every 20 seconds against a light that
    // is not there is the storm this codebase avoids everywhere else.
    expect(saved?.lastRunAt).toBe(at(2024, 3, 6, 7));
  });
});

describe('the schedule store', () => {
  it('drops entries that are structurally unusable', async () => {
    const file = path.join(dir, 'schedules.json');
    await fs.writeFile(
      file,
      JSON.stringify({
        version: 1,
        schedules: [
          { id: 'good', name: 'Fine', target: { kind: 'room', roomId: 'r1' }, timeMinutes: 400, days: [1], action: { power: true } },
          { id: 'no-target', name: 'Broken', timeMinutes: 400, days: [1], action: {} },
          { name: 'No id', target: { kind: 'room', roomId: 'r1' }, timeMinutes: 1, days: [1], action: {} },
        ],
      }),
      'utf8',
    );

    const store = new ScheduleStore(file);
    const loaded = await store.load();
    expect(loaded.map((s) => s.id)).toEqual(['good']);
  });

  it('clamps nonsense values instead of passing them to the lights', async () => {
    const file = path.join(dir, 'schedules.json');
    await fs.writeFile(
      file,
      JSON.stringify({
        version: 1,
        schedules: [
          {
            id: 'wild',
            name: 'Wild',
            target: { kind: 'device', serialNo: 'X' },
            timeMinutes: 99_999,
            days: [1, 1, 9, -2, 3],
            action: { brightness: 5_000, effect: '', power: 'yes' },
          },
        ],
      }),
      'utf8',
    );

    const [schedule] = await new ScheduleStore(file).load();
    expect(schedule?.timeMinutes).toBe(1439);
    expect(schedule?.days).toEqual([1, 3]);
    expect(schedule?.action).toEqual({ brightness: 100 });
  });
});

describe('schedules against devices', () => {
  /** A registry backed by temp files, with simulated devices already paired. */
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
        lastSeenAt: Date.now(),
      })),
    );

    const library = new EffectLibrary(path.join(dir, 'library.json'));
    registry = new DeviceRegistry(
      deviceStore,
      new RoomStore(path.join(dir, 'rooms.json')),
      { enableMdns: false, enableSsdp: false, enableSweep: false },
      library,
      new EffectHarvester(library),
      new ScheduleStore(path.join(dir, 'schedules.json')),
      // Never tick on its own: every test drives firing explicitly.
      { tickMs: 3_600_000 },
    );
    await registry.start();
    await waitFor(
      () => registry!.snapshot().devices.length === started.length,
      'devices adopted',
    );
    return { sims: started, registry: registry! };
  }

  it('applies a scene and brightness to a single light', async () => {
    const { sims: started, registry: reg } = await setup(['NL29']);
    const serialNo = started[0]!.serialNo;
    const effect = reg.snapshot().devices[0]!.effects[0]!;

    const id = await reg.createSchedule({
      name: 'Evening',
      enabled: true,
      target: { kind: 'device', serialNo },
      timeMinutes: 20 * 60,
      days: [0, 1, 2, 3, 4, 5, 6],
      action: { power: true, effect, brightness: 42 },
    });

    const result = await reg.runScheduleNow(id);
    expect(result.ok).toBe(true);

    await waitFor(
      () => started[0]!.info.effects.select === effect,
      'effect applied',
    );
    await waitFor(() => started[0]!.info.state.brightness.value === 42, 'brightness');
    expect(started[0]!.info.state.on.value).toBe(true);
  });

  it('turns a whole room off in one go', async () => {
    const { sims: started, registry: reg } = await setup(['NL29', 'NL22']);
    const roomId = await reg.createRoom('Office');
    for (const sim of started) await reg.assignDevice(sim.serialNo, roomId);

    const id = await reg.createSchedule({
      name: 'Bedtime',
      enabled: true,
      target: { kind: 'room', roomId },
      timeMinutes: 23 * 60,
      days: [0, 1, 2, 3, 4, 5, 6],
      action: { power: false },
    });

    expect((await reg.runScheduleNow(id)).ok).toBe(true);
    for (const sim of started) {
      await waitFor(() => sim.info.state.on.value === false, `${sim.serialNo} off`);
    }
  });

  it('refuses a scene the target does not have, and says which', async () => {
    const { sims: started, registry: reg } = await setup(['NL29']);
    const id = await reg.createSchedule({
      name: 'Impossible',
      enabled: true,
      target: { kind: 'device', serialNo: started[0]!.serialNo },
      timeMinutes: 60,
      days: [1],
      action: { effect: 'Not A Real Scene' },
    });

    const result = await reg.runScheduleNow(id);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Not A Real Scene');
  });

  it('forgetting a device takes its schedules with it', async () => {
    const { sims: started, registry: reg } = await setup(['NL29']);
    const serialNo = started[0]!.serialNo;
    await reg.createSchedule({
      name: 'Morning',
      enabled: true,
      target: { kind: 'device', serialNo },
      timeMinutes: 7 * 60,
      days: [1],
      action: { power: true },
    });
    expect(reg.snapshot().schedules).toHaveLength(1);

    await reg.forget(serialNo);

    // A schedule pointing at a device that no longer exists could never do
    // anything but fail every morning.
    expect(reg.snapshot().schedules).toHaveLength(0);
  });

  it('deleting a room takes its schedules with it', async () => {
    const { registry: reg } = await setup(['NL29']);
    const roomId = await reg.createRoom('Office');
    await reg.createSchedule({
      name: 'Morning',
      enabled: true,
      target: { kind: 'room', roomId },
      timeMinutes: 7 * 60,
      days: [1],
      action: { power: true },
    });

    await reg.deleteRoom(roomId);
    expect(reg.snapshot().schedules).toHaveLength(0);
  });

  it('lists schedules by time of day, not by when they were made', async () => {
    const { sims: started, registry: reg } = await setup(['NL29']);
    const target = { kind: 'device' as const, serialNo: started[0]!.serialNo };
    const base = {
      enabled: true,
      target,
      days: [0, 1, 2, 3, 4, 5, 6],
      action: { power: true },
    };

    // Created deliberately out of order.
    await reg.createSchedule({ ...base, name: 'Bedtime', timeMinutes: 23 * 60 });
    await reg.createSchedule({ ...base, name: 'Morning', timeMinutes: 7 * 60 });
    await reg.createSchedule({ ...base, name: 'Evening', timeMinutes: 18 * 60 + 30 });

    expect(reg.snapshot().schedules.map((s) => s.name)).toEqual([
      'Morning',
      'Evening',
      'Bedtime',
    ]);
  });

  it('breaks ties at the same time by name, so the order never jitters', async () => {
    const { sims: started, registry: reg } = await setup(['NL29']);
    const target = { kind: 'device' as const, serialNo: started[0]!.serialNo };
    const base = {
      enabled: true,
      target,
      timeMinutes: 7 * 60,
      days: [1],
      action: { power: true },
    };

    await reg.createSchedule({ ...base, name: 'Zebra' });
    await reg.createSchedule({ ...base, name: 'Apple' });

    expect(reg.snapshot().schedules.map((s) => s.name)).toEqual(['Apple', 'Zebra']);
  });

  it('shows the target name and the next run in the snapshot', async () => {
    const { registry: reg } = await setup(['NL29']);
    const roomId = await reg.createRoom('Office');
    await reg.createSchedule({
      name: 'Morning',
      enabled: true,
      target: { kind: 'room', roomId },
      timeMinutes: 7 * 60,
      days: [0, 1, 2, 3, 4, 5, 6],
      action: { power: true },
    });

    const [view] = reg.snapshot().schedules;
    expect(view?.targetName).toBe('Office');
    expect(view?.nextRunAt).toBeGreaterThan(Date.now());

    // Renaming the room must not leave the schedule naming the old one.
    await reg.renameRoom(roomId, 'Studio');
    expect(reg.snapshot().schedules[0]?.targetName).toBe('Studio');
  });
});
