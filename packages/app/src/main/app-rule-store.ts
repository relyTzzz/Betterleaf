import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { app } from 'electron';
import type { AppRule, AppRuleInput, ScheduleAction } from '../shared/types.js';

/**
 * What a target looked like before a rule took it over.
 *
 * Kept per device even for a room rule, because a room's members can be showing
 * different things, and putting them all back to one member's scene would be a
 * worse answer than not restoring at all.
 */
export interface CapturedDevice {
  serialNo: string;
  on: boolean;
  brightness: number;
  effect: string;
}

/** A rule currently holding a target, and what to put back afterwards. */
export interface Hold {
  /** `device:<serial>` or `room:<id>`. */
  targetKey: string;
  ruleId: string;
  /** What the rule applied, so we can tell whether it still holds. */
  applied: ScheduleAction;
  restore: CapturedDevice[];
  since: number;
}

interface StoreFile {
  version: 1;
  rules: AppRule[];
  holds: Hold[];
}

function cleanAction(value: unknown): ScheduleAction {
  const raw = (value ?? {}) as Record<string, unknown>;
  const action: ScheduleAction = {};
  if (typeof raw['power'] === 'boolean') action.power = raw['power'];
  if (typeof raw['effect'] === 'string' && raw['effect'] !== '') {
    action.effect = raw['effect'];
  }
  if (typeof raw['brightness'] === 'number' && Number.isFinite(raw['brightness'])) {
    action.brightness = Math.min(100, Math.max(0, Math.round(raw['brightness'])));
  }
  return action;
}

function cleanTarget(value: unknown): AppRule['target'] | undefined {
  const raw = value as AppRule['target'] | undefined;
  if (raw?.kind === 'device' && typeof raw.serialNo === 'string') {
    return { kind: 'device', serialNo: raw.serialNo };
  }
  if (raw?.kind === 'room' && typeof raw.roomId === 'string') {
    return { kind: 'room', roomId: raw.roomId };
  }
  return undefined;
}

/** Lowercased, trimmed, de-duplicated, empties dropped. */
export function cleanProcessNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((n): n is string => typeof n === 'string')
        .map((n) => n.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

/** The key a hold is filed under. One target, one hold. */
export function targetKey(target: AppRule['target']): string {
  return target.kind === 'device' ? `device:${target.serialNo}` : `room:${target.roomId}`;
}

/**
 * App rules on disk, and which of them are currently holding something.
 *
 * The holds live beside the rules rather than in memory because the restore
 * point has to survive a restart. Betterleaf closing while a game is running,
 * then reopening, must not capture the game's own scene as the thing to go back
 * to — that would quietly replace your real scene with the game's forever.
 */
export class AppRuleStore {
  #file: string;
  #cache: StoreFile | undefined;

  constructor(file?: string) {
    this.#file = file ?? path.join(app.getPath('userData'), 'app-rules.json');
  }

  async #read(): Promise<StoreFile> {
    if (this.#cache) return this.#cache;
    try {
      const parsed = JSON.parse(await fs.readFile(this.#file, 'utf8')) as StoreFile;
      const rules = (parsed.rules ?? [])
        .flatMap((raw, i) => {
          const target = cleanTarget(raw?.target);
          if (typeof raw?.id !== 'string' || !target) return [];
          return [
            {
              id: raw.id,
              name: typeof raw.name === 'string' ? raw.name : 'Rule',
              enabled: raw.enabled !== false,
              processNames: cleanProcessNames(raw.processNames),
              target,
              action: cleanAction(raw.action),
              priority: typeof raw.priority === 'number' ? raw.priority : i,
            } satisfies AppRule,
          ];
        })
        .sort((a, b) => a.priority - b.priority)
        .map((rule, i) => ({ ...rule, priority: i }));

      const holds = (parsed.holds ?? []).filter(
        (h): h is Hold =>
          typeof h?.targetKey === 'string' &&
          typeof h?.ruleId === 'string' &&
          Array.isArray(h?.restore),
      );
      this.#cache = { version: 1, rules, holds };
    } catch {
      this.#cache = { version: 1, rules: [], holds: [] };
    }
    return this.#cache;
  }

  async #write(next: StoreFile): Promise<void> {
    this.#cache = next;
    await fs.mkdir(path.dirname(this.#file), { recursive: true });
    await fs.writeFile(this.#file, JSON.stringify(next, null, 2), 'utf8');
  }

  async load(): Promise<AppRule[]> {
    return (await this.#read()).rules;
  }

  async holds(): Promise<Hold[]> {
    return (await this.#read()).holds;
  }

  async create(input: AppRuleInput): Promise<AppRule> {
    const file = await this.#read();
    const rule: AppRule = {
      id: randomUUID(),
      name: input.name.trim() || 'New rule',
      enabled: input.enabled !== false,
      processNames: cleanProcessNames(input.processNames),
      target: input.target,
      action: cleanAction(input.action),
      // New rules go to the bottom, where they cannot silently outrank
      // something the user already arranged.
      priority: file.rules.length,
    };
    await this.#write({ ...file, rules: [...file.rules, rule] });
    return rule;
  }

  async update(id: string, input: AppRuleInput): Promise<void> {
    const file = await this.#read();
    if (!file.rules.some((r) => r.id === id)) return;
    await this.#write({
      ...file,
      rules: file.rules.map((r) =>
        r.id === id
          ? {
              ...r,
              name: input.name.trim() || r.name,
              enabled: input.enabled !== false,
              processNames: cleanProcessNames(input.processNames),
              target: input.target,
              action: cleanAction(input.action),
            }
          : r,
      ),
    });
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const file = await this.#read();
    if (!file.rules.some((r) => r.id === id)) return;
    await this.#write({
      ...file,
      rules: file.rules.map((r) => (r.id === id ? { ...r, enabled } : r)),
    });
  }

  async remove(id: string): Promise<void> {
    const file = await this.#read();
    await this.#write({
      ...file,
      rules: file.rules.filter((r) => r.id !== id).map((r, i) => ({ ...r, priority: i })),
      holds: file.holds.filter((h) => h.ruleId !== id),
    });
  }

  /** Highest priority first. Anything unmentioned keeps its relative order. */
  async reorder(ids: string[]): Promise<void> {
    const file = await this.#read();
    const byId = new Map(file.rules.map((r) => [r.id, r]));
    const ordered: AppRule[] = [];
    for (const id of ids) {
      const rule = byId.get(id);
      if (rule) {
        ordered.push({ ...rule, priority: ordered.length });
        byId.delete(id);
      }
    }
    for (const rule of byId.values()) {
      ordered.push({ ...rule, priority: ordered.length });
    }
    await this.#write({ ...file, rules: ordered });
  }

  async setHold(hold: Hold): Promise<void> {
    const file = await this.#read();
    await this.#write({
      ...file,
      holds: [...file.holds.filter((h) => h.targetKey !== hold.targetKey), hold],
    });
  }

  async clearHold(key: string): Promise<void> {
    const file = await this.#read();
    if (!file.holds.some((h) => h.targetKey === key)) return;
    await this.#write({ ...file, holds: file.holds.filter((h) => h.targetKey !== key) });
  }

  /** Drop rules and holds aimed at a device that is being forgotten. */
  async pruneDevice(serialNo: string): Promise<void> {
    await this.#pruneWhere(
      (r) => r.target.kind === 'device' && r.target.serialNo === serialNo,
      `device:${serialNo}`,
    );
  }

  /** Drop rules and holds aimed at a room that is being deleted. */
  async pruneRoom(roomId: string): Promise<void> {
    await this.#pruneWhere(
      (r) => r.target.kind === 'room' && r.target.roomId === roomId,
      `room:${roomId}`,
    );
  }

  async #pruneWhere(doomed: (r: AppRule) => boolean, key: string): Promise<void> {
    const file = await this.#read();
    const rules = file.rules.filter((r) => !doomed(r));
    const holds = file.holds.filter((h) => h.targetKey !== key);
    if (rules.length === file.rules.length && holds.length === file.holds.length) return;
    await this.#write({
      ...file,
      rules: rules.map((r, i) => ({ ...r, priority: i })),
      holds,
    });
  }
}
