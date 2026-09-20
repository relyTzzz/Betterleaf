import { useEffect, useMemo, useState } from 'react';
import { api, useApp } from '../state/store.js';
import type {
  AppSnapshot,
  ScheduleAction,
  ScheduleInput,
  ScheduleTarget,
  ScheduleView,
} from '../../shared/types.js';
import {
  DAYS,
  EVERY_DAY,
  WEEKDAYS,
  describeAction,
  describeDays,
  describeNextRun,
  displayTime,
  inputToMinutes,
  minutesToInput,
} from '../schedule-format.js';
import { MusicNote } from './MusicNote.js';
import { Slider } from './Slider.js';

/**
 * A clock that re-renders the view as it advances.
 *
 * The countdown is derived from `nextRunAt`, which only changes when the main
 * process republishes a snapshot. Without a tick of its own, "in 18 min" would
 * sit there saying 18 until something unrelated happened to the lights.
 */
function useNow(intervalMs = 20_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Scenes that can actually be applied to this target. */
function effectsFor(snapshot: AppSnapshot, target: ScheduleTarget): string[] {
  if (target.kind === 'device') {
    return snapshot.devices.find((d) => d.serialNo === target.serialNo)?.effects ?? [];
  }
  return snapshot.rooms.find((r) => r.id === target.roomId)?.effects ?? [];
}

function blankSchedule(snapshot: AppSnapshot): ScheduleInput | undefined {
  const target: ScheduleTarget | undefined = snapshot.rooms[0]
    ? { kind: 'room', roomId: snapshot.rooms[0].id }
    : snapshot.devices[0]
      ? { kind: 'device', serialNo: snapshot.devices[0].serialNo }
      : undefined;
  if (!target) return undefined;

  return {
    name: '',
    enabled: true,
    target,
    timeMinutes: 7 * 60,
    days: [...EVERY_DAY],
    action: { power: true },
  };
}

export function SchedulesView() {
  const snapshot = useApp((s) => s.snapshot);
  const now = useNow();
  const [editing, setEditing] = useState<{ id?: string; draft: ScheduleInput } | undefined>();
  const [ranJustNow, setRanJustNow] = useState<Record<string, string>>({});

  const canSchedule = snapshot.devices.length > 0;

  const startNew = () => {
    const draft = blankSchedule(snapshot);
    if (draft) setEditing({ draft });
  };

  const startEdit = (schedule: ScheduleView) => {
    setEditing({
      id: schedule.id,
      draft: {
        name: schedule.name,
        enabled: schedule.enabled,
        target: schedule.target,
        timeMinutes: schedule.timeMinutes,
        days: [...schedule.days],
        action: { ...schedule.action },
      },
    });
  };

  const runNow = async (schedule: ScheduleView) => {
    const result = await api().runScheduleNow(schedule.id);
    setRanJustNow((prev) => ({
      ...prev,
      [schedule.id]: result.ok
        ? 'Applied'
        : result.error === 'locked'
          ? 'Held — the scene is locked'
          : (result.error ?? 'Failed'),
    }));
  };

  return (
    <main className="detail schedules-view">
      <header className="detail-head">
        <div>
          <h2>Schedules</h2>
          <div className="sub">
            Betterleaf applies these itself, so they run only while it is
            running — they are not stored on the lights.
          </div>
        </div>
        <div className="actions">
          <button className="primary" disabled={!canSchedule} onClick={startNew}>
            New schedule
          </button>
        </div>
      </header>

      <RunningSettings />

      {snapshot.schedules.length === 0 && !editing && (
        <div className="empty-inline">
          {canSchedule ? (
            <p>
              No schedules yet. A schedule turns a room or a single light on or
              off at a set time, and can pick the scene and brightness while it
              is at it.
            </p>
          ) : (
            <p>Pair a light first — there is nothing to schedule yet.</p>
          )}
        </div>
      )}

      <div className="schedule-list">
        {snapshot.schedules.map((schedule) => (
          <ScheduleRow
            key={schedule.id}
            schedule={schedule}
            now={now}
            note={ranJustNow[schedule.id]}
            onEdit={() => startEdit(schedule)}
            onRunNow={() => void runNow(schedule)}
          />
        ))}
      </div>

      {editing && (
        <ScheduleEditor
          {...(editing.id ? { id: editing.id } : {})}
          draft={editing.draft}
          snapshot={snapshot}
          onChange={(draft) => setEditing((prev) => (prev ? { ...prev, draft } : prev))}
          onClose={() => setEditing(undefined)}
        />
      )}
    </main>
  );
}

/**
 * The two settings that decide whether schedules actually fire.
 *
 * Placed above the list rather than hidden in a preferences pane: a schedule
 * created while Betterleaf quits on close will silently never run, and finding
 * that out at 7am is a bad way to learn it.
 */
function RunningSettings() {
  const settings = useApp((s) => s.snapshot.settings);

  return (
    <section className="schedule-settings">
      <label className="check">
        <input
          type="checkbox"
          checked={settings.trayEnabled}
          onChange={(e) => void api().setTrayEnabled(e.target.checked)}
        />
        <span>
          Keep running in the tray when the window is closed
          <em>Schedules stop firing the moment Betterleaf quits.</em>
        </span>
      </label>

      <label className={`check${settings.startWithWindowsSupported ? '' : ' disabled'}`}>
        <input
          type="checkbox"
          checked={settings.startWithWindows}
          disabled={!settings.startWithWindowsSupported}
          onChange={(e) => void api().setStartWithWindows(e.target.checked)}
        />
        <span>
          Start with Windows
          <em>
            {settings.startWithWindowsSupported
              ? 'Starts hidden in the tray when you sign in.'
              : 'Only available in the installed app, not when running from source.'}
          </em>
        </span>
      </label>
    </section>
  );
}

function ScheduleRow({
  schedule,
  now,
  note,
  onEdit,
  onRunNow,
}: {
  schedule: ScheduleView;
  now: number;
  note?: string;
  onEdit: () => void;
  onRunNow: () => void;
}) {
  const soundReactive = useApp((s) => s.snapshot.soundReactiveEffects);
  const orphaned = schedule.targetName === undefined;

  return (
    <article className={`schedule-card${schedule.enabled ? '' : ' paused'}`}>
      <div className="schedule-time">
        <strong>{displayTime(schedule.timeMinutes)}</strong>
        <span>{describeDays(schedule.days)}</span>
      </div>

      <div className="schedule-body">
        <div className="schedule-name">
          {schedule.name || 'Untitled schedule'}
          {schedule.action.effect !== undefined &&
            soundReactive.includes(schedule.action.effect) && <MusicNote />}
        </div>
        <div className="schedule-meta">
          {describeAction(schedule.action)} ·{' '}
          {orphaned ? (
            <span className="warn">target no longer exists</span>
          ) : (
            schedule.targetName
          )}
        </div>
        <div className="schedule-meta faint">
          {describeNextRun(schedule, now)}
          {schedule.lastResult === 'locked' ? (
            <> · held — the scene was locked</>
          ) : (
            schedule.lastResult &&
            schedule.lastResult !== 'ok' && (
              <>
                {' · '}
                <span className="warn">
                  {schedule.lastResult === 'missed'
                    ? 'missed — Betterleaf was not running'
                    : `last run failed: ${schedule.lastResult}`}
                </span>
              </>
            )
          )}
          {note && <> · {note}</>}
        </div>
      </div>

      <div className="schedule-actions">
        <label className="switch" title={schedule.enabled ? 'Pause' : 'Resume'}>
          <input
            type="checkbox"
            checked={schedule.enabled}
            onChange={(e) =>
              void api().setScheduleEnabled(schedule.id, e.target.checked)
            }
          />
          <span />
        </label>
        <button className="ghost" onClick={onRunNow}>
          Run now
        </button>
        <button className="ghost" onClick={onEdit}>
          Edit
        </button>
        <button className="ghost danger" onClick={() => void api().deleteSchedule(schedule.id)}>
          Delete
        </button>
      </div>
    </article>
  );
}

function ScheduleEditor({
  id,
  draft,
  snapshot,
  onChange,
  onClose,
}: {
  id?: string;
  draft: ScheduleInput;
  snapshot: AppSnapshot;
  onChange: (draft: ScheduleInput) => void;
  onClose: () => void;
}) {
  const soundReactive = snapshot.soundReactiveEffects;
  const effects = useMemo(() => effectsFor(snapshot, draft.target), [snapshot, draft.target]);

  const turningOff = draft.action.power === false;
  const noDays = draft.days.length === 0;
  const emptyAction =
    draft.action.power === undefined &&
    draft.action.effect === undefined &&
    draft.action.brightness === undefined;

  const setAction = (patch: Partial<ScheduleAction>) => {
    const action: ScheduleAction = { ...draft.action, ...patch };
    // Undefined means "leave alone", so strip the keys rather than carrying an
    // explicit undefined that would survive into JSON as a missing-but-present
    // field the main process then has to guess about.
    for (const key of ['power', 'effect', 'brightness'] as const) {
      if (action[key] === undefined) delete action[key];
    }
    onChange({ ...draft, action });
  };

  const toggleDay = (day: number) => {
    const days = draft.days.includes(day)
      ? draft.days.filter((d) => d !== day)
      : [...draft.days, day].sort((a, b) => a - b);
    onChange({ ...draft, days });
  };

  const targetValue =
    draft.target.kind === 'room' ? `room:${draft.target.roomId}` : `device:${draft.target.serialNo}`;

  const save = async () => {
    if (noDays || emptyAction) return;
    if (id) await api().updateSchedule(id, draft);
    else await api().createSchedule(draft);
    onClose();
  };

  return (
    <div className="backdrop" onClick={onClose}>
      <div className="dialog schedule-editor" onClick={(e) => e.stopPropagation()}>
        <h2>{id ? 'Edit schedule' : 'New schedule'}</h2>

        <label className="field">
          <span>Name</span>
          <input
            type="text"
            autoFocus
            placeholder="Good morning"
            value={draft.name}
            onChange={(e) => onChange({ ...draft, name: e.target.value })}
          />
        </label>

        <label className="field">
          <span>Applies to</span>
          <select
            value={targetValue}
            onChange={(e) => {
              const [kind, rest] = e.target.value.split(/:(.*)/s);
              const target: ScheduleTarget =
                kind === 'room'
                  ? { kind: 'room', roomId: rest ?? '' }
                  : { kind: 'device', serialNo: rest ?? '' };
              // The new target may not have the chosen scene; drop it rather
              // than saving a schedule that can only fail.
              const action = { ...draft.action };
              if (action.effect && !effectsFor(snapshot, target).includes(action.effect)) {
                delete action.effect;
              }
              onChange({ ...draft, target, action });
            }}
          >
            {snapshot.rooms.length > 0 && (
              <optgroup label="Rooms">
                {snapshot.rooms.map((room) => (
                  <option key={room.id} value={`room:${room.id}`}>
                    {room.name}
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label="Lights">
              {snapshot.devices.map((device) => (
                <option key={device.serialNo} value={`device:${device.serialNo}`}>
                  {device.name}
                </option>
              ))}
            </optgroup>
          </select>
        </label>

        <label className="field">
          <span>Time</span>
          <input
            type="time"
            value={minutesToInput(draft.timeMinutes)}
            onChange={(e) => onChange({ ...draft, timeMinutes: inputToMinutes(e.target.value) })}
          />
        </label>

        <div className="field">
          <span>Days</span>
          <div className="day-picker">
            {DAYS.map((day) => (
              <button
                key={day.value}
                type="button"
                title={day.label}
                aria-pressed={draft.days.includes(day.value)}
                className={draft.days.includes(day.value) ? 'day on' : 'day'}
                onClick={() => toggleDay(day.value)}
              >
                {day.short}
              </button>
            ))}
            <button
              type="button"
              className="ghost preset"
              onClick={() => onChange({ ...draft, days: [...EVERY_DAY] })}
            >
              Every day
            </button>
            <button
              type="button"
              className="ghost preset"
              onClick={() => onChange({ ...draft, days: [...WEEKDAYS] })}
            >
              Weekdays
            </button>
          </div>
        </div>

        <fieldset className="field action-fields">
          <legend>What it does</legend>

          <label className="field inline">
            <span>Power</span>
            <select
              value={draft.action.power === undefined ? 'leave' : draft.action.power ? 'on' : 'off'}
              onChange={(e) =>
                setAction({
                  power:
                    e.target.value === 'leave' ? undefined : e.target.value === 'on',
                })
              }
            >
              <option value="leave">Leave as it is</option>
              <option value="on">Turn on</option>
              <option value="off">Turn off</option>
            </select>
          </label>

          <label className="field inline">
            <span>Scene</span>
            <select
              disabled={turningOff}
              value={draft.action.effect ?? ''}
              onChange={(e) => setAction({ effect: e.target.value || undefined })}
            >
              <option value="">Leave as it is</option>
              {effects.map((effect) => (
                <option key={effect} value={effect}>
                  {effect}
                  {soundReactive.includes(effect) ? ' ♪' : ''}
                </option>
              ))}
            </select>
          </label>
          {effects.length === 0 && !turningOff && (
            <p className="hint warn">
              No scenes are shared by everything in this room, so only power and
              brightness can be set.
            </p>
          )}

          <label className="check">
            <input
              type="checkbox"
              disabled={turningOff}
              checked={draft.action.brightness !== undefined}
              onChange={(e) => setAction({ brightness: e.target.checked ? 60 : undefined })}
            />
            <span>Set brightness</span>
          </label>
          {draft.action.brightness !== undefined && !turningOff && (
            <Slider
              label="Brightness"
              min={0}
              max={100}
              value={draft.action.brightness}
              format={(v) => `${v}%`}
              onChange={(brightness) => setAction({ brightness })}
            />
          )}

          {turningOff && (
            <p className="hint">
              Turning off ignores the scene and brightness — there is nothing to
              set them on.
            </p>
          )}
        </fieldset>

        {noDays && <p className="hint warn">Pick at least one day, or it will never run.</p>}
        {emptyAction && <p className="hint warn">This schedule would do nothing.</p>}

        <div className="buttons">
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={noDays || emptyAction} onClick={() => void save()}>
            {id ? 'Save' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
