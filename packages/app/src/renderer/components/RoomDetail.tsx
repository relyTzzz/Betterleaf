import { useState } from 'react';
import { api, devicesIn, useApp } from '../state/store.js';
import type { RoomView } from '../../shared/types.js';
import { LockNote, LockToggle } from './LockToggle.js';
import { MusicNote } from './MusicNote.js';
import { Slider } from './Slider.js';
import { StatusChip } from './StatusChip.js';

export function RoomDetail({ room }: { room: RoomView }) {
  const snapshot = useApp((s) => s.snapshot);
  const select = useApp((s) => s.select);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(room.name);

  const members = devicesIn(snapshot, room);
  const soundReactive = snapshot.soundReactiveEffects;
  const empty = members.length === 0;

  const commitRename = async () => {
    setRenaming(false);
    const name = draftName.trim();
    if (name && name !== room.name) await api().renameRoom(room.id, name);
    else setDraftName(room.name);
  };

  return (
    <main className="detail">
      <header className="detail-head">
        <div>
          {renaming ? (
            <input
              type="text"
              autoFocus
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onBlur={() => void commitRename()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commitRename();
                if (e.key === 'Escape') {
                  setDraftName(room.name);
                  setRenaming(false);
                }
              }}
            />
          ) : (
            <h2 onDoubleClick={() => setRenaming(true)}>{room.name}</h2>
          )}
          <div className="sub">
            {members.length} {members.length === 1 ? 'light' : 'lights'}
            {!empty && ` · ${members.map((d) => d.name).join(', ')}`}
          </div>
        </div>
        <div className="actions">
          {!empty && <StatusChip status={room.status} />}
          <button className="ghost" onClick={() => setRenaming(true)}>
            Rename
          </button>
          <button
            className="ghost"
            onClick={async () => {
              await api().deleteRoom(room.id);
              select(undefined);
            }}
          >
            Delete
          </button>
        </div>
      </header>

      {empty ? (
        <div className="card">
          <h3>Empty room</h3>
          <p style={{ color: 'var(--text-dim)', margin: 0 }}>
            Pick a light on the left and choose this room from its Room menu.
          </p>
        </div>
      ) : (
        <>
          <div className="card">
            <h3>Everything in this room</h3>

            <div className="row">
              <label>Power</label>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={room.on}
                  onChange={(e) => void api().setRoomPower(room.id, e.target.checked)}
                />
                <span>{room.on ? 'On' : 'Off'}</span>
              </label>
            </div>

            <Slider
              label="Brightness"
              value={room.brightness}
              min={0}
              max={100}
              format={(v) => `${v}%`}
              onChange={(v) => void api().setRoomBrightness(room.id, v)}
            />
          </div>

          <div className="card">
            <h3 className="card-head">
              <span>Shared effects</span>
              <LockToggle
                locked={room.locked}
                what={room.currentEffect || 'these lights'}
                onToggle={() => void api().setRoomLocked(room.id, !room.locked)}
              />
            </h3>
            {room.effects.length > 0 ? (
              <>
                <div className="effects">
                  {room.effects.map((effect) => (
                    <button
                      key={effect}
                      className={effect === room.currentEffect ? 'active' : ''}
                      onClick={() => void api().setRoomEffect(room.id, effect)}
                    >
                      {effect}
                      {soundReactive.includes(effect) && <MusicNote />}
                    </button>
                  ))}
                </div>
                {room.currentEffect === undefined && (
                  <p className="effects-note">
                    These lights are showing different effects. Pick one to bring
                    them into sync.
                  </p>
                )}
              </>
            ) : (
              <p style={{ color: 'var(--text-faint)', margin: 0 }}>
                These lights have no effects in common, so none can be applied to
                the whole room. Apply effects to each light individually.
              </p>
            )}
            {room.locked && <LockNote subject="these lights" />}
          </div>

          <div className="card">
            <h3>Lights</h3>
            <div className="member-list">
              {members.map((device) => (
                <button
                  key={device.serialNo}
                  className="member"
                  onClick={() => select({ kind: 'device', id: device.serialNo })}
                >
                  <span className="member-name">{device.name}</span>
                  <StatusChip status={device.status} />
                  <span className="member-state">
                    {device.state.on ? `${device.state.brightness}%` : 'off'}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      <p className="footnote">
        Rooms exist only in Betterleaf. They are not sent to the lights, so they
        will not appear in the Nanoleaf app or in HomeKit.
      </p>
    </main>
  );
}
