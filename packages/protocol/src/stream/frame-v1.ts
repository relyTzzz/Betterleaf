import type { PanelColor } from '../model/types.js';

const U8_MAX = 255;

function u8(value: number, field: string): number {
  const v = Math.round(value);
  if (!Number.isFinite(v) || v < 0 || v > U8_MAX) {
    throw new RangeError(`extControl v1: ${field} must be 0–255, got ${value}`);
  }
  return v;
}

function clampChannel(value: number | undefined): number {
  return Math.max(0, Math.min(U8_MAX, Math.round(value ?? 0)));
}

/** Bytes per panel: panelId, nFrames, R, G, B, W, transTime. */
export const V1_BYTES_PER_PANEL = 7;

/**
 * Encode an external-control **v1** frame — the original Light Panels (NL22)
 * protocol, sent to UDP 60221.
 *
 *   u8 nPanels
 *   per panel: u8 panelId, u8 nFrames, u8 R, u8 G, u8 B, u8 W, u8 transTime
 *
 * Every field is a single byte, which is the whole reason v2 exists: panel IDs
 * above 255 and panel counts above 255 simply cannot be expressed. We throw
 * rather than truncate, because a truncated panel ID silently lights the wrong
 * panel and that is far harder to debug than an exception.
 *
 * `nFrames` is always 1: streaming means one frame per datagram, with motion
 * coming from the datagram rate rather than from multi-frame packets.
 *
 * transitionTime is in units of 100 ms.
 */
export function encodeFrameV1(panels: readonly PanelColor[]): Buffer {
  if (panels.length > U8_MAX) {
    throw new RangeError(
      `extControl v1 supports at most 255 panels per frame, got ${panels.length}`,
    );
  }

  const buf = Buffer.allocUnsafe(1 + panels.length * V1_BYTES_PER_PANEL);
  let offset = 0;

  buf.writeUInt8(panels.length, offset++);

  for (const panel of panels) {
    buf.writeUInt8(u8(panel.panelId, 'panelId'), offset++);
    buf.writeUInt8(1, offset++); // nFrames
    buf.writeUInt8(clampChannel(panel.r), offset++);
    buf.writeUInt8(clampChannel(panel.g), offset++);
    buf.writeUInt8(clampChannel(panel.b), offset++);
    buf.writeUInt8(clampChannel(panel.w), offset++);
    buf.writeUInt8(u8(panel.transitionTime ?? 0, 'transitionTime'), offset++);
  }

  return buf;
}
