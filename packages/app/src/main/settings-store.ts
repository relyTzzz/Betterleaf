import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import { DEFAULT_HOOK_PORT } from '../shared/hooks.js';

export interface StoredSettings {
  /** Closing the window hides to the tray instead of quitting. */
  trayEnabled: boolean;
  /**
   * Listen for hooks on loopback. Off until asked for: a program that opens a
   * port nobody asked it to is a surprise, however harmless the port.
   */
  hooksEnabled: boolean;
  hooksPort: number;
}

const DEFAULTS: StoredSettings = {
  trayEnabled: true,
  hooksEnabled: false,
  hooksPort: DEFAULT_HOOK_PORT,
};

/** A port someone could actually have meant. Below 1024 needs privileges. */
export function cleanPort(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1024 && value <= 65535
    ? value
    : DEFAULT_HOOK_PORT;
}

/**
 * How the app is set to run, on disk.
 *
 * Only `trayEnabled` lives here. Whether Betterleaf starts with Windows is not
 * stored: Electron's login item settings are the actual authority, and a copy
 * in a JSON file would be free to disagree with the registry the moment anyone
 * removed the entry by hand.
 */
export class SettingsStore {
  #file: string;
  #cache: StoredSettings | undefined;

  constructor(file?: string) {
    this.#file = file ?? path.join(app.getPath('userData'), 'settings.json');
  }

  async load(): Promise<StoredSettings> {
    if (this.#cache) return this.#cache;
    try {
      const parsed = JSON.parse(await fs.readFile(this.#file, 'utf8')) as
        | Partial<StoredSettings>
        | undefined;
      this.#cache = {
        trayEnabled: parsed?.trayEnabled !== false,
        hooksEnabled: parsed?.hooksEnabled === true,
        hooksPort: cleanPort(parsed?.hooksPort),
      };
    } catch {
      this.#cache = { ...DEFAULTS };
    }
    return this.#cache;
  }

  /** Change some settings and keep the rest. */
  async update(patch: Partial<StoredSettings>): Promise<StoredSettings> {
    const next = { ...(await this.load()), ...patch };
    await this.save(next);
    return next;
  }

  async save(settings: StoredSettings): Promise<void> {
    this.#cache = settings;
    await fs.mkdir(path.dirname(this.#file), { recursive: true });
    await fs.writeFile(this.#file, JSON.stringify(settings, null, 2), 'utf8');
  }
}
