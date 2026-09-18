import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import type { NanoleafEffect } from '@betterleaf/protocol';

/**
 * One archived effect.
 *
 * Note what is *not* stored: which devices currently hold it. That is derived
 * live from the devices themselves, because they are the authority on their own
 * contents and a cached answer would go stale the moment someone used the
 * Nanoleaf app. `seenOn` is history — where this effect was ever harvested from
 * — which is a different and safely durable fact.
 */
export interface LibraryEntry {
  /** The effect's name, which is also how the device addresses it. */
  name: string;
  effect: NanoleafEffect;
  /** Hash of the effect's content, ignoring its name. Detects edits. */
  contentHash: string;
  firstSeenAt: number;
  lastSeenAt: number;
  /** Serial numbers this was ever harvested from. */
  seenOn: string[];
  favourite?: boolean;
}

interface StoreFile {
  version: 1;
  entries: LibraryEntry[];
}

/**
 * Canonical JSON: keys sorted at every level, so two structurally identical
 * effects hash the same regardless of the order the firmware happened to
 * serialise them in.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonical((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Fingerprint an effect by what it *does*, ignoring what it is called.
 *
 * Renaming a scene should not create a second archive entry, and two devices
 * holding the same downloaded scene should collapse to one. Comparing content
 * rather than names is also how an edit is detected: same name, different hash.
 */
export function effectHash(effect: NanoleafEffect): string {
  const { animName: _ignored, ...rest } = effect;
  return createHash('sha256').update(JSON.stringify(canonical(rest))).digest('hex').slice(0, 16);
}

export interface MergeResult {
  added: string[];
  updated: string[];
  unchanged: string[];
}

/**
 * The local archive of effects harvested from devices.
 *
 * The premise: Nanoleaf's Discover marketplace delivers scenes *to the lights*,
 * so the lights already hold everything the user has ever downloaded. Reading
 * them off and keeping a copy gives the whole catalogue with no cloud API, no
 * account, and nothing that can break — and it outlives the controller's own
 * limited storage.
 */
export class EffectLibrary {
  #file: string;
  #entries: Map<string, LibraryEntry> | undefined;

  constructor(file?: string) {
    this.#file = file ?? path.join(app.getPath('userData'), 'effect-library.json');
  }

  async load(): Promise<LibraryEntry[]> {
    if (this.#entries) return [...this.#entries.values()];
    try {
      const parsed = JSON.parse(await fs.readFile(this.#file, 'utf8')) as StoreFile;
      this.#entries = new Map(
        (parsed.entries ?? [])
          .filter((e) => typeof e?.name === 'string' && e.effect)
          .map((e) => [e.name, { ...e, seenOn: e.seenOn ?? [] }]),
      );
    } catch {
      this.#entries = new Map();
    }
    return [...this.#entries.values()];
  }

  async #save(): Promise<void> {
    const file: StoreFile = { version: 1, entries: [...(this.#entries ?? []).values()] };
    await fs.mkdir(path.dirname(this.#file), { recursive: true });
    await fs.writeFile(this.#file, JSON.stringify(file, null, 2), 'utf8');
  }

  async entries(): Promise<LibraryEntry[]> {
    await this.load();
    return [...this.#entries!.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(name: string): Promise<LibraryEntry | undefined> {
    await this.load();
    return this.#entries!.get(name);
  }

  /**
   * Fold a device's effects into the archive.
   *
   * Keyed on name, because that is how a device addresses an effect and how the
   * user thinks about it. Same name and same hash is a no-op; same name with a
   * different hash means the scene was edited, and the newer content wins.
   */
  async merge(effects: readonly NanoleafEffect[], serialNo: string): Promise<MergeResult> {
    await this.load();
    const result: MergeResult = { added: [], updated: [], unchanged: [] };
    const now = Date.now();
    let dirty = false;

    for (const effect of effects) {
      const hash = effectHash(effect);
      const existing = this.#entries!.get(effect.animName);

      if (!existing) {
        this.#entries!.set(effect.animName, {
          name: effect.animName,
          effect,
          contentHash: hash,
          firstSeenAt: now,
          lastSeenAt: now,
          seenOn: [serialNo],
        });
        result.added.push(effect.animName);
        dirty = true;
        continue;
      }

      const seenOn = existing.seenOn.includes(serialNo)
        ? existing.seenOn
        : [...existing.seenOn, serialNo];

      if (existing.contentHash === hash) {
        // Nothing new, but record that this device still has it.
        if (seenOn !== existing.seenOn) dirty = true;
        this.#entries!.set(effect.animName, { ...existing, seenOn, lastSeenAt: now });
        result.unchanged.push(effect.animName);
        continue;
      }

      this.#entries!.set(effect.animName, {
        ...existing,
        effect,
        contentHash: hash,
        lastSeenAt: now,
        seenOn,
      });
      result.updated.push(effect.animName);
      dirty = true;
    }

    if (dirty || result.unchanged.length > 0) await this.#save();
    return result;
  }

  async setFavourite(name: string, favourite: boolean): Promise<void> {
    await this.load();
    const entry = this.#entries!.get(name);
    if (!entry) return;
    this.#entries!.set(name, { ...entry, favourite });
    await this.#save();
  }

  /** Forget an effect entirely. Does not touch any device. */
  async remove(name: string): Promise<void> {
    await this.load();
    if (this.#entries!.delete(name)) await this.#save();
  }

  /**
   * Is this effect safely archived, byte for byte?
   *
   * The gate before removing anything from a device. An archive that merely has
   * *a* scene by that name is not good enough — if the device's copy differs,
   * deleting it destroys something we do not have.
   */
  async isArchived(effect: NanoleafEffect): Promise<boolean> {
    await this.load();
    const entry = this.#entries!.get(effect.animName);
    return entry !== undefined && entry.contentHash === effectHash(effect);
  }

  get filePath(): string {
    return this.#file;
  }
}
