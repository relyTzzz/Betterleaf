import { useApp } from '../state/store.js';
import type { UnpairedDeviceView } from '../../shared/types.js';
import { StatusChip } from './StatusChip.js';

export function DeviceList({ onPair }: { onPair: (device: UnpairedDeviceView) => void }) {
  const { devices, unpaired } = useApp((s) => s.snapshot);
  const selected = useApp((s) => s.selected);
  const select = useApp((s) => s.select);

  return (
    <aside className="sidebar">
      {devices.length > 0 && <div className="section-label">Your lights</div>}

      {devices.map((device) => (
        <button
          key={device.serialNo}
          className={`device-card${device.serialNo === selected ? ' selected' : ''}`}
          onClick={() => select(device.serialNo)}
        >
          <div className="name">{device.name}</div>
          <div className="meta">
            <StatusChip status={device.status} />
            <span>·</span>
            <span>{device.model}</span>
          </div>
        </button>
      ))}

      {unpaired.length > 0 && <div className="section-label">Found, not paired</div>}

      {unpaired.map((device) => (
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
