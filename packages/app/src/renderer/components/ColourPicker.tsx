import { colourCss, colourName } from '../schedule-format.js';
import { Slider } from './Slider.js';

type Colour = { hue: number; saturation: number };

/**
 * Starting points, so the common case is one click.
 *
 * Hues are the device's 0–360. Saturation backs off for purple and pink,
 * which panels render garishly at full strength.
 */
const PRESETS: { label: string; colour: Colour }[] = [
  { label: 'Red', colour: { hue: 0, saturation: 100 } },
  { label: 'Orange', colour: { hue: 25, saturation: 100 } },
  { label: 'Amber', colour: { hue: 40, saturation: 100 } },
  { label: 'Yellow', colour: { hue: 55, saturation: 100 } },
  { label: 'Green', colour: { hue: 130, saturation: 75 } },
  { label: 'Teal', colour: { hue: 175, saturation: 85 } },
  { label: 'Blue', colour: { hue: 220, saturation: 90 } },
  { label: 'Purple', colour: { hue: 275, saturation: 80 } },
  { label: 'Pink', colour: { hue: 320, saturation: 70 } },
  { label: 'White', colour: { hue: 0, saturation: 0 } },
];

/** A solid colour for an action: presets, then hue and saturation to taste. */
export function ColourPicker({
  value,
  disabled,
  onChange,
}: {
  value: Colour;
  disabled?: boolean;
  onChange: (value: Colour) => void;
}) {
  return (
    <div className="colour-picker">
      <div className="colour-presets">
        {PRESETS.map((preset) => {
          const on =
            preset.colour.hue === value.hue && preset.colour.saturation === value.saturation;
          return (
            <button
              key={preset.label}
              type="button"
              className={`colour-preset${on ? ' on' : ''}`}
              title={preset.label}
              aria-label={preset.label}
              disabled={disabled}
              style={{ background: colourCss(preset.colour) }}
              onClick={() => onChange(preset.colour)}
            />
          );
        })}
        <span className="colour-current">
          <span className="swatch" style={{ background: colourCss(value) }} />
          {colourName(value)}
        </span>
      </div>
      <Slider
        label="Hue"
        className="hue"
        min={0}
        max={360}
        value={value.hue}
        disabled={disabled}
        format={(v) => `${v}°`}
        onChange={(hue) => onChange({ ...value, hue })}
      />
      <Slider
        label="Saturation"
        min={0}
        max={100}
        value={value.saturation}
        disabled={disabled}
        format={(v) => `${v}%`}
        onChange={(saturation) => onChange({ ...value, saturation })}
      />
    </div>
  );
}
