/**
 * Wire types for the Nanoleaf local OpenAPI (http://<ip>:16021/api/v1/<token>).
 *
 * These mirror what the devices actually send. Anything Betterleaf invents for
 * its own bookkeeping lives further down under "Betterleaf types".
 */

/** Nanoleaf wraps most scalars with their own valid range. */
export interface BoundedValue {
  value: number;
  max: number;
  min: number;
}

export interface DeviceState {
  on: { value: boolean };
  brightness: BoundedValue;
  hue: BoundedValue;
  sat: BoundedValue;
  /** Colour temperature in Kelvin. Typically 1200–6500. */
  ct: BoundedValue;
  colorMode: string;
}

export interface PanelPosition {
  panelId: number;
  x: number;
  y: number;
  /** Orientation in degrees. */
  o: number;
  /** See {@link ShapeType}. Absent on very old firmware. */
  shapeType?: number;
}

export interface PanelLayout {
  numPanels: number;
  sideLength: number;
  positionData: PanelPosition[];
}

export interface EffectsBlock {
  select: string;
  effectsList: string[];
}

export interface RhythmInfo {
  rhythmConnected: boolean;
  rhythmActive?: boolean;
  rhythmId?: number | null;
  hardwareVersion?: string | null;
  firmwareVersion?: string | null;
  auxAvailable?: boolean | null;
  rhythmMode?: number;
  rhythmPos?: { x: number; y: number; o: number } | null;
}

/** The full document returned by `GET /api/v1/<token>/`. */
export interface DeviceInfo {
  name: string;
  serialNo: string;
  manufacturer: string;
  firmwareVersion: string;
  hardwareVersion?: string;
  model: string;
  state: DeviceState;
  effects: EffectsBlock;
  panelLayout: {
    layout: PanelLayout;
    globalOrientation: BoundedValue;
  };
  rhythm?: RhythmInfo;
}

/**
 * Response to the request that enables external control. Light Panels fill this
 * in; Canvas returns an empty body and we fall back to the default port.
 */
export interface StreamControlInfo {
  streamControlIpAddr?: string;
  streamControlPort?: number;
  streamControlProtocol?: string;
}

// ---------------------------------------------------------------------------
// Panel geometry
// ---------------------------------------------------------------------------

/**
 * Known `shapeType` values.
 *
 * Only the ones Betterleaf needs to reason about are named. The critical
 * distinction is illuminated vs. not: a Rhythm module reports itself as a panel
 * in `positionData` but has no LEDs, so including it in a streaming frame
 * shifts every subsequent panel. See {@link isIlluminated}.
 */
export const ShapeType = {
  Triangle: 0,
  Rhythm: 1,
  Square: 2,
  ControlSquareMaster: 3,
  ControlSquarePassive: 4,
  ShapesHexagon: 7,
  ShapesTriangle: 8,
  ShapesMiniTriangle: 9,
  ShapesController: 12,
  ElementsHexagon: 14,
  LinesConnector: 17,
  Line: 18,
} as const;

/**
 * Non-illuminated pseudo-panels that the firmware still reports in
 * `positionData`. They must be filtered out of both streaming frames and the
 * layout render.
 *
 * NOTE: the Canvas control square (shapeType 3/4) *is* illuminated and stays in.
 * Verify both of these against the real NL22 and NL29 — community reports
 * disagree and the hardware is the only authority.
 */
const NON_ILLUMINATED: ReadonlySet<number> = new Set([
  ShapeType.Rhythm,
  ShapeType.ShapesController,
  ShapeType.LinesConnector,
]);

export function isIlluminated(panel: PanelPosition): boolean {
  if (panel.shapeType === undefined) return true;
  return !NON_ILLUMINATED.has(panel.shapeType);
}

/** Panels that can actually show a colour, in layout order. */
export function illuminatedPanels(layout: PanelLayout): PanelPosition[] {
  return layout.positionData.filter(isIlluminated);
}

// ---------------------------------------------------------------------------
// Betterleaf types
// ---------------------------------------------------------------------------

export type StreamVersion = 'v1' | 'v2';

/** Flattened device state — what the UI actually binds to. */
export interface StateSnapshot {
  on: boolean;
  brightness: number;
  hue: number;
  sat: number;
  ct: number;
  colorMode: string;
}

export type StatePatch = Partial<StateSnapshot>;

export function flattenState(state: DeviceState): StateSnapshot {
  return {
    on: state.on.value,
    brightness: state.brightness.value,
    hue: state.hue.value,
    sat: state.sat.value,
    ct: state.ct.value,
    colorMode: state.colorMode,
  };
}

export type DeviceFamily =
  | 'light-panels'
  | 'canvas'
  | 'shapes'
  | 'elements'
  | 'lines'
  | 'essentials'
  | 'unknown';

/**
 * Connection status shown to the user. There is deliberately no "connecting…"
 * that can hang forever — every state is either actionable or self-healing.
 */
export type ConnectionStatus =
  | 'connected'
  | 'reconnecting'
  | 'unreachable'
  | 'needs-pairing';

/** A single panel's colour. White channel is separate; most effects leave it 0. */
export interface PanelColor {
  panelId: number;
  r: number;
  g: number;
  b: number;
  w?: number;
  /** Transition time in units of 100 ms. 0 = snap instantly. */
  transitionTime?: number;
}

/**
 * What Betterleaf persists about a device between runs.
 *
 * Keyed on `serialNo`, never on address: a DHCP lease change must not look like
 * a new device, and must not require re-pairing.
 */
export interface DeviceRecord {
  serialNo: string;
  model: string;
  name: string;
  token: string;
  lastIp: string;
  lastPort: number;
  /** Whichever external-control version this unit actually accepted. */
  streamVersion?: StreamVersion;
  lastSeenAt?: number;
}

/** A device found on the network but not necessarily paired yet. */
export interface DiscoveredDevice {
  ip: string;
  port: number;
  /** Present when the transport that found it advertises one. */
  serialNo?: string;
  model?: string;
  name?: string;
  firmwareVersion?: string;
  source: 'cache' | 'mdns' | 'ssdp' | 'sweep' | 'manual';
}
