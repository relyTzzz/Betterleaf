import { useState } from 'react';
import { DeviceDetail } from './components/DeviceDetail.js';
import { DeviceList } from './components/DeviceList.js';
import { LibraryView } from './components/LibraryView.js';
import { PairDialog } from './components/PairDialog.js';
import { RoomDetail } from './components/RoomDetail.js';
import {
  api,
  useApp,
  useSelectedDevice,
  useSelectedRoom,
  useSnapshotSubscription,
} from './state/store.js';
import type { UnpairedDeviceView } from '../shared/types.js';

export function App() {
  useSnapshotSubscription();

  const snapshot = useApp((s) => s.snapshot);
  const device = useSelectedDevice();
  const room = useSelectedRoom();
  const showLibrary = useApp((s) => s.selection?.kind === 'library');
  const [pairing, setPairing] = useState<{ device?: UnpairedDeviceView } | undefined>();

  const { scanning, rung } = snapshot.discovery;
  const nothingFound =
    snapshot.devices.length === 0 && snapshot.unpaired.length === 0;

  return (
    <div className="app">
      <header className="titlebar">
        <h1>Betterleaf</h1>
        {scanning && (
          <span className="scanning">Searching{rung ? ` · ${rung}` : ''}…</span>
        )}
        <div className="spacer" />
        <button className="ghost" disabled={scanning} onClick={() => void api().rescan()}>
          Rescan
        </button>
        <button onClick={() => setPairing({})}>Add by address</button>
      </header>

      <DeviceList onPair={(d) => setPairing({ device: d })} />

      {showLibrary ? (
        <LibraryView />
      ) : room ? (
        <RoomDetail room={room} />
      ) : device ? (
        <DeviceDetail device={device} />
      ) : (
        <div className="empty">
          {nothingFound && !scanning ? (
            <>
              <h2>No Nanoleaf devices found</h2>
              <p>
                Make sure the lights are powered and on this Wi-Fi network. Some
                routers block the discovery protocols — if yours does, add the
                device by its IP address instead.
              </p>
              <div>
                <button className="primary" onClick={() => setPairing({})}>
                  Add by address
                </button>
              </div>
            </>
          ) : scanning ? (
            <>
              <h2>Looking for your lights</h2>
              <p>Devices appear here as soon as they answer.</p>
            </>
          ) : (
            <>
              <h2>Nothing paired yet</h2>
              <p>Pick a device on the left to pair with it.</p>
            </>
          )}
        </div>
      )}

      {pairing && (
        <PairDialog
          {...(pairing.device ? { device: pairing.device } : {})}
          onClose={() => setPairing(undefined)}
        />
      )}
    </div>
  );
}
