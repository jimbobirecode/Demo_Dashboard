import { leadGuestAside } from '../lib/correspondent.js';

/**
 * Who a booking is with, in one cell: the address the club writes to, and
 * underneath it the lead guest where the enquiry named one.
 *
 * The tables used to show the lead golfer's name on top and the address in
 * small print beneath, which read as "this is who you are emailing". At County
 * Louth it usually is not: the address belongs to a tour operator and the name
 * is a guest in the party who never writes to the club. So the address — the
 * one identifier that is always there, always unique, and always who a reply
 * goes to — is the line that identifies the booking, and the lead guest is
 * labelled as what it is.
 */
export default function Correspondent({ booking }) {
  const lead = leadGuestAside(booking);
  const email = booking?.guestEmail || '';

  return (
    <div>
      <div>{email || <span className="muted">No address</span>}</div>
      {lead && (
        <div className="muted" style={{ fontSize: '0.75rem' }}>
          Lead guest: {lead}
        </div>
      )}
    </div>
  );
}
