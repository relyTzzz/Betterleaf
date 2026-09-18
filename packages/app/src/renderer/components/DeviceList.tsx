import { useState } from 'react';
import {
  api,
  devicesIn,
  unassignedDevices,
  useApp,
} from '../state/store.js';
import type { DeviceView, UnpairedDeviceView } from '../../shared/types.js';
import { StatusChip } from './StatusChip.js';

export function DeviceList({ onPair }: { onPair: (device: UnpairedDeviceView) => void }) {
  const snapshot = useApp((s) => s.snapshot);
  const selection = useApp((s) => s.selection);
  const select = useApp((s) => s.select);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');

  const loose = unassignedDevices(snapshot);

  const commitNewRoom = async () => {
    const name = newName.trim();
    setAdding(false);
    setNewName('');
    if (!name) return;
    const id = await api().createRoom(name);
    select({ kind: 'room', id });
  };

  return (
    <aside className="sidebar">
      {snapshot.rooms.map((room) => (
        <section key={room.id} className="room-block">
          <button
            className={`room-header${
              selection?.kind === 'room' && selection.id === room.id ? ' selected' : ''
            }`}
            onClick={() => select({ kind: 'room', id: room.id })}
          >
            <span className="room-name">{room.name}</span>
            <span className="room-count">
              {room.deviceSerials.length}
              {room.deviceSerials.length === 1 ? ' light' : ' lights'}
            </span>
          </button>

          {devicesIn(snapshot, room).map((device) => (
            <DeviceRow
              key={device.serialNo}
              device={device}
              selected={
                selection?.kind === 'device' && selection.id === device.serialNo
              }
              onSelect={() => select({ kind: 'device', id: device.serialNo })}
              indented
            />
          ))}

          {room.deviceSerials.length === 0 && (
            <div className="room-empty">No lights yet</div>
          )}
        </section>
      ))}

      {loose.length > 0 && (
        <>
          {snapshot.rooms.length > 0 && (
            <div className="section-label">Not in a room</div>
          )}
          {loose.map((device) => (
            <DeviceRow
              key={device.serialNo}
              device={device}
              selected={
                selection?.kind === 'device' && selection.id === device.serialNo
              }
              onSelect={() => select({ kind: 'device', id: device.serialNo })}
            />
          ))}
        </>
      )}

      {snapshot.devices.length > 0 &&
        (adding ? (
          <input
            type="text"
            autoFocus
            className="room-input"
            placeholder="Room name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onBlur={() => void commitNewRoom()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commitNewRoom();
              if (e.key === 'Escape') {
                setAdding(false);
                setNewName('');
              }
            }}
          />
        ) : (
          <button className="add-room ghost" onClick={() => setAdding(true)}>
            + New room
          </button>
        ))}

      {snapshot.devices.length > 0 && (
        <button
          className={`library-link${selection?.kind === 'library' ? ' selected' : ''}`}
          onClick={() => select({ kind: 'library' })}
        >
          <span>Library</span>
          <span className="room-count">{snapshot.libraryCount}</span>
        </button>
      )}

      {snapshot.unpaired.length > 0 && (
        <div className="section-label">Found, not paired</div>
      )}
      {snapshot.unpaired.map((device) => (
        <button
          key={`${device.ip}:${device.port}`}
          className="device-card unpaired-card"
          onClick={() => onPair(device)}
        >
          <div className="name">{device.name ?? device.model ?? 'Nanoleaf device'}</div>
          <div className="meta">
            <span>
              {device.ip} · found via {device.source}
            </span>
          </div>
        </button>
      ))}
    </aside>
  );
}

function DeviceRow({
  device,
  selected,
  onSelect,
  indented,
}: {
  device: DeviceView;
  selected: boolean;
  onSelect: () => void;
  indented?: boolean;
}) {
  return (
    <button
      className={`device-card${selected ? ' selected' : ''}${indented ? ' indented' : ''}`}
      onClick={onSelect}
    >
      <div className="name">{device.name}</div>
      <div className="meta">
        <StatusChip status={device.status} />
        <span>·</span>
        <span>{device.model}</span>
      </div>
    </button>
  );
}
