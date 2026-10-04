import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { app } from 'electron';
import type { Schedule, ScheduleInput } from '../shared/types.js';
import { cleanAction, cleanTarget } from './action.js';

interface StoreFile {
  version: 1;
  schedules: Schedule[];
}

/** 0–1439, so a corrupt file cannot produce a schedule that fires at hour 97. */
function clampTime(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0;
  return Math.min(1439, Math.max(0, n));
}

/** Unique, sorted, and only real weekdays. */
function cleanDays(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort(
    (a, b) => a - b,
  );
}

/**
 * Schedules on disk.
 *
 * A third file alongside `devices.json` and `rooms.json`, for the same reason
 * rooms are separate: nothing here is sensitive, and a hand-edited or corrupt
 * schedules file must never cost you a pairing.
 *
 * Everything read back is re-validated rather than trusted. This file is the one
 * thing in Betterleaf that acts on its own, hours after anyone last looked at
 * the app, so a malformed entry has to be neutralised at load time rather than
 * discovered at 3am by the lights.
 */
export class ScheduleStore {
  #file: string;
  #cache: Schedule[] | undefined;

  constructor(file?: string) {
    this.#file = file ?? path.join(app.getPath('userData'), 'schedules.json');
  }

  async load(): Promise<Schedule[]> {
    if (this.#cache) return this.#cache;
    try {
      const parsed = JSON.parse(await fs.readFile(this.#file, 'utf8')) as StoreFile;
      this.#cache = (parsed.schedules ?? [])
        .flatMap((raw, i) => {
          const target = cleanTarget(raw?.target);
          if (typeof raw?.id !== 'string' || !target) return [];
          const schedule: Schedule = {
            id: raw.id,
            name: typeof raw.name === 'string' ? raw.name : 'Schedule',
            enabled: raw.enabled !== false,
            target,
            timeMinutes: clampTime(raw.timeMinutes),
            days: cleanDays(raw.days),
            action: cleanAction(raw.action),
            order: typeof raw.order === 'number' ? raw.order : i,
          };
          if (typeof raw.lastRunAt === 'number') schedule.lastRunAt = raw.lastRunAt;
          if (typeof raw.lastResult === 'string') schedule.lastResult = raw.lastResult;
          return [schedule];
        })
        .sort((a, b) => a.order - b.order);
    } catch {
      this.#cache = [];
    }
    return this.#cache;
  }

  async save(schedules: Schedule[]): Promise<void> {
    this.#cache = schedules;
    const file: StoreFile = { version: 1, schedules };
    await fs.mkdir(path.dirname(this.#file), { recursive: true });
    await fs.writeFile(this.#file, JSON.stringify(file, null, 2), 'utf8');
  }

  async create(input: ScheduleInput): Promise<Schedule> {
    const schedules = [...(await this.load())];
    const schedule: Schedule = {
      id: randomUUID(),
      name: input.name.trim() || 'New schedule',
      enabled: input.enabled !== false,
      target: input.target,
      timeMinutes: clampTime(input.timeMinutes),
      days: cleanDays(input.days),
      action: cleanAction(input.action),
      order: schedules.length,
      // Claim the slot that has already passed today, so a schedule created at
      // 9am for 7am is not immediately reported as missed for this morning.
      lastRunAt: Date.now(),
    };
    schedules.push(schedule);
    await this.save(schedules);
    return schedule;
  }

  /**
   * Replace a schedule's editable fields.
   *
   * `lastRunAt` is deliberately reset to now: moving a schedule from 7am to 6am
   * must not make this morning's 6am slot look overdue and fire on the spot.
   */
  async update(id: string, input: ScheduleInput): Promise<void> {
    const schedules = await this.load();
    if (!schedules.some((s) => s.id === id)) return;
    await this.save(
      schedules.map((s) => {
        if (s.id !== id) return s;
        const next: Schedule = {
          ...s,
          name: input.name.trim() || s.name,
          enabled: input.enabled !== false,
          target: input.target,
          timeMinutes: clampTime(input.timeMinutes),
          days: cleanDays(input.days),
          action: cleanAction(input.action),
          lastRunAt: Date.now(),
        };
        delete next.lastResult;
        return next;
      }),
    );
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const schedules = await this.load();
    const current = schedules.find((s) => s.id === id);
    if (!current || current.enabled === enabled) return;
    await this.save(
      schedules.map((s) =>
        // Re-enabling claims the current slot too, for the same reason as above.
        s.id === id ? { ...s, enabled, lastRunAt: Date.now() } : s,
      ),
    );
  }

  /** Record the outcome of a firing. `slotAt` is the slot, not the wall clock. */
  async recordRun(id: string, slotAt: number, result: string): Promise<void> {
    const schedules = await this.load();
    if (!schedules.some((s) => s.id === id)) return;
    await this.save(
      schedules.map((s) =>
        s.id === id ? { ...s, lastRunAt: slotAt, lastResult: result } : s,
      ),
    );
  }

  async remove(id: string): Promise<void> {
    const schedules = await this.load();
    await this.save(
      schedules.filter((s) => s.id !== id).map((s, i) => ({ ...s, order: i })),
    );
  }

  /** Drop every schedule aimed at a device that is being forgotten. */
  async pruneDevice(serialNo: string): Promise<void> {
    await this.#pruneWhere(
      (s) => s.target.kind === 'device' && s.target.serialNo === serialNo,
    );
  }

  /** Drop every schedule aimed at a room that is being deleted. */
  async pruneRoom(roomId: string): Promise<void> {
    await this.#pruneWhere((s) => s.target.kind === 'room' && s.target.roomId === roomId);
  }

  async #pruneWhere(doomed: (s: Schedule) => boolean): Promise<void> {
    const schedules = await this.load();
    if (!schedules.some(doomed)) return;
    await this.save(
      schedules.filter((s) => !doomed(s)).map((s, i) => ({ ...s, order: i })),
    );
  }
}
