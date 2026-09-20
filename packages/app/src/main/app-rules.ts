import { EventEmitter } from 'node:events';
import type { AppRule, ScheduleAction, ScheduleTarget } from '../shared/types.js';
import { targetKey, type CapturedDevice, type AppRuleStore } from './app-rule-store.js';
import { matchProcess, type ListProcesses } from './process-watch.js';

/**
 * What the engine needs from the rest of the app.
 *
 * Kept behind an interface for the same reason the scheduler is: deciding which
 * rule wins, when to take a light over and when to give it back is the part
 * that is easy to get subtly wrong, and it should be testable without devices,
 * Electron or a real process list.
 */
export interface RuleTargetOps {
  /** Which serials a target covers right now, or empty when it is gone. */
  serialsFor(target: ScheduleTarget): string[];
  /** What those lights are showing, to put back later. */
  capture(serialNos: string[]): CapturedDevice[];
  apply(target: ScheduleTarget, action: ScheduleAction): Promise<void>;
  /** Put one light back as it was. */
  restoreDevice(state: CapturedDevice): Promise<void>;
  /** What a light is showing now, for deciding whether a restore is wanted. */
  current(serialNo: string): CapturedDevice | undefined;
}

export interface AppRuleEngineOptions {
  /**
   * How often to look at the process list.
   *
   * Deliberately unhurried. Enumerating processes costs roughly half a second
   * of wall time, so a brisk poll would have Betterleaf spawning `tasklist`
   * more or less permanently for a background feature. Ten seconds is well
   * inside how long anyone takes to notice a game has started.
   */
  pollMs?: number;
  now?: () => number;
}

type Events = {
  /** Holds changed, so the snapshot needs republishing. */
  changed: [];
};

/**
 * Is this light still showing what the rule put there?
 *
 * Restoring is only right when nothing has touched the light since. If you
 * changed the scene by hand while the game was running, putting the old one
 * back when the game quits would be undoing your change, not tidying up after
 * the rule — so in that case the rule lets go without doing anything.
 */
export function stillHolding(
  current: CapturedDevice | undefined,
  applied: ScheduleAction,
): boolean {
  if (!current) return false;
  if (applied.effect !== undefined) return current.effect === applied.effect;
  if (applied.brightness !== undefined) return current.brightness === applied.brightness;
  if (applied.power !== undefined) return current.on === applied.power;
  // A rule that set nothing borrowed nothing.
  return false;
}

/**
 * Picks the winning rule per target and moves the lights when it changes.
 *
 * Edge-triggered, not continuously enforced: it acts when the winner changes,
 * and otherwise leaves the lights alone. Re-applying every few seconds would
 * fight anyone adjusting a light by hand while the app was open, which is a
 * worse failure than a rule not re-asserting itself.
 */
export class AppRuleEngine extends EventEmitter<Events> {
  readonly #store: AppRuleStore;
  readonly #list: ListProcesses;
  readonly #ops: RuleTargetOps;
  readonly #pollMs: number;
  readonly #now: () => number;

  #timer: NodeJS.Timeout | undefined;
  /** The pass currently running, so concurrent callers can join it. */
  #inFlight: Promise<void> | undefined;
  /** Last seen process list, for the UI and for `matching` flags. */
  #processes = new Set<string>();

  constructor(
    store: AppRuleStore,
    list: ListProcesses,
    ops: RuleTargetOps,
    options: AppRuleEngineOptions = {},
  ) {
    super();
    this.#store = store;
    this.#list = list;
    this.#ops = ops;
    this.#pollMs = options.pollMs ?? 10_000;
    this.#now = options.now ?? (() => Date.now());
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.evaluate(), this.#pollMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** The most recent process list, for building rules and showing state. */
  get processes(): ReadonlySet<string> {
    return this.#processes;
  }

  /**
   * Read the process list whether or not any rule wants it.
   *
   * For the rule editor, which offers what is running as suggestions. `evaluate`
   * deliberately skips the listing when nothing needs it, so it cannot be used
   * for this.
   */
  async refreshProcesses(): Promise<ReadonlySet<string>> {
    this.#processes = await this.#list();
    return this.#processes;
  }

  /** Which serials a rule is currently holding, so schedules can skip them. */
  async heldSerials(): Promise<Set<string>> {
    const held = new Set<string>();
    for (const hold of await this.#store.holds()) {
      for (const captured of hold.restore) held.add(captured.serialNo);
    }
    return held;
  }

  /** Which rule, if any, is holding each target. */
  async holdingRuleIds(): Promise<Set<string>> {
    return new Set((await this.#store.holds()).map((h) => h.ruleId));
  }

  /**
   * Look at what is running and make the lights agree.
   *
   * Public so tests can drive it directly rather than waiting on a timer.
   */
  async evaluate(): Promise<void> {
    // Joining rather than bailing out. A caller that awaits this has to be able
    // to rely on the state being settled afterwards — returning early while a
    // pass was still in flight left `createAppRule` racing its own evaluate,
    // and the snapshot reporting a rule as idle while it was already playing.
    if (this.#inFlight) {
      // Their pass may have started before whatever prompted this call, so look
      // again once it finishes rather than inheriting its answer.
      const previous = this.#inFlight;
      await previous;
      // Annotated, because narrowing from the check above survives the await
      // and would otherwise make this look like a constant.
      const current: Promise<void> | undefined = this.#inFlight;
      // Someone started a fresh pass while we waited; join that one rather than
      // queueing a third.
      if (current && current !== previous) return current;
    }
    const run = this.#evaluateOnce().finally(() => {
      this.#inFlight = undefined;
    });
    this.#inFlight = run;
    return run;
  }

  async #evaluateOnce(): Promise<void> {
    const rules = await this.#store.load();
    const holds = await this.#store.holds();

    // Nothing to watch for and nothing being held: skip the process listing
    // entirely. Half a second of `tasklist` every poll is a real cost, and a
    // user with no rules should not pay it at all.
    const watching = rules.some((r) => r.enabled && r.processNames.length > 0);
    if (!watching && holds.length === 0) {
      this.#processes = new Set();
      return;
    }

    this.#processes = await this.#list();
    let changed = false;

    // The winner per target: lowest priority number among matching rules.
    const winners = new Map<string, { rule: AppRule; process: string }>();
    for (const rule of [...rules].sort((a, b) => a.priority - b.priority)) {
      if (!rule.enabled) continue;
      const key = targetKey(rule.target);
      if (winners.has(key)) continue; // something above it already won
      const process = matchProcess(rule.processNames, this.#processes);
      if (process) winners.set(key, { rule, process });
    }

    // Release anything whose rule stopped winning.
    for (const hold of holds) {
      const winner = winners.get(hold.targetKey);
      if (winner?.rule.id === hold.ruleId) continue;

      await this.#release(hold.targetKey, hold.ruleId, hold.applied, hold.restore);
      changed = true;
    }

    // Take over anything newly won.
    for (const [key, { rule }] of winners) {
      const existing = holds.find((h) => h.targetKey === key);
      if (existing?.ruleId === rule.id) continue;

      const serials = this.#ops.serialsFor(rule.target);
      if (serials.length === 0) continue; // target gone or nothing connected

      // Capture before applying, or the restore point is the rule's own
      // scene. When one rule takes over from another, the thing to go back to
      // is what the *first* rule displaced, not what it left on screen.
      const restore = existing ? existing.restore : this.#ops.capture(serials);

      await this.#ops.apply(rule.target, rule.action);
      await this.#store.setHold({
        targetKey: key,
        ruleId: rule.id,
        applied: rule.action,
        restore,
        since: this.#now(),
      });
      changed = true;
    }

    if (changed) this.emit('changed');
  }

  /** Give a target back, if the lights still show what the rule put there. */
  async #release(
    key: string,
    _ruleId: string,
    applied: ScheduleAction,
    restore: CapturedDevice[],
  ): Promise<void> {
    for (const captured of restore) {
      if (!stillHolding(this.#ops.current(captured.serialNo), applied)) continue;
      try {
        await this.#ops.restoreDevice(captured);
      } catch {
        // An unreachable light cannot be put back, and there is nothing useful
        // to retry against. Dropping the hold anyway is right: keeping it would
        // block schedules on a light no rule is really driving.
      }
    }
    await this.#store.clearHold(key);
  }

  /** Let go of everything, restoring where the lights still show a rule scene. */
  async releaseAll(): Promise<void> {
    for (const hold of await this.#store.holds()) {
      await this.#release(hold.targetKey, hold.ruleId, hold.applied, hold.restore);
    }
    this.emit('changed');
  }
}
