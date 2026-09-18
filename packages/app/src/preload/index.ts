import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type AppSnapshot, type BetterleafApi, type PairProgress } from '../shared/types.js';

/**
 * The entire surface the renderer gets.
 *
 * Nothing here hands back an ipcRenderer, an event object, or anything else the
 * renderer could use to reach further into the main process — each subscription
 * unwraps the IPC event and passes only the payload, and returns an
 * unsubscribe function so React effects can clean up properly.
 */
const api: BetterleafApi = {
  getSnapshot: () => ipcRenderer.invoke(IPC.snapshot),
  rescan: () => ipcRenderer.invoke(IPC.rescan),

  createRoom: (name) => ipcRenderer.invoke(IPC.createRoom, name),
  renameRoom: (roomId, name) => ipcRenderer.invoke(IPC.renameRoom, roomId, name),
  deleteRoom: (roomId) => ipcRenderer.invoke(IPC.deleteRoom, roomId),
  reorderRooms: (roomIds) => ipcRenderer.invoke(IPC.reorderRooms, roomIds),
  assignDevice: (serialNo, roomId) =>
    ipcRenderer.invoke(IPC.assignDevice, serialNo, roomId),

  setRoomPower: (roomId, on) => ipcRenderer.invoke(IPC.setRoomPower, roomId, on),
  setRoomBrightness: (roomId, value) =>
    ipcRenderer.invoke(IPC.setRoomBrightness, roomId, value),
  setRoomEffect: (roomId, name) => ipcRenderer.invoke(IPC.setRoomEffect, roomId, name),

  exportEffects: (serialNo) => ipcRenderer.invoke(IPC.exportEffects, serialNo),
  importEffects: (serialNo) => ipcRenderer.invoke(IPC.importEffects, serialNo),
  copyEffects: (from, to) => ipcRenderer.invoke(IPC.copyEffects, from, to),
  listMotions: (serialNo) => ipcRenderer.invoke(IPC.listMotions, serialNo),

  setPower: (serialNo, on) => ipcRenderer.invoke(IPC.setPower, serialNo, on),
  setBrightness: (serialNo, value) => ipcRenderer.invoke(IPC.setBrightness, serialNo, value),
  setHueSat: (serialNo, hue, sat) => ipcRenderer.invoke(IPC.setHueSat, serialNo, hue, sat),
  setColorTemp: (serialNo, kelvin) => ipcRenderer.invoke(IPC.setColorTemp, serialNo, kelvin),
  selectEffect: (serialNo, name) => ipcRenderer.invoke(IPC.selectEffect, serialNo, name),
  identify: (serialNo) => ipcRenderer.invoke(IPC.identify, serialNo),
  forget: (serialNo) => ipcRenderer.invoke(IPC.forget, serialNo),

  pair: (ip, port) => ipcRenderer.invoke(IPC.pair, ip, port),
  cancelPair: () => ipcRenderer.invoke(IPC.cancelPair),

  onSnapshot: (handler: (snapshot: AppSnapshot) => void) => {
    const listener = (_event: unknown, snapshot: AppSnapshot) => handler(snapshot);
    ipcRenderer.on(IPC.snapshotChanged, listener);
    return () => ipcRenderer.removeListener(IPC.snapshotChanged, listener);
  },

  onPairProgress: (handler: (progress: PairProgress) => void) => {
    const listener = (_event: unknown, progress: PairProgress) => handler(progress);
    ipcRenderer.on(IPC.pairProgress, listener);
    return () => ipcRenderer.removeListener(IPC.pairProgress, listener);
  },
};

contextBridge.exposeInMainWorld('betterleaf', api);
