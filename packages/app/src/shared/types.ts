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
    rhythm: boolean;
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
  rooms: RoomView[];
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
