import { describe, expect, it } from 'vitest';
import {
  calendarDaysUntil,
  describeAction,
  describeDays,
  describeNextRun,
  inputToMinutes,
  minutesToInput,
} from '../src/renderer/schedule-format.js';
import type { ScheduleView } from '../src/shared/types.js';

/** Local-time epoch ms, so the tests read the way the formatter thinks. */
function at(year: number, month: number, day: number, hour: number, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

function schedule(nextRunAt: number | undefined, enabled = true): ScheduleView {
  const view: ScheduleView = {
    id: 's1',
    name: 'Bedtime',
    enabled,
    target: { kind: 'device', serialNo: 'X' },
    timeMinutes: 23 * 60,
    days: [0, 1, 2, 3, 4, 5, 6],
    action: { power: false },
    order: 0,
  };
  if (nextRunAt !== undefined) view.nextRunAt = nextRunAt;
  return view;
}

describe('how far away the next run is', () => {
  it('counts down in minutes when it is close', () => {
    const now = at(2024, 3, 6, 22, 42);
    expect(describeNextRun(schedule(at(2024, 3, 6, 23, 0)), now)).toBe('Next in 18 min');
  });

  it('says a minute rather than "1 min"', () => {
    const now = at(2024, 3, 6, 22, 59);
    expect(describeNextRun(schedule(at(2024, 3, 6, 23, 0)), now)).toBe('Next in a minute');
  });

  it('says due now once the moment has arrived', () => {
    const at11 = at(2024, 3, 6, 23, 0);
    expect(describeNextRun(schedule(at11), at11)).toBe('Due now');
    // Slightly past, because the scheduler ticks rather than firing to the
    // millisecond. Still "due now", never a negative countdown.
    expect(describeNextRun(schedule(at11), at11 + 10_000)).toBe('Due now');
  });

  it('calls tonight tonight, not tomorrow', () => {
    // The bug this test exists for: 23:00 is 0.96 days from this morning's
    // midnight, and rounding that to a whole day reported tonight as tomorrow.
    const now = at(2024, 3, 6, 12, 30);
    expect(describeNextRun(schedule(at(2024, 3, 6, 23, 0)), now)).toContain('today');
  });

  it('calls tomorrow tomorrow', () => {
    const now = at(2024, 3, 6, 23, 30);
    expect(describeNextRun(schedule(at(2024, 3, 7, 7, 0)), now)).toContain('tomorrow');
  });

  it('names the weekday when it is further out', () => {
    const now = at(2024, 3, 6, 9, 0);
    // 2024-03-10 was a Sunday.
    const text = describeNextRun(schedule(at(2024, 3, 10, 7, 0)), now);
    expect(text).not.toContain('today');
    expect(text).not.toContain('tomorrow');
    expect(text).toContain('Sunday');
  });

  it('says paused rather than a time when it is switched off', () => {
    expect(describeNextRun(schedule(at(2024, 3, 6, 23, 0), false), at(2024, 3, 6, 9))).toBe(
      'Paused',
    );
  });

  it('is honest when no day is selected', () => {
    expect(describeNextRun(schedule(undefined), at(2024, 3, 6, 9))).toBe(
      'Never — no days selected',
    );
  });
});

describe('calendar day arithmetic', () => {
  it('treats any time later today as zero days away', () => {
    const morning = new Date(at(2024, 3, 6, 0, 1));
    expect(calendarDaysUntil(new Date(at(2024, 3, 6, 23, 59)), morning)).toBe(0);
  });

  it('counts a day even when the gap is only minutes', () => {
    const justBeforeMidnight = new Date(at(2024, 3, 6, 23, 59));
    expect(calendarDaysUntil(new Date(at(2024, 3, 7, 0, 1)), justBeforeMidnight)).toBe(1);
  });

  it('survives a spring-forward boundary, where a day is 23 hours', () => {
    // US DST began 2024-03-10.
    const before = new Date(at(2024, 3, 9, 12));
    expect(calendarDaysUntil(new Date(at(2024, 3, 10, 12)), before)).toBe(1);
    expect(calendarDaysUntil(new Date(at(2024, 3, 11, 12)), before)).toBe(2);
  });
});

describe('describing a schedule in words', () => {
  it('names the common day patterns', () => {
    expect(describeDays([0, 1, 2, 3, 4, 5, 6])).toBe('Every day');
    expect(describeDays([1, 2, 3, 4, 5])).toBe('Weekdays');
    expect(describeDays([0, 6])).toBe('Weekends');
    expect(describeDays([1, 3])).toBe('Mon, Wed');
    expect(describeDays([])).toBe('No days — never runs');
  });

  it('describes what the action will do', () => {
    expect(describeAction({ power: false })).toBe('Turn off');
    // Turning off wins outright: there is nothing to set a scene on.
    expect(describeAction({ power: false, effect: 'Nemo', brightness: 40 })).toBe('Turn off');
    expect(describeAction({ power: true, effect: 'Nemo', brightness: 40 })).toBe(
      'Turn on, play "Nemo", 40% brightness',
    );
    expect(describeAction({ effect: 'Nemo' })).toBe('Play "Nemo"');
    expect(describeAction({})).toBe('Do nothing');
  });

  it('round-trips a time through the time input', () => {
    expect(minutesToInput(7 * 60 + 5)).toBe('07:05');
    expect(minutesToInput(23 * 60)).toBe('23:00');
    expect(inputToMinutes('07:05')).toBe(7 * 60 + 5);
    expect(inputToMinutes('23:00')).toBe(23 * 60);
    // Nonsense from a browser that did not give us a time at all.
    expect(inputToMinutes('')).toBe(0);
  });
});
