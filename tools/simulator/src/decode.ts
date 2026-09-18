import type { PanelColor, StreamVersion } from '@betterleaf/protocol';

/**
 * Decoders for external-control frames.
 *
 * Deliberately written from the protocol description rather than by inverting
 * the encoder: an encoder checked against its own mirror image will agree with
 * itself no matter how wrong it is. These are what the simulator uses to report
 * what it actually received.
 */
export function decodeFrameV1(buf: Buffer): PanelColor[] {
  const count = buf.readUInt8(0);
  const panels: PanelColor[] = [];
  let offset = 1;
  for (let i = 0; i < count; i++) {
    const panelId = buf.readUInt8(offset);
    // offset+1 is nFrames, always 1 in a streaming frame.
    panels.push({
      panelId,
      r: buf.readUInt8(offset + 2),
      g: buf.readUInt8(offset + 3),
      b: buf.readUInt8(offset + 4),
      w: buf.readUInt8(offset + 5),
      transitionTime: buf.readUInt8(offset + 6),
    });
    offset += 7;
  }
  return panels;
}

export function decodeFrameV2(buf: Buffer): PanelColor[] {
  const count = buf.readUInt16BE(0);
  const panels: PanelColor[] = [];
  let offset = 2;
  for (let i = 0; i < count; i++) {
    panels.push({
      panelId: buf.readUInt16BE(offset),
      r: buf.readUInt8(offset + 2),
      g: buf.readUInt8(offset + 3),
      b: buf.readUInt8(offset + 4),
      w: buf.readUInt8(offset + 5),
      transitionTime: buf.readUInt16BE(offset + 6),
    });
    offset += 8;
  }
  return panels;
}

export function decodeFrame(version: StreamVersion, buf: Buffer): PanelColor[] {
  return version === 'v1' ? decodeFrameV1(buf) : decodeFrameV2(buf);
}
