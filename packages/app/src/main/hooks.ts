import { EventEmitter } from 'node:events';
import type { Hook, ScheduleAction, ScheduleTarget } from '../shared/types.js';
import { targetKey } from './app-rule-store.js';
import type { HookStore } from './hook-store.js';
import type { ApplyOutcome } from './scheduler.js';

/** What actually moves the lights. Locks and app rules are its business. */
export type ApplyHook = (
  target: ScheduleTarget,
  action: ScheduleAction,
) => Promise<ApplyOutcome>;

export interface HookEngineOptions {
  /**
   * How long a caller still counts after it was last heard from.
   *
   * A Claude Code session closed with its window never says goodbye, and one
   * that died mid-task would otherwise keep its "working" outranking every
   * live session's "done" until Betterleaf restarted. An hour is far longer
   * than any working session goes without reporting a tool call, and only
   * matters when callers disagree: a lone caller expiring changes nothing,
   * because the lights are left showing its last report.
   */
  sourceTtlMs?: number;
  /** How often to look for callers that have gone quiet. */
  tickMs?: number;
  now?: () => number;
}

/** Answered before anything is applied, so a caller never waits on a light. */
export type FireOutcome = 'accepted' | 'unknown' | 'disabled';

/** One caller: a Claude Code session, a script, or anonymous. */
interface Source {
  lastHeardAt: number;
  /** Its latest report per target: target key -> hook id. */
  byTarget: Map<string, string>;
}

/** What hooks last put on a target, so a repeat report changes nothing. */
interface Shown {
  hookId: string;
  /** The action as applied, so editing the hook re-applies it. */
  action: string;
}

type Events = {
  /** Something a hook view shows has changed. */
  changed: [];
};

/**
 * Decides what each target shows when other programs report in.
 *
 * Callers report a hook, not an action: "this session is waiting", "that one
 * is done". Each caller's latest report counts, and when several callers'
 * reports land on the same lights, the hook highest in the list wins. That is
 * what makes two Claude Code sessions behave: one finishing must not paint
 * over another that is waiting on you.
 *
 * Edge-triggered, like app rules. A report that leaves the winner unchanged
 * does nothing at all, which matters because Claude Code reports after every
 * tool call — re-applying each time would hammer the lights and fight anyone
 * who changed them by hand.
 *
 * Nothing is captured or restored. A caller that wants the lights back says
 * so with a hook of its own; when the last caller leaves, the lights are left
 * as they are.
 */
export class HookEngine extends EventEmitter<Events> {
  readonly #store: HookStore;
  readonly #apply: ApplyHook;
  readonly #ttlMs: number;
  readonly #tickMs: number;
  readonly #now: () => number;

  /** Mirror of the store, so `fire` can answer without waiting on disk. */
  #hooks: Hook[] = [];
  readonly #sources = new Map<string, Source>();
  readonly #shown = new Map<string, Shown>();
  readonly #firedAt = new Map<string, number>();
  readonly #results = new Map<string, string>();

  /** Targets whose winner may have changed. */
  readonly #dirty = new Set<string>();
  /** The pass in progress. One at a time, so writes cannot interleave. */
  #running: Promise<void> | undefined;
  #timer: NodeJS.Timeout | undefined;

  constructor(store: HookStore, apply: ApplyHook, options: HookEngineOptions = {}) {
    super();
    this.#store = store;
    this.#apply = apply;
    this.#ttlMs = options.sourceTtlMs ?? 60 * 60_000;
    this.#tickMs = options.tickMs ?? 60_000;
    this.#now = options.now ?? (() => Date.now());
  }

  async start(): Promise<void> {
    this.#hooks = await this.#store.load();
    if (this.#timer) return;
    this.#timer = setInterval(() => this.sweep(), this.#tickMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Pick up configuration changes, and re-settle anything they affect. */
  async reload(): Promise<void> {
    this.#hooks = await this.#store.load();
    const known = new Set(this.#hooks.map((h) => h.id));
    for (const id of [...this.#results.keys()]) {
      if (!known.has(id)) this.#results.delete(id);
    }
    this.#queue(this.#allKeys());
  }

  /**
   * A caller reports a hook.
   *
   * Synchronous on purpose: whether the hook exists is known at once, and the
   * lights are settled afterwards, so the HTTP answer never waits on a light
   * that is slow or not there.
   */
  fire(slug: string, source = ''): FireOutcome {
    const hook = this.#hooks.find((h) => h.slug === slug);
    if (!hook) return 'unknown';
    if (!hook.enabled) return 'disabled';

    const now = this.#now();
    let entry = this.#sources.get(source);
    if (!entry) {
      entry = { lastHeardAt: now, byTarget: new Map() };
      this.#sources.set(source, entry);
    }
    entry.lastHeardAt = now;
    entry.byTarget.set(targetKey(hook.target), hook.id);
    this.#firedAt.set(hook.id, now);
    this.#queue([targetKey(hook.target)]);
    return 'accepted';
  }

  /** A caller is going away; its reports stop counting. */
  release(source = ''): boolean {
    const entry = this.#sources.get(source);
    if (!entry) return false;
    this.#sources.delete(source);
    this.#queue(entry.byTarget.keys());
    return true;
  }

  /** Forget every caller. The lights are left as they are. */
  clearSources(): void {
    const keys = this.#allKeys();
    this.#sources.clear();
    this.#queue(keys);
  }

  /**
   * Apply a hook's action now, without it counting as anyone's report.
   *
   * The target's record of what hooks last showed is dropped, because the
   * lights no longer show it. Otherwise the next report of the hook that was
   * winning would look like no change, and the lights would keep the test.
   */
  async test(id: string): Promise<{ ok: boolean; error?: string }> {
    const hook = this.#hooks.find((h) => h.id === id);
    if (!hook) return { ok: false, error: 'That hook no longer exists.' };
    this.#shown.delete(targetKey(hook.target));
    const result = await this.#run(hook);
    this.emit('changed');
    return result === 'ok' ? { ok: true } : { ok: false, error: result };
  }

  /** Drop callers that have gone quiet, and settle what they were holding up. */
  sweep(): void {
    const cutoff = this.#now() - this.#ttlMs;
    const keys: string[] = [];
    for (const [id, source] of this.#sources) {
      if (source.lastHeardAt >= cutoff) continue;
      this.#sources.delete(id);
      keys.push(...source.byTarget.keys());
    }
    if (keys.length > 0) this.#queue(keys);
  }

  /** Resolves once every queued report has been applied. */
  async settled(): Promise<void> {
    while (this.#running) await this.#running;
  }

  /** What the hooks view shows for one hook. */
  stateOf(hook: Hook): {
    sources: number;
    active: boolean;
    lastFiredAt?: number;
    lastResult?: string;
  } {
    const key = targetKey(hook.target);
    const cutoff = this.#now() - this.#ttlMs;
    let sources = 0;
    for (const source of this.#sources.values()) {
      if (source.lastHeardAt >= cutoff && source.byTarget.get(key) === hook.id) sources++;
    }
    const state: ReturnType<HookEngine['stateOf']> = {
      sources,
      active: this.#winnerFor(key)?.id === hook.id,
    };
    const firedAt = this.#firedAt.get(hook.id);
    if (firedAt !== undefined) state.lastFiredAt = firedAt;
    const result = this.#results.get(hook.id);
    if (result !== undefined) state.lastResult = result;
    return state;
  }

  #allKeys(): Set<string> {
    const keys = new Set(this.#shown.keys());
    for (const source of this.#sources.values()) {
      for (const key of source.byTarget.keys()) keys.add(key);
    }
    return keys;
  }

  /** The highest hook any live caller has reported for this target. */
  #winnerFor(key: string): Hook | undefined {
    const cutoff = this.#now() - this.#ttlMs;
    let best: Hook | undefined;
    for (const source of this.#sources.values()) {
      if (source.lastHeardAt < cutoff) continue;
      const id = source.byTarget.get(key);
      const hook = id === undefined ? undefined : this.#hooks.find((h) => h.id === id);
      // Paused, deleted, or moved to other lights since it was reported.
      if (!hook || !hook.enabled || targetKey(hook.target) !== key) continue;
      if (!best || hook.priority < best.priority) best = hook;
    }
    return best;
  }

  #queue(keys: Iterable<string>): void {
    for (const key of keys) this.#dirty.add(key);
    // Counts and timestamps changed even when the lights will not.
    this.emit('changed');
    this.#kick();
  }

  /**
   * Start a pass unless one is running.
   *
   * Reports that arrive mid-pass only mark their target; the running pass
   * picks them up before it finishes. So a burst of reports while a light is
   * slow to answer becomes one more pass, not a queue of stale writes.
   */
  #kick(): void {
    if (this.#running) return;
    const run = this.#drain();
    this.#running = run;
    void run.finally(() => {
      if (this.#running === run) this.#running = undefined;
      // Anything marked between the loop's last look and this point.
      if (this.#dirty.size > 0) this.#kick();
    });
  }

  async #drain(): Promise<void> {
    while (this.#dirty.size > 0) {
      const keys = [...this.#dirty];
      this.#dirty.clear();
      for (const key of keys) await this.#settle(key);
    }
  }

  async #settle(key: string): Promise<void> {
    const winner = this.#winnerFor(key);
    const shown = this.#shown.get(key);

    if (!winner) {
      // Nobody is asking for anything. Forgetting what was shown means the
      // next report applies even if it repeats the last one, which is right:
      // the lights may have been changed by hand in between.
      if (shown) this.#shown.delete(key);
      return;
    }

    const action = JSON.stringify(winner.action);
    if (shown?.hookId === winner.id && shown.action === action) return;

    // Claimed whatever the outcome, like a schedule's slot. A light that is
    // unreachable is not retried on every report — Claude Code reports after
    // each tool call, and that would be a storm against a light that is not
    // there. The next change of winner tries again.
    this.#shown.set(key, { hookId: winner.id, action });
    await this.#run(winner);
    this.emit('changed');
  }

  async #run(hook: Hook): Promise<string> {
    let result: string;
    try {
      const outcome = await this.#apply(hook.target, hook.action);
      result = outcome.kind === 'ok' ? 'ok' : outcome.reason;
    } catch (err) {
      result = (err as Error).message;
    }
    this.#results.set(hook.id, result);
    return result;
  }
}
