/**
 * Marks a light or room whose scene is being held against schedules.
 *
 * Drawn rather than using the Unicode padlock, for the same reason as the music
 * note: that glyph renders as a colour emoji in some font stacks, which cannot
 * be tinted and sits badly beside a name.
 *
 * The open variant is only used on the button that would lock something, so the
 * shackle tells you what pressing it does rather than only what is true now.
 */
export function LockIcon({ open, className }: { open?: boolean; className?: string }) {
  return (
    <svg
      className={className ? `lock-icon ${className}` : 'lock-icon'}
      viewBox="0 0 16 16"
      width="13"
      height="13"
      role="img"
      aria-label={open ? 'Unlocked' : 'Locked'}
      aria-hidden={className === undefined ? undefined : true}
    >
      <title>{open ? 'Not locked' : 'Locked — schedules skip this'}</title>
      <rect
        x="3.25"
        y="7"
        width="9.5"
        height="7"
        rx="1.6"
        fill="currentColor"
      />
      <path
        // Open: the shackle is swung clear to the right of the body.
        d={open ? 'M5.9 7V4.9a2.6 2.6 0 0 1 5.2 0v.7' : 'M5.9 7V4.9a2.1 2.1 0 0 1 4.2 0V7'}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
