import { describe, expect, it } from 'vitest';
import { streamablePanelIds, toRenderLayout } from '../src/device/layout.js';
import { illuminatedPanels, ShapeType, type PanelLayout } from '../src/model/types.js';
import { PROFILES } from '../../../tools/simulator/src/profiles.js';

const auroraLayout = (): PanelLayout =>
  PROFILES.NL22.info().panelLayout.layout;
const canvasLayout = (): PanelLayout =>
  PROFILES.NL29.info().panelLayout.layout;

describe('panel filtering', () => {
  it('drops the Rhythm module from an Aurora layout', () => {
    const layout = auroraLayout();
    // The firmware reports the Rhythm alongside real panels...
    expect(layout.positionData).toHaveLength(10);
    expect(
      layout.positionData.some((p) => p.shapeType === ShapeType.Rhythm),
    ).toBe(true);

    // ...but it has no LEDs, so it must not occupy a slot in a frame.
    const lit = illuminatedPanels(layout);
    expect(lit).toHaveLength(9);
    expect(lit.some((p) => p.shapeType === ShapeType.Rhythm)).toBe(false);
  });

  it('keeps the Canvas control square, which does light up', () => {
    const layout = canvasLayout();
    expect(
      layout.positionData.some(
        (p) => p.shapeType === ShapeType.ControlSquareMaster,
      ),
    ).toBe(true);
    // All nine squares are addressable, control square included.
    expect(illuminatedPanels(layout)).toHaveLength(9);
  });

  it('streamable ids match the illuminated panels exactly', () => {
    const ids = streamablePanelIds(auroraLayout());
    expect(ids).toHaveLength(9);
    // panelId 0 is the Rhythm in this layout and must not be addressed.
    expect(ids).not.toContain(0);
  });

  it('treats panels with no shapeType as illuminated', () => {
    // Very old firmware omits shapeType; assuming "not a panel" would blank the
    // whole device, so the safe default is to include it.
    const layout: PanelLayout = {
      numPanels: 1,
      sideLength: 100,
      positionData: [{ panelId: 42, x: 0, y: 0, o: 0 }],
    };
    expect(illuminatedPanels(layout)).toHaveLength(1);
  });
});

describe('toRenderLayout', () => {
  it('flips the y axis for screen coordinates', () => {
    // Nanoleaf y grows upward, screen y grows downward. Rendering the raw
    // values gives a vertically mirrored wall — plausible enough to ship by
    // accident, baffling to use.
    const layout: PanelLayout = {
      numPanels: 2,
      sideLength: 100,
      positionData: [
        { panelId: 1, x: 0, y: 0, o: 0, shapeType: ShapeType.Square },
        { panelId: 2, x: 0, y: 100, o: 0, shapeType: ShapeType.Square },
      ],
    };

    const render = toRenderLayout(layout);
    const top = render.panels.find((p) => p.panelId === 2)!;
    const bottom = render.panels.find((p) => p.panelId === 1)!;

    // Panel 2 is physically higher, so on screen it must be nearer the top.
    expect(top.screenY).toBeLessThan(bottom.screenY);
    expect(top.screenY).toBe(0);
    expect(bottom.screenY).toBe(100);
  });

  it('normalises the origin to the top-left of the bounding box', () => {
    const layout: PanelLayout = {
      numPanels: 2,
      sideLength: 100,
      positionData: [
        { panelId: 1, x: -250, y: -80, o: 0, shapeType: ShapeType.Square },
        { panelId: 2, x: -150, y: 20, o: 0, shapeType: ShapeType.Square },
      ],
    };

    const render = toRenderLayout(layout);
    expect(Math.min(...render.panels.map((p) => p.screenX))).toBe(0);
    expect(Math.min(...render.panels.map((p) => p.screenY))).toBe(0);
    expect(render.bounds.width).toBe(100);
    expect(render.bounds.height).toBe(100);
  });

  it('excludes pseudo-panels from the bounding box', () => {
    // The Rhythm in the fixture sits above every real panel. If it leaked into
    // the bounds the render would have a blank strip at the top.
    const render = toRenderLayout(auroraLayout());
    expect(render.panels).toHaveLength(9);
    expect(render.bounds.height).toBe(300);
  });

  it('survives a layout with no illuminated panels', () => {
    const render = toRenderLayout({
      numPanels: 1,
      sideLength: 0,
      positionData: [{ panelId: 0, x: 0, y: 0, o: 0, shapeType: ShapeType.Rhythm }],
    });
    expect(render.panels).toEqual([]);
    expect(render.bounds.width).toBe(0);
  });

  it('falls back to a usable side length when the device reports 0', () => {
    const render = toRenderLayout({
      numPanels: 1,
      sideLength: 0,
      positionData: [{ panelId: 1, x: 0, y: 0, o: 0, shapeType: ShapeType.Square }],
    });
    expect(render.sideLength).toBeGreaterThan(0);
  });
});
