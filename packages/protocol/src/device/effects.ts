import type { PanelColor } from '../model/types.js';

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
   * Some firmware wants an explicit `"version": "2.0"` on effect writes. Left
   * off by default because the classic form is accepted more widely; flip it on
   * if a device rejects the write.
   *
   * TODO(hardware): confirm which form the NL22 and NL29 actually need.
   */
  version?: string;
}

/** Request body for `PUT /effects` that saves a scene onto the device. */
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
