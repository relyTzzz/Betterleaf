import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DeviceRecord } from '@betterleaf/protocol';

/**
 * Where the CLI keeps paired devices.
 *
 * Plain JSON in the user's home directory. The Electron app encrypts tokens with
 * the OS keystore instead; this is a developer tool and being able to read the
 * file is a feature when something is going wrong.
 */
const STORE_DIR = process.env['BETTERLEAF_HOME'] ?? path.join(os.homedir(), '.betterleaf');
const STORE_FILE = path.join(STORE_DIR, 'devices.json');

export async function loadRecords(): Promise<DeviceRecord[]> {
  try {
    const text = await fs.readFile(STORE_FILE, 'utf8');
    const parsed = JSON.parse(text) as { devices?: DeviceRecord[] };
    return parsed.devices ?? [];
  } catch {
    return [];
  }
}

export async function saveRecords(records: DeviceRecord[]): Promise<void> {
  await fs.mkdir(STORE_DIR, { recursive: true });
  await fs.writeFile(
    STORE_FILE,
    JSON.stringify({ devices: records }, null, 2),
    'utf8',
  );
}

/** Insert or update by serial number — never by address. */
export async function upsertRecord(record: DeviceRecord): Promise<void> {
  const records = await loadRecords();
  const index = records.findIndex((r) => r.serialNo === record.serialNo);
  if (index === -1) records.push(record);
  else records[index] = { ...records[index], ...record };
  await saveRecords(records);
}

export async function removeRecord(serialNo: string): Promise<void> {
  const records = await loadRecords();
  await saveRecords(records.filter((r) => r.serialNo !== serialNo));
}

export function storePath(): string {
  return STORE_FILE;
}

/**
 * Resolve a user-supplied target to one stored device.
 *
 * Accepts a serial prefix, a model number, or part of the name, so you can type
 * `betterleaf state canvas --on` rather than a serial number.
 */
export function resolveTarget(
  records: DeviceRecord[],
  target: string | undefined,
): DeviceRecord {
  if (records.length === 0) {
    throw new Error('No paired devices. Run `betterleaf pair <ip>` first.');
  }
  if (!target) {
    if (records.length === 1) return records[0]!;
    throw new Error(
      `Several devices are paired; name one of: ${records.map((r) => r.name).join(', ')}`,
    );
  }

  const needle = target.toLowerCase();
  const matches = records.filter(
    (r) =>
      r.serialNo.toLowerCase().startsWith(needle) ||
      r.model.toLowerCase() === needle ||
      r.name.toLowerCase().includes(needle),
  );

  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw new Error(`No paired device matches "${target}"`);
  throw new Error(
    `"${target}" matches several devices: ${matches.map((m) => m.name).join(', ')}`,
  );
}
