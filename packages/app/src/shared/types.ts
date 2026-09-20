import type {
  ConnectionStatus,
  DeviceFamily,
  PanelShapeKind,
  StateSnapshot,
  StreamVersion,
} from '@betterleaf/protocol';

/**
 * A panel as the renderer needs it: already in screen space, already classified.
 *
 * The renderer imports only types from the protocol package, never values —
 * that package speaks `node:dgram` and `node:http`, and pulling any of it into
 * the browser bundle drags those in with it.
 */
export interface PanelView {
  panelId: number;
  screenX: number;
  screenY: number;
  sideLength: number;
  /** Orientation in degrees, as the device reports it. */
  o: number;
  shape: PanelShapeKind;
}

/**
 * What the renderer sees.
 *
 * Deliberately a plain serialisable snapshot rather than a live object: it
 * crosses an IPC boundary, and keeping it dumb means the renderer can never
 * accidentally hold a socket or a timer.
 */
export interface DeviceView {
  serialNo: string;
  name: string;
  model: string;
  family: DeviceFamily;
  host: string;
  port: number;
  status: ConnectionStatus;
  state: StateSnapshot;
  effects: string[];
  currentEffect: string;
  capabilities: {
    touch: boolean;
    /** Can play sound-reactive scenes, however it listens. */
    soundReactive: boolean;
    /** Uses an external Rhythm module rather than a built-in microphone. */
    rhythmModule: boolean;
  };
  streamVersion?: StreamVersion;
  layout: {
    panels: PanelView[];
    bounds: { width: number; height: number };
    sideLength: number;
  };
  /** Last time an event or a successful request proved the device was there. */
  lastSeenAt?: number;
  /** Room this device belongs to, if any. A device is in at most one room. */
  roomId?: string;
  /**
   * Held by the user, so schedules leave it alone entirely.
   *
   * Only schedules are blocked. Anything done by hand still works — the point
   * is to stop the app changing the scene behind your back, not to stop you.
   */
  locked: boolean;
}

/**
 * A group of devices.
 *
 * Rooms are entirely a Betterleaf concept — the Nanoleaf local API has no
 * equivalent, so nothing about them is written to the devices. They will not
 * appear in the official app or in HomeKit, and the UI says so.
 */
export interface Room {
  id: string;
  name: string;
  deviceSerials: string[];
  order: number;
}

/**
 * A room plus the state derived from its members.
 *
 * Every derived value is deliberately pessimistic or conservative, so a room can
 * never look healthier or more capable than the devices in it.
 */
export interface RoomView {
  id: string;
  name: string;
  order: number;
  /** Members that are actually connected right now, in device order. */
  deviceSerials: string[];
  /** True when *any* member is on, so the toggle reads "is anything lit". */
  on: boolean;
  /** Mean brightness across members that are on; 0 when none are. */
  brightness: number;
  /** The worst status among members. */
  status: ConnectionStatus;
  /** Only effects present on every member — the rest cannot apply room-wide. */
  effects: string[];
  /**
   * The effect every member is currently showing, or undefined when they
   * disagree. Undefined is the honest answer for a mixed room: highlighting one
   * member's effect would claim the whole room is showing it.
   */
  currentEffect?: string;
  /**
   * True when every connected member is locked.
   *
   * Deliberately "every", not "any": a room that reads locked while a schedule
   * could still change one of its lights would be lying. Partially locked rooms
   * report false, and the members show their own badges.
   */
  locked: boolean;
}

/**
 * What a schedule points at.
 *
 * A room rather than a list of devices, so a schedule follows the room's
 * membership: add a light to "Office" and the 7am schedule covers it without
 * being edited.
 */
export type ScheduleTarget =
  | { kind: 'device'; serialNo: string }
  | { kind: 'room'; roomId: string };

/**
 * What a schedule does when it fires.
 *
 * Every field is optional and only the ones present are applied, so a schedule
 * can dim without disturbing the scene, or change scene without touching
 * brightness. All three absent is a schedule that does nothing, which the
 * editor refuses to save.
 */
export interface ScheduleAction {
  /** Turn the lights on or off. Omitted leaves power alone. */
  power?: boolean;
  /** Scene to select, by name. */
  effect?: string;
  /** 0–100. */
  brightness?: number;
}

export interface Schedule {
  id: string;
  name: string;
  enabled: boolean;
  target: ScheduleTarget;
  /** Minutes past local midnight, 0–1439. Local time, so DST is handled by it. */
  timeMinutes: number;
  /** Days it runs on: 0 = Sunday, matching `Date#getDay`. Empty never fires. */
  days: number[];
  action: ScheduleAction;
  order: number;
  /**
   * When this last fired, as the epoch ms of the *slot* rather than of the
   * actual write. Persisted, so restarting the app cannot re-fire a schedule
   * that already ran, and so a slot is never claimed twice.
   */
  lastRunAt?: number;
  /** 'ok', 'missed', or the error that stopped it. */
  lastResult?: string;
}

/** A schedule plus what only the main process can work out. */
export interface ScheduleView extends Schedule {
  /** The room or device name, or undefined when the target is gone. */
  targetName?: string;
  /** Epoch ms of the next firing; undefined when it will never fire. */
  nextRunAt?: number;
}

/** Fields the editor can set. The rest are managed by the store. */
export type ScheduleInput = Omit<
  Schedule,
  'id' | 'order' | 'lastRunAt' | 'lastResult'
>;

/**
 * Whether Betterleaf keeps running when the window is closed.
 *
 * Schedules only fire while the app is running, so this is load-bearing rather
 * than a convenience, and the UI says as much.
 */
export interface AppSettings {
  /** True when closing the window hides to the tray instead of quitting. */
  trayEnabled: boolean;
  startWithWindows: boolean;
  /**
   * False in development, where the login item would point at electron.exe
   * rather than at Betterleaf. The UI greys the toggle out and explains why.
   */
  startWithWindowsSupported: boolean;
}

/**
 * A scene that plays while a particular program is running.
 *
 * Reuses `ScheduleTarget` and `ScheduleAction` deliberately: "put these lights
 * into that state" is the same idea whether a clock or a running program asked
 * for it, and one action model means one set of rules about what happens.
 */
export interface AppRule {
  id: string;
  name: string;
  enabled: boolean;
  /**
   * Executable names that activate this rule, lowercased — `overwatch.exe`.
   * Several, so one rule can cover a launcher and its game.
   */
  processNames: string[];
  target: ScheduleTarget;
  action: ScheduleAction;
  /**
   * 0 is highest. When several rules match at once the lowest number wins, so
   * "Gaming" can outrank "Working" without either having to know about the
   * other. Kept contiguous by the store.
   */
  priority: number;
}

export type AppRuleInput = Omit<AppRule, 'id' | 'priority'>;

export interface AppRuleView extends AppRule {
  /** The room or light this points at, or undefined once it is gone. */
  targetName?: string;
  /** True when one of its processes is running right now. */
  matching: boolean;
  /**
   * True when this rule is the one currently holding its target.
   *
   * Different from `matching`: a lower-priority rule can match without holding
   * anything, because something above it won.
   */
  holding: boolean;
  /** Which process name matched, for showing why it is active. */
  matchedProcess?: string;
}

/** A program currently running, offered so rules can be built without typing. */
export interface RunningApp {
  /** Executable name, lowercased. */
  processName: string;
  /**
   * Full path, lowercased, when Windows would tell us.
   *
   * Absent for processes running at a higher integrity level than Betterleaf,
   * which is most system processes and anything started as administrator.
   */
  path?: string;
}

/**
 * An archived effect, as the renderer sees it.
 *
 * `onDevices` is computed live from the devices themselves rather than stored:
 * they are the authority on their own contents, and a cached answer goes stale
 * the moment someone uses the Nanoleaf app.
 */
export interface LibraryEntryView {
  name: string;
  /** Which built-in motion drives it, when we can name one. */
  motion?: string;
  motionUuid?: string;
  /**
   * Driven by a sound-reactive motion, so it responds to music rather than
   * running on its own. Needs a Rhythm module on the device to do anything.
   */
  soundReactive: boolean;
  paletteColors: { hue: number; saturation: number; brightness: number }[];
  favourite: boolean;
  firstSeenAt: number;
  /** Serials that currently hold this effect, byte-identical to the archive. */
  onDevices: string[];
  /** Serials it was ever harvested from. */
  seenOn: string[];
}

/** Per-effect result of writing a batch to a device. */
export interface ImportOutcome {
  imported: string[];
  skipped: { name: string; reason: string }[];
  cancelled?: boolean;
}

export interface ExportOutcome {
  path: string;
  count: number;
  cancelled?: boolean;
}

/** A motion the device can render, which effects are authored against. */
export interface MotionView {
  id: string;
  label: string;
  uuid: string;
  pluginType: 'color' | 'rhythm';
  description: string;
  /** True when this device reports having the motion. */
  available: boolean;
}

/** A Nanoleaf found on the network that we do not have a token for. */
export interface UnpairedDeviceView {
  ip: string;
  port: number;
  model?: string;
  name?: string;
  source: string;
}

export interface DiscoveryState {
  scanning: boolean;
  /** Which rung is currently running, for an honest progress line. */
  rung?: string;
  lastScanAt?: number;
}

export interface AppSnapshot {
  devices: DeviceView[];
  /** Count only; the full list is fetched on demand so snapshots stay small. */
  libraryCount: number;
  /**
   * Names of archived effects that respond to music.
   *
   * Devices and rooms know their effects only by name, so this is what lets the
   * effect chips there be marked. It comes from the library, which holds the
   * full documents — an effect on a device but not yet harvested simply will not
   * be marked, which is the honest failure: better unmarked than wrongly marked.
   */
  soundReactiveEffects: string[];
  rooms: RoomView[];
  schedules: ScheduleView[];
  appRules: AppRuleView[];
  settings: AppSettings;
  unpaired: UnpairedDeviceView[];
  discovery: DiscoveryState;
}

export interface PairProgress {
  ip: string;
  port: number;
  /** Milliseconds left in the pairing window. */
  msRemaining: number;
}

export interface PairResult {
  ok: boolean;
  serialNo?: string;
  name?: string;
  error?: string;
}

/** The surface exposed to the renderer through contextBridge. */
export interface BetterleafApi {
  getSnapshot(): Promise<AppSnapshot>;
  rescan(): Promise<void>;

  createRoom(name: string): Promise<string>;
  renameRoom(roomId: string, name: string): Promise<void>;
  deleteRoom(roomId: string): Promise<void>;
  reorderRooms(roomIds: string[]): Promise<void>;
  /** Pass null to remove a device from whatever room it is in. */
  assignDevice(serialNo: string, roomId: string | null): Promise<void>;

  setRoomPower(roomId: string, on: boolean): Promise<void>;
  setRoomBrightness(roomId: string, value: number): Promise<void>;
  setRoomEffect(roomId: string, name: string): Promise<void>;

  createSchedule(input: ScheduleInput): Promise<string>;
  updateSchedule(id: string, input: ScheduleInput): Promise<void>;
  deleteSchedule(id: string): Promise<void>;
  setScheduleEnabled(id: string, enabled: boolean): Promise<void>;
  /** Apply a schedule's action now, without waiting for its time or changing it. */
  runScheduleNow(id: string): Promise<{ ok: boolean; error?: string }>;

  /** Hold a light's scene, so schedules skip it until it is unlocked. */
  setDeviceLocked(serialNo: string, locked: boolean): Promise<void>;
  /** Lock or unlock every connected member of a room at once. */
  setRoomLocked(roomId: string, locked: boolean): Promise<void>;

  createAppRule(input: AppRuleInput): Promise<string>;
  updateAppRule(id: string, input: AppRuleInput): Promise<void>;
  deleteAppRule(id: string): Promise<void>;
  setAppRuleEnabled(id: string, enabled: boolean): Promise<void>;
  /** Highest priority first. Ids not mentioned keep their relative order. */
  reorderAppRules(ids: string[]): Promise<void>;
  /** Programs running right now, so a rule can be built without typing names. */
  listRunningApps(): Promise<RunningApp[]>;

  setTrayEnabled(enabled: boolean): Promise<void>;
  setStartWithWindows(enabled: boolean): Promise<void>;

  listLibrary(): Promise<LibraryEntryView[]>;
  refreshLibrary(): Promise<void>;
  applyLibraryEffect(name: string, serialNo: string): Promise<ImportOutcome>;
  pushLibraryEffect(name: string, serialNo: string): Promise<ImportOutcome>;
  /** Free a slot on the device. Refuses unless the archive matches byte for byte. */
  removeFromDevice(name: string, serialNo: string): Promise<{ ok: boolean; error?: string }>;
  forgetLibraryEffect(name: string): Promise<void>;
  setFavourite(name: string, favourite: boolean): Promise<void>;

  exportEffects(serialNo: string): Promise<ExportOutcome>;
  importEffects(serialNo: string): Promise<ImportOutcome>;
  copyEffects(fromSerialNo: string, toSerialNo: string): Promise<ImportOutcome>;
  listMotions(serialNo: string): Promise<MotionView[]>;

  setPower(serialNo: string, on: boolean): Promise<void>;
  setBrightness(serialNo: string, value: number): Promise<void>;
  setHueSat(serialNo: string, hue: number, sat: number): Promise<void>;
  setColorTemp(serialNo: string, kelvin: number): Promise<void>;
  selectEffect(serialNo: string, name: string): Promise<void>;
  identify(serialNo: string): Promise<void>;
  forget(serialNo: string): Promise<void>;

  pair(ip: string, port?: number): Promise<PairResult>;
  cancelPair(): Promise<void>;

  onSnapshot(handler: (snapshot: AppSnapshot) => void): () => void;
  onPairProgress(handler: (progress: PairProgress) => void): () => void;
}

export const IPC = {
  snapshot: 'betterleaf:snapshot',
  rescan: 'betterleaf:rescan',
  createRoom: 'betterleaf:createRoom',
  renameRoom: 'betterleaf:renameRoom',
  deleteRoom: 'betterleaf:deleteRoom',
  reorderRooms: 'betterleaf:reorderRooms',
  assignDevice: 'betterleaf:assignDevice',
  setRoomPower: 'betterleaf:setRoomPower',
  setRoomBrightness: 'betterleaf:setRoomBrightness',
  setRoomEffect: 'betterleaf:setRoomEffect',
  createSchedule: 'betterleaf:createSchedule',
  updateSchedule: 'betterleaf:updateSchedule',
  deleteSchedule: 'betterleaf:deleteSchedule',
  setScheduleEnabled: 'betterleaf:setScheduleEnabled',
  runScheduleNow: 'betterleaf:runScheduleNow',
  createAppRule: 'betterleaf:createAppRule',
  updateAppRule: 'betterleaf:updateAppRule',
  deleteAppRule: 'betterleaf:deleteAppRule',
  setAppRuleEnabled: 'betterleaf:setAppRuleEnabled',
  reorderAppRules: 'betterleaf:reorderAppRules',
  listRunningApps: 'betterleaf:listRunningApps',
  setDeviceLocked: 'betterleaf:setDeviceLocked',
  setRoomLocked: 'betterleaf:setRoomLocked',
  setTrayEnabled: 'betterleaf:setTrayEnabled',
  setStartWithWindows: 'betterleaf:setStartWithWindows',
  listLibrary: 'betterleaf:listLibrary',
  refreshLibrary: 'betterleaf:refreshLibrary',
  applyLibraryEffect: 'betterleaf:applyLibraryEffect',
  pushLibraryEffect: 'betterleaf:pushLibraryEffect',
  removeFromDevice: 'betterleaf:removeFromDevice',
  forgetLibraryEffect: 'betterleaf:forgetLibraryEffect',
  setFavourite: 'betterleaf:setFavourite',
  exportEffects: 'betterleaf:exportEffects',
  importEffects: 'betterleaf:importEffects',
  copyEffects: 'betterleaf:copyEffects',
  listMotions: 'betterleaf:listMotions',
  setPower: 'betterleaf:setPower',
  setBrightness: 'betterleaf:setBrightness',
  setHueSat: 'betterleaf:setHueSat',
  setColorTemp: 'betterleaf:setColorTemp',
  selectEffect: 'betterleaf:selectEffect',
  identify: 'betterleaf:identify',
  forget: 'betterleaf:forget',
  pair: 'betterleaf:pair',
  cancelPair: 'betterleaf:cancelPair',
  // main -> renderer
  snapshotChanged: 'betterleaf:snapshotChanged',
  pairProgress: 'betterleaf:pairProgress',
} as const;
