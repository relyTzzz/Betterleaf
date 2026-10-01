/*
 * Render the screenshots the Betterleaf site and README use.
 *
 *   pnpm screenshots                 -> screenshots/*.png
 *
 * They come from the simulator, not from real lights, so no real serial number,
 * address or scene name ever appears in them, and they can be regenerated after
 * any visible change instead of being re-shot by hand. What happens:
 *
 *   1. the two fake devices start on loopback with mDNS off (`--no-advertise`),
 *      so nothing on the LAN is touched or advertised to;
 *   2. a throwaway profile is seeded with both lights already paired, a room,
 *      schedules, app rules and a lock, and the app is launched against it with
 *      `--user-data-dir`, so your own pairings are never read or written;
 *   3. the views are walked over the DevTools protocol and each one is captured
 *      at 2x — the app's own Chromium does the rendering, nothing is mocked.
 *
 * The packaged app (`pnpm package`, release/win-unpacked) is used when it exists,
 * because that is what people run: the schedules view, for instance, offers
 * "Start with Windows" only when packaged. Otherwise the dev build in
 * packages/app/out is used — run `pnpm build` first.
 *
 * Discovery still runs its real rungs (mDNS, SSDP, sweep) while the app is up,
 * so lights on your network may be found and offered for pairing. Those rows are
 * hidden with a stylesheet before capturing; nothing is paired or written.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appDir = path.join(root, 'packages', 'app');
const outDir = path.join(root, 'screenshots');
const CDP_PORT = Number(process.env.BETTERLEAF_SHOT_PORT) || 9555;

/** The simulator's fixed ports and tokens (tools/simulator/src/cli.ts) and profiles. */
const SIM = [
  { model: 'NL22', name: 'Light Panels 57:F7:6A', serialNo: 'S19112AB1234', port: 16021, token: 'sim-nl22' },
  { model: 'NL29', name: 'Canvas EEE0', serialNo: 'S20233CD5678', port: 16022, token: 'sim-nl29' },
];
const ROOM_ID = '6f1c2c4e-9b1e-4a1a-8f8e-0f3c5e1a2b3c';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function die(msg) {
  console.error(msg);
  process.exit(1);
}

/** Where the app is. */
function findApp() {
  const packaged = path.join(appDir, 'release', 'win-unpacked', 'Betterleaf.exe');
  if (process.platform === 'win32' && existsSync(packaged)) {
    return { exe: packaged, args: [], what: 'packaged app' };
  }
  if (!existsSync(path.join(appDir, 'out', 'main', 'index.js'))) {
    die('No build to run: `pnpm build` first (or `pnpm package` for the installed look).');
  }
  const require = createRequire(path.join(appDir, 'package.json'));
  return { exe: require('electron'), args: [appDir], what: 'dev build' };
}

/** A profile with everything already set up, so the pictures are not of an empty app. */
async function seedProfile(dir) {
  const now = Date.now();
  const write = (name, data) =>
    fs.writeFile(path.join(dir, name), JSON.stringify(data, null, 2), 'utf8');

  await write('devices.json', {
    version: 1,
    devices: SIM.map((d) => ({
      serialNo: d.serialNo,
      model: d.model,
      name: d.name,
      token: d.token,
      tokenEncrypted: false,
      lastIp: '127.0.0.1',
      lastPort: d.port,
      lastSeenAt: now,
    })),
  });
  await write('rooms.json', {
    version: 1,
    rooms: [{ id: ROOM_ID, name: 'Office', deviceSerials: SIM.map((d) => d.serialNo), order: 0 }],
  });
  await write('schedules.json', {
    version: 1,
    schedules: [
      {
        id: 'b7e5a2c1-0001-4000-8000-000000000001',
        name: 'Good morning',
        enabled: true,
        target: { kind: 'room', roomId: ROOM_ID },
        timeMinutes: 7 * 60,
        days: [1, 2, 3, 4, 5],
        action: { power: true, effect: 'Northern Lights', brightness: 60 },
        order: 0,
        lastRunAt: now,
        lastResult: 'ok',
      },
      {
        id: 'b7e5a2c1-0001-4000-8000-000000000002',
        name: 'Wind down',
        enabled: true,
        target: { kind: 'room', roomId: ROOM_ID },
        timeMinutes: 22 * 60,
        days: [0, 1, 2, 3, 4, 5, 6],
        action: { effect: 'Romantic', brightness: 25 },
        order: 1,
        lastRunAt: now,
        lastResult: 'ok',
      },
      {
        id: 'b7e5a2c1-0001-4000-8000-000000000003',
        name: 'Lights out',
        enabled: true,
        target: { kind: 'room', roomId: ROOM_ID },
        timeMinutes: 23 * 60 + 30,
        days: [0, 1, 2, 3, 4, 5, 6],
        action: { power: false },
        order: 2,
        lastRunAt: now,
        lastResult: 'ok',
      },
    ],
  });
  await write('app-rules.json', {
    version: 1,
    rules: [
      {
        id: 'c8f6b3d2-0002-4000-8000-000000000001',
        name: 'Gaming',
        enabled: true,
        processNames: ['overwatch.exe'],
        target: { kind: 'room', roomId: ROOM_ID },
        action: { power: true, effect: 'Fireworks', brightness: 100 },
        priority: 0,
      },
      {
        id: 'c8f6b3d2-0002-4000-8000-000000000002',
        name: 'Movie night',
        enabled: true,
        processNames: ['vlc.exe'],
        target: { kind: 'room', roomId: ROOM_ID },
        action: { power: true, effect: 'Nemo', brightness: 20 },
        priority: 1,
      },
    ],
    holds: [],
  });
  await write('locks.json', { version: 1, locked: [SIM[0].serialNo] });
  await write('settings.json', { trayEnabled: true });
}

/** Start the simulator on loopback and wait until both devices answer. */
async function startSimulator() {
  const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (!existsSync(tsx)) die('tsx is missing — run `pnpm install`.');
  const sim = spawn(
    process.execPath,
    [tsx, path.join(root, 'tools', 'simulator', 'src', 'cli.ts'), '--no-advertise'],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  sim.stderr.on('data', (d) => process.stderr.write(`[sim] ${d}`));
  for (let i = 0; i < 100; i++) {
    let ok = true;
    for (const d of SIM) {
      try {
        const res = await fetch(`http://127.0.0.1:${d.port}/api/v1/${d.token}/`);
        if (!res.ok) ok = false;
      } catch {
        ok = false;
      }
    }
    if (ok) return sim;
    if (sim.exitCode !== null) die('The simulator exited. Are ports 16021/16022 free?');
    await sleep(200);
  }
  die('The simulator did not come up.');
}

/** A minimal DevTools protocol client over the WebSocket Node ships with. */
class Cdp {
  #ws;
  #next = 1;
  #pending = new Map();

  static async connect(port) {
    let target;
    for (let i = 0; i < 100 && !target; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        target = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
      } catch {
        /* not listening yet */
      }
      if (!target) await sleep(200);
    }
    if (!target) die('The app never opened its window (no DevTools page target).');
    const cdp = new Cdp();
    cdp.#ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      cdp.#ws.addEventListener('open', resolve, { once: true });
      cdp.#ws.addEventListener('error', reject, { once: true });
    });
    cdp.#ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data));
      const waiting = cdp.#pending.get(msg.id);
      if (!waiting) return;
      cdp.#pending.delete(msg.id);
      if (msg.error) waiting.reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else waiting.resolve(msg.result);
    });
    return cdp;
  }

  send(method, params = {}) {
    const id = this.#next++;
    this.#ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
  }

  /** Run an expression in the page and hand back its value; throws on a page-side exception. */
  async eval(expression) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    }
    return result.value;
  }

  /** Poll until the expression is truthy. */
  async until(expression, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.eval(expression)) return true;
      await sleep(150);
    }
    return false;
  }

  /** Click the first element matching `selector` whose text starts with `text`. */
  async click(selector, text) {
    const match =
      text === undefined ? 'true' : `e.textContent.trim().startsWith(${JSON.stringify(text)})`;
    await this.eval(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => ${match});
      if (!el) throw new Error('nothing to click for ${selector} ${text ?? ''}');
      el.click();
    })()`);
  }

  async viewport(width, height) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await sleep(350);
  }

  async shot(name) {
    await sleep(400);
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(outDir, `${name}.png`);
    await fs.writeFile(file, Buffer.from(data, 'base64'));
    console.log(`  ${path.relative(root, file)}`);
  }

  close() {
    this.#ws.close();
  }
}

function kill(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}

const app = findApp();
console.log(`Using the ${app.what}.`);
await fs.mkdir(outDir, { recursive: true });
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'betterleaf-screenshots-'));
await seedProfile(profile);

let sim;
let electron;
try {
  sim = await startSimulator();
  console.log('Simulator up on 127.0.0.1:16021 and :16022.');

  // ELECTRON_RUN_AS_NODE (set by VS Code's terminal) would make Electron run as
  // plain Node, so it is dropped from the child's environment.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  electron = spawn(
    app.exe,
    [`--user-data-dir=${profile}`, `--remote-debugging-port=${CDP_PORT}`, ...app.args],
    { env, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  electron.stderr.on('data', (d) => {
    const line = String(d);
    if (!/DevTools listening/.test(line)) process.stderr.write(`[app] ${line}`);
  });

  const cdp = await Cdp.connect(CDP_PORT);
  console.log('Connected to the app.');

  if (!(await cdp.until("document.querySelectorAll('.device-card:not(.unpaired-card)').length === 2", 40_000))) {
    die('The app did not adopt both simulated lights.');
  }
  // Rows for lights found on the real network, if any, are not part of the picture, and
  // neither are scrollbars: a view taller than the window is scrolled to what matters.
  await cdp.eval(`(() => {
    const s = document.createElement('style');
    s.textContent = '.unpaired-card{display:none!important}.section-label:has(+ .unpaired-card){display:none!important}::-webkit-scrollbar{width:0;height:0}';
    document.head.appendChild(s);
  })()`);
  // Discovery keeps going after the cached lights answered (mDNS, SSDP, then a
  // sweep); wait for the "Searching…" line to clear so the header is at rest.
  if (!(await cdp.until("!document.querySelector('.titlebar .scanning')", 90_000))) {
    console.warn('Discovery is still running; hiding its progress line.');
    await cdp.eval(`document.head.appendChild(Object.assign(document.createElement('style'), { textContent: '.titlebar .scanning{display:none}' }))`);
  }
  // Six factory scenes are harvested off each light into the library on adoption.
  await cdp.until("[...document.querySelectorAll('.library-link')].some((b) => /Library\\s*6/.test(b.textContent))", 20_000);

  console.log('Capturing:');
  await cdp.viewport(1280, 800);
  await cdp.click('.device-card', 'Canvas');
  await cdp.until("!!document.querySelector('.layout-preview')");
  await cdp.shot('device');
  // The same view scrolled to its foot, where the wall is drawn as it hangs.
  await cdp.eval("document.querySelector('.detail').scrollTop = 1e6");
  await cdp.shot('layout');
  await cdp.eval("document.querySelector('.detail').scrollTop = 0");

  await cdp.click('.room-header');
  await cdp.until("!!document.querySelector('.member-list')");
  await cdp.shot('room');

  await cdp.viewport(1280, 900); // two rows of scene cards
  await cdp.click('.library-link', 'Library');
  await cdp.until("document.querySelectorAll('.library-card').length > 0");
  // One favourite, so the star has a meaning in the picture.
  await cdp.eval("document.querySelector('.library-card .star').click()");
  await cdp.until("!!document.querySelector('.library-card .star.on')");
  await cdp.shot('library');

  await cdp.viewport(1280, 800);
  await cdp.click('.library-link', 'Schedules');
  await cdp.until("document.querySelectorAll('.schedule-card').length === 3");
  await cdp.shot('schedules');
  await cdp.click('.detail-head button.primary', 'New schedule');
  await cdp.until("!!document.querySelector('.schedule-editor')");
  await cdp.shot('schedule-editor');
  await cdp.click('.schedule-editor .buttons button', 'Cancel');

  await cdp.click('.library-link', 'App scenes');
  await cdp.until("document.querySelectorAll('.rule-card').length === 2");
  await cdp.shot('app-scenes');
  await cdp.viewport(1280, 1000); // the rule editor is the tallest dialog
  await cdp.click('.detail-head button.primary', 'New rule');
  await cdp.until("!!document.querySelector('.schedule-editor')");
  await sleep(1500); // the running-programs picker appears once the process list is read
  await cdp.shot('rule-editor');
  await cdp.click('.schedule-editor .buttons button', 'Cancel');
  await cdp.viewport(1280, 800);

  await cdp.click('.titlebar button', 'Add by address');
  await cdp.until("!!document.querySelector('.dialog')");
  await cdp.shot('pair');
  await cdp.click('.dialog .buttons button', 'Cancel');

  cdp.close();
  console.log('Done.');
} finally {
  kill(electron);
  kill(sim);
  await sleep(500);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
}
