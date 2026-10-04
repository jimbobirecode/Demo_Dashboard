import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { formatCurrency, formatDate, formatDateTime } from '../lib/format.js';
import { MEMBERSHIP_ACTIONS } from '../lib/membership.js';
import MembershipStatusPill from './MembershipStatusPill.jsx';

/**
 * One application: who, what they applied for, how they came to us, what has
 * happened since, and the moves that are open from here. Each move says which
 * email the applicant will receive before it is confirmed.
 */
export default function MembershipDrawer({ applicationId, enabled, onClose, onChanged }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const [pending, setPending] = useState(null);
  const [note, setNote] = useState('');
  const [staffNote, setStaffNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.membershipApplication(applicationId));
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [applicationId]);

  useEffect(() => {
    setData(null);
    setPending(null);
    setMessage(null);
    load();
  }, [load]);

  useEffect(() => {
    const onKeyDown = (event) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  async function run(action) {
    setBusy(true);
    setMessage(null);
    try {
      const text = await action();
      setMessage({ kind: 'success', text });
      setPending(null);
      setNote('');
      await load();
      onChanged?.();
    } catch (err) {
      setMessage({ kind: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  function emailOutcome(result, label) {
    if (result.emailed) return `${label}. The applicant has been emailed.`;
    return `${label}. ${result.emailNotice ?? 'No email was sent'} — let the applicant know yourself.`;
  }

  function confirmMove(status) {
    const application = data.application;
    if (status === 'invited') {
      return run(async () => emailOutcome(await api.inviteMembershipApplicant(application.id), 'Invited to apply'));
    }
    return run(async () => {
      const result = await api.setMembershipStatus(application.id, status, note);
      const label = `Moved to ${result.application.statusLabel}`;
      return result.emailKind ? emailOutcome(result, label) : `${label}.`;
    });
  }

  const application = data?.application;

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={`Application ${application?.reference ?? ''}`}>
        <div className="between" style={{ alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontSize: '1.2rem', fontWeight: 700 }}>
              {application ? application.name || application.email : 'Application'}
            </div>
            {application && (
              <div className="secondary" style={{ fontSize: '0.8125rem' }}>
                <span className="mono">{application.reference}</span> · {application.email}
              </div>
            )}
          </div>
          <button type="button" onClick={onClose} aria-label="Close details">
            ✕
          </button>
        </div>

        {error && <div className="banner error">{error}</div>}
        {message && (
          <div className={`banner ${message.kind}`} role="status">
            {message.text}
          </div>
        )}
        {!data && !error && <div className="empty">Loading application…</div>}

        {application && (
          <>
            <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
              <MembershipStatusPill status={application.status} />
              <span className="tag">{application.kind === 'waitlist' ? 'Waitlist' : 'Application'}</span>
              {application.submittedAt && (
                <span className="muted" style={{ fontSize: '0.75rem' }}>
                  Submitted {formatDateTime(application.submittedAt)}
                </span>
              )}
            </div>

            <Actions
              application={application}
              enabled={enabled}
              emailConfigured={data.emailConfigured}
              pending={pending}
              setPending={setPending}
              note={note}
              setNote={setNote}
              busy={busy}
              onConfirm={confirmMove}
            />

            <section className="stack" style={{ gap: '0.6rem' }}>
              <h3>Applicant</h3>
              <div className="detail-grid">
                <Field label="Phone" value={application.phone} />
                <Field
                  label="Date of birth"
                  value={application.dateOfBirth ? formatDate(application.dateOfBirth) : ''}
                />
                <Field label="Handicap" value={application.handicap} />
                <Field label="Home club" value={application.homeClub} />
                <Field label="Proposer" value={application.proposer} />
                <Field label="Seconder" value={application.seconder} />
              </div>
              {application.address && <Field label="Address" value={application.address} block />}
              {application.message && <Field label="In their words" value={application.message} block />}
              <div className="muted" style={{ fontSize: '0.75rem' }}>
                {application.consent ? 'Consented to the club holding these details.' : 'No consent recorded yet.'}
              </div>
            </section>

            <section className="stack" style={{ gap: '0.6rem' }}>
              <h3>Membership</h3>
              {data.category ? (
                <CategoryLine category={data.category} label="Applied for" />
              ) : (
                <div className="muted">No category chosen yet.</div>
              )}
              {data.recommendedCategories.length > 0 && (
                <div className="stack" style={{ gap: '0.35rem' }}>
                  <span className="label">Recommended from their enquiry</span>
                  {data.recommendedCategories.map((category) => (
                    <CategoryLine key={category.id} category={category} />
                  ))}
                </div>
              )}
              {application.decisionNote && <Field label="Decision note" value={application.decisionNote} block />}
              {application.decidedBy && (
                <div className="muted" style={{ fontSize: '0.75rem' }}>
                  Decided by {application.decidedBy}
                  {application.decidedAt ? ` · ${formatDateTime(application.decidedAt)}` : ''}
                </div>
              )}
            </section>

            {(application.enquirySummary || data.sourceEmail) && (
              <section className="stack" style={{ gap: '0.6rem' }}>
                <h3>Enquiry</h3>
                {application.enquirySummary && <p style={{ margin: 0 }}>{application.enquirySummary}</p>}
                {data.sourceEmail && (
                  <details className="chart-table">
                    <summary>
                      Original email from {data.sourceEmail.fromEmail} · {formatDateTime(data.sourceEmail.createdAt)}
                    </summary>
                    {data.sourceEmail.subject && <div className="chat-subject">{data.sourceEmail.subject}</div>}
                    <div className="chat-body" style={{ whiteSpace: 'pre-wrap' }}>
                      {data.sourceEmail.body}
                    </div>
                  </details>
                )}
              </section>
            )}

            <section className="stack" style={{ gap: '0.6rem' }}>
              <h3>Timeline</h3>
              {data.events.length ? (
                <ol className="timeline">
                  <li>
                    <span className="timeline-when">{formatDateTime(application.createdAt)}</span>
                    <span>Application created</span>
                  </li>
                  {data.events.map((event) => (
                    <li key={event.id}>
                      <span className="timeline-when">{formatDateTime(event.createdAt)}</span>
                      <span>
                        <strong>{event.label}</strong> <span className="muted">· {event.actor}</span>
                        {event.note && <div className="secondary">{event.note}</div>}
                      </span>
                    </li>
                  ))}
                </ol>
              ) : (
                <div className="muted">
                  Created {formatDateTime(application.createdAt)}. Nothing has happened since.
                </div>
              )}
            </section>

            <section className="stack" style={{ gap: '0.6rem' }}>
              <h3>Staff notes</h3>
              {application.staffNotes ? (
                <div className="secondary" style={{ whiteSpace: 'pre-wrap', fontSize: '0.875rem' }}>
                  {application.staffNotes}
                </div>
              ) : (
                <div className="muted">No notes yet. Notes are for the club only — never emailed.</div>
              )}
              <form
                className="stack"
                style={{ gap: '0.5rem' }}
                onSubmit={(event) => {
                  event.preventDefault();
                  const text = staffNote.trim();
                  if (!text) return;
                  run(async () => {
                    await api.addMembershipNote(application.id, text);
                    setStaffNote('');
                    return 'Note added.';
                  });
                }}
              >
                <textarea
                  aria-label="Add a staff note"
                  rows={2}
                  maxLength={2000}
                  value={staffNote}
                  onChange={(event) => setStaffNote(event.target.value)}
                  placeholder="Called them back, proposer confirmed…"
                />
                <div>
                  <button type="submit" className="btn-sm" disabled={busy || !staffNote.trim()}>
                    Add note
                  </button>
                </div>
              </form>
            </section>
          </>
        )}
      </aside>
    </>
  );
}

function Actions({ application, enabled, emailConfigured, pending, setPending, note, setNote, busy, onConfirm }) {
  const moves = application.nextStatuses;
  if (!moves.length) {
    return (
      <div className="muted" style={{ fontSize: '0.875rem' }}>
        This application is closed — there is nothing more to do.
      </div>
    );
  }

  const action = pending ? MEMBERSHIP_ACTIONS[pending] : null;
  return (
    <div className="card stack" style={{ gap: '0.75rem', padding: '1rem' }}>
      <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
        {moves.map((status) => {
          const move = MEMBERSHIP_ACTIONS[status];
          const blocked = status === 'invited' && !enabled;
          return (
            <button
              key={status}
              type="button"
              className={`btn-sm ${move.danger ? 'btn-danger' : 'btn-primary'}`}
              aria-pressed={pending === status}
              disabled={busy || blocked}
              title={blocked ? 'Switch applications on to invite the waitlist' : undefined}
              onClick={() => {
                setPending(status);
                setNote('');
              }}
            >
              {move.label}
            </button>
          );
        })}
      </div>
      {moves.includes('invited') && !enabled && (
        <div className="muted" style={{ fontSize: '0.75rem' }}>
          Applications are closed. Switch them on to invite the waitlist to apply.
        </div>
      )}

      {action && (
        <div className="confirm-panel stack" role="alertdialog" aria-label={`Confirm: ${action.label}`}>
          <div style={{ fontWeight: 700 }}>{action.label}?</div>
          <div className="secondary" style={{ fontSize: '0.875rem' }}>
            {action.email ? (
              emailConfigured ? (
                <>
                  <strong>The applicant will receive:</strong> {action.email}
                </>
              ) : (
                <>
                  <strong>No email will be sent</strong> — email sending is not set up on this dashboard. They would
                  normally receive: {action.email}
                </>
              )
            ) : (
              'No email is sent for this.'
            )}
          </div>
          {action.note && (
            <textarea
              aria-label={action.note}
              placeholder={action.note}
              rows={2}
              maxLength={2000}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          )}
          <div className="row" style={{ gap: '0.5rem' }}>
            <button
              type="button"
              className={action.danger ? 'btn-danger' : 'btn-primary'}
              disabled={busy}
              onClick={() => onConfirm(pending)}
            >
              {busy ? 'Working…' : `Confirm: ${action.label}`}
            </button>
            <button type="button" disabled={busy} onClick={() => setPending(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function CategoryLine({ category, label }) {
  return (
    <div className="category-line">
      <div>
        {label && <div className="label">{label}</div>}
        <strong>{category.name}</strong>
        {!category.active && <span className="muted"> (retired)</span>}
        {category.eligibility && (
          <div className="muted" style={{ fontSize: '0.75rem' }}>
            {category.eligibility}
          </div>
        )}
      </div>
      <div className="num" style={{ fontSize: '0.8125rem' }}>
        <div>Joining {formatCurrency(category.joiningFee)}</div>
        <div className="muted">Annual {formatCurrency(category.annualFee)}</div>
      </div>
    </div>
  );
}

function Field({ label, value, block }) {
  return (
    <div style={block ? { whiteSpace: 'pre-wrap' } : undefined}>
      <div className="label">{label}</div>
      <div>{value || '—'}</div>
    </div>
  );
}
