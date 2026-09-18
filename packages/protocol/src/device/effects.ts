import type { PanelColor } from '../model/types.js';

/**
 * A stored effect, in the shape the device speaks.
 *
 * This is what `requestAll` returns and what `add` accepts, so it doubles as
 * Betterleaf's interchange format: an effect exported from one device can be
 * written straight to another without translation.
 */
export interface NanoleafEffect {
  animName: string;
  animType: 'plugin' | 'custom' | 'static';
  colorType?: 'HSB';
  palette?: PaletteColor[];
  /** `color` for ordinary motions, `rhythm` for sound-reactive ones. */
  pluginType?: 'color' | 'rhythm';
  pluginUuid?: string;
  pluginOptions?: PluginOption[];
  /** Rendered per-panel data; `custom` and `static` only. */
  animData?: string;
  hasOverlay?: boolean;
  /**
   * Observed on real hardware but absent from the documentation. Named here
   * so it is visible; preserved regardless by {@link buildEffectWrite}.
   */
  rhythmFeatureSource?: number;
  loop?: boolean;
  version?: '1.0' | '2.0';
}

export interface PaletteColor {
  hue: number;
  saturation: number;
  brightness: number;
  /** Relative weight for motions that pick colours at random. */
  probability?: number;
}

export interface PluginOption {
  name: string;
  value: string | number | boolean;
}

/**
 * The motions every Nanoleaf controller ships with, by UUID.
 *
 * These are the engine behind most effects you would otherwise download: a
 * "marketplace" effect is largely one of these plus a palette and a few option
 * values. Authoring against them gets the same result with no cloud involved.
 *
 * A device has more than these: a real NL22 reports fourteen. `requestPlugins`
 * is the authority for any given unit; these six are the documented ones that
 */
export interface BuiltinMotion {
  id: string;
  label: string;
  uuid: string;
  pluginType: 'color' | 'rhythm';
  /** Options this motion understands, with sensible starting values. */
  options: PluginOption[];
  description: string;
}

export const BUILTIN_MOTIONS: readonly BuiltinMotion[] = [
  {
    id: 'wheel',
    label: 'Wheel',
    uuid: '6970681a-20b5-4c5e-8813-bdaebc4ee4fa',
    pluginType: 'color',
    options: [
      { name: 'transTime', value: 30 },
      { name: 'linDirection', value: 'right' },
      { name: 'nColorsPerFrame', value: 2 },
      { name: 'loop', value: true },
    ],
    description: 'Colours sweep across the layout in a chosen direction.',
  },
  {
    id: 'flow',
    label: 'Flow',
    uuid: '027842e4-e1d6-4a4c-a731-be74a1ebd4cf',
    pluginType: 'color',
    options: [
      { name: 'transTime', value: 20 },
      { name: 'delayTime', value: 10 },
      { name: 'linDirection', value: 'left' },
      { name: 'loop', value: true },
    ],
    description: 'Palette colours drift steadily across the panels.',
  },
  {
    id: 'explode',
    label: 'Explode',
    uuid: '713518c1-d560-47db-8991-de780af71d1e',
    pluginType: 'color',
    options: [
      { name: 'transTime', value: 10 },
      { name: 'delayTime', value: 10 },
      { name: 'loop', value: true },
    ],
    description: 'Colour bursts radiate outwards from a panel.',
  },
  {
    id: 'fade',
    label: 'Fade',
    uuid: 'b3fd723a-aae8-4c99-bf2b-087159e0ef53',
    pluginType: 'color',
    options: [
      { name: 'transTime', value: 40 },
      { name: 'delayTime', value: 20 },
      { name: 'loop', value: true },
    ],
    description: 'The whole layout crossfades between palette colours.',
  },
  {
    id: 'random',
    label: 'Random',
    uuid: 'ba632d3e-9c2b-4413-a965-510c839b3f71',
    pluginType: 'color',
    options: [
      { name: 'transTime', value: 20 },
      { name: 'delayTime', value: 20 },
      { name: 'loop', value: true },
    ],
    description: 'Each panel independently picks colours from the palette.',
  },
  {
    id: 'highlight',
    label: 'Highlight',
    uuid: '70b7c636-6bf8-491f-89c1-f4103508d642',
    pluginType: 'color',
    options: [
      { name: 'transTime', value: 20 },
      { name: 'delayTime', value: 20 },
      { name: 'loop', value: true },
    ],
    description: 'A base colour with occasional accent panels picked out.',
  },
];

export function motionByUuid(uuid: string): BuiltinMotion | undefined {
  return BUILTIN_MOTIONS.find((m) => m.uuid === uuid);
}

// ---------------------------------------------------------------------------
// Request builders
// ---------------------------------------------------------------------------

/**
 * Request body for `PUT /effects` that stores an effect on the device.
 *
 * `version: "2.0"` is sent by default: it is what the documented `add` example
 * uses, and the fields below (`pluginOptions`, per-colour `probability`) are the
 * 2.0 shape. An effect carrying its own `version` keeps it, so a round-tripped
 * 1.0 effect is written back exactly as it came.
 */
export function buildEffectWrite(effect: NanoleafEffect): unknown {
  // Spread rather than pick field by field.
  //
  // Real effects carry fields this model does not name — `rhythmFeatureSource`
  // turned up on hardware and appears nowhere in the documentation — and a
  // whitelist drops them silently on a round trip. Since this doubles as the
  // interchange format for moving an effect between devices, losing a field
  // means the copy renders differently from the original, with nothing to
  // indicate why.
  //
  // `loop` is deliberately not defaulted: real effects keep it inside
  // `pluginOptions`, and inventing a top-level one writes back something the
  // device never had.
  return {
    write: {
      command: 'add',
      ...effect,
      version: effect.version ?? '2.0',
      colorType: effect.colorType ?? 'HSB',
      palette: effect.palette ?? [],
    },
  };
}

/** Request body that reads back every effect stored on the device. */
export function buildRequestAllEffects(): unknown {
  return { write: { command: 'requestAll' } };
}

/** Request body that reads back one effect by name. */
export function buildRequestEffect(name: string): unknown {
  return { write: { command: 'request', animName: name } };
}

/** Request body that lists the motion plugins this device actually has. */
export function buildRequestPlugins(): unknown {
  return { write: { command: 'requestPlugins' } };
}

/** Request body that applies an already-stored effect by name. */
export function buildSelectEffect(name: string): unknown {
  return { select: name };
}

/** Request body that deletes a stored effect. */
export function buildDeleteEffect(name: string): unknown {
  return { write: { command: 'delete', animName: name } };
}

/** Request body that plays an effect for a fixed number of seconds. */
export function buildTempEffect(name: string, durationSec: number): unknown {
  return {
    write: { command: 'displayTemp', animName: name, duration: durationSec },
  };
}

// ---------------------------------------------------------------------------
// Static (per-panel) effects
// ---------------------------------------------------------------------------

/**
 * Encode panel colours as Nanoleaf's `animData` string.
 *
 *   nPanels panelId nFrames R G B W transTime  panelId nFrames R G B W transTime …
 *
 * Space-separated decimal — the same per-panel model as a streaming frame, just
 * in the format the device stores rather than the one it listens for. That
 * symmetry is the point: a scene painted live over UDP can be written to the
 * device verbatim, so "what I see" and "what gets saved" cannot drift apart.
 *
 * Unlike a streaming frame this persists: it survives Betterleaf quitting, a
 * power cycle, and shows up in the official app and HomeKit.
 */
export function encodeAnimData(panels: readonly PanelColor[]): string {
  const parts: number[] = [panels.length];
  for (const panel of panels) {
    parts.push(
      panel.panelId,
      1, // nFrames — a static effect holds one frame per panel
      clamp8(panel.r),
      clamp8(panel.g),
      clamp8(panel.b),
      clamp8(panel.w ?? 0),
      Math.max(0, Math.round(panel.transitionTime ?? 0)),
    );
  }
  return parts.join(' ');
}

function clamp8(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

export interface StaticEffectOptions {
  name: string;
  panels: readonly PanelColor[];
  /**
   * Older firmware accepts the classic form with no version field. Left off by
   * default here, unlike {@link buildEffectWrite}, because this path is already
   * proven against the hardware and there is no reason to change it.
   */
  version?: string;
}

/** Request body for `PUT /effects` that saves a per-panel scene onto the device. */
export function buildStaticEffectWrite(opts: StaticEffectOptions): unknown {
  const write: Record<string, unknown> = {
    command: 'add',
    animName: opts.name,
    animType: 'static',
    animData: encodeAnimData(opts.panels),
    loop: false,
    palette: [],
    colorType: 'HSB',
  };
  if (opts.version) write['version'] = opts.version;
  return { write };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Is this parsed JSON actually an effect?
 *
 * Effects arrive from files and, potentially, from the network, so nothing is
 * written to a device before it has been checked. The bar is deliberately the
 * minimum the device needs rather than a full schema: being stricter than the
 * firmware would reject effects that work.
 */
export function isNanoleafEffect(value: unknown): value is NanoleafEffect {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  if (typeof e['animName'] !== 'string' || e['animName'] === '') return false;
  if (
    e['animType'] !== 'plugin' &&
    e['animType'] !== 'custom' &&
    e['animType'] !== 'static'
  ) {
    return false;
  }
  // A plugin effect without a uuid names no motion and cannot render.
  if (e['animType'] === 'plugin' && typeof e['pluginUuid'] !== 'string') return false;
  // custom/static carry their pixels inline; without them there is nothing to show.
  if (e['animType'] !== 'plugin' && typeof e['animData'] !== 'string') return false;
  if (e['palette'] !== undefined && !Array.isArray(e['palette'])) return false;
  return true;
}

/**
 * Why an effect cannot be written to a given device, or undefined if it can.
 *
 * The check exists because the failure it prevents is otherwise inscrutable: a
 * plugin the device does not have comes back as a bare HTTP 400 with no
 * indication of which motion was missing or that the model is the problem.
 */
export function effectCompatibility(
  effect: NanoleafEffect,
  availablePluginUuids: readonly string[],
): string | undefined {
  if (effect.animType !== 'plugin') return undefined;
  const uuid = effect.pluginUuid;
  if (!uuid) return `"${effect.animName}" is a plugin effect but names no motion.`;
  if (availablePluginUuids.length === 0) return undefined; // device didn't say; let it try
  if (availablePluginUuids.includes(uuid)) return undefined;

  const motion = motionByUuid(uuid);
  const named = motion ? `the "${motion.label}" motion` : `motion ${uuid}`;
  return `This device does not have ${named}, which "${effect.animName}" needs.`;
}
