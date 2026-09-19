/**
 * Marks a sound-reactive scene.
 *
 * Drawn rather than using the Unicode note: that glyph renders as a colour emoji
 * in some font stacks, which sits badly beside a scene name and cannot be tinted
 * to match the rest of the UI.
 */
export function MusicNote({ className }: { className?: string }) {
  return (
    <svg
      className={className ? `music-note ${className}` : 'music-note'}
      viewBox="0 0 16 16"
      width="13"
      height="13"
      role="img"
      aria-label="Sound reactive"
    >
      <title>Sound reactive — responds to music</title>
      <path
        d="M6 12.5V4.2l7-1.7v8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <ellipse cx="4.2" cy="12.4" rx="2.2" ry="1.8" fill="currentColor" />
      <ellipse cx="11.2" cy="10.6" rx="2.2" ry="1.8" fill="currentColor" />
    </svg>
  );
}
