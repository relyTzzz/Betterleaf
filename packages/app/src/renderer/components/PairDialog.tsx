import { useState } from 'react';
import { api, useApp } from '../state/store.js';
import type { UnpairedDeviceView } from '../../shared/types.js';

interface PairDialogProps {
  device?: UnpairedDeviceView;
  onClose: () => void;
}

/**
 * Pairing, with the button-press and the request overlapping.
 *
 * Nanoleaf only accepts a token request during a 30-second window opened by
 * holding the power button. Rather than make the user get that ordering right,
 * we start polling immediately and count down — they can press the button any
 * time before the window closes.
 */
export function PairDialog({ device, onClose }: PairDialogProps) {
  const [ip, setIp] = useState(device?.ip ?? '');
  const [port, setPort] = useState(String(device?.port ?? 16021));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const progress = useApp((s) => s.pairProgress);

  const start = async () => {
    setBusy(true);
    setError(undefined);
    const result = await api().pair(ip.trim(), Number(port) || 16021);
    setBusy(false);
    if (result.ok) onClose();
    else setError(result.error ?? 'Pairing failed.');
  };

  const cancel = () => {
    void api().cancelPair();
    setBusy(false);
    onClose();
  };

  const seconds = progress ? Math.ceil(progress.msRemaining / 1000) : undefined;

  return (
    <div className="backdrop" onClick={(e) => e.target === e.currentTarget && cancel()}>
      <div className="dialog">
        <h2>Pair a device</h2>
        <p>
          Hold the power button on the controller for 5–7 seconds, until its LED
          starts flashing. You can press it after starting — Betterleaf keeps
          trying for the whole window.
        </p>

        {error && <div className="error">{error}</div>}

        <div className="fields">
          <input
            type="text"
            value={ip}
            placeholder="192.168.1.50"
            disabled={busy}
            onChange={(e) => setIp(e.target.value)}
          />
          <input
            type="text"
            value={port}
            style={{ width: 80, flex: 'none' }}
            disabled={busy}
            onChange={(e) => setPort(e.target.value)}
          />
        </div>

        <div className="buttons">
          {busy && seconds !== undefined && (
            <span className="countdown" style={{ marginRight: 'auto', alignSelf: 'center' }}>
              Waiting for pairing mode… {seconds}s
            </span>
          )}
          <button className="ghost" onClick={cancel}>
            Cancel
          </button>
          <button className="primary" disabled={busy || ip.trim() === ''} onClick={() => void start()}>
            {busy ? 'Pairing…' : 'Pair'}
          </button>
        </div>
      </div>
    </div>
  );
}
