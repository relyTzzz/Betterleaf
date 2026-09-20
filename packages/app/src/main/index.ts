import { join } from 'node:path';
import { BrowserWindow, Menu, Tray, app, ipcMain, nativeImage, shell } from 'electron';
import { IPC, type AppSettings, type ScheduleInput } from '../shared/types.js';
import { DeviceRegistry } from './registry.js';
import { SettingsStore } from './settings-store.js';

// Before anything reads app.getPath('userData'): the package name is scoped
// (@betterleaf/app), which would otherwise become the directory name on disk.
app.setName('Betterleaf');

// No application menu. Betterleaf has nothing to put in one — every action lives
// in the window itself — and the stock File/Edit/View/Window/Help bar is just
// Electron showing through.
//
// Safe on Windows and Linux: Chromium handles editing shortcuts (Ctrl+A/C/V/X/Z)
// inside editable fields in the renderer itself, so they do not depend on menu
// accelerators. macOS is the platform where those roles are load-bearing, and
// would need an Edit menu restoring if this ever ships there.
Menu.setApplicationMenu(null);

const registry = new DeviceRegistry();
const settingsStore = new SettingsStore();
let window: BrowserWindow | undefined;
let tray: Tray | undefined;

/**
 * Set once the user has actually asked to quit, so `close` can tell the two
 * cases apart: closing the window should hide to the tray, quitting should not.
 */
let quitting = false;

/**
 * The arguments the login item is registered with, so signing in brings
 * Betterleaf up in the tray rather than throwing a window in your face.
 *
 * These have to be passed to `getLoginItemSettings` as well as to the setter.
 * On Windows the getter compares the stored command line against the `args` it
 * is given, so reading back with none reports `openAtLogin: false` even when
 * the registry entry is sitting right there — the toggle then appears to do
 * nothing, because it un-ticks itself the instant it is ticked.
 */
const LOGIN_ITEM_ARGS = ['--hidden'];

/** Whether the login item exists, asked in the one way that answers truthfully. */
function startsWithWindows(): boolean {
  return app.getLoginItemSettings({ args: LOGIN_ITEM_ARGS }).openAtLogin;
}

/** Mirrors the store, plus the login-item state Electron owns. */
let settings: AppSettings = {
  trayEnabled: true,
  startWithWindows: false,
  // Only meaningful once packaged: in development the login item would point at
  // electron.exe and a stray dev build, not at Betterleaf.
  startWithWindowsSupported: app.isPackaged && process.platform === 'win32',
};

/**
 * Only one Betterleaf at a time.
 *
 * Load-bearing now that schedules exist: two copies running would each fire
 * every schedule, so the lights would get two of everything and the two
 * processes would race each other writing `schedules.json`.
 */
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

/** The tray icon, which is the app icon at whatever size the platform wants. */
function trayImage() {
  const file = app.isPackaged
    ? join(process.resourcesPath, 'icon.ico')
    : join(__dirname, '../../build/icon.ico');
  const image = nativeImage.createFromPath(file);
  // An empty image gives an invisible tray entry, which is worse than none:
  // the app would be running with no way to get back to it.
  return image.isEmpty() ? undefined : image;
}

function buildTray(): void {
  if (tray || !settings.trayEnabled) return;
  const image = trayImage();
  if (!image) return;

  tray = new Tray(image);
  tray.setToolTip('Betterleaf');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Betterleaf', click: () => showWindow() },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', () => showWindow());
}

function destroyTray(): void {
  tray?.destroy();
  tray = undefined;
}

function showWindow(): void {
  if (!window || window.isDestroyed()) {
    createWindow();
    return;
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function applySettings(next: AppSettings): void {
  settings = next;
  if (settings.trayEnabled) buildTray();
  else destroyTray();
  registry.setSettings(settings);
}

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

  // Launched by the login item: come up in the tray rather than throwing a
  // window in your face every time you sign in.
  const startHidden = process.argv.includes('--hidden');
  window.on('ready-to-show', () => {
    if (!startHidden) window?.show();
  });

  // Closing the window keeps the app alive in the tray, because schedules only
  // fire while it is running. Without this, "close" would silently mean "cancel
  // every schedule", which is not what closing a window looks like it does.
  window.on('close', (event) => {
    if (quitting || !settings.trayEnabled) return;
    event.preventDefault();
    window?.hide();
  });

  // Removing the menu also removes its accelerators, so put the one that
  // actually matters back — but only in development, where it is wanted.
  if (!app.isPackaged) {
    window.webContents.on('before-input-event', (_event, input) => {
      const devtools =
        input.key === 'F12' ||
        (input.control && input.shift && input.key.toLowerCase() === 'i');
      if (devtools) window?.webContents.toggleDevTools();
    });
  }

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

  ipcMain.handle(IPC.createSchedule, (_e, input: ScheduleInput) =>
    registry.createSchedule(input),
  );
  ipcMain.handle(IPC.updateSchedule, (_e, id: string, input: ScheduleInput) =>
    registry.updateSchedule(id, input),
  );
  ipcMain.handle(IPC.deleteSchedule, (_e, id: string) => registry.deleteSchedule(id));
  ipcMain.handle(IPC.setScheduleEnabled, (_e, id: string, enabled: boolean) =>
    registry.setScheduleEnabled(id, enabled),
  );
  ipcMain.handle(IPC.runScheduleNow, (_e, id: string) => registry.runScheduleNow(id));

  ipcMain.handle(IPC.setDeviceLocked, (_e, serial: string, locked: boolean) =>
    registry.setDeviceLocked(serial, locked),
  );
  ipcMain.handle(IPC.setRoomLocked, (_e, roomId: string, locked: boolean) =>
    registry.setRoomLocked(roomId, locked),
  );

  ipcMain.handle(IPC.setTrayEnabled, async (_e, enabled: boolean) => {
    await settingsStore.save({ trayEnabled: enabled });
    applySettings({ ...settings, trayEnabled: enabled });
  });

  ipcMain.handle(IPC.setStartWithWindows, (_e, enabled: boolean) => {
    if (!settings.startWithWindowsSupported) return;
    app.setLoginItemSettings({ openAtLogin: enabled, args: LOGIN_ITEM_ARGS });
    applySettings({
      ...settings,
      // Read back rather than assume: if Windows refused, the toggle should
      // show what is actually true.
      startWithWindows: startsWithWindows(),
    });
  });

  ipcMain.handle(IPC.listLibrary, () => registry.listLibrary());
  ipcMain.handle(IPC.refreshLibrary, () => registry.refreshLibrary());
  ipcMain.handle(IPC.applyLibraryEffect, (_e, name: string, serial: string) =>
    registry.applyLibraryEffect(name, serial),
  );
  ipcMain.handle(IPC.pushLibraryEffect, (_e, name: string, serial: string) =>
    registry.pushLibraryEffect(name, serial),
  );
  ipcMain.handle(IPC.removeFromDevice, (_e, name: string, serial: string) =>
    registry.removeFromDevice(name, serial),
  );
  ipcMain.handle(IPC.forgetLibraryEffect, (_e, name: string) =>
    registry.forgetLibraryEffect(name),
  );
  ipcMain.handle(IPC.setFavourite, (_e, name: string, favourite: boolean) =>
    registry.setFavourite(name, favourite),
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

void app.whenReady().then(async () => {
  const stored = await settingsStore.load();
  applySettings({
    trayEnabled: stored.trayEnabled,
    startWithWindows: settings.startWithWindowsSupported ? startsWithWindows() : false,
    startWithWindowsSupported: settings.startWithWindowsSupported,
  });

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
  // With the tray on, a closed window is not a closed app — the whole point is
  // that schedules keep firing. Quitting is an explicit act, from the tray menu.
  if (settings.trayEnabled && !quitting) return;
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  quitting = true;
  destroyTray();
  void registry.dispose();
});
