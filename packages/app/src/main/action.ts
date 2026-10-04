import type { ScheduleAction, ScheduleTarget } from '../shared/types.js';

/**
 * Reading actions and targets back off disk, or out of the renderer.
 *
 * One copy for schedules, app rules and hooks, because they share one action
 * model, and three cleaners would be three chances for a field to survive in
 * one file and be dropped in another.
 */

function clampRound(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Drop action fields that are absent or malformed.
 *
 * Only the keys actually present are applied, so an undefined that survived
 * into the file would otherwise turn into "set brightness to NaN" against real
 * hardware.
 */
export function cleanAction(value: unknown): ScheduleAction {
  const raw = (value ?? {}) as Record<string, unknown>;
  const action: ScheduleAction = {};
  if (typeof raw['power'] === 'boolean') action.power = raw['power'];
  if (typeof raw['effect'] === 'string' && raw['effect'] !== '') {
    action.effect = raw['effect'];
  }
  const color = raw['color'] as Record<string, unknown> | undefined;
  // A scene and a colour compete for the same panels. Keeping both would make
  // the order they are applied in decide what you see, so the scene wins and
  // the colour goes; the editors never produce both.
  if (action.effect === undefined && finite(color?.['hue']) && finite(color?.['saturation'])) {
    action.color = {
      // 360 and 0 are the same red, but the device takes 0–360 inclusive, so
      // clamping rather than wrapping keeps what was typed.
      hue: clampRound(color['hue'], 0, 360),
      saturation: clampRound(color['saturation'], 0, 100),
    };
  }
  if (finite(raw['brightness'])) {
    action.brightness = clampRound(raw['brightness'], 0, 100);
  }
  return action;
}

export function cleanTarget(value: unknown): ScheduleTarget | undefined {
  const raw = value as ScheduleTarget | undefined;
  if (raw?.kind === 'device' && typeof raw.serialNo === 'string') {
    return { kind: 'device', serialNo: raw.serialNo };
  }
  if (raw?.kind === 'room' && typeof raw.roomId === 'string') {
    return { kind: 'room', roomId: raw.roomId };
  }
  return undefined;
}

/** True when applying the action would change nothing at all. */
export function isEmptyAction(action: ScheduleAction): boolean {
  return (
    action.power === undefined &&
    action.effect === undefined &&
    action.color === undefined &&
    action.brightness === undefined
  );
}
