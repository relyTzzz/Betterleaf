import type { DeviceFamily, DeviceInfo, StreamVersion } from './types.js';

/**
 * What a given model can do.
 *
 * Expanding Betterleaf to the rest of the Nanoleaf catalog should mean adding a
 * row to {@link FAMILY_BY_MODEL} and, if needed, a branch in {@link deriveCapabilities}
 * — not a new code path. Everything below the capability layer is shared.
 */
export interface DeviceCapabilities {
  model: string;
  family: DeviceFamily;
  /** Touch/gesture events over SSE (event id 4). Canvas only, today. */
  touch: boolean;
  /**
   * Can play sound-reactive effects.
   *
   * Not the same as taking a Rhythm module: Canvas and Shapes detect sound with
   * a built-in microphone, while Light Panels need the external module. Both
   * ends up able to run rhythm motions, which is what this means.
   *
   * A hint only. `requestPlugins` is the authority for any given unit, and is
   * what the compatibility check actually consults.
   */
  soundReactive: boolean;
  /** Takes an external Rhythm module, rather than detecting sound itself. */
  rhythmModule: boolean;
  /**
   * Which external-control version to *try first*. Never trusted as final:
   * {@link import('../stream/extcontrol.js').StreamController} falls back and
   * persists whichever version the unit actually accepted.
   */
  preferredStreamVersion: StreamVersion;
  /** Default UDP port for that version, used when the device doesn't tell us. */
  defaultStreamPort: number;
}

/** Model number → product family. Model numbers come straight from `info.model`. */
const FAMILY_BY_MODEL: Record<string, DeviceFamily> = {
  NL22: 'light-panels', // Light Panels / Aurora
  NL29: 'canvas', // Canvas
  NL42: 'shapes', // Shapes Hexagons
  NL47: 'shapes', // Shapes Triangles
  NL48: 'shapes', // Shapes Mini Triangles
  NL52: 'elements', // Elements Hexagons
  NL59: 'lines', // Lines
};

export const STREAM_PORT_V1 = 60221;
export const STREAM_PORT_V2 = 60222;

export function familyForModel(model: string): DeviceFamily {
  return FAMILY_BY_MODEL[model.toUpperCase()] ?? 'unknown';
}

export function deriveCapabilities(info: DeviceInfo): DeviceCapabilities {
  const model = info.model;
  const family = familyForModel(model);

  // Light Panels are the only family that shipped with the v1 streaming
  // protocol. Recent Aurora firmware does accept v2, so this is only a starting
  // guess — the stream controller probes and remembers the truth.
  const preferredStreamVersion: StreamVersion =
    family === 'light-panels' ? 'v1' : 'v2';

  return {
    model,
    family,
    touch: family === 'canvas',
    // Verified against hardware: a real NL29 reports the same rhythm motions as
    // a real NL22, because it listens with a built-in microphone rather than an
    // add-on module. Treating sound reactivity as a Light Panels exclusive was
    // simply wrong.
    soundReactive: family !== 'unknown',
    rhythmModule: family === 'light-panels',
    preferredStreamVersion,
    defaultStreamPort:
      preferredStreamVersion === 'v1' ? STREAM_PORT_V1 : STREAM_PORT_V2,
  };
}

export function defaultPortForVersion(version: StreamVersion): number {
  return version === 'v1' ? STREAM_PORT_V1 : STREAM_PORT_V2;
}
