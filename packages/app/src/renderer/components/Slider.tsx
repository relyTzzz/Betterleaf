import { useEffect, useRef, useState } from 'react';

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  className?: string;
  format?: (value: number) => string;
  onChange: (value: number) => void;
}

/**
 * A slider that tracks your finger, not the network.
 *
 * While dragging, the thumb is driven by local state and the device is told
 * about every move without waiting for an answer — the main process coalesces
 * those into a few requests. The incoming value is only allowed to move the
 * thumb once you let go, so a slightly-late confirmation can never yank it
 * backwards mid-drag. That snap-back is the single most irritating thing about
 * the official app's sliders.
 */
export function Slider({
  label,
  value,
  min,
  max,
  disabled,
  className,
  format,
  onChange,
}: SliderProps) {
  const [local, setLocal] = useState(value);
  const dragging = useRef(false);

  useEffect(() => {
    if (!dragging.current) setLocal(value);
  }, [value]);

  const commit = (next: number) => {
    setLocal(next);
    onChange(next);
  };

  return (
    <div className="row">
      <label>{label}</label>
      <input
        type="range"
        className={className}
        min={min}
        max={max}
        value={local}
        disabled={disabled}
        onPointerDown={() => (dragging.current = true)}
        onPointerUp={() => (dragging.current = false)}
        onPointerCancel={() => (dragging.current = false)}
        onKeyDown={() => (dragging.current = true)}
        onKeyUp={() => (dragging.current = false)}
        onChange={(e) => commit(Number(e.target.value))}
      />
      <span className="value">{format ? format(local) : local}</span>
    </div>
  );
}
