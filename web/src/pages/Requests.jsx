import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { formatDate, formatDateTime, formatNumber } from '../lib/format.js';

/**
 * What guests have asked for, and the club's answer.
 *
 * Approving a cancellation cancels the booking. Approving an *amendment* does
 * not rewrite the tee sheet — what the guest asked for may not be free, and
 * choosing a slot is the club's job — so it marks the request answered and
 * says the booking still needs editing.
 */
export default function Requests() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [showAll, setShowAll] = useState(false);

  async function load() {
    try {
      setData(await api.changeRequests());
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function resolve(request, decision) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.resolveChangeRequest(request.id, decision, '');
      const told = result.guestEmailed
        ? ` The guest has been emailed${result.guestEmail ? ` at ${result.guestEmail}` : ''}.`
        : ' No email went to the guest (email sending is not set up, or the booking has no address) - let them know yourself.';
      setNotice(
        (result.bookingCancelled
          ? `${request.bookingId} cancelled.`
          : result.needsEditing
            ? `Request approved - now edit ${request.bookingId} on the Bookings page to make the change.`
            : `Request ${decision}d.`) + told,
      );
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <div className="empty">{error ?? 'Loading requests…'}</div>;
  const open = data.requests.filter((request) => request.open);
  const shown = showAll ? data.requests : open;

  return (
    <div className="stack">
      <header className="between">
        <div>
          <h1>Guest requests</h1>
          <p className="muted" style={{ margin: '0.25rem 0 0' }}>
            Guests can only ask. Nothing is cancelled or changed until you approve it, and the guest is emailed either
            way.
          </p>
        </div>
        <button type="button" className="btn-sm" onClick={() => setShowAll(!showAll)}>
          {showAll ? `Show only open (${open.length})` : 'Show everything'}
        </button>
      </header>

      {error && <div className="banner error">{error}</div>}
      {notice && <div className="banner success">{notice}</div>}

      {!shown.length ? (
        <div className="empty">No guest requests{showAll ? '' : ' waiting'}.</div>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Booking</th>
                <th>Guest</th>
                <th>Asked</th>
                <th>What they want</th>
                <th className="num">Days to play</th>
                <th>State</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((request) => (
                <tr key={request.id} style={{ opacity: request.open ? 1 : 0.6 }}>
                  <td>
                    <div className="mono">{request.bookingId}</div>
                    <div className="muted" style={{ fontSize: '0.75rem' }}>
                      {request.playDate ? formatDate(request.playDate) : '—'}
                      {request.teeTime ? ` · ${request.teeTime}` : ''}
                    </div>
                  </td>
                  <td>
                    <div>{request.guestName || '—'}</div>
                    <div className="muted" style={{ fontSize: '0.75rem' }}>
                      {request.guestEmail}
                    </div>
                  </td>
                  <td>{formatDateTime(request.createdAt)}</td>
                  <td>
                    <strong>{request.kind === 'cancel' ? 'Cancel' : 'Amend'}</strong>
                    {request.source === 'email' && (
                      <span className="muted" style={{ fontSize: '0.75rem' }}>
                        {' '}
                        · read from an email
                      </span>
                    )}
                    {request.requestedDate && (
                      <div style={{ fontSize: '0.8125rem' }}>
                        Move to {formatDate(request.requestedDate)}
                        {request.requestedTime ? `, ${request.requestedTime}` : ''}
                        {request.requestedPlayers ? `, ${request.requestedPlayers} players` : ''}
                      </div>
                    )}
                    {request.message && (
                      <div className="muted" style={{ fontSize: '0.8125rem', whiteSpace: 'pre-line' }}>
                        “{request.message.length > 400 ? `${request.message.slice(0, 400)}…` : request.message}”
                      </div>
                    )}
                  </td>
                  <td className="num">
                    {request.daysBeforePlay === null ? '—' : formatNumber(request.daysBeforePlay)}
                  </td>
                  <td>
                    {request.status}
                    {request.autoApplied && (
                      <div className="muted" style={{ fontSize: '0.75rem' }}>
                        Applied automatically (old setting)
                      </div>
                    )}
                    {request.resolvedBy && (
                      <div className="muted" style={{ fontSize: '0.75rem' }}>
                        {request.resolvedBy}
                      </div>
                    )}
                  </td>
                  <td className="num">
                    {request.open && (
                      <div className="row" style={{ justifyContent: 'flex-end', gap: '0.4rem' }}>
                        <button
                          type="button"
                          className="btn-sm"
                          disabled={busy}
                          onClick={() => resolve(request, 'approve')}
                        >
                          {request.kind === 'cancel' ? 'Cancel the booking' : 'Approve'}
                        </button>
                        <button
                          type="button"
                          className="btn-sm btn-danger"
                          disabled={busy}
                          onClick={() => resolve(request, 'decline')}
                        >
                          Decline
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
