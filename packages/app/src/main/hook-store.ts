import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { app } from 'electron';
import { cleanAction, cleanTarget } from './action.js';
import { slugify } from '../shared/hooks.js';
import type { Hook, HookInput } from '../shared/types.js';

interface StoreFile {
  version: 1;
  hooks: Hook[];
}

/** `wanted`, or `wanted-2`, `wanted-3`… whichever is free first. */
function uniqueSlug(wanted: string, taken: Set<string>): string {
  const base = wanted || 'hook';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Hooks on disk.
 *
 * Only the configuration lives here. Which callers are currently reporting
 * which hook is deliberately kept in memory: nothing is captured to restore
 * later, so a restart costs nothing worse than the next report re-applying a
 * scene the lights already show.
 */
export class HookStore {
  #file: string;
  #cache: StoreFile | undefined;

  constructor(file?: string) {
    this.#file = file ?? path.join(app.getPath('userData'), 'hooks.json');
  }

  async #read(): Promise<StoreFile> {
    if (this.#cache) return this.#cache;
    try {
      const parsed = JSON.parse(await fs.readFile(this.#file, 'utf8')) as StoreFile;
      const taken = new Set<string>();
      const hooks = (parsed.hooks ?? [])
        .flatMap((raw, i) => {
          const target = cleanTarget(raw?.target);
          if (typeof raw?.id !== 'string' || !target) return [];
          const name = typeof raw.name === 'string' ? raw.name : 'Hook';
          // A hand-edited file could hold two hooks at one address. The first
          // keeps it, so whatever already calls that address keeps working.
          const slug = uniqueSlug(
            slugify(typeof raw.slug === 'string' ? raw.slug : name),
            taken,
          );
          taken.add(slug);
          return [
            {
              id: raw.id,
              name,
              slug,
              enabled: raw.enabled !== false,
              target,
              action: cleanAction(raw.action),
              priority: typeof raw.priority === 'number' ? raw.priority : i,
            } satisfies Hook,
          ];
        })
        .sort((a, b) => a.priority - b.priority)
        .map((hook, i) => ({ ...hook, priority: i }));
      this.#cache = { version: 1, hooks };
    } catch {
      this.#cache = { version: 1, hooks: [] };
    }
    return this.#cache;
  }

  async #write(next: StoreFile): Promise<void> {
    this.#cache = next;
    await fs.mkdir(path.dirname(this.#file), { recursive: true });
    await fs.writeFile(this.#file, JSON.stringify(next, null, 2), 'utf8');
  }

  async load(): Promise<Hook[]> {
    return (await this.#read()).hooks;
  }

  async create(input: HookInput): Promise<Hook> {
    const file = await this.#read();
    const name = input.name.trim() || 'New hook';
    const taken = new Set(file.hooks.map((h) => h.slug));
    const hook: Hook = {
      id: randomUUID(),
      name,
      slug: uniqueSlug(slugify(input.slug) || slugify(name), taken),
      enabled: input.enabled !== false,
      target: input.target,
      action: cleanAction(input.action),
      // New hooks go to the bottom, where they cannot silently outrank
      // something the user already arranged.
      priority: file.hooks.length,
    };
    await this.#write({ ...file, hooks: [...file.hooks, hook] });
    return hook;
  }

  async update(id: string, input: HookInput): Promise<void> {
    const file = await this.#read();
    const existing = file.hooks.find((h) => h.id === id);
    if (!existing) return;
    const taken = new Set(file.hooks.filter((h) => h.id !== id).map((h) => h.slug));
    // An emptied address field keeps the old address rather than deriving a
    // new one from the name: changing it is the one edit that breaks callers,
    // so it only happens when someone types a new one.
    const slug = uniqueSlug(slugify(input.slug) || existing.slug, taken);
    await this.#write({
      ...file,
      hooks: file.hooks.map((h) =>
        h.id === id
          ? {
              ...h,
              name: input.name.trim() || h.name,
              slug,
              enabled: input.enabled !== false,
              target: input.target,
              action: cleanAction(input.action),
            }
          : h,
      ),
    });
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const file = await this.#read();
    if (!file.hooks.some((h) => h.id === id)) return;
    await this.#write({
      ...file,
      hooks: file.hooks.map((h) => (h.id === id ? { ...h, enabled } : h)),
    });
  }

  async remove(id: string): Promise<void> {
    const file = await this.#read();
    await this.#write({
      ...file,
      hooks: file.hooks.filter((h) => h.id !== id).map((h, i) => ({ ...h, priority: i })),
    });
  }

  /** Highest priority first. Anything unmentioned keeps its relative order. */
  async reorder(ids: string[]): Promise<void> {
    const file = await this.#read();
    const byId = new Map(file.hooks.map((h) => [h.id, h]));
    const ordered: Hook[] = [];
    for (const id of ids) {
      const hook = byId.get(id);
      if (hook) {
        ordered.push({ ...hook, priority: ordered.length });
        byId.delete(id);
      }
    }
    for (const hook of byId.values()) {
      ordered.push({ ...hook, priority: ordered.length });
    }
    await this.#write({ ...file, hooks: ordered });
  }

  /** Drop hooks aimed at a device that is being forgotten. */
  async pruneDevice(serialNo: string): Promise<void> {
    await this.#pruneWhere((h) => h.target.kind === 'device' && h.target.serialNo === serialNo);
  }

  /** Drop hooks aimed at a room that is being deleted. */
  async pruneRoom(roomId: string): Promise<void> {
    await this.#pruneWhere((h) => h.target.kind === 'room' && h.target.roomId === roomId);
  }

  async #pruneWhere(doomed: (h: Hook) => boolean): Promise<void> {
    const file = await this.#read();
    const hooks = file.hooks.filter((h) => !doomed(h));
    if (hooks.length === file.hooks.length) return;
    await this.#write({ ...file, hooks: hooks.map((h, i) => ({ ...h, priority: i })) });
  }
}
