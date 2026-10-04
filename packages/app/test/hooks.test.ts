import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
  safeStorage: { isEncryptionAvailable: () => false },
}));

const { cleanAction } = await import('../src/main/action.js');
const { HookStore } = await import('../src/main/hook-store.js');
const { HookEngine } = await import('../src/main/hooks.js');
const { HookServer, describeListenError, sourceOf } = await import(
  '../src/main/hook-server.js'
);
const { claudeCodeSettings, slugify } = await import('../src/shared/hooks.js');
const { colourCss, colourName, describeAction } = await import(
  '../src/renderer/schedule-format.js'
);
const { AppRuleStore } = await import('../src/main/app-rule-store.js');
const { DeviceRegistry } = await import('../src/main/registry.js');
const { EffectHarvester } = await import('../src/main/effects/harvester.js');
const { EffectLibrary } = await import('../src/main/effects/library.js');
const { LockStore } = await import('../src/main/lock-store.js');
const { RoomStore } = await import('../src/main/room-store.js');
const { ScheduleStore } = await import('../src/main/schedule-store.js');
const { DeviceStore } = await import('../src/main/store.js');
const { startSimulator } = await import('../../../tools/simulator/src/index.js');

type Sim = Awaited<ReturnType<typeof startSimulator>>;
type ScheduleAction = import('../src/shared/types.js').ScheduleAction;
type ScheduleTarget = import('../src/shared/types.js').ScheduleTarget;
type HookInput = import('../src/shared/types.js').HookInput;
type ApplyOutcome = import('../src/main/scheduler.js').ApplyOutcome;

let dir: string;
let sims: Sim[] = [];
let registry: InstanceType<typeof DeviceRegistry> | undefined;
let servers: InstanceType<typeof HookServer>[] = [];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'betterleaf-hooks-'));
});

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
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

const room: ScheduleTarget = { kind: 'room', roomId: 'office' };

function hookInput(slug: string, action: ScheduleAction, target = room): HookInput {
  return { name: slug, slug, enabled: true, target, action };
}

describe('the shared action model', () => {
  it('keeps a colour, clamped to what the device takes', () => {
    expect(cleanAction({ color: { hue: 400, saturation: -5 } })).toEqual({
      color: { hue: 360, saturation: 0 },
    });
    expect(cleanAction({ color: { hue: 32.4, saturation: 99.6 } })).toEqual({
      color: { hue: 32, saturation: 100 },
    });
  });

  it('drops a colour that arrives alongside a scene', () => {
    // They compete for the same panels; the scene wins, so what you see does
    // not depend on which happened to be applied last.
    expect(cleanAction({ effect: 'Nemo', color: { hue: 10, saturation: 50 } })).toEqual({
      effect: 'Nemo',
    });
  });

  it('drops a malformed colour rather than sending NaN to a light', () => {
    expect(cleanAction({ color: { hue: 'red', saturation: 50 } })).toEqual({});
    expect(cleanAction({ color: { hue: 10 } })).toEqual({});
  });

  it('says what a colour does in words', () => {
    expect(describeAction({ power: true, color: { hue: 220, saturation: 90 } })).toBe(
      'Turn on, blue',
    );
    expect(colourName({ hue: 32, saturation: 100 })).toBe('orange');
    expect(colourName({ hue: 130, saturation: 30 })).toBe('pale green');
    expect(colourName({ hue: 200, saturation: 5 })).toBe('white');
    expect(colourName({ hue: 359, saturation: 100 })).toBe('red');
    // Full saturation is a pure hue; none is white.
    expect(colourCss({ hue: 120, saturation: 100 })).toBe('hsl(120 100% 50%)');
    expect(colourCss({ hue: 120, saturation: 0 })).toBe('hsl(120 100% 100%)');
  });
});

describe('hook addresses', () => {
  it('turns a name into something that needs no escaping', () => {
    expect(slugify('Claude: waiting!')).toBe('claude-waiting');
    expect(slugify('  Build -- Failed  ')).toBe('build-failed');
    expect(slugify('Café')).toBe('cafe');
    expect(slugify('!!!')).toBe('');
  });

  it('keeps addresses unique', async () => {
    const store = new HookStore(path.join(dir, 'hooks.json'));
    const a = await store.create(hookInput('', { power: true }));
    const b = await store.create({ ...hookInput('', { power: true }), name: 'Build' });
    const c = await store.create({ ...hookInput('', { power: true }), name: 'Build' });
    // Unnamed hooks are called "New hook", and their address follows.
    expect(a.slug).toBe('new-hook');
    expect(b.slug).toBe('build');
    expect(c.slug).toBe('build-2');
  });

  it('keeps the address when a hook is renamed', async () => {
    // Whatever calls it has the address in its own configuration; a rename
    // must not quietly break that.
    const store = new HookStore(path.join(dir, 'hooks.json'));
    const hook = await store.create(hookInput('claude-done', { power: true }));
    await store.update(hook.id, { ...hookInput('', { power: true }), name: 'Finished' });
    const [after] = await store.load();
    expect(after?.name).toBe('Finished');
    expect(after?.slug).toBe('claude-done');
  });

  it('reads back what it wrote, with priority contiguous', async () => {
    const file = path.join(dir, 'hooks.json');
    const store = new HookStore(file);
    const one = await store.create(hookInput('one', { color: { hue: 10, saturation: 20 } }));
    const two = await store.create(hookInput('two', { effect: 'Nemo' }));
    await store.reorder([two.id, one.id]);

    const reread = await new HookStore(file).load();
    expect(reread.map((h) => [h.slug, h.priority])).toEqual([
      ['two', 0],
      ['one', 1],
    ]);
    expect(reread[1]?.action).toEqual({ color: { hue: 10, saturation: 20 } });
  });

  it('gives a duplicated address in a hand-edited file to the first hook', async () => {
    const file = path.join(dir, 'hooks.json');
    const hooks = ['a', 'b'].map((id, i) => ({
      id,
      name: id,
      slug: 'same',
      enabled: true,
      target: room,
      action: { power: true },
      priority: i,
    }));
    await fs.writeFile(file, JSON.stringify({ version: 1, hooks }));
    const loaded = await new HookStore(file).load();
    expect(loaded.map((h) => h.slug)).toEqual(['same', 'same-2']);
  });

  it('drops hooks aimed at a forgotten light or a deleted room', async () => {
    const store = new HookStore(path.join(dir, 'hooks.json'));
    await store.create(hookInput('room', { power: true }));
    await store.create(hookInput('light', { power: true }, { kind: 'device', serialNo: 'S1' }));
    await store.pruneDevice('S1');
    expect((await store.load()).map((h) => h.slug)).toEqual(['room']);
    await store.pruneRoom('office');
    expect(await store.load()).toEqual([]);
  });
});

describe('the hook engine', () => {
  async function setup(
    options: {
      apply?: (target: ScheduleTarget, action: ScheduleAction) => Promise<ApplyOutcome>;
    } = {},
  ) {
    let clock = 1_000_000;
    const applied: ScheduleAction[] = [];
    const store = new HookStore(path.join(dir, 'hooks.json'));
    // Created in priority order: waiting outranks working outranks done.
    const waiting = await store.create(hookInput('waiting', { color: { hue: 32, saturation: 100 } }));
    const working = await store.create(hookInput('working', { color: { hue: 220, saturation: 90 } }));
    const done = await store.create(hookInput('done', { color: { hue: 130, saturation: 75 } }));
    const engine = new HookEngine(
      store,
      options.apply ??
        (async (_target, action) => {
          applied.push(action);
          return { kind: 'ok' };
        }),
      { now: () => clock, sourceTtlMs: 60_000, tickMs: 3_600_000 },
    );
    await engine.start();
    return {
      engine,
      store,
      applied,
      hooks: { waiting, working, done },
      advance: (ms: number) => (clock += ms),
      /** Which hook each application was, by colour. */
      names: () =>
        applied.map((a) =>
          a.color?.hue === 32 ? 'waiting' : a.color?.hue === 220 ? 'working' : 'done',
        ),
    };
  }

  it('answers at once whether a hook exists', async () => {
    const { engine, store, hooks } = await setup();
    expect(engine.fire('nope')).toBe('unknown');
    await store.setEnabled(hooks.done.id, false);
    await engine.reload();
    expect(engine.fire('done')).toBe('disabled');
    expect(engine.fire('working')).toBe('accepted');
    engine.stop();
  });

  it('applies a report once, and a repeat of it not at all', async () => {
    // Claude Code reports after every tool call. Re-applying each time would
    // hammer the lights and fight anyone who changed them by hand.
    const { engine, names } = await setup();
    engine.fire('working', 'A');
    engine.fire('working', 'A');
    await engine.settled();
    engine.fire('working', 'A');
    await engine.settled();
    expect(names()).toEqual(['working']);
    engine.stop();
  });

  it('lets a waiting session outrank another one finishing', async () => {
    const { engine, names, hooks } = await setup();
    engine.fire('working', 'A');
    await engine.settled();
    engine.fire('waiting', 'B');
    await engine.settled();
    // A finishing must not paint over B, which still needs you.
    engine.fire('done', 'A');
    await engine.settled();
    expect(names()).toEqual(['working', 'waiting']);
    expect(engine.stateOf(hooks.waiting)).toMatchObject({ active: true, sources: 1 });
    expect(engine.stateOf(hooks.done)).toMatchObject({ active: false, sources: 1 });

    // B is answered and back at work; working now outranks A's done.
    engine.fire('working', 'B');
    await engine.settled();
    expect(names()).toEqual(['working', 'waiting', 'working']);
    engine.stop();
  });

  it('falls back to the next caller when one leaves', async () => {
    const { engine, names } = await setup();
    engine.fire('done', 'A');
    engine.fire('waiting', 'B');
    await engine.settled();
    expect(engine.release('B')).toBe(true);
    await engine.settled();
    expect(names().at(-1)).toBe('done');
    expect(engine.release('nobody')).toBe(false);
    engine.stop();
  });

  it('leaves the lights alone when the last caller leaves', async () => {
    const { engine, names } = await setup();
    engine.fire('done', 'A');
    await engine.settled();
    engine.release('A');
    await engine.settled();
    expect(names()).toEqual(['done']);

    // With nobody asking, the lights may have been changed by hand since, so
    // the next report applies even though it repeats the last one.
    engine.fire('done', 'A');
    await engine.settled();
    expect(names()).toEqual(['done', 'done']);
    engine.stop();
  });

  it('stops counting a caller that has gone quiet', async () => {
    const { engine, names, advance, hooks } = await setup();
    engine.fire('waiting', 'dead');
    await engine.settled();
    advance(50_000);
    engine.fire('done', 'alive');
    await engine.settled();
    expect(names()).toEqual(['waiting']); // still inside the window

    advance(20_000); // 'dead' last heard 70s ago, past the 60s window
    engine.sweep();
    await engine.settled();
    expect(names()).toEqual(['waiting', 'done']);
    expect(engine.stateOf(hooks.waiting).sources).toBe(0);
    engine.stop();
  });

  it('treats callers without an id as one caller, where the latest wins', async () => {
    const { engine, names } = await setup();
    engine.fire('waiting');
    await engine.settled();
    engine.fire('done');
    await engine.settled();
    expect(names()).toEqual(['waiting', 'done']);
    engine.stop();
  });

  it('records a failure and does not retry it on every report', async () => {
    let calls = 0;
    const { engine, hooks } = await setup({
      apply: async () => {
        calls++;
        throw new Error('That light is not connected.');
      },
    });
    engine.fire('working', 'A');
    await engine.settled();
    engine.fire('working', 'A');
    await engine.settled();
    expect(calls).toBe(1);
    expect(engine.stateOf(hooks.working).lastResult).toBe('That light is not connected.');
    engine.stop();
  });

  it('records a lock holding it back as a reason, not an error', async () => {
    const { engine, hooks } = await setup({
      apply: async () => ({ kind: 'skipped', reason: 'locked' }),
    });
    engine.fire('working', 'A');
    await engine.settled();
    expect(engine.stateOf(hooks.working).lastResult).toBe('locked');
    engine.stop();
  });

  it('folds a burst of reports into the latest while a light is slow', async () => {
    const releases: (() => void)[] = [];
    const seen: string[] = [];
    const { engine } = await setup({
      apply: (_target, action) => {
        seen.push(action.color?.hue === 32 ? 'waiting' : action.color?.hue === 220 ? 'working' : 'done');
        return new Promise((resolve) => releases.push(() => resolve({ kind: 'ok' })));
      },
    });
    engine.fire('working', 'A');
    await new Promise((r) => setImmediate(r));
    // The light has not answered yet. These pile up behind it…
    engine.fire('done', 'A');
    engine.fire('waiting', 'A');
    engine.fire('done', 'A');
    releases.shift()?.();
    await waitFor(() => releases.length > 0, 'second write');
    releases.shift()?.();
    await engine.settled();
    // …and become one write of the latest, not three stale ones.
    expect(seen).toEqual(['working', 'done']);
    engine.stop();
  });

  it('re-applies when the winning hook is edited or outranked', async () => {
    const { engine, store, names, applied, hooks } = await setup();
    engine.fire('working', 'A');
    engine.fire('done', 'B');
    await engine.settled();
    expect(names()).toEqual(['working']);

    await store.update(hooks.working.id, {
      ...hookInput('working', { color: { hue: 221, saturation: 90 } }),
    });
    await engine.reload();
    await engine.settled();
    expect(applied.at(-1)?.color?.hue).toBe(221);

    // Put done above working: B's report now wins.
    await store.reorder([hooks.done.id, hooks.working.id, hooks.waiting.id]);
    await engine.reload();
    await engine.settled();
    expect(names().at(-1)).toBe('done');
    engine.stop();
  });

  it('a test does not leave the lights stuck on the test', async () => {
    const { engine, names, hooks } = await setup();
    engine.fire('working', 'A');
    await engine.settled();
    expect(await engine.test(hooks.waiting.id)).toEqual({ ok: true });
    expect(engine.stateOf(hooks.waiting).sources).toBe(0);

    // The lights now show the test; the next report of the winner must undo it.
    engine.fire('working', 'A');
    await engine.settled();
    expect(names()).toEqual(['working', 'waiting', 'working']);
    engine.stop();
  });
});

describe('the hook listener', () => {
  type Call = { kind: 'fire' | 'release'; slug?: string; source: string };

  async function listen(outcomes: Record<string, 'accepted' | 'unknown' | 'disabled'> = {}) {
    const calls: Call[] = [];
    const server = new HookServer({
      fire: (slug, source) => {
        calls.push({ kind: 'fire', slug, source });
        return outcomes[slug] ?? 'accepted';
      },
      release: (source) => {
        calls.push({ kind: 'release', source });
      },
      list: () => [{ slug: 'working', name: 'Working', enabled: true }],
    });
    servers.push(server);
    await server.start(0);
    return { server, calls, port: server.port };
  }

  function request(
    port: number,
    {
      method = 'POST',
      path: urlPath = '/',
      body,
      headers = {},
    }: { method?: string; path?: string; body?: string; headers?: Record<string, string> },
  ): Promise<{ status: number; body: string; type?: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method,
          path: urlPath,
          headers: { host: `127.0.0.1:${port}`, ...headers },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
              ...(res.headers['content-type'] ? { type: res.headers['content-type'] } : {}),
            }),
          );
        },
      );
      req.on('error', reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  it('fires with an empty 204, taking the caller from Claude Code’s session id', async () => {
    const { port, calls } = await listen();
    const res = await request(port, {
      path: '/hooks/working',
      body: JSON.stringify({ session_id: 'abc-123', hook_event_name: 'PostToolUse' }),
      headers: { 'content-type': 'application/json' },
    });
    // Empty, because Claude Code reads a hook's response body as instructions.
    expect(res).toEqual({ status: 204, body: '' });
    expect(calls).toEqual([{ kind: 'fire', slug: 'working', source: 'abc-123' }]);
  });

  it('finds the session id at the start of a body too big to keep', async () => {
    // A PostToolUse after writing a file carries the whole file.
    const { port, calls } = await listen();
    const huge = JSON.stringify({
      session_id: 'big-one',
      tool_input: { content: 'x'.repeat(300_000) },
    });
    const res = await request(port, { path: '/hooks/working', body: huge });
    expect(res.status).toBe(204);
    expect(calls[0]?.source).toBe('big-one');
  });

  it('lets ?source= name the caller, and treats no id as anonymous', async () => {
    const { port, calls } = await listen();
    await request(port, { path: '/hooks/working?source=stream-deck', body: '{"session_id":"x"}' });
    await request(port, { path: '/hooks/working' });
    expect(calls.map((c) => c.source)).toEqual(['stream-deck', '']);
  });

  it('says when there is no such hook, or it is paused', async () => {
    const { port } = await listen({ ghost: 'unknown', paused: 'disabled' });
    expect((await request(port, { path: '/hooks/ghost' })).status).toBe(404);
    expect((await request(port, { path: '/hooks/paused' })).status).toBe(409);
  });

  it('refuses to fire on GET, which any page could do with an <img>', async () => {
    const { port, calls } = await listen();
    expect((await request(port, { method: 'GET', path: '/hooks/working' })).status).toBe(405);
    expect(calls).toEqual([]);
  });

  it('refuses requests from web pages', async () => {
    const { port, calls } = await listen();
    const fromPage = await request(port, {
      path: '/hooks/working',
      headers: { origin: 'https://example.com' },
    });
    const crossSite = await request(port, {
      path: '/hooks/working',
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(fromPage.status).toBe(403);
    expect(crossSite.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('refuses a request addressed to another name, as DNS rebinding would be', async () => {
    const { port, calls } = await listen();
    const res = await request(port, {
      path: '/hooks/working',
      headers: { host: `evil.example:${port}` },
    });
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
    // The loopback names are all fine.
    for (const host of [`localhost:${port}`, `[::1]:${port}`]) {
      expect((await request(port, { path: '/hooks/working', headers: { host } })).status).toBe(204);
    }
  });

  it('releases a caller', async () => {
    const { port, calls } = await listen();
    const res = await request(port, { path: '/release', body: '{"session_id":"gone"}' });
    expect(res.status).toBe(204);
    expect(calls).toEqual([{ kind: 'release', source: 'gone' }]);
  });

  it('lists the hooks', async () => {
    const { port } = await listen();
    const res = await request(port, { method: 'GET', path: '/hooks' });
    expect(res.status).toBe(200);
    expect(res.type).toContain('application/json');
    expect(JSON.parse(res.body)).toEqual([{ slug: 'working', name: 'Working', enabled: true }]);
  });

  it('explains a port that is already taken', async () => {
    const { port } = await listen();
    const second = new HookServer({ fire: () => 'unknown', release: () => {}, list: () => [] });
    servers.push(second);
    const err = await second.start(port).catch((e: unknown) => e);
    expect(describeListenError(err, port)).toBe(
      `Port ${port} is already in use by another program. Pick another.`,
    );
    expect(second.listening).toBe(false);
  });

  it('reads the caller from the body however it arrives', () => {
    const none = new URLSearchParams();
    expect(sourceOf(none, '', true)).toBe('');
    expect(sourceOf(none, 'not json', true)).toBe('');
    expect(sourceOf(none, '{"session_id":"a\\"b"}', true)).toBe('a"b');
    // Cut off mid-way: found by pattern, escapes and all.
    expect(sourceOf(none, '{"session_id":"cut\\u0041","tool_input":{"x":"', false)).toBe('cutA');
  });
});

describe('Claude Code settings', () => {
  it('maps each event to the right hook', () => {
    const json = JSON.parse(
      claudeCodeSettings(16100, { waiting: 'w8', working: 'busy', done: 'fin' }),
    ) as { hooks: Record<string, { matcher?: string; hooks: { type: string; url: string }[] }[]> };
    const url = (event: string) => json.hooks[event]?.[0]?.hooks[0]?.url;

    expect(url('UserPromptSubmit')).toBe('http://127.0.0.1:16100/hooks/busy');
    expect(url('PermissionRequest')).toBe('http://127.0.0.1:16100/hooks/w8');
    // A question waits on you as much as a permission does.
    expect(json.hooks['PreToolUse']?.[0]?.matcher).toBe('AskUserQuestion');
    expect(url('PreToolUse')).toBe('http://127.0.0.1:16100/hooks/w8');
    // A tool finishing ends a wait; it is not the end of the task.
    expect(url('PostToolUse')).toBe('http://127.0.0.1:16100/hooks/busy');
    expect(url('Stop')).toBe('http://127.0.0.1:16100/hooks/fin');
    expect(url('SessionEnd')).toBe('http://127.0.0.1:16100/release');
    expect(json.hooks['Stop']?.[0]?.hooks[0]?.type).toBe('http');
  });
});

describe('hooks against devices', () => {
  async function setup(profiles: ('NL22' | 'NL29')[] = ['NL29']) {
    const started = await Promise.all(profiles.map((profile) => startSimulator({ profile })));
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
    const running = new Set<string>();
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
      new HookStore(path.join(dir, 'hooks.json')),
      { tickMs: 3_600_000 },
    );
    await registry.start();
    await waitFor(() => registry!.snapshot().devices.length === started.length, 'devices adopted');
    return { sims: started, registry: registry!, running };
  }

  it('puts a light on a solid colour', async () => {
    const { sims: [sim], registry: reg } = await setup();
    const target = { kind: 'device' as const, serialNo: sim!.serialNo };
    await reg.createHook(hookInput('working', { power: true, color: { hue: 220, saturation: 90 } }, target));

    expect(reg.fireHook('working', 'session-1')).toBe('accepted');
    await reg.hooksSettled();
    await waitFor(() => sim!.info.state.hue.value === 220, 'colour applied');

    expect(sim!.info.state.sat.value).toBe(90);
    expect(sim!.info.state.colorMode).toBe('hs');
    expect(sim!.info.effects.select).toBe('*Solid*');
    const view = reg.snapshot().hooks[0];
    expect(view).toMatchObject({ active: true, sources: 1, lastResult: 'ok' });
    expect(view?.targetName).toBe(sim!.info.name);
  });

  it('leaves a locked light alone, and says so', async () => {
    const { sims: [sim], registry: reg } = await setup();
    const target = { kind: 'device' as const, serialNo: sim!.serialNo };
    const before = sim!.info.effects.select;
    await reg.setDeviceLocked(sim!.serialNo, true);
    await reg.createHook(hookInput('working', { color: { hue: 220, saturation: 90 } }, target));

    reg.fireHook('working', 'session-1');
    await reg.hooksSettled();
    expect(reg.snapshot().hooks[0]?.lastResult).toBe('locked');
    expect(sim!.info.effects.select).toBe(before);
  });

  it('gives a colour back when an app scene ends', async () => {
    // A game rule captures the hook's colour as the thing to return to. A
    // colour reports a pseudo-scene that cannot be selected, so restoring has
    // to put the colour itself back.
    const { sims: [sim], registry: reg, running } = await setup();
    const target = { kind: 'device' as const, serialNo: sim!.serialNo };
    const gameScene = reg.snapshot().devices[0]!.effects.at(-1)!;

    await reg.createHook(hookInput('working', { color: { hue: 220, saturation: 90 } }, target));
    reg.fireHook('working', 'session-1');
    await reg.hooksSettled();
    await waitFor(
      () => reg.snapshot().devices[0]?.currentEffect === '*Solid*',
      'the app saw the colour',
    );

    await reg.createAppRule({
      name: 'Gaming',
      enabled: true,
      processNames: ['game.exe'],
      target,
      action: { effect: gameScene },
    });
    running.add('game.exe');
    await reg.listRunningApps();
    await waitFor(() => sim!.info.effects.select === gameScene, 'game scene applied');
    expect(sim!.info.state.colorMode).toBe('effect');

    // While the game runs, the rule outranks the hook.
    reg.fireHook('working', 'session-2');
    await reg.hooksSettled();
    expect(sim!.info.effects.select).toBe(gameScene);

    running.delete('game.exe');
    await reg.listRunningApps();
    await waitFor(() => sim!.info.state.colorMode === 'hs', 'colour restored');
    expect(sim!.info.state.hue.value).toBe(220);
    expect(sim!.info.state.sat.value).toBe(90);
  });

  it('forgetting a light takes its hooks with it', async () => {
    const { sims: [sim], registry: reg } = await setup();
    const target = { kind: 'device' as const, serialNo: sim!.serialNo };
    await reg.createHook(hookInput('working', { power: true }, target));
    expect(reg.hookSummaries()).toEqual([{ slug: 'working', name: 'working', enabled: true }]);
    await reg.forget(sim!.serialNo);
    expect(reg.snapshot().hooks).toEqual([]);
    expect(reg.fireHook('working', 'x')).toBe('unknown');
  });
});
