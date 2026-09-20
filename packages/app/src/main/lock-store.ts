import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';

interface StoreFile {
  version: 1;
  /** Serial numbers of locked devices. */
  locked: string[];
}

/**
 * Which lights are being held, on disk.
 *
 * A lock means "schedules leave this alone". It is keyed on `serialNo` like
 * everything else that outlives a session, so a DHCP lease change cannot quietly
 * release one.
 *
 * Persisted rather than kept in memory because the thing a lock defends against
 * happens hours later, often after a restart — a lock that evaporated when the
 * app closed would fail in exactly the case it exists for.
 *
 * Its own file for the same reason rooms and schedules have theirs: nothing here
 * is sensitive, and it must never share a fate with `devices.json`, which holds
 * the auth tokens.
 */
export class LockStore {
  #file: string;
  #cache: Set<string> | undefined;

  constructor(file?: string) {
    this.#file = file ?? path.join(app.getPath('userData'), 'locks.json');
  }

  async load(): Promise<Set<string>> {
    if (this.#cache) return this.#cache;
    try {
      const parsed = JSON.parse(await fs.readFile(this.#file, 'utf8')) as StoreFile;
      this.#cache = new Set(
        (parsed.locked ?? []).filter((s): s is string => typeof s === 'string'),
      );
    } catch {
      this.#cache = new Set();
    }
    return this.#cache;
  }

  async #save(locked: Set<string>): Promise<void> {
    this.#cache = locked;
    const file: StoreFile = { version: 1, locked: [...locked].sort() };
    await fs.mkdir(path.dirname(this.#file), { recursive: true });
    await fs.writeFile(this.#file, JSON.stringify(file, null, 2), 'utf8');
  }

  async setLocked(serialNo: string, locked: boolean): Promise<void> {
    const current = await this.load();
    if (current.has(serialNo) === locked) return;

    const next = new Set(current);
    if (locked) next.add(serialNo);
    else next.delete(serialNo);
    await this.#save(next);
  }

  /** Lock or unlock several lights in one write, as a room toggle does. */
  async setManyLocked(serialNos: string[], locked: boolean): Promise<void> {
    const current = await this.load();
    const next = new Set(current);
    for (const serial of serialNos) {
      if (locked) next.add(serial);
      else next.delete(serial);
    }
    if (next.size === current.size && [...next].every((s) => current.has(s))) return;
    await this.#save(next);
  }

  /** Drop a serial entirely. Called when a device is forgotten. */
  async prune(serialNo: string): Promise<void> {
    await this.setLocked(serialNo, false);
  }
}
