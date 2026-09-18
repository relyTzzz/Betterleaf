#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  BUILTIN_MOTIONS,
  NanoleafDevice,
  illuminatedPanels,
  isNanoleafEffect,
  motionByUuid,
  pairDevice,
  probeDevice,
  runDiscoveryLadder,
  toRenderLayout,
  type DeviceInfo,
  type DeviceRecord,
  type NanoleafEffect,
  type PanelColor,
} from '@betterleaf/protocol';
import {
  loadRecords,
  removeRecord,
  resolveTarget,
  storePath,
  upsertRecord,
} from './store.js';
import { hsvToRgb, parseFlags, table } from './util.js';

const [command, ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);
const positional = flags._;

const out = (text: string) => process.stdout.write(text);
const err = (text: string) => process.stderr.write(text);

/**
 * Open a live device from a stored record.
 *
 * If the cached address no longer answers this re-runs discovery and follows the
 * device to wherever it moved — the same drift healing the app does on launch,
 * exercised every time you use the CLI.
 */
async function openDevice(target?: string): Promise<NanoleafDevice> {
  const records = await loadRecords();
  const record = resolveTarget(records, target);

  const probe = await probeDevice(record.lastIp, {
    port: record.lastPort,
    token: record.token,
    timeoutMs: 1500,
  });

  if (probe?.info) return persisting(new NanoleafDevice({ record, info: probe.info }));

  err(`${record.name} did not answer at ${record.lastIp}:${record.lastPort}; searching...\n`);
  const found = await runDiscoveryLadder({ known: [record] });
  const match = found.find((f) => f.serialNo === record.serialNo);

  if (!match?.info) {
    throw new Error(
      `Could not reach ${record.name} (${record.serialNo}). Is it powered and on this network?`,
    );
  }

  record.lastIp = match.ip;
  record.lastPort = match.port;
  await upsertRecord(record);
  err(`Found it at ${match.ip}:${match.port}\n`);
  return persisting(new NanoleafDevice({ record, info: match.info }));
}

/**
 * Write the device's record back to the store whenever it learns something
 * worth remembering — a new address, or which streaming protocol it accepted.
 * Next run then skips the probing and goes straight to what works.
 */
function persisting(device: NanoleafDevice): NanoleafDevice {
  device.on('record', (record) => void upsertRecord(record));
  return device;
}

async function cmdDiscover(): Promise<void> {
  const known = await loadRecords();
  const started = Date.now();
  const rows: string[][] = [];

  out('Searching...\n\n');

  const found = await runDiscoveryLadder({
    known,
    ...(flags['ip'] ? { manualAddresses: [{ ip: String(flags['ip']) }] } : {}),
    onRung: (rung) => err(`  [${Date.now() - started}ms] ${rung}\n`),
    onFound: (r) =>
      rows.push([
        r.info?.name ?? r.name ?? '(unpaired)',
        r.model ?? '?',
        r.serialNo ?? '-',
        `${r.ip}:${r.port}`,
        r.source,
        r.needsPairing ? 'needs pairing' : 'paired',
      ]),
  });

  out('\n');
  if (found.length === 0) {
    out('No Nanoleaf devices found.\n');
    out('If you know the address, try: betterleaf discover --ip 192.168.1.50\n');
    return;
  }

  out(table(['NAME', 'MODEL', 'SERIAL', 'ADDRESS', 'VIA', 'STATUS'], rows));
  out(`\n${found.length} device(s) in ${Date.now() - started}ms\n`);
}

async function cmdPair(): Promise<void> {
  const ip = positional[0];
  if (!ip) throw new Error('Usage: betterleaf pair <ip> [--port 16021]');
  const port = flags['port'] ? Number(flags['port']) : 16021;

  out('Hold the power button on the controller for 5-7 seconds until the LED flashes.\n');

  let lastPrinted = -1;
  const token = await pairDevice({
    host: ip,
    port,
    onTick: (msLeft) => {
      const sec = Math.ceil(msLeft / 1000);
      if (sec !== lastPrinted) {
        lastPrinted = sec;
        out(`\rWaiting for pairing mode... ${sec}s  `);
      }
    },
  });
  out('\n');

  const probe = await probeDevice(ip, { port, token, timeoutMs: 3000 });
  if (!probe?.info) throw new Error('Paired, but the device did not return its info');

  const info: DeviceInfo = probe.info;
  const record: DeviceRecord = {
    serialNo: info.serialNo,
    model: info.model,
    name: info.name,
    token,
    lastIp: ip,
    lastPort: port,
    lastSeenAt: Date.now(),
  };
  await upsertRecord(record);

  out(`\nPaired with ${info.name} (${info.model}, ${info.serialNo})\n`);
  out(`Saved to ${storePath()}\n`);
}

async function cmdList(): Promise<void> {
  const records = await loadRecords();
  if (records.length === 0) {
    out('No paired devices. Run: betterleaf pair <ip>\n');
    return;
  }
  out(
    table(
      ['NAME', 'MODEL', 'SERIAL', 'LAST ADDRESS', 'STREAM'],
      records.map((r) => [
        r.name,
        r.model,
        r.serialNo,
        `${r.lastIp}:${r.lastPort}`,
        r.streamVersion ?? '-',
      ]),
    ),
  );
}

async function cmdInfo(): Promise<void> {
  const device = await openDevice(positional[0]);
  const lit = illuminatedPanels(device.layout);
  const s = device.state;

  out(`${device.name}\n`);
  out(`  model      ${device.model} (${device.capabilities.family})\n`);
  out(`  serial     ${device.serialNo}\n`);
  out(`  address    ${device.host}:${device.port}\n`);
  out(`  panels     ${lit.length} illuminated of ${device.layout.positionData.length} reported\n`);
  out(`  touch      ${device.capabilities.touch ? 'yes' : 'no'}\n`);
  out(`  rhythm     ${describeRhythm(device)}\n`);
  out(`  stream     prefers ${device.capabilities.preferredStreamVersion}\n`);
  out(`  state      ${s.on ? 'on' : 'off'}  bri ${s.brightness}  hue ${s.hue}  sat ${s.sat}  ct ${s.ct}K  (${s.colorMode})\n`);
  out(`  effect     ${device.currentEffect}\n`);

  await device.close();
}

/**
 * What the device says about its Rhythm module.
 *
 * `capabilities.rhythm` only means the model can take one. Whether a module is
 * actually plugged in is a different question, and reporting the first as if it
 * were the second is exactly the kind of confident-but-wrong answer this app
 * exists to avoid.
 */
function describeRhythm(device: NanoleafDevice): string {
  if (!device.capabilities.rhythm) return 'not supported';
  const rhythm = device.rhythm;
  if (!rhythm) return 'supported, device did not report one';
  if (!rhythm.rhythmConnected) return 'supported, none attached';
  return `connected (hw ${rhythm.hardwareVersion ?? '?'}, fw ${rhythm.firmwareVersion ?? '?'})`;
}

async function cmdState(): Promise<void> {
  const device = await openDevice(positional[0]);

  if (flags['on']) await device.setPower(true);
  if (flags['off']) await device.setPower(false);
  if (flags['brightness'] !== undefined) await device.setBrightness(Number(flags['brightness']));
  if (flags['hue'] !== undefined) await device.setHue(Number(flags['hue']));
  if (flags['sat'] !== undefined) await device.setSaturation(Number(flags['sat']));
  if (flags['ct'] !== undefined) await device.setColorTemp(Number(flags['ct']));

  const s = device.state;
  out(`${device.name}: ${s.on ? 'on' : 'off'}  bri ${s.brightness}  hue ${s.hue}  sat ${s.sat}  ct ${s.ct}K\n`);
  await device.close();
}

async function cmdEffects(): Promise<void> {
  const device = await openDevice(positional[0]);
  const name = positional[1];

  if (name) {
    await device.selectEffect(name);
    out(`${device.name}: applied "${name}"\n`);
  } else {
    for (const effect of device.effects) {
      out(`${effect === device.currentEffect ? '* ' : '  '}${effect}\n`);
    }
  }
  await device.close();
}

async function cmdLayout(): Promise<void> {
  const device = await openDevice(positional[0]);
  const render = toRenderLayout(device.layout);

  out(`${device.name} - ${render.panels.length} illuminated panels\n\n`);
  out(
    table(
      ['PANEL ID', 'X', 'Y', 'SCREEN X', 'SCREEN Y', 'ORIENT', 'SHAPE'],
      render.panels.map((p) => [
        String(p.panelId),
        String(p.x),
        String(p.y),
        String(p.screenX),
        String(p.screenY),
        `${p.o}deg`,
        String(p.shapeType ?? '-'),
      ]),
    ),
  );

  const excluded = device.layout.positionData.filter(
    (p) => !render.panels.some((r) => r.panelId === p.panelId),
  );
  if (excluded.length > 0) {
    out(
      `\nExcluded as non-illuminated: ${excluded
        .map((p) => `panelId=${p.panelId} shapeType=${p.shapeType}`)
        .join(', ')}\n`,
    );
    out('Verify against the hardware: anything listed here will never light up.\n');
  }
  await device.close();
}

async function cmdWatch(): Promise<void> {
  const device = await openDevice(positional[0]);
  device.connect();

  out(`Watching ${device.name}. Ctrl-C to stop.\n\n`);
  const stamp = () => new Date().toISOString().slice(11, 23);

  device.on('status', (s) => out(`${stamp()}  status  ${s}\n`));
  device.on('state', (s) =>
    out(`${stamp()}  state   on=${s.on} bri=${s.brightness} hue=${s.hue} sat=${s.sat} ct=${s.ct} mode=${s.colorMode}\n`),
  );
  device.on('effect', (e) => out(`${stamp()}  effect  ${e}\n`));
  device.on('touch', (t) => out(`${stamp()}  touch   ${t.gesture} on panel ${t.panelId}\n`));
  device.on('error', (e) => out(`${stamp()}  error   ${e.message}\n`));

  await new Promise<void>((resolve) => process.on('SIGINT', () => resolve()));
  await device.close();
}

async function cmdStream(): Promise<void> {
  const device = await openDevice(positional[0]);
  const seconds = flags['seconds'] ? Number(flags['seconds']) : 15;
  const panels = illuminatedPanels(device.layout).map((p) => p.panelId);

  device.on('error', (e) => err(`stream error: ${e.message}\n`));

  await device.startStream();
  out(`Streaming a moving gradient to ${panels.length} panels over ${device.streamVersion} for ${seconds}s...\n`);

  const started = Date.now();
  const timer = setInterval(() => {
    const t = (Date.now() - started) / 1000;
    const frame: PanelColor[] = panels.map((panelId, i) => {
      const hue = (t * 60 + (i / Math.max(1, panels.length)) * 360) % 360;
      const { r, g, b } = hsvToRgb(hue, 1, 1);
      return { panelId, r, g, b, w: 0, transitionTime: 1 };
    });
    device.sendFrame(frame);
  }, 100);

  await new Promise((r) => setTimeout(r, seconds * 1000));
  clearInterval(timer);

  const restore = flags['restore'] ? String(flags['restore']) : undefined;
  await device.stopStream(restore);
  out(`Done${restore ? `, restored "${restore}"` : ''}.\n`);
  await device.close();
}

async function cmdSaveScene(): Promise<void> {
  const device = await openDevice(positional[0]);
  const name = positional[1] ?? 'Betterleaf Scene';
  const panels = illuminatedPanels(device.layout).map((p) => p.panelId);

  // A fixed rainbow across the wall, written onto the device permanently.
  const colors: PanelColor[] = panels.map((panelId, i) => {
    const { r, g, b } = hsvToRgb((i / Math.max(1, panels.length)) * 360, 1, 1);
    return { panelId, r, g, b, w: 0, transitionTime: 10 };
  });

  await device.saveStaticEffect(name, colors);
  await device.selectEffect(name);

  out(`Saved "${name}" onto ${device.name} and applied it.\n`);
  out('It lives on the device now: quit this, power-cycle the panels, and it should still be there.\n');
  await device.close();
}

async function cmdPlugins(): Promise<void> {
  const device = await openDevice(positional[0]);
  const uuids = await device.listPlugins();

  if (uuids.length === 0) {
    out(`${device.name} did not report its plugins (older firmware often does not).\n`);
  } else {
    out(
      table(
        ['MOTION', 'UUID'],
        uuids.map((uuid) => [motionByUuid(uuid)?.label ?? '(unknown)', uuid]),
      ),
    );
  }
  await device.close();
}

async function cmdExportEffects(): Promise<void> {
  const device = await openDevice(positional[0]);
  // Absolute, because pnpm runs this from the package directory and a bare
  // filename otherwise appears somewhere the user did not expect.
  const file = resolve(positional[1] ?? `${device.model}-effects.json`);

  const effects = await device.exportEffects();
  await writeFile(file, JSON.stringify(effects, null, 2), 'utf8');

  out(`Exported ${effects.length} effect(s) from ${device.name} to ${file}\n`);
  for (const effect of effects) {
    const motion = effect.pluginUuid ? motionByUuid(effect.pluginUuid)?.label : undefined;
    out(`  ${effect.animName}  (${effect.animType}${motion ? `, ${motion}` : ''})\n`);
  }
  await device.close();
}

async function cmdImportEffect(): Promise<void> {
  const file = positional[1];
  if (!file) throw new Error('Usage: betterleaf import-effect <target> <file> [--name X]');

  const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
  const all: NanoleafEffect[] = Array.isArray(parsed)
    ? parsed.filter(isNanoleafEffect)
    : isNanoleafEffect(parsed)
      ? [parsed]
      : [];

  if (all.length === 0) throw new Error(`${file} contains no Nanoleaf effects.`);

  const wanted = flags['name'] ? String(flags['name']) : undefined;
  const chosen = wanted ? all.filter((e) => e.animName === wanted) : all;
  if (chosen.length === 0) {
    throw new Error(`No effect named "${wanted}" in ${file}.`);
  }

  const device = await openDevice(positional[0]);
  let written = 0;

  for (const effect of chosen) {
    try {
      await device.importEffect(effect);
      out(`  wrote ${effect.animName}\n`);
      written++;
    } catch (e) {
      // Keep going: one incompatible effect should not abandon the rest.
      err(`  skipped ${effect.animName}: ${(e as Error).message}\n`);
    }
  }

  out(`Imported ${written} of ${chosen.length} effect(s) into ${device.name}.\n`);
  await device.close();
}

async function cmdMotions(): Promise<void> {
  out(
    table(
      ['ID', 'MOTION', 'TYPE', 'DESCRIPTION'],
      BUILTIN_MOTIONS.map((m) => [m.id, m.label, m.pluginType, m.description]),
    ),
  );
}

async function cmdIdentify(): Promise<void> {
  const device = await openDevice(positional[0]);
  await device.identify();
  out(`${device.name} should be flashing now.\n`);
  await device.close();
}

async function cmdForget(): Promise<void> {
  const records = await loadRecords();
  const record = resolveTarget(records, positional[0]);
  await removeRecord(record.serialNo);
  out(`Forgot ${record.name}.\n`);
}

const USAGE = `betterleaf - Nanoleaf control from the command line

  discover [--ip <addr>]     Find devices on the network
  pair <ip> [--port N]       Pair with a device in pairing mode
  list                       Show paired devices
  forget [target]            Remove a paired device

  info [target]              Device details and capabilities
  state [target] [--on] [--off] [--brightness N] [--hue N] [--sat N] [--ct N]
  effects [target] [name]    List effects, or apply one
  layout [target]            Panel positions, and what gets filtered out
  identify [target]          Flash the panels

  plugins [target]           Motions this device actually has
  motions                    The built-in motions effects can be authored from
  export-effects [target] [file]
                             Save every effect on the device to a JSON file
  import-effect <target> <file> [--name X]
                             Write effects from a file onto the device

  watch [target]             Live event stream (state, effects, touch)
  stream [target] [--seconds N] [--restore <effect>]
                             Stream a moving gradient over UDP
  save-scene [target] [name] Write a scene onto the device permanently

'target' matches a serial prefix, model number, or part of the name.
Omit it when only one device is paired.
`;

const COMMANDS: Record<string, () => Promise<void>> = {
  discover: cmdDiscover,
  pair: cmdPair,
  list: cmdList,
  forget: cmdForget,
  info: cmdInfo,
  state: cmdState,
  effects: cmdEffects,
  effect: cmdEffects,
  layout: cmdLayout,
  identify: cmdIdentify,
  plugins: cmdPlugins,
  motions: cmdMotions,
  'export-effects': cmdExportEffects,
  'import-effect': cmdImportEffect,
  watch: cmdWatch,
  stream: cmdStream,
  'save-scene': cmdSaveScene,
};

const handler = command ? COMMANDS[command] : undefined;
if (!handler) {
  out(USAGE);
  process.exit(command ? 1 : 0);
}

try {
  await handler();
  process.exit(0);
} catch (e) {
  err(`\nError: ${(e as Error).message}\n`);
  process.exit(1);
}
