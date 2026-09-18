import type { DeviceInfo, PanelPosition } from '@betterleaf/protocol';
import { ShapeType } from '@betterleaf/protocol';

export type ProfileName = 'NL22' | 'NL29';

export interface Profile {
  name: ProfileName;
  info: () => DeviceInfo;
  /** Which extControl versions this fake device accepts. */
  streamVersions: ('v1' | 'v2')[];
  /** mDNS service type this vintage advertises. */
  mdnsType: 'nanoleafapi' | 'nanoleafms';
  supportsTouch: boolean;
}

/**
 * Light Panels (Aurora) layout: nine triangles plus the Rhythm module.
 *
 * The Rhythm is the interesting part. Firmware reports it in `positionData`
 * exactly like a real panel even though it has no LEDs, so any code that treats
 * `positionData` as "the panels" gets the count wrong and shifts every colour by
 * one. Keeping it here means the test suite catches that rather than the wall.
 */
function auroraPanels(): PanelPosition[] {
  const side = 150;
  const panels: PanelPosition[] = [];
  // Panel ids on a real Aurora are arbitrary small integers — and crucially all
  // fit in one byte, which is why v1's 1-byte panelId was ever viable.
  const ids = [96, 135, 172, 39, 209, 63, 118, 241, 87];
  for (let i = 0; i < ids.length; i++) {
    const col = i % 3;
    const row = Math.floor(i / 3);
    panels.push({
      panelId: ids[i]!,
      x: col * side,
      y: row * side,
      o: (i % 2) * 180,
      shapeType: ShapeType.Triangle,
    });
  }
  panels.push({
    panelId: 0,
    x: 0,
    y: -side,
    o: 0,
    shapeType: ShapeType.Rhythm,
  });
  return panels;
}

/**
 * Canvas layout: a 3x3 grid of squares, one of them the control square.
 *
 * Panel ids here deliberately exceed 255 — real Canvas ids do — which makes them
 * inexpressible in a v1 frame. That is the concrete reason the NL29 needs v2 and
 * a good thing for tests to assert.
 */
function canvasPanels(): PanelPosition[] {
  const side = 100;
  const panels: PanelPosition[] = [];
  const ids = [374, 401, 432, 118, 265, 299, 512, 548, 577];
  for (let i = 0; i < ids.length; i++) {
    panels.push({
      panelId: ids[i]!,
      x: (i % 3) * side,
      y: Math.floor(i / 3) * side,
      o: 0,
      // The control square is illuminated, unlike the Rhythm module.
      shapeType: i === 4 ? ShapeType.ControlSquareMaster : ShapeType.Square,
    });
  }
  return panels;
}

function baseInfo(
  name: string,
  model: string,
  serialNo: string,
  firmware: string,
  panels: PanelPosition[],
  sideLength: number,
): DeviceInfo {
  return {
    name,
    serialNo,
    manufacturer: 'Nanoleaf',
    firmwareVersion: firmware,
    hardwareVersion: '1.0-0',
    model,
    state: {
      on: { value: true },
      brightness: { value: 60, max: 100, min: 0 },
      hue: { value: 220, max: 360, min: 0 },
      sat: { value: 80, max: 100, min: 0 },
      ct: { value: 4000, max: 6500, min: 1200 },
      colorMode: 'effect',
    },
    effects: {
      select: 'Northern Lights',
      effectsList: [
        'Northern Lights',
        'Forest',
        'Nemo',
        'Fireworks',
        'Romantic',
        'Snowfall',
      ],
    },
    panelLayout: {
      layout: { numPanels: panels.length, sideLength, positionData: panels },
      globalOrientation: { value: 0, max: 360, min: 0 },
    },
  };
}

export const PROFILES: Record<ProfileName, Profile> = {
  NL22: {
    name: 'NL22',
    mdnsType: 'nanoleafms',
    supportsTouch: false,
    // Recent Aurora firmware accepts v2 as well, which is exactly why the
    // stream controller probes instead of trusting the model number.
    streamVersions: ['v1'],
    info: () => ({
      ...baseInfo(
        'Light Panels 57:F7:6A',
        'NL22',
        'S19112AB1234',
        '3.2.4',
        auroraPanels(),
        150,
      ),
      rhythm: {
        rhythmConnected: true,
        rhythmActive: false,
        rhythmId: 1,
        hardwareVersion: '1.2',
        firmwareVersion: '2.4.3',
        auxAvailable: false,
        rhythmMode: 0,
        rhythmPos: { x: 0, y: -150, o: 0 },
      },
    }),
  },
  NL29: {
    name: 'NL29',
    mdnsType: 'nanoleafapi',
    supportsTouch: true,
    streamVersions: ['v2'],
    info: () =>
      baseInfo('Canvas EEE0', 'NL29', 'S20233CD5678', '1.3.1', canvasPanels(), 100),
  },
};
