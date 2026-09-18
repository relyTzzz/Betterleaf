import fs from 'node:fs/promises';
import path from 'node:path';
import { app, safeStorage } from 'electron';
import type { DeviceRecord } from '@betterleaf/protocol';

interface StoredDevice extends Omit<DeviceRecord, 'token'> {
  /** Base64 ciphertext when `tokenEncrypted`, otherwise the token in the clear. */
  token: string;
  tokenEncrypted: boolean;
}

interface StoreFile {
  version: 1;
  devices: StoredDevice[];
}

/**
 * Paired devices on disk.
 *
 * Auth tokens are encrypted with Electron's `safeStorage`, which on Windows is
 * DPAPI keyed to the user account. A token is not a password, but it is a
 * permanent grant of control over the lights, and leaving it in plaintext JSON
 * is a gratuitous risk. Where encryption is unavailable we store it in the clear
 * and say so in the file rather than failing — losing the pairing would be a
 * worse outcome than the exposure.
 */
export class DeviceStore {
  #file: string;
  #cache: DeviceRecord[] | undefined;

  constructor(file?: string) {
    this.#file = file ?? path.join(app.getPath('userData'), 'devices.json');
  }

  async load(): Promise<DeviceRecord[]> {
    if (this.#cache) return this.#cache;

    try {
      const text = await fs.readFile(this.#file, 'utf8');
      const parsed = JSON.parse(text) as StoreFile;
      this.#cache = (parsed.devices ?? []).flatMap((stored) => {
        const token = this.#decrypt(stored);
        if (token === undefined) return [];
        const { tokenEncrypted: _ignored, ...rest } = stored;
        return [{ ...rest, token }];
      });
    } catch {
      this.#cache = [];
    }
    return this.#cache;
  }

  async save(records: DeviceRecord[]): Promise<void> {
    this.#cache = records;
    const encryptable = this.#canEncrypt();

    const file: StoreFile = {
      version: 1,
      devices: records.map((record) => ({
        ...record,
        token: encryptable
          ? safeStorage.encryptString(record.token).toString('base64')
          : record.token,
        tokenEncrypted: encryptable,
      })),
    };

    await fs.mkdir(path.dirname(this.#file), { recursive: true });
    await fs.writeFile(this.#file, JSON.stringify(file, null, 2), 'utf8');
  }

  /** Insert or update by serial number — never by address. */
  async upsert(record: DeviceRecord): Promise<void> {
    const records = [...(await this.load())];
    const index = records.findIndex((r) => r.serialNo === record.serialNo);
    if (index === -1) records.push(record);
    else records[index] = { ...records[index], ...record };
    await this.save(records);
  }

  async remove(serialNo: string): Promise<void> {
    const records = await this.load();
    await this.save(records.filter((r) => r.serialNo !== serialNo));
  }

  #canEncrypt(): boolean {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  #decrypt(stored: StoredDevice): string | undefined {
    if (!stored.tokenEncrypted) return stored.token;
    try {
      return safeStorage.decryptString(Buffer.from(stored.token, 'base64'));
    } catch {
      // Written under a different OS user or a reset keychain. The token is
      // unrecoverable; drop the record so the user is told to re-pair rather
      // than being shown a device that can never respond.
      return undefined;
    }
  }
}
