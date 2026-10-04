import { useState } from 'react';
import { formatDateTime } from '../lib/format.js';

const STATES = {
  on: {
    title: 'Accepting applications',
    guest:
      'An enquiry to the membership address gets an instant reply listing your membership categories and fees, the best fits first, with a link to the application form. Completed applications arrive here for review.',
  },
  off: {
    title: 'Closed – enquiries are offered the waitlist',
    guest:
      'An enquiry gets an instant reply saying applications are currently closed, with a link to join the waitlist. When you reopen, you can invite the waitlist to apply.',
  },
};

/**
 * The membership service switch. Administrators flip it after confirming
 * what guests will receive from then on; everyone else sees the state.
 */
export default function MembershipToggle({ enabled, canEdit, updatedBy, updatedAt, onChange }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const current = enabled ? STATES.on : STATES.off;
  const next = enabled ? STATES.off : STATES.on;

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await onChange(!enabled);
      setConfirming(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={`card stack membership-toggle${enabled ? ' is-on' : ''}`} aria-label="Membership applications">
      <div className="between" style={{ alignItems: 'flex-start', gap: '1rem', flexWrap: 'wrap' }}>
        <div className="row" style={{ gap: '1rem', alignItems: 'center' }}>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label={enabled ? 'Accepting applications' : 'Applications closed'}
            className="switch"
            disabled={!canEdit || busy}
            onClick={() => setConfirming(true)}
          >
            <span className="switch-knob" />
          </button>
          <div>
            <div className="label">{enabled ? 'On' : 'Off'}</div>
            <div className="membership-toggle-title">{current.title}</div>
          </div>
        </div>
        <div className="muted" style={{ fontSize: '0.75rem', textAlign: 'right' }}>
          {updatedBy ? `Last changed by ${updatedBy}${updatedAt ? ` · ${formatDateTime(updatedAt)}` : ''}` : null}
          {!canEdit && <div>Only an administrator can change this.</div>}
        </div>
      </div>

      <p className="secondary" style={{ margin: 0, fontSize: '0.9rem' }}>
        <strong>What guests receive now: </strong>
        {current.guest}
      </p>

      {error && <div className="banner error">{error}</div>}

      {confirming && (
        <div className="confirm-panel stack" role="alertdialog" aria-label="Confirm the change">
          <div style={{ fontWeight: 700 }}>
            {enabled ? 'Close membership applications?' : 'Start accepting applications?'}
          </div>
          <div className="secondary" style={{ fontSize: '0.875rem' }}>
            From now on: {next.guest}
          </div>
          <div className="row" style={{ gap: '0.5rem' }}>
            <button type="button" className={enabled ? 'btn-danger' : 'btn-primary'} disabled={busy} onClick={confirm}>
              {enabled ? 'Yes, close applications' : 'Yes, accept applications'}
            </button>
            <button type="button" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
