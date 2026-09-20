import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';

export interface StoredSettings {
  /** Closing the window hides to the tray instead of quitting. */
  trayEnabled: boolean;
}

const DEFAULTS: StoredSettings = { trayEnabled: true };

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
      };
    } catch {
      this.#cache = { ...DEFAULTS };
    }
    return this.#cache;
  }

  async save(settings: StoredSettings): Promise<void> {
    this.#cache = settings;
    await fs.mkdir(path.dirname(this.#file), { recursive: true });
    await fs.writeFile(this.#file, JSON.stringify(settings, null, 2), 'utf8');
  }
}
