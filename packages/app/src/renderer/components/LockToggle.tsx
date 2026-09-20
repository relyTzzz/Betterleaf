import { LockIcon } from './LockIcon.js';

/**
 * Holds the current scene against the scheduler.
 *
 * Says "Lock" when it would lock and "Locked" when it has, rather than naming
 * the action it performs in both states — a button labelled "Unlock" next to
 * lights that are not locked is the classic way to make a toggle unreadable.
 */
export function LockToggle({
  locked,
  what,
  onToggle,
}: {
  locked: boolean;
  /** What is being held, for the tooltip: a scene name, or "this light". */
  what: string;
  onToggle: () => void;
}) {
  return (
    <button
      className={`lock-toggle${locked ? ' on' : ''}`}
      aria-pressed={locked}
      title={
        locked
          ? 'Unlock, so schedules can change this again'
          : `Lock ${what} so schedules leave it alone`
      }
      onClick={onToggle}
    >
      <LockIcon open={!locked} />
      <span>{locked ? 'Locked' : 'Lock'}</span>
    </button>
  );
}

/** The line that explains what the lock is currently doing. */
export function LockNote({ subject }: { subject: string }) {
  return (
    <p className="lock-note">
      Schedules will skip {subject} until you unlock it. Changing the scene here
      still works.
    </p>
  );
}
