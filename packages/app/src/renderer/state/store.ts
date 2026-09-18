import { useEffect } from 'react';
import { create } from 'zustand';
import type {
  AppSnapshot,
  BetterleafApi,
  DeviceView,
  PairProgress,
  RoomView,
} from '../../shared/types.js';

declare global {
  interface Window {
    betterleaf: BetterleafApi;
  }
}

export const api = (): BetterleafApi => window.betterleaf;

/** The sidebar can select either a room or a single device. */
export type Selection =
  | { kind: 'device'; id: string }
  | { kind: 'room'; id: string };

interface AppState {
  snapshot: AppSnapshot;
  selection: Selection | undefined;
  pairProgress: PairProgress | undefined;
  select: (selection: Selection | undefined) => void;
  setSnapshot: (snapshot: AppSnapshot) => void;
  setPairProgress: (progress: PairProgress | undefined) => void;
}

const EMPTY: AppSnapshot = {
  devices: [],
  rooms: [],
  unpaired: [],
  discovery: { scanning: false },
};

/** Does this selection still point at something that exists? */
function stillValid(selection: Selection | undefined, snapshot: AppSnapshot): boolean {
  if (!selection) return false;
  return selection.kind === 'device'
    ? snapshot.devices.some((d) => d.serialNo === selection.id)
    : snapshot.rooms.some((r) => r.id === selection.id);
}

export const useApp = create<AppState>((set) => ({
  snapshot: EMPTY,
  selection: undefined,
  pairProgress: undefined,
  select: (selection) => set({ selection }),
  setPairProgress: (pairProgress) => set({ pairProgress }),
  setSnapshot: (snapshot) =>
    set((prev) => ({
      snapshot,
      // Keep the current selection while it still exists; otherwise fall back to
      // the first device so the detail pane is never pointlessly empty.
      selection: stillValid(prev.selection, snapshot)
        ? prev.selection
        : snapshot.devices[0]
          ? { kind: 'device', id: snapshot.devices[0].serialNo }
          : undefined,
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
  return useApp((s) =>
    s.selection?.kind === 'device'
      ? s.snapshot.devices.find((d) => d.serialNo === s.selection!.id)
      : undefined,
  );
}

export function useSelectedRoom(): RoomView | undefined {
  return useApp((s) =>
    s.selection?.kind === 'room'
      ? s.snapshot.rooms.find((r) => r.id === s.selection!.id)
      : undefined,
  );
}

/** Devices in a room, in the room's own order. */
export function devicesIn(snapshot: AppSnapshot, room: RoomView): DeviceView[] {
  return room.deviceSerials.flatMap((serial) => {
    const device = snapshot.devices.find((d) => d.serialNo === serial);
    return device ? [device] : [];
  });
}

/** Devices belonging to no room, which the sidebar lists last. */
export function unassignedDevices(snapshot: AppSnapshot): DeviceView[] {
  return snapshot.devices.filter((d) => !d.roomId);
}
