import { useEffect, useMemo, useState } from 'react';
import { api, useApp } from '../state/store.js';
import type {
  AppRuleInput,
  AppRuleView,
  AppSnapshot,
  RunningApp,
  ScheduleAction,
  ScheduleTarget,
} from '../../shared/types.js';
import { describeAction } from '../schedule-format.js';
import { MusicNote } from './MusicNote.js';
import { Slider } from './Slider.js';

/** Scenes that can actually be applied to this target. */
function effectsFor(snapshot: AppSnapshot, target: ScheduleTarget): string[] {
  if (target.kind === 'device') {
    return snapshot.devices.find((d) => d.serialNo === target.serialNo)?.effects ?? [];
  }
  return snapshot.rooms.find((r) => r.id === target.roomId)?.effects ?? [];
}

function blankRule(snapshot: AppSnapshot): AppRuleInput | undefined {
  const target: ScheduleTarget | undefined = snapshot.rooms[0]
    ? { kind: 'room', roomId: snapshot.rooms[0].id }
    : snapshot.devices[0]
      ? { kind: 'device', serialNo: snapshot.devices[0].serialNo }
      : undefined;
  if (!target) return undefined;

  return {
    name: '',
    enabled: true,
    processNames: [],
    target,
    action: { power: true },
  };
}

export function AppRulesView() {
  const snapshot = useApp((s) => s.snapshot);
  const [editing, setEditing] = useState<{ id?: string; draft: AppRuleInput } | undefined>();

  const rules = snapshot.appRules;
  const canAdd = snapshot.devices.length > 0;

  const startNew = () => {
    const draft = blankRule(snapshot);
    if (draft) setEditing({ draft });
  };

  const startEdit = (rule: AppRuleView) => {
    setEditing({
      id: rule.id,
      draft: {
        name: rule.name,
        enabled: rule.enabled,
        processNames: [...rule.processNames],
        target: rule.target,
        action: { ...rule.action },
      },
    });
  };

  /** Move a rule up or down the priority order. */
  const move = (id: string, delta: number) => {
    const ids = rules.map((r) => r.id);
    const from = ids.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    void api().reorderAppRules(ids);
  };

  return (
    <main className="detail">
      <header className="detail-head">
        <div>
          <h2>App scenes</h2>
          <div className="sub">
            Play a scene while a program is running. When several rules match at
            once, the one nearest the top wins.
          </div>
        </div>
        <div className="actions">
          <button className="primary" disabled={!canAdd} onClick={startNew}>
            New rule
          </button>
        </div>
      </header>

      {rules.length === 0 && (
        <div className="empty-inline">
          {canAdd ? (
            <p>
              No rules yet. A rule watches for a program — a game, an editor, a
              video player — and puts a room or a single light into a scene for
              as long as it is open, then puts it back afterwards.
            </p>
          ) : (
            <p>Pair a light first — there is nothing to drive yet.</p>
          )}
        </div>
      )}

      <div className="schedule-list">
        {rules.map((rule, i) => (
          <RuleRow
            key={rule.id}
            rule={rule}
            first={i === 0}
            last={i === rules.length - 1}
            onEdit={() => startEdit(rule)}
            onMove={(delta) => move(rule.id, delta)}
          />
        ))}
      </div>

      {rules.length > 1 && (
        <p className="hint">
          Priority runs top to bottom. If two programs are open at once and both
          rules point at the same lights, the higher rule is the one you see.
        </p>
      )}

      {editing && (
        <RuleEditor
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

function RuleRow({
  rule,
  first,
  last,
  onEdit,
  onMove,
}: {
  rule: AppRuleView;
  first: boolean;
  last: boolean;
  onEdit: () => void;
  onMove: (delta: number) => void;
}) {
  const soundReactive = useApp((s) => s.snapshot.soundReactiveEffects);
  const orphaned = rule.targetName === undefined;

  return (
    <article className={`schedule-card rule-card${rule.enabled ? '' : ' paused'}`}>
      <div className="rank">
        <button
          className="ghost"
          disabled={first}
          title="Higher priority"
          onClick={() => onMove(-1)}
        >
          ↑
        </button>
        <span>{rule.priority + 1}</span>
        <button
          className="ghost"
          disabled={last}
          title="Lower priority"
          onClick={() => onMove(1)}
        >
          ↓
        </button>
      </div>

      <div className="schedule-body">
        <div className="schedule-name">
          {rule.name || 'Untitled rule'}
          {rule.action.effect !== undefined &&
            soundReactive.includes(rule.action.effect) && <MusicNote />}
          {rule.holding ? (
            <span className="badge live">Playing now</span>
          ) : (
            rule.matching && <span className="badge">Running, outranked</span>
          )}
        </div>
        <div className="schedule-meta">
          {describeAction(rule.action)} ·{' '}
          {orphaned ? (
            <span className="warn">target no longer exists</span>
          ) : (
            rule.targetName
          )}
        </div>
        <div className="schedule-meta faint">
          {rule.processNames.length > 0 ? (
            <>
              When running: {rule.processNames.join(', ')}
              {rule.matchedProcess && ` · matched ${rule.matchedProcess}`}
            </>
          ) : (
            <span className="warn">No programs listed — this rule never matches</span>
          )}
        </div>
      </div>

      <div className="schedule-actions">
        <label className="switch" title={rule.enabled ? 'Pause' : 'Resume'}>
          <input
            type="checkbox"
            checked={rule.enabled}
            onChange={(e) => void api().setAppRuleEnabled(rule.id, e.target.checked)}
          />
          <span />
        </label>
        <button className="ghost" onClick={onEdit}>
          Edit
        </button>
        <button className="ghost danger" onClick={() => void api().deleteAppRule(rule.id)}>
          Delete
        </button>
      </div>
    </article>
  );
}

function RuleEditor({
  id,
  draft,
  snapshot,
  onChange,
  onClose,
}: {
  id?: string;
  draft: AppRuleInput;
  snapshot: AppSnapshot;
  onChange: (draft: AppRuleInput) => void;
  onClose: () => void;
}) {
  const soundReactive = snapshot.soundReactiveEffects;
  const effects = useMemo(() => effectsFor(snapshot, draft.target), [snapshot, draft.target]);
  const [running, setRunning] = useState<RunningApp[]>([]);
  const [namesText, setNamesText] = useState(draft.processNames.join(', '));

  // The running list is a convenience, not a gate: a program you want a rule
  // for might not be open while you are writing the rule.
  useEffect(() => {
    void api().listRunningApps().then(setRunning);
  }, []);

  const turningOff = draft.action.power === false;
  const names = namesText
    .split(',')
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean);
  const noNames = names.length === 0;
  const emptyAction =
    draft.action.power === undefined &&
    draft.action.effect === undefined &&
    draft.action.brightness === undefined;

  const setAction = (patch: Partial<ScheduleAction>) => {
    const action: ScheduleAction = { ...draft.action, ...patch };
    for (const key of ['power', 'effect', 'brightness'] as const) {
      if (action[key] === undefined) delete action[key];
    }
    onChange({ ...draft, action });
  };

  const targetValue =
    draft.target.kind === 'room'
      ? `room:${draft.target.roomId}`
      : `device:${draft.target.serialNo}`;

  const save = async () => {
    if (noNames || emptyAction) return;
    const next = { ...draft, processNames: names };
    if (id) await api().updateAppRule(id, next);
    else await api().createAppRule(next);
    onClose();
  };

  return (
    <div className="backdrop" onClick={onClose}>
      <div className="dialog schedule-editor" onClick={(e) => e.stopPropagation()}>
        <h2>{id ? 'Edit rule' : 'New rule'}</h2>

        <label className="field">
          <span>Name</span>
          <input
            type="text"
            autoFocus
            placeholder="Gaming"
            value={draft.name}
            onChange={(e) => onChange({ ...draft, name: e.target.value })}
          />
        </label>

        <label className="field">
          <span>Programs</span>
          <input
            type="text"
            list="running-apps"
            placeholder="overwatch.exe, steam.exe"
            value={namesText}
            onChange={(e) => setNamesText(e.target.value)}
          />
          <datalist id="running-apps">
            {running.map((app) => (
              <option key={app.processName} value={app.processName} />
            ))}
          </datalist>
          <p className="hint">
            Separate several with commas — the rule matches when any of them is
            running. {running.length > 0 && `${running.length} programs are open now; `}
            the box suggests from them as you type.
          </p>
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

        <fieldset className="field action-fields">
          <legend>While it is running</legend>

          <label className="field inline">
            <span>Power</span>
            <select
              value={
                draft.action.power === undefined ? 'leave' : draft.action.power ? 'on' : 'off'
              }
              onChange={(e) =>
                setAction({
                  power: e.target.value === 'leave' ? undefined : e.target.value === 'on',
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
        </fieldset>

        <p className="hint">
          When the program closes, the lights go back to whatever they were
          showing before — unless you changed them yourself in the meantime, in
          which case your change is left alone.
        </p>

        {noNames && <p className="hint warn">Name at least one program, or it never runs.</p>}
        {emptyAction && <p className="hint warn">This rule would do nothing.</p>}

        <div className="buttons">
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={noNames || emptyAction} onClick={() => void save()}>
            {id ? 'Save' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
