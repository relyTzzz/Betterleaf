import { api, useApp } from '../state/store.js';
import type { DeviceView } from '../../shared/types.js';
import { EffectLibrary } from './EffectLibrary.js';
import { LayoutPreview } from './LayoutPreview.js';
import { LockNote, LockToggle } from './LockToggle.js';
import { MusicNote } from './MusicNote.js';
import { Slider } from './Slider.js';
import { StatusChip } from './StatusChip.js';

export function DeviceDetail({ device }: { device: DeviceView }) {
  const rooms = useApp((s) => s.snapshot.rooms);
  const soundReactive = useApp((s) => s.snapshot.soundReactiveEffects);
  // Controls stay usable while reconnecting — the write queue will deliver as
  // soon as the device is back, and greying everything out on a brief blip is
  // more annoying than useful. Only a dead token makes control impossible.
  const disabled = device.status === 'needs-pairing';
  const { state } = device;

  return (
    <main className="detail">
      <header className="detail-head">
        <div>
          <h2>{device.name}</h2>
          <div className="sub">
            {device.model} · {device.layout.panels.length} panels · {device.host}
            {device.streamVersion ? ` · stream ${device.streamVersion}` : ''}
          </div>
        </div>
        <div className="actions">
          <StatusChip status={device.status} />
          {rooms.length > 0 && (
            <select
              className="room-picker"
              value={device.roomId ?? ''}
              onChange={(e) =>
                void api().assignDevice(device.serialNo, e.target.value || null)
              }
            >
              <option value="">No room</option>
              {rooms.map((room) => (
                <option key={room.id} value={room.id}>
                  {room.name}
                </option>
              ))}
            </select>
          )}
          <button className="ghost" onClick={() => void api().identify(device.serialNo)}>
            Identify
          </button>
        </div>
      </header>

      {device.status === 'needs-pairing' && (
        <div className="card">
          <h3>Pairing required</h3>
          <p style={{ color: 'var(--text-dim)', margin: 0 }}>
            This device rejected our token. Remove it and pair again — hold the
            controller's power button for 5–7 seconds until the LED flashes.
          </p>
          <div style={{ marginTop: 14 }}>
            <button onClick={() => void api().forget(device.serialNo)}>
              Forget this device
            </button>
          </div>
        </div>
      )}

      <div className="card">
        <h3>Control</h3>

        <div className="row">
          <label>Power</label>
          <label className="switch">
            <input
              type="checkbox"
              checked={state.on}
              disabled={disabled}
              onChange={(e) => void api().setPower(device.serialNo, e.target.checked)}
            />
            <span>{state.on ? 'On' : 'Off'}</span>
          </label>
        </div>

        <Slider
          label="Brightness"
          value={state.brightness}
          min={0}
          max={100}
          disabled={disabled}
          format={(v) => `${v}%`}
          onChange={(v) => void api().setBrightness(device.serialNo, v)}
        />

        <Slider
          label="Hue"
          className="hue"
          value={state.hue}
          min={0}
          max={360}
          disabled={disabled}
          format={(v) => `${v}°`}
          onChange={(v) => void api().setHueSat(device.serialNo, v, state.sat)}
        />

        <Slider
          label="Saturation"
          value={state.sat}
          min={0}
          max={100}
          disabled={disabled}
          format={(v) => `${v}%`}
          onChange={(v) => void api().setHueSat(device.serialNo, state.hue, v)}
        />

        <Slider
          label="Warmth"
          className="ct"
          value={state.ct}
          min={1200}
          max={6500}
          disabled={disabled}
          format={(v) => `${v}K`}
          onChange={(v) => void api().setColorTemp(device.serialNo, v)}
        />
      </div>

      <div className="card">
        <h3 className="card-head">
          <span>Effects</span>
          <LockToggle
            locked={device.locked}
            what={device.currentEffect || 'this light'}
            onToggle={() =>
              void api().setDeviceLocked(device.serialNo, !device.locked)
            }
          />
        </h3>
        <div className="effects">
          {device.effects.map((effect) => (
            <button
              key={effect}
              className={effect === device.currentEffect ? 'active' : ''}
              disabled={disabled}
              onClick={() => void api().selectEffect(device.serialNo, effect)}
            >
              {effect}
              {soundReactive.includes(effect) && <MusicNote />}
            </button>
          ))}
          {device.effects.length === 0 && (
            <span style={{ color: 'var(--text-faint)' }}>No effects stored on this device.</span>
          )}
        </div>
        {device.locked && <LockNote subject="this light" />}
      </div>

      <EffectLibrary device={device} />

      {device.layout.panels.length > 0 && (
        <div className="card">
          <h3>Layout</h3>
          <LayoutPreview device={device} />
        </div>
      )}
    </main>
  );
}
