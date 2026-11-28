import { statusColor, statusTone, normaliseStatus } from '../lib/status.js';

/** Colour plus the written status — identity is never carried by colour alone. */
export default function StatusPill({ status }) {
  const label = normaliseStatus(status);
  return (
    <span className="status-pill" data-tone={statusTone(status)} style={{ '--pill-color': statusColor(status) }}>
      {label}
    </span>
  );
}
