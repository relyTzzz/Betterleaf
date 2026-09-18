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
