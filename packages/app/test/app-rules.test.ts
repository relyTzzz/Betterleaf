import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
  safeStorage: { isEncryptionAvailable: () => false },
}));

const { AppRuleStore, targetKey } = await import('../src/main/app-rule-store.js');
const { AppRuleEngine, stillHolding } = await import('../src/main/app-rules.js');
const { matchProcess, normaliseEntry, parseTasklist, parsePs } = await import(
  '../src/main/process-watch.js'
);
const { DeviceRegistry } = await import('../src/main/registry.js');
const { EffectHarvester } = await import('../src/main/effects/harvester.js');
const { EffectLibrary } = await import('../src/main/effects/library.js');
const { LockStore } = await import('../src/main/lock-store.js');
const { RoomStore } = await import('../src/main/room-store.js');
const { ScheduleStore } = await import('../src/main/schedule-store.js');
const { DeviceStore } = await import('../src/main/store.js');
const { startSimulator } = await import('../../../tools/simulator/src/index.js');

type Sim = Awaited<ReturnType<typeof startSimulator>>;
type CapturedDevice = import('../src/main/app-rule-store.js').CapturedDevice;
type ScheduleAction = import('../src/shared/types.js').ScheduleAction;
type ScheduleTarget = import('../src/shared/types.js').ScheduleTarget;
type ProcessSnapshot = import('../src/main/process-watch.js').ProcessSnapshot;

/** A process list holding only bare image names, as `tasklist` gives. */
function namesOnly(...names: string[]): ProcessSnapshot {
  return { names: new Set(names), paths: new Set() };
}

let dir: string;
let sims: Sim[] = [];
let registry: InstanceType<typeof DeviceRegistry> | undefined;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'betterleaf-rules-'));
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

describe('reading the process list', () => {
  it('takes only the first CSV column, whatever the window title contains', () => {
    // A title with commas and quotes in it must not shift the column we read.
    const stdout =
      '"Overwatch.exe","1234","Console","1","2,345 K"\r\n' +
      '"chrome.exe","99","Console","1","10 K"\r\n';
    expect(parseTasklist(stdout).names).toEqual(
      new Set(['overwatch.exe', 'chrome.exe']),
    );
    // tasklist cannot give paths at all, which is why it is only the fallback.
    expect(parseTasklist(stdout).paths.size).toBe(0);
  });

  it('reads both the basename and the full path from ps', () => {
    const parsed = parsePs('/usr/bin/firefox\n/bin/zsh\n');
    expect(parsed.names).toEqual(new Set(['firefox', 'zsh']));
    expect(parsed.paths).toEqual(new Set(['/usr/bin/firefox', '/bin/zsh']));
  });

  it('tolerates a name written without .exe', () => {
    const running = namesOnly('overwatch.exe');
    expect(matchProcess(['overwatch'], running)).toBe('overwatch.exe');
    expect(matchProcess(['Overwatch.EXE'], running)).toBe('overwatch.exe');
    expect(matchProcess(['notepad'], running)).toBeUndefined();
  });

  it('matches when any of several names is running', () => {
    expect(matchProcess(['steam.exe', 'vlc.exe'], namesOnly('vlc.exe'))).toBe('vlc.exe');
  });

  it('matches an exact path, however it was typed', () => {
    const lol = 'c:\\riot games\\league of legends\\game\\league of legends.exe';
    const running: ProcessSnapshot = {
      names: new Set(['league of legends.exe']),
      paths: new Set([lol]),
    };

    const typed = 'C:\\Riot Games\\League of Legends\\Game\\League of Legends.exe';
    expect(matchProcess([typed], running)).toBe(lol);
    // Forward slashes, because people type them out of habit.
    expect(
      matchProcess(['C:/Riot Games/League of Legends/Game/League of Legends.exe'], running),
    ).toBe(lol);
    // Explorer's "copy as path" wraps the whole thing in quotes.
    expect(matchProcess([`"${typed}"`], running)).toBe(lol);
  });

  it('does not let a path match the same name running from somewhere else', () => {
    // Precision is the entire point of writing a path out: an unrelated
    // launcher.exe must not satisfy a rule aimed at one specific program.
    const running: ProcessSnapshot = {
      names: new Set(['launcher.exe']),
      paths: new Set(['c:\\other\\launcher.exe']),
    };
    expect(matchProcess(['c:\\games\\mine\\launcher.exe'], running)).toBeUndefined();
    // A bare name still matches whatever is running under that name.
    expect(matchProcess(['launcher.exe'], running)).toBe('launcher.exe');
  });

  it('cannot match a path for a process that would not give one', () => {
    // About half a real process list has no path, because those run at a higher
    // integrity level than Betterleaf. A path rule simply will not match them.
    const running = namesOnly('league of legends.exe');
    expect(matchProcess(['c:\\riot\\league of legends.exe'], running)).toBeUndefined();
  });

  it('normalises quotes, slashes and case the same way everywhere', () => {
    expect(normaliseEntry('  "C:/Games/A.EXE" ', 'win32')).toBe('c:\\games\\a.exe');
  });

  it('leaves POSIX separators alone', () => {
    // A slash is the only separator POSIX has; folding it to a backslash the
    // way Windows wants would turn every path into nonsense.
    expect(normaliseEntry('/usr/bin/Firefox', 'linux')).toBe('/usr/bin/firefox');
  });
});

describe('deciding whether to put the lights back', () => {
  const captured = (over: Partial<CapturedDevice> = {}): CapturedDevice => ({
    serialNo: 'X',
    on: true,
    brightness: 50,
    effect: 'Battle',
    ...over,
  });

  it('restores when the light still shows what the rule set', () => {
    expect(stillHolding(captured(), { effect: 'Battle' })).toBe(true);
  });

  it('leaves a light alone once you have changed it yourself', () => {
    // Putting the old scene back here would be undoing the user's change, not
    // tidying up after the rule.
    expect(stillHolding(captured({ effect: 'Forest' }), { effect: 'Battle' })).toBe(false);
  });

  it('falls back to brightness, then power, when no scene was set', () => {
    expect(stillHolding(captured(), { brightness: 50 })).toBe(true);
    expect(stillHolding(captured(), { brightness: 20 })).toBe(false);
    expect(stillHolding(captured({ on: false }), { power: false })).toBe(true);
  });

  it('never restores when the rule set nothing, or the light is gone', () => {
    expect(stillHolding(captured(), {})).toBe(false);
    expect(stillHolding(undefined, { effect: 'Battle' })).toBe(false);
  });
});

describe('the rule engine', () => {
  /** An engine over a temp store, against fake lights. */
  async function engineFor(running: Set<string>) {
    const store = new AppRuleStore(path.join(dir, 'app-rules.json'));
    const state = new Map<string, CapturedDevice>([
      ['A', { serialNo: 'A', on: true, brightness: 50, effect: 'Forest' }],
      ['B', { serialNo: 'B', on: true, brightness: 50, effect: 'Forest' }],
    ]);
    const applied: { target: ScheduleTarget; action: ScheduleAction }[] = [];

    const engine = new AppRuleEngine(
      store,
      async () => ({ names: running, paths: new Set<string>() }),
      {
        serialsFor: (target) =>
          target.kind === 'device' ? [target.serialNo] : ['A', 'B'],
        capture: (serials) =>
          serials.flatMap((s) => {
            const cur = state.get(s);
            return cur ? [{ ...cur }] : [];
          }),
        apply: async (target, action) => {
          applied.push({ target, action });
          const serials = target.kind === 'device' ? [target.serialNo] : ['A', 'B'];
          for (const s of serials) {
            const cur = state.get(s);
            if (!cur) continue;
            if (action.effect !== undefined) cur.effect = action.effect;
            if (action.brightness !== undefined) cur.brightness = action.brightness;
            if (action.power !== undefined) cur.on = action.power;
          }
        },
        restoreDevice: async (want) => {
          state.set(want.serialNo, { ...want });
        },
        current: (serial) => {
          const cur = state.get(serial);
          return cur ? { ...cur } : undefined;
        },
      },
      { pollMs: 3_600_000 },
    );

    return { store, engine, state, applied };
  }

  const deviceA: ScheduleTarget = { kind: 'device', serialNo: 'A' };

  it('plays a scene while the program is running, and puts it back after', async () => {
    const running = new Set(['game.exe']);
    const { store, engine, state } = await engineFor(running);
    await store.create({
      name: 'Gaming',
      enabled: true,
      processNames: ['game.exe'],
      target: deviceA,
      action: { effect: 'Battle' },
    });

    await engine.evaluate();
    expect(state.get('A')?.effect).toBe('Battle');
    expect((await store.holds()).length).toBe(1);

    running.delete('game.exe');
    await engine.evaluate();
    expect(state.get('A')?.effect).toBe('Forest');
    expect(await store.holds()).toEqual([]);
  });

  it('does not undo a change you made while the program was running', async () => {
    const running = new Set(['game.exe']);
    const { store, engine, state } = await engineFor(running);
    await store.create({
      name: 'Gaming',
      enabled: true,
      processNames: ['game.exe'],
      target: deviceA,
      action: { effect: 'Battle' },
    });
    await engine.evaluate();

    // You picked something else by hand mid-game.
    state.set('A', { serialNo: 'A', on: true, brightness: 50, effect: 'Nemo' });

    running.delete('game.exe');
    await engine.evaluate();

    expect(state.get('A')?.effect).toBe('Nemo');
    expect(await store.holds()).toEqual([]);
  });

  it('lets the highest-priority matching rule win', async () => {
    const running = new Set(['game.exe', 'editor.exe']);
    const { store, engine, state } = await engineFor(running);

    // Created in this order, so "Working" starts above "Gaming".
    await store.create({
      name: 'Working',
      enabled: true,
      processNames: ['editor.exe'],
      target: deviceA,
      action: { effect: 'Focus' },
    });
    await store.create({
      name: 'Gaming',
      enabled: true,
      processNames: ['game.exe'],
      target: deviceA,
      action: { effect: 'Battle' },
    });

    await engine.evaluate();
    expect(state.get('A')?.effect).toBe('Focus');

    // Promote Gaming above Working.
    const rules = await store.load();
    const gaming = rules.find((r) => r.name === 'Gaming')!;
    const working = rules.find((r) => r.name === 'Working')!;
    await store.reorder([gaming.id, working.id]);

    await engine.evaluate();
    expect(state.get('A')?.effect).toBe('Battle');
  });

  it('hands back to what the first rule displaced, not to the second rule scene', async () => {
    const running = new Set(['editor.exe']);
    const { store, engine, state } = await engineFor(running);
    await store.create({
      name: 'Gaming',
      enabled: true,
      processNames: ['game.exe'],
      target: deviceA,
      action: { effect: 'Battle' },
    });
    await store.create({
      name: 'Working',
      enabled: true,
      processNames: ['editor.exe'],
      target: deviceA,
      action: { effect: 'Focus' },
    });

    await engine.evaluate();
    expect(state.get('A')?.effect).toBe('Focus');

    // The game starts: a higher rule takes over from a lower one.
    running.add('game.exe');
    await engine.evaluate();
    expect(state.get('A')?.effect).toBe('Battle');

    // Everything closes. The restore point must still be the original scene,
    // not the one the first rule left on screen.
    running.clear();
    await engine.evaluate();
    expect(state.get('A')?.effect).toBe('Forest');
  });

  it('ignores a disabled rule and a rule naming nothing', async () => {
    const running = new Set(['game.exe']);
    const { store, engine, state } = await engineFor(running);
    await store.create({
      name: 'Off',
      enabled: false,
      processNames: ['game.exe'],
      target: deviceA,
      action: { effect: 'Battle' },
    });
    await store.create({
      name: 'Nameless',
      enabled: true,
      processNames: [],
      target: deviceA,
      action: { effect: 'Battle' },
    });

    await engine.evaluate();
    expect(state.get('A')?.effect).toBe('Forest');
    expect(await store.holds()).toEqual([]);
  });

  it('survives a restart without capturing the rule scene as the restore point', async () => {
    const running = new Set(['game.exe']);
    const first = await engineFor(running);
    await first.store.create({
      name: 'Gaming',
      enabled: true,
      processNames: ['game.exe'],
      target: deviceA,
      action: { effect: 'Battle' },
    });
    await first.engine.evaluate();
    expect(first.state.get('A')?.effect).toBe('Battle');

    // A second engine over the same file, as if Betterleaf had restarted while
    // the game was still running. The hold, and its restore point, persist.
    const second = await engineFor(running);
    second.state.set('A', { serialNo: 'A', on: true, brightness: 50, effect: 'Battle' });
    await second.engine.evaluate();

    running.delete('game.exe');
    await second.engine.evaluate();

    // Forest, not Battle: the original scene, read back from disk.
    expect(second.state.get('A')?.effect).toBe('Forest');
  });

  it('does not enumerate processes when no rule is watching', async () => {
    const store = new AppRuleStore(path.join(dir, 'app-rules.json'));
    let listCalls = 0;
    const engine = new AppRuleEngine(
      store,
      async () => {
        listCalls++;
        return namesOnly();
      },
      {
        serialsFor: () => ['A'],
        capture: () => [],
        apply: async () => {},
        restoreDevice: async () => {},
        current: () => undefined,
      },
      { pollMs: 3_600_000 },
    );

    // Enumerating processes costs about half a second, so an idle install must
    // not pay it on every poll.
    await engine.evaluate();
    expect(listCalls).toBe(0);

    await store.create({
      name: 'Gaming',
      enabled: true,
      processNames: ['game.exe'],
      target: deviceA,
      action: { effect: 'Battle' },
    });
    await engine.evaluate();
    expect(listCalls).toBe(1);

    // A rule that is paused, or names nothing, is not something to watch for.
    const [rule] = await store.load();
    await store.setEnabled(rule!.id, false);
    await engine.evaluate();
    expect(listCalls).toBe(1);
  });

  it('files one hold per target', async () => {
    expect(targetKey({ kind: 'device', serialNo: 'A' })).toBe('device:A');
    expect(targetKey({ kind: 'room', roomId: 'r1' })).toBe('room:r1');
  });
});

describe('app rules against devices', () => {
  async function setup(running: Set<string>, profiles: ('NL22' | 'NL29')[] = ['NL29']) {
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
      { tickMs: 3_600_000 },
      new LockStore(path.join(dir, 'locks.json')),
      new AppRuleStore(path.join(dir, 'app-rules.json')),
      async () => ({ names: running, paths: new Set<string>() }),
      { pollMs: 3_600_000 },
    );
    await registry.start();
    await waitFor(
      () => registry!.snapshot().devices.length === started.length,
      'devices adopted',
    );
    return { sims: started, registry: registry! };
  }

  it('drives a real light while the program is running', async () => {
    const running = new Set<string>();
    const { sims: started, registry: reg } = await setup(running);
    const serialNo = started[0]!.serialNo;
    const effect = reg.snapshot().devices[0]!.effects.at(-1)!;

    await reg.createAppRule({
      name: 'Gaming',
      enabled: true,
      processNames: ['game.exe'],
      target: { kind: 'device', serialNo },
      action: { effect },
    });

    running.add('game.exe');
    await reg.listRunningApps(); // forces an evaluate
    await waitFor(() => started[0]!.info.effects.select === effect, 'rule applied');

    expect(reg.snapshot().appRules[0]?.holding).toBe(true);
    expect(reg.snapshot().appRules[0]?.matching).toBe(true);
  });

  it('holds the light against a schedule while the program runs', async () => {
    const running = new Set(['game.exe']);
    const { sims: started, registry: reg } = await setup(running);
    const serialNo = started[0]!.serialNo;
    const effects = reg.snapshot().devices[0]!.effects;
    const ruleEffect = effects.at(-1)!;
    const scheduleEffect = effects[0]!;

    await reg.createAppRule({
      name: 'Gaming',
      enabled: true,
      processNames: ['game.exe'],
      target: { kind: 'device', serialNo },
      action: { effect: ruleEffect },
    });
    await reg.listRunningApps();
    await waitFor(() => started[0]!.info.effects.select === ruleEffect, 'rule applied');

    const id = await reg.createSchedule({
      name: 'Evening',
      enabled: true,
      target: { kind: 'device', serialNo },
      timeMinutes: 20 * 60,
      days: [0, 1, 2, 3, 4, 5, 6],
      action: { effect: scheduleEffect },
    });

    const result = await reg.runScheduleNow(id);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('held-by-app');
    // The program owns the light for as long as it is open.
    expect(started[0]!.info.effects.select).toBe(ruleEffect);
  });

  it('forgetting a device takes its rules with it', async () => {
    const { sims: started, registry: reg } = await setup(new Set());
    const serialNo = started[0]!.serialNo;
    await reg.createAppRule({
      name: 'Gaming',
      enabled: true,
      processNames: ['game.exe'],
      target: { kind: 'device', serialNo },
      action: { power: true },
    });
    expect(reg.snapshot().appRules).toHaveLength(1);

    await reg.forget(serialNo);
    expect(reg.snapshot().appRules).toHaveLength(0);
  });

  it('shows the target name and keeps priority contiguous', async () => {
    const { sims: started, registry: reg } = await setup(new Set());
    const serialNo = started[0]!.serialNo;
    const base = {
      enabled: true,
      processNames: ['a.exe'],
      target: { kind: 'device' as const, serialNo },
      action: { power: true },
    };
    const first = await reg.createAppRule({ ...base, name: 'One' });
    const second = await reg.createAppRule({ ...base, name: 'Two' });

    expect(reg.snapshot().appRules.map((r) => r.priority)).toEqual([0, 1]);
    expect(reg.snapshot().appRules[0]?.targetName).toBe(started[0]!.info.name);

    await reg.reorderAppRules([second, first]);
    expect(reg.snapshot().appRules.map((r) => r.name)).toEqual(['Two', 'One']);
    expect(reg.snapshot().appRules.map((r) => r.priority)).toEqual([0, 1]);
  });
});
