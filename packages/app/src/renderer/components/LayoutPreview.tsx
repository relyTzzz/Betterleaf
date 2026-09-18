import type { DeviceView, PanelView } from '../../shared/types.js';

/**
 * Draw the wall as it actually hangs.
 *
 * Positions arrive already converted to screen space — y flipped, origin at the
 * top-left, non-illuminated pseudo-panels removed — and already classified as
 * triangles or squares. All the Nanoleaf-specific reasoning happens in the main
 * process; this file only draws.
 *
 * Triangles are drawn with their real orientation, because a Light Panels layout
 * with every triangle pointing the same way looks nothing like the thing on the
 * wall.
 */
export function LayoutPreview({ device }: { device: DeviceView }) {
  const { panels, bounds, sideLength } = device.layout;
  if (panels.length === 0) return null;

  const pad = sideLength * 0.75;
  const width = bounds.width + pad * 2;
  const height = bounds.height + pad * 2;
  const fill = device.state.on ? panelColor(device) : 'var(--bg-raised)';

  return (
    <svg
      className="layout-preview"
      viewBox={`${-pad} ${-pad} ${width} ${height}`}
      width={Math.min(360, width)}
      role="img"
      aria-label={`${panels.length} panel layout`}
    >
      {panels.map((panel) => (
        <PanelShape key={panel.panelId} panel={panel} fill={fill} />
      ))}
    </svg>
  );
}

function PanelShape({ panel, fill }: { panel: PanelView; fill: string }) {
  const common = {
    fill,
    stroke: 'var(--border)',
    strokeWidth: Math.max(1, panel.sideLength * 0.02),
  };
  const place = `translate(${panel.screenX} ${panel.screenY}) rotate(${-panel.o})`;

  if (panel.shape === 'triangle') {
    // Equilateral triangle centred on the panel position.
    const r = panel.sideLength / Math.sqrt(3);
    const points = [0, 120, 240]
      .map((deg) => {
        const rad = ((deg - 90) * Math.PI) / 180;
        return `${(Math.cos(rad) * r).toFixed(2)},${(Math.sin(rad) * r).toFixed(2)}`;
      })
      .join(' ');

    return <polygon points={points} transform={place} {...common} />;
  }

  const size = panel.sideLength * 0.92;
  return (
    <rect
      x={-size / 2}
      y={-size / 2}
      width={size}
      height={size}
      rx={size * 0.09}
      transform={place}
      {...common}
    />
  );
}

/**
 * Approximate what the wall is showing. Exact in hue/sat mode; while an effect
 * is running there is no single colour to report, so we show a neutral tone
 * rather than inventing one.
 */
function panelColor(device: DeviceView): string {
  const { colorMode, hue, sat, brightness } = device.state;
  if (colorMode === 'hs') {
    return `hsl(${hue} ${sat}% ${Math.max(18, brightness * 0.55)}%)`;
  }
  if (colorMode === 'ct') {
    return `hsl(38 ${Math.max(0, 40 - brightness * 0.15)}% ${Math.max(22, brightness * 0.6)}%)`;
  }
  return `hsl(210 12% ${Math.max(22, brightness * 0.42)}%)`;
}
