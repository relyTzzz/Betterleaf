import { EventEmitter } from 'node:events';
import type { Schedule, ScheduleAction, ScheduleTarget } from '../shared/types.js';
import type { ScheduleStore } from './schedule-store.js';

/**
 * The result of trying to carry a schedule out.
 *
 * `skipped` is deliberately neither success nor an error. A locked light was
 * held back on purpose, so recording it as a failure would put a warning on
 * something working exactly as asked — and recording it as `ok` would claim the
 * lights changed when they did not.
 */
export type ApplyOutcome = { kind: 'ok' } | { kind: 'skipped'; reason: string };

/**
 * Recorded as `lastResult` when a lock held the schedule back.
 *
 * A sentinel rather than a sentence, because the UI has more room and better
 * words than a stored string does.
 */
export const LOCKED_RESULT = 'locked';

/** What actually drives the lights when a schedule fires. */
export type ApplySchedule = (
  target: ScheduleTarget,
  action: ScheduleAction,
) => Promise<ApplyOutcome>;

export interface SchedulerOptions {
  /**
   * How often to look for due schedules.
   *
   * A repeating tick rather than one long timer per schedule. `setTimeout` for
   * eight hours does not survive the machine sleeping, and a lid closing is the
   * normal case here, not an edge case. Ticking also means a clock change, a
   * timezone change or a DST jump is noticed within one tick instead of quietly
   * skewing every schedule.
   */
  tickMs?: number;
  /**
   * How late a schedule may fire and still count.
   *
   * Past this it is recorded as missed and skipped. Turning the lights on four
   * hours late because the PC was asleep is worse than not turning them on: the
   * schedule said 7am, and 11am is not a late 7am, it is the wrong answer.
   */
  graceMs?: number;
  /** Injectable clock, for tests. */
  now?: () => number;
}

type SchedulerEvents = {
  /** A schedule fired or was marked missed; its stored state changed. */
  changed: [];
  fired: [{ id: string; result: string }];
};

const MINUTES_PER_DAY = 1440;

/**
 * The most recent moment this schedule was due, at or before `nowMs`.
 *
 * Built from local date components rather than by subtracting milliseconds, so
 * the hour named in the schedule is the hour on the wall clock across a DST
 * boundary. Searches back a whole week because a Sunday-only schedule can be
 * six days stale. Returns undefined when it runs on no days at all.
 *
 * On a spring-forward morning a time inside the skipped hour does not exist;
 * JavaScript normalises it to the following hour, which is what most people
 * would expect and is at least deterministic.
 */
export function mostRecentOccurrence(
  schedule: Pick<Schedule, 'timeMinutes' | 'days'>,
  nowMs: number,
): number | undefined {
  if (schedule.days.length === 0) return undefined;
  const now = new Date(nowMs);
  const hours = Math.floor(schedule.timeMinutes / 60);
  const minutes = schedule.timeMinutes % 60;

  for (let back = 0; back <= 7; back++) {
    const candidate = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - back,
      hours,
      minutes,
      0,
      0,
    );
    if (candidate.getTime() > nowMs) continue;
    if (!schedule.days.includes(candidate.getDay())) continue;
    return candidate.getTime();
  }
  return undefined;
}

/** The next moment this schedule is due, strictly after `nowMs`. */
export function nextOccurrence(
  schedule: Pick<Schedule, 'timeMinutes' | 'days'>,
  nowMs: number,
): number | undefined {
  if (schedule.days.length === 0) return undefined;
  const now = new Date(nowMs);
  const hours = Math.floor(schedule.timeMinutes / 60);
  const minutes = schedule.timeMinutes % 60;

  for (let forward = 0; forward <= 7; forward++) {
    const candidate = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + forward,
      hours,
      minutes,
      0,
      0,
    );
    if (candidate.getTime() <= nowMs) continue;
    if (!schedule.days.includes(candidate.getDay())) continue;
    return candidate.getTime();
  }
  return undefined;
}

/** True when the action would do nothing at all, which the editor refuses. */
export function isEmptyAction(action: ScheduleAction): boolean {
  return (
    action.power === undefined &&
    action.effect === undefined &&
    action.brightness === undefined
  );
}

/** "07:30", for display and for the time input. */
export function formatTime(timeMinutes: number): string {
  const m = ((Math.round(timeMinutes) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/**
 * Fires schedules while the app is running.
 *
 * Deliberately knows nothing about devices, rooms or Electron: it decides *when*
 * and hands the *what* to an apply function. That keeps the timing rules — the
 * part that is easy to get subtly wrong and impossible to notice — testable
 * without a window, a network or real hardware.
 */
export class Scheduler extends EventEmitter<SchedulerEvents> {
  readonly #store: ScheduleStore;
  readonly #apply: ApplySchedule;
  readonly #tickMs: number;
  readonly #graceMs: number;
  readonly #now: () => number;

  #timer: NodeJS.Timeout | undefined;
  /** One tick at a time: a slow device must not let the next tick double-fire. */
  #ticking = false;

  constructor(store: ScheduleStore, apply: ApplySchedule, options: SchedulerOptions = {}) {
    super();
    this.#store = store;
    this.#apply = apply;
    this.#tickMs = options.tickMs ?? 20_000;
    this.#graceMs = options.graceMs ?? 120_000;
    this.#now = options.now ?? (() => Date.now());
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.tick(), this.#tickMs);
    // Does not hold the process open on its own; the window does that.
    this.#timer.unref?.();
  }

  stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /**
   * Fire everything that has come due.
   *
   * Public so tests can drive it directly rather than waiting on wall time.
   */
  async tick(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      const now = this.#now();
      let changed = false;

      for (const schedule of await this.#store.load()) {
        if (!schedule.enabled) continue;

        const due = mostRecentOccurrence(schedule, now);
        if (due === undefined) continue;

        // Already claimed. Comparing against the slot rather than against the
        // moment of the write is what makes this idempotent across restarts.
        if (schedule.lastRunAt !== undefined && schedule.lastRunAt >= due) continue;

        if (now - due > this.#graceMs) {
          // The machine was off, asleep, or Betterleaf was not running. Claim the
          // slot so it is not retried forever, and say so rather than pretending.
          await this.#store.recordRun(schedule.id, due, 'missed');
          changed = true;
          continue;
        }

        const result = await this.#fire(schedule);
        await this.#store.recordRun(schedule.id, due, result);
        this.emit('fired', { id: schedule.id, result });
        changed = true;
      }

      if (changed) this.emit('changed');
    } finally {
      this.#ticking = false;
    }
  }

  /** Apply a schedule's action immediately, without touching its slot state. */
  async runNow(id: string): Promise<{ ok: boolean; error?: string }> {
    const schedule = (await this.#store.load()).find((s) => s.id === id);
    if (!schedule) return { ok: false, error: 'That schedule no longer exists.' };
    const result = await this.#fire(schedule);
    return result === 'ok' ? { ok: true } : { ok: false, error: result };
  }

  /** Returns 'ok', a skip reason, or the error text to record. */
  async #fire(schedule: Schedule): Promise<string> {
    try {
      const outcome = await this.#apply(schedule.target, schedule.action);
      return outcome.kind === 'ok' ? 'ok' : outcome.reason;
    } catch (err) {
      return (err as Error).message || 'Failed';
    }
  }
}
