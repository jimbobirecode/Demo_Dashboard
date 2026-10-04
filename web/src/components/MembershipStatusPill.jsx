import { MEMBERSHIP_STATUS_COLORS, statusLabel } from '../lib/membership.js';

/** A membership status: colour plus the written status, never colour alone. */
export default function MembershipStatusPill({ status }) {
  return (
    <span className="status-pill" style={{ '--pill-color': MEMBERSHIP_STATUS_COLORS[status] }}>
      {statusLabel(status)}
    </span>
  );
}
