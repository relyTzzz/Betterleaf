import type { ScheduleAction, ScheduleView } from '../shared/types.js';

/**
 * Turning schedules into the words the UI shows.
 *
 * Kept out of the component so it can be tested without a DOM. These are date
 * calculations wearing a presentation hat, and date calculations are where the
 * quiet, plausible-looking mistakes live — "Next tomorrow at 11:00 PM" for
 * something eighteen minutes away reads perfectly fine right up until you
 * notice it.
 */

/** 0 = Sunday, matching `Date#getDay` and what the store keeps. */
export const DAYS = [
  { value: 0, short: 'S', label: 'Sunday' },
  { value: 1, short: 'M', label: 'Monday' },
  { value: 2, short: 'T', label: 'Tuesday' },
  { value: 3, short: 'W', label: 'Wednesday' },
  { value: 4, short: 'T', label: 'Thursday' },
  { value: 5, short: 'F', label: 'Friday' },
  { value: 6, short: 'S', label: 'Saturday' },
];

export const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
export const WEEKDAYS = [1, 2, 3, 4, 5];
export const WEEKENDS = [0, 6];

function sameDays(a: number[], b: number[]): boolean {
  return a.length === b.length && b.every((d) => a.includes(d));
}

export function describeDays(days: number[]): string {
  if (days.length === 0) return 'No days — never runs';
  if (sameDays(days, EVERY_DAY)) return 'Every day';
  if (sameDays(days, WEEKDAYS)) return 'Weekdays';
  if (sameDays(days, WEEKENDS)) return 'Weekends';
  return [...days]
    .sort((a, b) => a - b)
    .map((d) => DAYS[d]?.label.slice(0, 3) ?? '?')
    .join(', ');
}

/** "07:30", as an `<input type="time">` wants it. */
export function minutesToInput(timeMinutes: number): string {
  const h = Math.floor(timeMinutes / 60);
  const m = timeMinutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function inputToMinutes(value: string): number {
  const [h, m] = value.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  return Math.min(1439, Math.max(0, (h ?? 0) * 60 + (m ?? 0)));
}

/** "7:30 AM", in whatever the machine's locale calls it. */
export function displayTime(timeMinutes: number): string {
  const d = new Date();
  d.setHours(Math.floor(timeMinutes / 60), timeMinutes % 60, 0, 0);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function describeAction(action: ScheduleAction): string {
  const parts: string[] = [];
  if (action.power === false) return 'Turn off';
  if (action.power === true) parts.push('Turn on');
  if (action.effect !== undefined) parts.push(`play "${action.effect}"`);
  if (action.brightness !== undefined) parts.push(`${action.brightness}% brightness`);
  if (parts.length === 0) return 'Do nothing';
  return parts.join(', ').replace(/^./, (c) => c.toUpperCase());
}

/**
 * Whole calendar days from today to the day `then` falls on.
 *
 * Both sides are reduced to midnight before subtracting, rather than dividing
 * the raw gap by a day. An 11pm schedule is 0.96 days away from this morning's
 * midnight, and rounding that to 1 put tonight's schedule on tomorrow — along
 * with everything else later than noon. Comparing midnights also survives a DST
 * boundary, where a calendar day is 23 or 25 hours long.
 */
export function calendarDaysUntil(then: Date, now: Date): number {
  const startOfThen = new Date(then.getFullYear(), then.getMonth(), then.getDate());
  const startOfNow = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((startOfThen.getTime() - startOfNow.getTime()) / 86_400_000);
}

export function describeNextRun(schedule: ScheduleView, nowMs: number): string {
  if (!schedule.enabled) return 'Paused';
  if (schedule.nextRunAt === undefined) return 'Never — no days selected';

  // Counting down is what you want when it is close: "in 18 min" answers the
  // question, where "at 11:00 PM" makes you do the arithmetic yourself.
  const minutesAway = Math.round((schedule.nextRunAt - nowMs) / 60_000);
  if (minutesAway <= 0) return 'Due now';
  if (minutesAway === 1) return 'Next in a minute';
  if (minutesAway < 60) return `Next in ${minutesAway} min`;

  const next = new Date(schedule.nextRunAt);
  const days = calendarDaysUntil(next, new Date(nowMs));
  const when =
    days === 0
      ? 'today'
      : days === 1
        ? 'tomorrow'
        : next.toLocaleDateString(undefined, { weekday: 'long' });

  return `Next ${when} at ${next.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}
