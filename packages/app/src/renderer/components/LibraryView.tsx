import { useEffect, useMemo, useState } from 'react';
import { api, useApp } from '../state/store.js';
import type { LibraryEntryView } from '../../shared/types.js';

/**
 * The archive of every scene harvested off the lights.
 *
 * Nanoleaf's Discover marketplace delivers scenes to the devices, so the devices
 * already hold everything the user has downloaded. Betterleaf reads them off and
 * keeps a copy — which outlives the controller's own limited storage, and means
 * a scene deleted to make room is not lost.
 */
export function LibraryView() {
  const devices = useApp((s) => s.snapshot.devices);
  const libraryCount = useApp((s) => s.snapshot.libraryCount);

  const [entries, setEntries] = useState<LibraryEntryView[]>([]);
  const [query, setQuery] = useState('');
  const [onlyFavourites, setOnlyFavourites] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | undefined>();

  const reload = async () => setEntries(await api().listLibrary());

  // Reload whenever the archive size changes, which is how a harvest announces
  // itself without pushing the whole library through every snapshot.
  useEffect(() => {
    void reload();
  }, [libraryCount, devices.length]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return entries.filter((e) => {
      if (onlyFavourites && !e.favourite) return false;
      if (!needle) return true;
      return (
        e.name.toLowerCase().includes(needle) ||
        (e.motion ?? '').toLowerCase().includes(needle)
      );
    });
  }, [entries, query, onlyFavourites]);

  const act = async (label: string, work: () => Promise<string | undefined>) => {
    setBusy(true);
    setNote(undefined);
    try {
      setNote(await work());
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
      await reload();
    }
  };

  return (
    <main className="detail">
      <header className="detail-head">
        <div>
          <h2>Library</h2>
          <div className="sub">
            {entries.length} {entries.length === 1 ? 'scene' : 'scenes'} archived from
            your lights
          </div>
        </div>
        <div className="actions">
          <button
            className="ghost"
            disabled={busy}
            onClick={() =>
              void act('refresh', async () => {
                await api().refreshLibrary();
                return 'Checked every device.';
              })
            }
          >
            Refresh
          </button>
        </div>
      </header>

      <div className="card">
        <div className="library-filters">
          <input
            type="text"
            placeholder="Search scenes…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <label className="switch">
            <input
              type="checkbox"
              checked={onlyFavourites}
              onChange={(e) => setOnlyFavourites(e.target.checked)}
            />
            <span>Favourites</span>
          </label>
        </div>
        {note && <p className="effects-note">{note}</p>}
      </div>

      {shown.length === 0 ? (
        <div className="card">
          <h3>{entries.length === 0 ? 'Nothing archived yet' : 'No matches'}</h3>
          <p style={{ color: 'var(--text-dim)', margin: 0 }}>
            {entries.length === 0
              ? 'Scenes you download in the Nanoleaf app land on your lights, and Betterleaf copies them here automatically. Download one, or press Refresh.'
              : 'No scene matches that search.'}
          </p>
        </div>
      ) : (
        <div className="library-grid">
          {shown.map((entry) => (
            <LibraryCard
              key={entry.name}
              entry={entry}
              busy={busy}
              devices={devices.map((d) => ({ serialNo: d.serialNo, name: d.name }))}
              act={act}
            />
          ))}
        </div>
      )}

      <p className="footnote">
        Archived from your lights, not downloaded from Nanoleaf. Anything you get
        in the Nanoleaf app appears here on its own, and stays here even after you
        delete it from a device to free up space.
      </p>
    </main>
  );
}

function LibraryCard({
  entry,
  devices,
  busy,
  act,
}: {
  entry: LibraryEntryView;
  devices: { serialNo: string; name: string }[];
  busy: boolean;
  act: (label: string, work: () => Promise<string | undefined>) => Promise<void>;
}) {
  const missing = devices.filter((d) => !entry.onDevices.includes(d.serialNo));
  const present = devices.filter((d) => entry.onDevices.includes(d.serialNo));

  return (
    <div className="library-card">
      <div className="swatches" aria-hidden>
        {entry.paletteColors.slice(0, 6).map((c, i) => (
          <span
            key={i}
            style={{
              background: `hsl(${c.hue} ${c.saturation}% ${Math.max(25, c.brightness * 0.6)}%)`,
            }}
          />
        ))}
      </div>

      <div className="library-card-body">
        <div className="library-name">
          {entry.name}
          <button
            className={`star${entry.favourite ? ' on' : ''}`}
            title={entry.favourite ? 'Remove from favourites' : 'Add to favourites'}
            disabled={busy}
            onClick={() =>
              void act('favourite', async () => {
                await api().setFavourite(entry.name, !entry.favourite);
                return undefined;
              })
            }
          >
            {entry.favourite ? '★' : '☆'}
          </button>
        </div>

        <div className="library-meta">
          {entry.motion ?? 'Custom'}
          {present.length > 0 && ` · on ${present.map((d) => d.name).join(', ')}`}
          {present.length === 0 && ' · archived only'}
        </div>

        <div className="library-actions">
          {present.map((d) => (
            <button
              key={`apply-${d.serialNo}`}
              disabled={busy}
              onClick={() =>
                void act('apply', async () => {
                  const r = await api().applyLibraryEffect(entry.name, d.serialNo);
                  return r.imported.length > 0
                    ? `Playing on ${d.name}.`
                    : r.skipped[0]?.reason;
                })
              }
            >
              Play on {d.name}
            </button>
          ))}

          {missing.map((d) => (
            <button
              key={`push-${d.serialNo}`}
              disabled={busy}
              onClick={() =>
                void act('push', async () => {
                  const r = await api().pushLibraryEffect(entry.name, d.serialNo);
                  return r.imported.length > 0
                    ? `Added to ${d.name}.`
                    : r.skipped[0]?.reason;
                })
              }
            >
              Add to {d.name}
            </button>
          ))}

          {present.map((d) => (
            <button
              key={`remove-${d.serialNo}`}
              className="ghost"
              disabled={busy}
              title="Free a slot on the device. The archived copy is kept."
              onClick={() =>
                void act('remove', async () => {
                  const r = await api().removeFromDevice(entry.name, d.serialNo);
                  return r.ok ? `Removed from ${d.name}; still archived here.` : r.error;
                })
              }
            >
              Remove from {d.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
