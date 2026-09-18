import { describe, expect, it } from 'vitest';
import { encodeFrameV1 } from '../src/stream/frame-v1.js';
import { encodeFrameV2 } from '../src/stream/frame-v2.js';
import { decodeFrameV1, decodeFrameV2 } from '../../../tools/simulator/src/decode.js';
import type { PanelColor } from '../src/model/types.js';

describe('extControl v1 frames (Light Panels / NL22)', () => {
  it('matches the example packet from the Nanoleaf documentation', () => {
    // Documented as: 3 123 1 255 0 0 0 9 223 1 0 255 0 0 24 67 1 0 0 255 0 32
    //   nPanels=3
    //   panel 123: nFrames=1, red,   transTime=9
    //   panel 223: nFrames=1, green, transTime=24
    //   panel 67:  nFrames=1, blue,  transTime=32
    const panels: PanelColor[] = [
      { panelId: 123, r: 255, g: 0, b: 0, w: 0, transitionTime: 9 },
      { panelId: 223, r: 0, g: 255, b: 0, w: 0, transitionTime: 24 },
      { panelId: 67, r: 0, g: 0, b: 255, w: 0, transitionTime: 32 },
    ];

    expect([...encodeFrameV1(panels)]).toEqual([
      3, 123, 1, 255, 0, 0, 0, 9, 223, 1, 0, 255, 0, 0, 24, 67, 1, 0, 0, 255, 0, 32,
    ]);
  });

  it('is 1 + 7n bytes long', () => {
    const panels = Array.from({ length: 9 }, (_, i) => ({
      panelId: i + 1,
      r: 1,
      g: 2,
      b: 3,
    }));
    expect(encodeFrameV1(panels).length).toBe(1 + 9 * 7);
  });

  it('always writes nFrames = 1', () => {
    const frame = encodeFrameV1([{ panelId: 5, r: 0, g: 0, b: 0 }]);
    expect(frame[2]).toBe(1);
  });

  it('rejects a panel id that will not fit in one byte', () => {
    // This is the concrete reason a Canvas cannot use v1: its ids exceed 255.
    // Truncating would silently light the wrong panel, so we throw instead.
    expect(() => encodeFrameV1([{ panelId: 374, r: 0, g: 0, b: 0 }])).toThrow(
      /panelId must be 0–255/,
    );
  });

  it('rejects more than 255 panels', () => {
    const panels = Array.from({ length: 256 }, (_, i) => ({
      panelId: i % 255,
      r: 0,
      g: 0,
      b: 0,
    }));
    expect(() => encodeFrameV1(panels)).toThrow(/at most 255 panels/);
  });

  it('clamps out-of-range colour channels rather than wrapping', () => {
    const frame = encodeFrameV1([{ panelId: 1, r: 300, g: -20, b: 128 }]);
    const [panel] = decodeFrameV1(frame);
    expect(panel).toMatchObject({ r: 255, g: 0, b: 128 });
  });

  it('round-trips through an independent decoder', () => {
    const panels: PanelColor[] = [
      { panelId: 96, r: 10, g: 20, b: 30, w: 40, transitionTime: 5 },
      { panelId: 135, r: 200, g: 100, b: 50, w: 0, transitionTime: 0 },
    ];
    expect(decodeFrameV1(encodeFrameV1(panels))).toEqual(panels);
  });
});

describe('extControl v2 frames (Canvas / NL29)', () => {
  it('matches the example packet from the Nanoleaf documentation', () => {
    // Documented prefix: 0x00 0x03 0x01 0x76 0xFF 0x00 0xFF 0x00 0x00 0x0C
    //   nPanels  = 0x0003 = 3          (big-endian u16)
    //   panelId  = 0x0176 = 374        (big-endian u16)
    //   RGBW     = FF 00 FF 00         (magenta)
    //   transTime= 0x000C = 12         (big-endian u16, = 1.2s)
    const frame = encodeFrameV2([
      { panelId: 374, r: 255, g: 0, b: 255, w: 0, transitionTime: 12 },
      { panelId: 401, r: 0, g: 0, b: 0, w: 0, transitionTime: 0 },
      { panelId: 432, r: 0, g: 0, b: 0, w: 0, transitionTime: 0 },
    ]);

    expect([...frame.subarray(0, 10)]).toEqual([
      0x00, 0x03, 0x01, 0x76, 0xff, 0x00, 0xff, 0x00, 0x00, 0x0c,
    ]);
  });

  it('is 2 + 8n bytes long', () => {
    const panels = Array.from({ length: 9 }, (_, i) => ({
      panelId: 300 + i,
      r: 1,
      g: 2,
      b: 3,
    }));
    expect(encodeFrameV2(panels).length).toBe(2 + 9 * 8);
  });

  it('uses big-endian for every multi-byte field', () => {
    const frame = encodeFrameV2([
      { panelId: 0x0102, r: 0, g: 0, b: 0, w: 0, transitionTime: 0x0304 },
    ]);
    // panelId high byte first, then transTime high byte first.
    expect([frame[0], frame[1]]).toEqual([0x00, 0x01]); // nPanels = 1
    expect([frame[2], frame[3]]).toEqual([0x01, 0x02]);
    expect([frame[8], frame[9]]).toEqual([0x03, 0x04]);
  });

  it('carries panel ids above 255, which v1 cannot', () => {
    const panels: PanelColor[] = [{ panelId: 577, r: 1, g: 2, b: 3, w: 4, transitionTime: 1 }];
    expect(decodeFrameV2(encodeFrameV2(panels))).toEqual(panels);
    expect(() => encodeFrameV1(panels)).toThrow();
  });

  it('has no nFrames byte, unlike v1', () => {
    // v1 spends a byte per panel on a constant. The 8-byte v2 panel record is
    // panelId(2) + RGBW(4) + transTime(2) with nothing left over.
    const one = encodeFrameV2([{ panelId: 1, r: 0, g: 0, b: 0 }]);
    expect(one.length).toBe(2 + 8);
  });

  it('round-trips through an independent decoder', () => {
    const panels: PanelColor[] = [
      { panelId: 374, r: 255, g: 128, b: 64, w: 0, transitionTime: 3 },
      { panelId: 65535, r: 0, g: 0, b: 0, w: 255, transitionTime: 65535 },
    ];
    expect(decodeFrameV2(encodeFrameV2(panels))).toEqual(panels);
  });

  it('defaults the white channel and transition time to 0', () => {
    const [panel] = decodeFrameV2(encodeFrameV2([{ panelId: 7, r: 1, g: 2, b: 3 }]));
    expect(panel).toEqual({
      panelId: 7,
      r: 1,
      g: 2,
      b: 3,
      w: 0,
      transitionTime: 0,
    });
  });
});
