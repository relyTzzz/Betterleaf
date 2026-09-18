import type { PanelColor } from '../model/types.js';

const U8_MAX = 255;
const U16_MAX = 65_535;

function u16(value: number, field: string): number {
  const v = Math.round(value);
  if (!Number.isFinite(v) || v < 0 || v > U16_MAX) {
    throw new RangeError(`extControl v2: ${field} must be 0–65535, got ${value}`);
  }
  return v;
}

function clampChannel(value: number | undefined): number {
  return Math.max(0, Math.min(U8_MAX, Math.round(value ?? 0)));
}

/** Bytes per panel: panelId(2), R, G, B, W, transTime(2). */
export const V2_BYTES_PER_PANEL = 8;

/**
 * Encode an external-control **v2** frame — Canvas (NL29), Shapes, Lines and
 * recent Light Panels firmware, sent to UDP 60222.
 *
 *   u16be nPanels
 *   per panel: u16be panelId, u8 R, u8 G, u8 B, u8 W, u16be transTime
 *
 * v2 widened nPanels, panelId and transTime from one byte to two (big-endian)
 * and dropped v1's `nFrames` byte, which was always 1 anyway. Panel IDs on a
 * Canvas routinely exceed 255, so v1 cannot address them at all.
 *
 * transitionTime is in units of 100 ms; 0 snaps instantly.
 */
export function encodeFrameV2(panels: readonly PanelColor[]): Buffer {
  if (panels.length > U16_MAX) {
    throw new RangeError(
      `extControl v2 supports at most 65535 panels per frame, got ${panels.length}`,
    );
  }

  const buf = Buffer.allocUnsafe(2 + panels.length * V2_BYTES_PER_PANEL);
  let offset = 0;

  buf.writeUInt16BE(panels.length, offset);
  offset += 2;

  for (const panel of panels) {
    buf.writeUInt16BE(u16(panel.panelId, 'panelId'), offset);
    offset += 2;
    buf.writeUInt8(clampChannel(panel.r), offset++);
    buf.writeUInt8(clampChannel(panel.g), offset++);
    buf.writeUInt8(clampChannel(panel.b), offset++);
    buf.writeUInt8(clampChannel(panel.w), offset++);
    buf.writeUInt16BE(u16(panel.transitionTime ?? 0, 'transitionTime'), offset);
    offset += 2;
  }

  return buf;
}
