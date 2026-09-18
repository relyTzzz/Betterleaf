import { useEffect } from 'react';
import { create } from 'zustand';
import type { AppSnapshot, BetterleafApi, DeviceView, PairProgress } from '../../shared/types.js';

declare global {
  interface Window {
    betterleaf: BetterleafApi;
  }
}

export const api = (): BetterleafApi => window.betterleaf;

interface AppState {
  snapshot: AppSnapshot;
  selected: string | undefined;
  pairProgress: PairProgress | undefined;
  select: (serialNo: string | undefined) => void;
  setSnapshot: (snapshot: AppSnapshot) => void;
  setPairProgress: (progress: PairProgress | undefined) => void;
}

const EMPTY: AppSnapshot = {
  devices: [],
  unpaired: [],
  discovery: { scanning: false },
};

export const useApp = create<AppState>((set) => ({
  snapshot: EMPTY,
  selected: undefined,
  pairProgress: undefined,
  select: (serialNo) => set({ selected: serialNo }),
  setPairProgress: (pairProgress) => set({ pairProgress }),
  setSnapshot: (snapshot) =>
    set((prev) => ({
      snapshot,
      // Keep a selection if it still exists; otherwise fall back to the first
      // device so the detail pane is never pointlessly empty.
      selected:
        prev.selected && snapshot.devices.some((d) => d.serialNo === prev.selected)
          ? prev.selected
          : snapshot.devices[0]?.serialNo,
    })),
}));

/** Subscribe to main-process updates for as long as the app is mounted. */
export function useSnapshotSubscription(): void {
  const setSnapshot = useApp((s) => s.setSnapshot);
  const setPairProgress = useApp((s) => s.setPairProgress);

  useEffect(() => {
    void api().getSnapshot().then(setSnapshot);
    const offSnapshot = api().onSnapshot(setSnapshot);
    const offPair = api().onPairProgress(setPairProgress);
    return () => {
      offSnapshot();
      offPair();
    };
  }, [setSnapshot, setPairProgress]);
}

export function useSelectedDevice(): DeviceView | undefined {
  return useApp((s) => s.snapshot.devices.find((d) => d.serialNo === s.selected));
}
