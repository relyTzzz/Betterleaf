import { useEffect, useMemo, useState } from 'react';
import { api, useApp } from '../state/store.js';
import type {
  AppSnapshot,
  HookInput,
  HookServerView,
  HookView,
  ScheduleAction,
  ScheduleTarget,
} from '../../shared/types.js';
import {
  CLAUDE_CODE_HOOKS,
  claudeCodeHookInputs,
  claudeCodeSettings,
  hookBase,
  hookUrl,
  slugify,
} from '../../shared/hooks.js';
import { colourCss, describeAction } from '../schedule-format.js';
import { ColourPicker } from './ColourPicker.js';
import { MusicNote } from './MusicNote.js';
import { Slider } from './Slider.js';

const DEFAULT_COLOUR = { hue: 220, saturation: 90 };

/** Scenes that can actually be applied to this target. */
function effectsFor(snapshot: AppSnapshot, target: ScheduleTarget): string[] {
  if (target.kind === 'device') {
    return snapshot.devices.find((d) => d.serialNo === target.serialNo)?.effects ?? [];
  }
  return snapshot.rooms.find((r) => r.id === target.roomId)?.effects ?? [];
}

/** A room if there is one, since that is usually what people mean by "the lights". */
function firstTarget(snapshot: AppSnapshot): ScheduleTarget | undefined {
  if (snapshot.rooms[0]) return { kind: 'room', roomId: snapshot.rooms[0].id };
  if (snapshot.devices[0]) return { kind: 'device', serialNo: snapshot.devices[0].serialNo };
  return undefined;
}

function targetLabel(snapshot: AppSnapshot, target: ScheduleTarget): string | undefined {
  return target.kind === 'device'
    ? snapshot.devices.find((d) => d.serialNo === target.serialNo)?.name
    : snapshot.rooms.find((r) => r.id === target.roomId)?.name;
}

/** "12s ago", for the last time a caller fired a hook. */
function ago(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return `at ${new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

/**
 * What became of the last firing, in words.
 *
 * A lock or an app scene holding a hook back is the app doing what it was
 * told, so it reads as information rather than as a warning. Only a genuine
 * failure is marked.
 */
function describeResult(result: string | undefined): { text: string; warn: boolean } | undefined {
  if (result === undefined) return undefined;
  if (result === 'ok') return { text: 'applied', warn: false };
  if (result === 'locked') return { text: 'held back — the light is locked', warn: false };
  if (result === 'held-by-app') {
    return { text: 'held back — an app scene is playing', warn: false };
  }
  return { text: result, warn: true };
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      className="ghost copy"
      onClick={() => {
        api().copyText(text);
        setCopied(true);
      }}
    >
      {copied ? 'Copied' : label}
    </button>
  );
}

function Swatch({ colour }: { colour: { hue: number; saturation: number } }) {
  return <span className="swatch" style={{ background: colourCss(colour) }} />;
}

export function HooksView() {
  const snapshot = useApp((s) => s.snapshot);
  const [editing, setEditing] = useState<{ id?: string; draft: HookInput } | undefined>();
  const [now, setNow] = useState(Date.now());

  // "Fired 12s ago" has to keep counting while nothing else changes.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);
  // A fresh snapshot is a fresh moment too, so a firing reads "just now".
  useEffect(() => setNow(Date.now()), [snapshot]);

  const hooks = snapshot.hooks;
  const server = snapshot.hookServer;
  const target = firstTarget(snapshot);
  const callers = hooks.reduce((sum, h) => sum + h.sources, 0);

  const startNew = () => {
    if (!target) return;
    setEditing({
      draft: {
        name: '',
        slug: '',
        enabled: true,
        target,
        action: { power: true, color: { ...DEFAULT_COLOUR } },
      },
    });
  };

  const startEdit = (hook: HookView) => {
    setEditing({
      id: hook.id,
      draft: {
        name: hook.name,
        slug: hook.slug,
        enabled: hook.enabled,
        target: hook.target,
        action: structuredClone(hook.action),
      },
    });
  };

  /** Move a hook up or down the priority order. */
  const move = (id: string, delta: number) => {
    const ids = hooks.map((h) => h.id);
    const from = ids.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    void api().reorderHooks(ids);
  };

  return (
    <main className="detail">
      <header className="detail-head">
        <div>
          <h2>Hooks</h2>
          <div className="sub">
            Let other programs change the lights. Each hook has an address, and
            anything that can send a web request — Claude Code, a script, a
            Stream Deck — can fire it.
          </div>
        </div>
        <div className="actions">
          <button className="primary" disabled={!target} onClick={startNew}>
            New hook
          </button>
        </div>
      </header>

      <ListenerPanel server={server} />
      <ClaudeCodePanel snapshot={snapshot} />

      {hooks.length === 0 && (
        <div className="empty-inline">
          {target ? (
            <p>
              No hooks yet. A hook puts a room or a light into a scene or a
              colour when something calls its address — a build finishing, a
              stream going live, Claude Code waiting on you.
            </p>
          ) : (
            <p>Pair a light first — there is nothing to drive yet.</p>
          )}
        </div>
      )}

      <div className="schedule-list">
        {hooks.map((hook, i) => (
          <HookRow
            key={hook.id}
            hook={hook}
            port={server.port}
            now={now}
            first={i === 0}
            last={i === hooks.length - 1}
            onEdit={() => startEdit(hook)}
            onMove={(delta) => move(hook.id, delta)}
          />
        ))}
      </div>

      {hooks.length > 0 && (
        <p className="hint">
          Each caller counts once, with whatever it fired last. When callers
          disagree about the same lights, the hook nearest the top wins — so a
          Claude Code session waiting on you is not painted over by another one
          finishing. A caller that goes quiet for an hour stops counting.
          {callers > 0 && (
            <>
              {' '}
              <button className="ghost inline-link" onClick={() => void api().clearHookSources()}>
                Forget all {callers} {callers === 1 ? 'caller' : 'callers'} now
              </button>
            </>
          )}
        </p>
      )}

      {editing && (
        <HookEditor
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

function ListenerPanel({ server }: { server: HookServerView }) {
  const [port, setPort] = useState(String(server.port));
  useEffect(() => setPort(String(server.port)), [server.port]);

  const commitPort = () => {
    const next = Number(port);
    if (Number.isInteger(next) && next !== server.port) {
      void api().setHookServer(server.enabled, next);
    } else {
      setPort(String(server.port));
    }
  };

  const status = server.listening
    ? { text: `Listening at ${hookBase(server.port)}`, className: 'ok' }
    : server.enabled
      ? { text: server.error ?? 'Starting…', className: server.error ? 'warn' : '' }
      : { text: 'Off — nothing can fire a hook until this is on.', className: '' };

  return (
    <section className="schedule-settings">
      <label className="check">
        <input
          type="checkbox"
          checked={server.enabled}
          onChange={(e) => void api().setHookServer(e.target.checked, server.port)}
        />
        <span>
          Listen for hooks on this computer
          <em>
            Only programs on this PC can reach it, and requests from web pages
            are refused. Keeps working while Betterleaf sits in the tray.
          </em>
        </span>
      </label>
      <div className="listener-line">
        <label className="field inline port-field">
          <span>Port</span>
          <input
            type="text"
            inputMode="numeric"
            value={port}
            onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))}
            onBlur={commitPort}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitPort();
            }}
          />
        </label>
        <span className={`listener-status ${status.className}`}>{status.text}</span>
      </div>
    </section>
  );
}

/**
 * One click to the three Claude Code hooks, then the settings to paste.
 *
 * Open until the hooks exist, because that is when someone is looking for it;
 * folded away afterwards, because by then it is reference.
 */
function ClaudeCodePanel({ snapshot }: { snapshot: AppSnapshot }) {
  const target = firstTarget(snapshot);
  const found = CLAUDE_CODE_HOOKS.map((preset) => ({
    preset,
    hook: snapshot.hooks.find((h) => h.slug === preset.slug),
  }));
  const complete = found.every((f) => f.hook);
  const [busy, setBusy] = useState(false);
  // Remembered rather than derived from `complete`: creating the hooks must
  // not fold the panel shut, because the settings to paste appear in it next.
  const [open, setOpen] = useState(!complete);

  const create = async () => {
    if (!target) return;
    setBusy(true);
    try {
      // In priority order, and only the ones missing, so running this after
      // deleting one hook does not duplicate the other two.
      for (const input of claudeCodeHookInputs(target)) {
        if (!snapshot.hooks.some((h) => h.slug === input.slug)) await api().createHook(input);
      }
    } finally {
      setBusy(false);
    }
  };

  const settings = claudeCodeSettings(snapshot.hookServer.port, {
    waiting: found[0]?.hook?.slug ?? 'claude-waiting',
    working: found[1]?.hook?.slug ?? 'claude-working',
    done: found[2]?.hook?.slug ?? 'claude-done',
  });

  const colourOf = (i: number) =>
    found[i]?.hook?.action.color ?? CLAUDE_CODE_HOOKS[i]?.color ?? DEFAULT_COLOUR;

  return (
    <details
      className="claude-panel"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>Use with Claude Code</summary>
      <p>
        Three hooks follow a Claude Code session: <Swatch colour={colourOf(1)} /> working
        while it works, <Swatch colour={colourOf(0)} /> waiting when it needs a
        permission or an answer from you, and <Swatch colour={colourOf(2)} /> done
        when it finishes. With several sessions open, waiting wins over working,
        and working over done.
      </p>
      {!complete ? (
        <>
          <button className="primary" disabled={!target || busy} onClick={() => void create()}>
            Create the Claude Code hooks
          </button>
          {target && (
            <p className="hint">
              They will point at {targetLabel(snapshot, target)}. Change the
              lights or the colours afterwards like any other hook.
            </p>
          )}
        </>
      ) : (
        <>
          <p>
            Then add this to Claude Code’s settings — <code>~/.claude/settings.json</code>{' '}
            covers every project. If that file already has a <code>hooks</code>{' '}
            block, merge these events into it rather than replacing it.
          </p>
          <pre className="snippet">{settings}</pre>
          <div className="snippet-actions">
            <CopyButton text={settings} label="Copy settings" />
            {!snapshot.hookServer.listening && (
              <span className="hint warn">Turn listening on above, or nothing will answer.</span>
            )}
          </div>
          <p className="hint">
            Pressing Esc to stop Claude mid-task does not count as finishing, so
            the lights keep saying working until your next prompt.
          </p>
        </>
      )}
    </details>
  );
}

function HookRow({
  hook,
  port,
  now,
  first,
  last,
  onEdit,
  onMove,
}: {
  hook: HookView;
  port: number;
  now: number;
  first: boolean;
  last: boolean;
  onEdit: () => void;
  onMove: (delta: number) => void;
}) {
  const soundReactive = useApp((s) => s.snapshot.soundReactiveEffects);
  const [testing, setTesting] = useState(false);
  const orphaned = hook.targetName === undefined;
  const url = hookUrl(port, hook.slug);
  const result = describeResult(hook.lastResult);

  const test = async () => {
    setTesting(true);
    try {
      await api().testHook(hook.id);
    } finally {
      setTesting(false);
    }
  };

  return (
    <article className={`schedule-card rule-card${hook.enabled ? '' : ' paused'}`}>
      <div className="rank">
        <button className="ghost" disabled={first} title="Higher priority" onClick={() => onMove(-1)}>
          ↑
        </button>
        <span>{hook.priority + 1}</span>
        <button className="ghost" disabled={last} title="Lower priority" onClick={() => onMove(1)}>
          ↓
        </button>
      </div>

      <div className="schedule-body">
        <div className="schedule-name">
          {hook.name || 'Untitled hook'}
          {hook.action.effect !== undefined && soundReactive.includes(hook.action.effect) && (
            <MusicNote />
          )}
          {hook.active && <span className="badge live">Active</span>}
          {hook.sources > 0 && (
            <span className="badge">
              {hook.sources} {hook.sources === 1 ? 'caller' : 'callers'}
            </span>
          )}
        </div>
        <div className="schedule-meta">
          {hook.action.color && <Swatch colour={hook.action.color} />}
          {describeAction(hook.action)} ·{' '}
          {orphaned ? <span className="warn">target no longer exists</span> : hook.targetName}
        </div>
        <div className="schedule-meta faint hook-address">
          <code title={url}>POST {url}</code>
          <CopyButton text={url} />
        </div>
        {(hook.lastFiredAt !== undefined || result) && (
          <div className="schedule-meta faint">
            {hook.lastFiredAt !== undefined && `Fired ${ago(hook.lastFiredAt, now)}`}
            {hook.lastFiredAt !== undefined && result && ' · '}
            {result && <span className={result.warn ? 'warn' : undefined}>{result.text}</span>}
          </div>
        )}
      </div>

      <div className="schedule-actions">
        <button
          className="ghost"
          disabled={testing || orphaned}
          title="Apply it now, to see it — callers are not affected"
          onClick={() => void test()}
        >
          Test
        </button>
        <label className="switch" title={hook.enabled ? 'Pause' : 'Resume'}>
          <input
            type="checkbox"
            checked={hook.enabled}
            onChange={(e) => void api().setHookEnabled(hook.id, e.target.checked)}
          />
          <span />
        </label>
        <button className="ghost" onClick={onEdit}>
          Edit
        </button>
        <button className="ghost danger" onClick={() => void api().deleteHook(hook.id)}>
          Delete
        </button>
      </div>
    </article>
  );
}

type ShowMode = 'leave' | 'scene' | 'colour';

function HookEditor({
  id,
  draft,
  snapshot,
  onChange,
  onClose,
}: {
  id?: string;
  draft: HookInput;
  snapshot: AppSnapshot;
  onChange: (draft: HookInput) => void;
  onClose: () => void;
}) {
  const soundReactive = snapshot.soundReactiveEffects;
  const effects = useMemo(() => effectsFor(snapshot, draft.target), [snapshot, draft.target]);
  const original = id ? snapshot.hooks.find((h) => h.id === id) : undefined;

  // A new hook's address follows its name until someone types one; an
  // existing hook's never moves on its own, because callers depend on it.
  const [slugTouched, setSlugTouched] = useState(Boolean(id));
  const slug = slugTouched ? slugify(draft.slug) : slugify(draft.name);
  const clash = snapshot.hooks.some((h) => h.id !== id && h.slug === slug);
  const moved = original !== undefined && slug !== '' && slug !== original.slug;

  const turningOff = draft.action.power === false;
  const mode: ShowMode =
    draft.action.effect !== undefined ? 'scene' : draft.action.color !== undefined ? 'colour' : 'leave';
  const emptyAction =
    draft.action.power === undefined &&
    draft.action.effect === undefined &&
    draft.action.color === undefined &&
    draft.action.brightness === undefined;

  const setAction = (patch: Partial<ScheduleAction>) => {
    const action: ScheduleAction = { ...draft.action, ...patch };
    for (const key of ['power', 'effect', 'color', 'brightness'] as const) {
      if (action[key] === undefined) delete action[key];
    }
    onChange({ ...draft, action });
  };

  const setMode = (next: ShowMode) => {
    if (next === 'leave') setAction({ effect: undefined, color: undefined });
    if (next === 'scene') setAction({ color: undefined, effect: effects[0] });
    if (next === 'colour') {
      setAction({ effect: undefined, color: draft.action.color ?? { ...DEFAULT_COLOUR } });
    }
  };

  const targetValue =
    draft.target.kind === 'room' ? `room:${draft.target.roomId}` : `device:${draft.target.serialNo}`;

  const save = async () => {
    if (emptyAction) return;
    const next = { ...draft, slug };
    if (id) await api().updateHook(id, next);
    else await api().createHook(next);
    onClose();
  };

  return (
    <div className="backdrop" onClick={onClose}>
      <div className="dialog schedule-editor" onClick={(e) => e.stopPropagation()}>
        <h2>{id ? 'Edit hook' : 'New hook'}</h2>

        <label className="field">
          <span>Name</span>
          <input
            type="text"
            autoFocus
            placeholder="Build failed"
            value={draft.name}
            onChange={(e) => onChange({ ...draft, name: e.target.value })}
          />
        </label>

        <label className="field">
          <span>Address</span>
          <div className="slug-input">
            <span>/hooks/</span>
            <input
              type="text"
              spellCheck={false}
              placeholder={slugify(draft.name) || 'build-failed'}
              value={slugTouched ? draft.slug : slugify(draft.name)}
              onChange={(e) => {
                setSlugTouched(true);
                onChange({ ...draft, slug: e.target.value });
              }}
            />
          </div>
          {clash && (
            <p className="hint warn">
              Another hook already has this address, so this one will get a number added.
            </p>
          )}
          {moved && (
            <p className="hint warn">
              Anything still calling <code>/hooks/{original.slug}</code> will stop working.
            </p>
          )}
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
          <legend>When it fires</legend>

          <label className="field inline">
            <span>Power</span>
            <select
              value={draft.action.power === undefined ? 'leave' : draft.action.power ? 'on' : 'off'}
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
            <span>Show</span>
            <select
              disabled={turningOff}
              value={mode}
              onChange={(e) => setMode(e.target.value as ShowMode)}
            >
              <option value="leave">Leave as it is</option>
              <option value="colour">A colour</option>
              <option value="scene" disabled={effects.length === 0}>
                A scene
              </option>
            </select>
          </label>

          {mode === 'scene' && (
            <label className="field inline">
              <span>Scene</span>
              <select
                disabled={turningOff}
                value={draft.action.effect ?? ''}
                onChange={(e) => setAction({ effect: e.target.value || undefined })}
              >
                {effects.map((effect) => (
                  <option key={effect} value={effect}>
                    {effect}
                    {soundReactive.includes(effect) ? ' ♪' : ''}
                  </option>
                ))}
              </select>
            </label>
          )}

          {mode === 'colour' && draft.action.color && (
            <ColourPicker
              value={draft.action.color}
              disabled={turningOff}
              onChange={(color) => setAction({ color })}
            />
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
        </fieldset>

        <p className="hint">
          A locked light is left alone, and so is one an app scene is playing on.
          Nothing is put back afterwards: to return to a scene, fire a hook that
          sets it.
        </p>

        {emptyAction && <p className="hint warn">This hook would do nothing.</p>}

        <div className="buttons">
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={emptyAction} onClick={() => void save()}>
            {id ? 'Save' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
