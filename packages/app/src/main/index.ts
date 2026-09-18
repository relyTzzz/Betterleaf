import { join } from 'node:path';
import { BrowserWindow, app, ipcMain, shell } from 'electron';
import { IPC } from '../shared/types.js';
import { DeviceRegistry } from './registry.js';

// Before anything reads app.getPath('userData'): the package name is scoped
// (@betterleaf/app), which would otherwise become the directory name on disk.
app.setName('Betterleaf');

const registry = new DeviceRegistry();
let window: BrowserWindow | undefined;

function createWindow(): void {
  window = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 420,
    minHeight: 520,
    show: false,
    backgroundColor: '#12131a',
    title: 'Betterleaf',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // The renderer has no business touching Node. Everything it needs comes
      // through the narrow, typed bridge in preload/index.ts.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  window.on('ready-to-show', () => window?.show());

  // Links open in the user's browser, never inside the app shell.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devServer = process.env['ELECTRON_RENDERER_URL'];
  if (devServer) void window.loadURL(devServer);
  else void window.loadFile(join(__dirname, '../renderer/index.html'));
}

function registerIpc(): void {
  ipcMain.handle(IPC.snapshot, () => registry.snapshot());
  ipcMain.handle(IPC.rescan, () => registry.scan());

  ipcMain.handle(IPC.createRoom, (_e, name: string) => registry.createRoom(name));
  ipcMain.handle(IPC.renameRoom, (_e, id: string, name: string) =>
    registry.renameRoom(id, name),
  );
  ipcMain.handle(IPC.deleteRoom, (_e, id: string) => registry.deleteRoom(id));
  ipcMain.handle(IPC.reorderRooms, (_e, ids: string[]) => registry.reorderRooms(ids));
  ipcMain.handle(IPC.assignDevice, (_e, serial: string, roomId: string | null) =>
    registry.assignDevice(serial, roomId),
  );

  ipcMain.handle(IPC.setRoomPower, (_e, id: string, on: boolean) =>
    registry.setRoomPower(id, on),
  );
  ipcMain.handle(IPC.setRoomBrightness, (_e, id: string, value: number) =>
    registry.setRoomBrightness(id, value),
  );
  ipcMain.handle(IPC.setRoomEffect, (_e, id: string, name: string) =>
    registry.setRoomEffect(id, name),
  );

  ipcMain.handle(IPC.exportEffects, (_e, serial: string) =>
    registry.exportEffects(serial),
  );
  ipcMain.handle(IPC.importEffects, (_e, serial: string) =>
    registry.importEffects(serial),
  );
  ipcMain.handle(IPC.copyEffects, (_e, from: string, to: string) =>
    registry.copyEffects(from, to),
  );
  ipcMain.handle(IPC.listMotions, (_e, serial: string) => registry.listMotions(serial));

  ipcMain.handle(IPC.setPower, (_e, serial: string, on: boolean) =>
    registry.setPower(serial, on),
  );
  ipcMain.handle(IPC.setBrightness, (_e, serial: string, value: number) =>
    registry.setBrightness(serial, value),
  );
  ipcMain.handle(IPC.setHueSat, (_e, serial: string, hue: number, sat: number) =>
    registry.setHueSat(serial, hue, sat),
  );
  ipcMain.handle(IPC.setColorTemp, (_e, serial: string, kelvin: number) =>
    registry.setColorTemp(serial, kelvin),
  );
  ipcMain.handle(IPC.selectEffect, (_e, serial: string, name: string) =>
    registry.selectEffect(serial, name),
  );
  ipcMain.handle(IPC.identify, (_e, serial: string) => registry.identify(serial));
  ipcMain.handle(IPC.forget, (_e, serial: string) => registry.forget(serial));

  ipcMain.handle(IPC.pair, (_e, ip: string, port?: number) => registry.pair(ip, port));
  ipcMain.handle(IPC.cancelPair, () => registry.cancelPair());

  registry.on('snapshot', (snapshot) => {
    if (window && !window.isDestroyed()) {
      window.webContents.send(IPC.snapshotChanged, snapshot);
    }
  });
  registry.on('pairProgress', (progress) => {
    if (window && !window.isDestroyed()) {
      window.webContents.send(IPC.pairProgress, progress);
    }
  });
}

void app.whenReady().then(() => {
  registerIpc();
  createWindow();

  // Discovery runs after the window exists so cached devices appear as they are
  // adopted rather than after everything settles.
  void registry.start();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  void registry.dispose();
});
