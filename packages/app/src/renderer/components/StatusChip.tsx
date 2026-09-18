import type { ConnectionStatus } from '@betterleaf/protocol';

/**
 * Four states, each of them true and each of them actionable. There is
 * deliberately no indefinite spinner: if we do not know, we say which kind of
 * not-knowing it is.
 */
const LABELS: Record<ConnectionStatus, string> = {
  connected: 'Connected',
  reconnecting: 'Reconnecting',
  unreachable: 'Unreachable',
  'needs-pairing': 'Needs pairing',
};

export function StatusChip({ status }: { status: ConnectionStatus }) {
  return (
    <span className={`chip ${status}`}>
      <span className="dot" />
      {LABELS[status]}
    </span>
  );
}
