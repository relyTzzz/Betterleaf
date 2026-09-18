import {
  illuminatedPanels,
  ShapeType,
  type PanelLayout,
  type PanelPosition,
} from '../model/types.js';

export interface LayoutBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

export interface RenderPanel extends PanelPosition {
  /** Screen-space position: origin top-left, y increasing downward. */
  screenX: number;
  screenY: number;
  /** Nominal edge length for this shape, in the same units as the positions. */
  sideLength: number;
}

export interface RenderLayout {
  panels: RenderPanel[];
  bounds: LayoutBounds;
  sideLength: number;
}

/**
 * Side length per shape, for layouts that mix shapes.
 *
 * `panelLayout.layout.sideLength` is a single number and is reported as 0 on
 * some firmware, so it is a hint rather than a source of truth.
 */
function sideLengthFor(panel: PanelPosition, fallback: number): number {
  switch (panel.shapeType) {
    case ShapeType.ShapesMiniTriangle:
      return fallback / 2;
    default:
      return fallback;
  }
}

/**
 * Convert a device layout into something drawable.
 *
 * Two traps handled here:
 *
 *  1. **Y axis.** Nanoleaf reports positions in a maths orientation with y
 *     increasing upward; SVG and canvas both increase downward. Rendering the
 *     raw values gives a layout mirrored vertically — which looks plausible
 *     enough that it is easy to ship by accident and very confusing to use.
 *
 *  2. **Pseudo-panels.** A Rhythm module and the Shapes/Lines controllers appear
 *     in `positionData` but have no LEDs. They are dropped here so the render
 *     and the streaming frame agree on what a panel is.
 */
export function toRenderLayout(layout: PanelLayout): RenderLayout {
  const panels = illuminatedPanels(layout);
  const fallbackSide = layout.sideLength > 0 ? layout.sideLength : 100;

  if (panels.length === 0) {
    return {
      panels: [],
      bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
      sideLength: fallbackSide,
    };
  }

  const xs = panels.map((p) => p.x);
  const ys = panels.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  return {
    sideLength: fallbackSide,
    bounds: {
      minX,
      minY,
      maxX,
      maxY,
      width: maxX - minX,
      height: maxY - minY,
    },
    panels: panels.map((panel) => ({
      ...panel,
      screenX: panel.x - minX,
      // Flip: device y grows upward, screen y grows downward.
      screenY: maxY - panel.y,
      sideLength: sideLengthFor(panel, fallbackSide),
    })),
  };
}

/** The shape families a UI needs to draw. */
export type PanelShapeKind = 'triangle' | 'square';

/**
 * Classify a panel for rendering.
 *
 * Exists so a UI layer never has to know Nanoleaf's `shapeType` numbering —
 * that is protocol detail, and leaking it into a renderer means every new
 * product in the catalog touches the drawing code.
 */
export function panelShapeKind(shapeType: number | undefined): PanelShapeKind {
  switch (shapeType) {
    case ShapeType.Triangle:
    case ShapeType.ShapesTriangle:
    case ShapeType.ShapesMiniTriangle:
      return 'triangle';
    default:
      return 'square';
  }
}

/** Panel ids that can actually be addressed in a streaming frame, in layout order. */
export function streamablePanelIds(layout: PanelLayout): number[] {
  return illuminatedPanels(layout).map((p) => p.panelId);
}
