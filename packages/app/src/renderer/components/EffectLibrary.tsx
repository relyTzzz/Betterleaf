import { useState } from 'react';
import { api, useApp } from '../state/store.js';
import type { DeviceView, ImportOutcome } from '../../shared/types.js';

/**
 * Getting effects onto a light from somewhere other than the light itself.
 *
 * Two sources work today: a JSON file, and another paired device. Both go
 * through the same write path, which checks the target actually has the motion
 * an effect needs before sending anything — so a rhythm effect bound for the
 * Canvas is refused with a reason rather than a bare HTTP 400.
 *
 * Discover is not here yet: the API behind it is undocumented and is being
 * mapped from a traffic capture (see docs/discover-capture.md). It will appear
 * as one more source when there is something real to talk to.
 */
export function EffectLibrary({ device }: { device: DeviceView }) {
  const devices = useApp((s) => s.snapshot.devices);
  const [busy, setBusy] = useState<string | undefined>();
  const [result, setResult] = useState<ImportOutcome | undefined>();
  const [note, setNote] = useState<string | undefined>();

  const others = devices.filter((d) => d.serialNo !== device.serialNo);
  const disabled = device.status === 'needs-pairing' || busy !== undefined;

  const run = async (label: string, work: () => Promise<void>) => {
    setBusy(label);
    setResult(undefined);
    setNote(undefined);
    try {
      await work();
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const doImport = () =>
    run('Importing', async () => {
      const outcome = await api().importEffects(device.serialNo);
      if (!outcome.cancelled) setResult(outcome);
    });

  const doExport = () =>
    run('Exporting', async () => {
      const outcome = await api().exportEffects(device.serialNo);
      if (!outcome.cancelled) {
        setNote(`Saved ${outcome.count} effect${outcome.count === 1 ? '' : 's'} to ${outcome.path}`);
      }
    });

  const doCopy = (fromSerial: string) =>
    run('Copying', async () => {
      setResult(await api().copyEffects(fromSerial, device.serialNo));
    });

  return (
    <div className="card">
      <h3>Add effects</h3>

      <div className="effects">
        <button disabled={disabled} onClick={() => void doImport()}>
          Import from file…
        </button>
        <button disabled={disabled} onClick={() => void doExport()}>
          Export to file…
        </button>
        {others.map((other) => (
          <button
            key={other.serialNo}
            disabled={disabled}
            onClick={() => void doCopy(other.serialNo)}
          >
            Copy from {other.name}
          </button>
        ))}
      </div>

      {busy && <p className="effects-note">{busy}…</p>}

      {note && <p className="effects-note">{note}</p>}

      {result && (
        <div className="import-result">
          {result.imported.length > 0 && (
            <p className="ok">
              Added {result.imported.length}:{' '}
              {result.imported.join(', ')}
            </p>
          )}
          {result.skipped.length > 0 && (
            <>
              <p className="warn">
                Skipped {result.skipped.length}
                {result.imported.length > 0 ? ', which this device cannot render:' : ':'}
              </p>
              <ul>
                {result.skipped.map((s) => (
                  <li key={s.name}>
                    <strong>{s.name}</strong> — {s.reason}
                  </li>
                ))}
              </ul>
            </>
          )}
          {result.imported.length === 0 && result.skipped.length === 0 && (
            <p className="effects-note">Nothing to add.</p>
          )}
        </div>
      )}
    </div>
  );
}
