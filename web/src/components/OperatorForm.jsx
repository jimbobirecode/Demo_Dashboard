import { useEffect, useState } from 'react';
import { formatCurrency, formatDate, formatNumber } from '../lib/format.js';
import { BRAND } from '../lib/brand.js';

const BLANK = {
  name: '',
  contactName: '',
  contactEmail: '',
  contactPhone: '',
  accountCode: '',
  emailDomains: '',
  paymentTermsDays: 30,
  depositPercent: 0,
  depositDueDaysBeforePlay: '',
  balanceDueDaysBeforePlay: '',
  creditLimit: '',
  currency: BRAND.currency,
  onHold: false,
  active: true,
  autoChase: true,
  notes: '',
};

/**
 * Open or edit a trade account.
 *
 * The credit terms are the point of this form, so they get their own section
 * with the rule written underneath each field rather than in a help page: what
 * "net 30" resolves to depends on whether a lead time is also set, and somebody
 * typing the numbers in needs to see which one is going to win.
 */
export default function OperatorForm({ operator, account, onSave, onDelete, onClose, seed }) {
  const [form, setForm] = useState(BLANK);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setForm(operator ? toForm(operator) : { ...BLANK, ...(seed ?? {}) });
    setMessage(null);
    setConfirmDelete(false);
  }, [operator, seed]);

  useEffect(() => {
    const onKeyDown = (event) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const set = (field) => (event) => {
    const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
    setForm((current) => ({ ...current, [field]: value }));
  };

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await onSave(toPayload(form));
    } catch (err) {
      setMessage({ kind: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={operator ? `Edit ${operator.name}` : 'New tour operator'}>
        <div className="between">
          <div>
            <h2 style={{ margin: 0 }}>{operator ? operator.name : 'New tour operator'}</h2>
            {operator && <div className="secondary">{operator.terms}</div>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {message && <div className={`banner ${message.kind}`}>{message.text}</div>}

        {account && account.bookings > 0 && (
          <div className="card" style={{ background: 'var(--surface-0)' }}>
            <div className="label">This account today</div>
            <div className="detail-grid" style={{ marginTop: '0.5rem' }}>
              <Stat label="Bookings" value={formatNumber(account.bookings)} />
              <Stat label="Committed" value={formatCurrency(account.committedGross)} />
              <Stat label="Outstanding" value={formatCurrency(account.outstanding)} />
              <Stat label="Overdue" value={formatCurrency(account.overdueAmount)} />
              <Stat
                label="Headroom"
                value={account.headroom === null ? 'No limit' : formatCurrency(account.headroom)}
              />
              <Stat label="Next play" value={account.nextPlayDate ? formatDate(account.nextPlayDate) : '—'} />
            </div>
          </div>
        )}

        <form className="stack" onSubmit={submit}>
          <Section title="Who they are">
            <Row label="Name" hint="As it appears on their invoices.">
              <input value={form.name} onChange={set('name')} required autoFocus={!operator} />
            </Row>
            <Row label="Contact name">
              <input value={form.contactName} onChange={set('contactName')} />
            </Row>
            <Row label="Contact email" hint="Where reminders are sent. Without it this account cannot be chased.">
              <input type="email" value={form.contactEmail} onChange={set('contactEmail')} />
            </Row>
            <Row label="Phone">
              <input value={form.contactPhone} onChange={set('contactPhone')} />
            </Row>
            <Row label="Account code" hint="Their reference in the club's accounting system, if it has one.">
              <input value={form.accountCode} onChange={set('accountCode')} />
            </Row>
          </Section>

          <Section
            title="How their bookings are recognised"
            note="Any booking arriving from one of these domains is counted as this operator's, with no tagging needed. Separate several with commas."
          >
            <Row label="Sending domains" hint="e.g. golfbreaks.com, golfbreaks.ie">
              <input value={form.emailDomains} onChange={set('emailDomains')} placeholder="operator.com" />
            </Row>
          </Section>

          <Section
            title="Credit terms"
            note="A lead time wins where it is set; otherwise the invoice terms decide the due date, counted from the invoice date — or from the play date while nothing has been invoiced."
          >
            <Row label="Payment terms (days)" hint="Net days from the invoice date. 0 means payable on invoice.">
              <input type="number" min="0" max="365" value={form.paymentTermsDays} onChange={set('paymentTermsDays')} />
            </Row>
            <Row label="Deposit (%)" hint="Share of the booking total due up front. 0 means no deposit.">
              <input
                type="number"
                min="0"
                max="100"
                step="0.5"
                value={form.depositPercent}
                onChange={set('depositPercent')}
              />
            </Row>
            <Row label="Deposit due (days before play)" hint="Leave blank to use the invoice terms above.">
              <input
                type="number"
                min="0"
                max="365"
                value={form.depositDueDaysBeforePlay}
                onChange={set('depositDueDaysBeforePlay')}
              />
            </Row>
            <Row label="Balance due (days before play)" hint="Leave blank to use the invoice terms above.">
              <input
                type="number"
                min="0"
                max="365"
                value={form.balanceDueDaysBeforePlay}
                onChange={set('balanceDueDaysBeforePlay')}
              />
            </Row>
            <Row label="Credit limit" hint="Most they may owe at once. Blank means no limit is enforced.">
              <input type="number" min="0" step="100" value={form.creditLimit} onChange={set('creditLimit')} />
            </Row>
            <Row label="Currency" hint="What they are invoiced in.">
              <input value={form.currency} onChange={set('currency')} maxLength={3} style={{ width: '6rem' }} />
            </Row>
          </Section>

          <Section
            title="Chasing"
            note="What the booking lifecycle will send this account, worked out from the terms above. The confirmations and arrival details go to the guest; anything about money goes to the contact email."
          >
            <ChasingSummary form={form} />
            <label className="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={form.autoChase} onChange={set('autoChase')} />
              <span>
                Send payment reminders automatically
                <span className="secondary" style={{ display: 'block', fontSize: '0.75rem' }}>
                  Off, this account still gets the confirmations and arrival details, but is never chased for money and
                  never cancelled by the lifecycle — for an account that pays by invoice on its own cycle.
                </span>
              </span>
            </label>
          </Section>

          <Section title="Trading state">
            <label className="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={form.onHold} onChange={set('onHold')} />
              <span>On hold — take no new business until the account is settled</span>
            </label>
            <label className="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={form.active} onChange={set('active')} />
              <span>Active — a retired account keeps its history but is never chased</span>
            </label>
            <Row label="Notes">
              <textarea rows={4} value={form.notes} onChange={set('notes')} />
            </Row>
          </Section>

          <div className="row">
            <button type="submit" className="btn-primary" disabled={busy || !form.name.trim()}>
              {busy ? 'Saving…' : operator ? 'Save changes' : 'Create operator'}
            </button>
            <button type="button" onClick={onClose} disabled={busy}>
              Cancel
            </button>
          </div>
        </form>

        {operator && onDelete && (
          <>
            <div className="divider" />
            <div className="stack" style={{ gap: '0.5rem' }}>
              <span className="label" style={{ color: 'var(--status-rejected)' }}>
                Danger zone
              </span>
              <p className="secondary" style={{ margin: 0, fontSize: '0.8125rem' }}>
                An account with bookings against it is retired rather than deleted — the history and the money owed stay
                where they are.
              </p>
              {confirmDelete ? (
                <div className="row">
                  <button type="button" className="btn-danger" disabled={busy} onClick={() => onDelete(operator)}>
                    Yes, remove this account
                  </button>
                  <button type="button" onClick={() => setConfirmDelete(false)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <button type="button" className="btn-danger" onClick={() => setConfirmDelete(true)}>
                  Delete or retire account
                </button>
              )}
            </div>
          </>
        )}
      </aside>
    </>
  );
}

function Section({ title, note, children }) {
  return (
    <div className="card stack" style={{ background: 'var(--surface-0)', gap: '0.75rem' }}>
      <div>
        <div className="label">{title}</div>
        {note && (
          <p className="secondary" style={{ margin: '0.35rem 0 0', fontSize: '0.8125rem' }}>
            {note}
          </p>
        )}
      </div>
      {children}
    </div>
  );
}

function Row({ label, hint, children }) {
  return (
    <div className="stack" style={{ gap: '0.25rem' }}>
      <span className="label">{label}</span>
      {children}
      {hint && (
        <span className="secondary" style={{ fontSize: '0.75rem' }}>
          {hint}
        </span>
      )}
    </div>
  );
}

/**
 * The account's chasing schedule in one breath, so somebody typing the terms
 * in can see what they add up to before saving: "deposit chased from 2 days
 * before the 90-day mark, balance from 10 days before the 60-day mark".
 */
function ChasingSummary({ form }) {
  if (!form.active)
    return (
      <p className="secondary" style={{ margin: 0, fontSize: '0.8125rem' }}>
        A retired account is never chased.
      </p>
    );
  if (!form.autoChase)
    return (
      <p className="secondary" style={{ margin: 0, fontSize: '0.8125rem' }}>
        Payment reminders are switched off for this account.
      </p>
    );

  const deposit = Number(form.depositPercent) || 0;
  const depositDays = form.depositDueDaysBeforePlay === '' ? null : Number(form.depositDueDaysBeforePlay);
  const balanceDays = form.balanceDueDaysBeforePlay === '' ? null : Number(form.balanceDueDaysBeforePlay);
  const lines = [];

  if (deposit > 0 && depositDays != null) {
    lines.push(
      `${deposit}% deposit chased towards ${depositDays} days before play, with reminders two days and one day before and final notices after.`,
    );
  } else if (deposit > 0) {
    lines.push(
      `${deposit}% deposit chased on the club's standard window from the booking date (set a deposit due date above to chase towards a date of their own).`,
    );
  } else {
    lines.push("No deposit: the full amount is asked for on the club's standard window from the booking date.");
  }

  if (balanceDays != null) {
    lines.push(
      `Balance chased from ${balanceDays + 10} days before play (ten days ahead of their ${balanceDays}-day deadline), then 48 and 24 hours before it.`,
    );
  } else {
    lines.push("Balance chased on the club's standard lead time, set under Settings.");
  }

  if (!form.contactEmail) lines.push('No contact email: money reminders will fall back to the guest on each booking.');

  return (
    <ul className="secondary" style={{ margin: 0, paddingLeft: '1.1rem', fontSize: '0.8125rem', lineHeight: 1.5 }}>
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}

function Stat({ label, value }) {
  return (
    <div>
      <div className="label">{label}</div>
      <div style={{ fontWeight: 600 }}>{value}</div>
    </div>
  );
}

function toForm(operator) {
  return {
    name: operator.name ?? '',
    contactName: operator.contactName ?? '',
    contactEmail: operator.contactEmail ?? '',
    contactPhone: operator.contactPhone ?? '',
    accountCode: operator.accountCode ?? '',
    emailDomains: (operator.emailDomains ?? []).join(', '),
    paymentTermsDays: operator.paymentTermsDays ?? 30,
    depositPercent: operator.depositPercent ?? 0,
    depositDueDaysBeforePlay: operator.depositDueDaysBeforePlay ?? '',
    balanceDueDaysBeforePlay: operator.balanceDueDaysBeforePlay ?? '',
    creditLimit: operator.creditLimit ?? '',
    currency: operator.currency ?? BRAND.currency,
    onHold: Boolean(operator.onHold),
    autoChase: operator.autoChase !== false,
    active: operator.active !== false,
    notes: operator.notes ?? '',
  };
}

/** Numbers come off an <input> as strings; the API validates whole numbers. */
function toPayload(form) {
  return {
    ...form,
    paymentTermsDays: toInt(form.paymentTermsDays, 30),
    depositPercent: Number(form.depositPercent) || 0,
    depositDueDaysBeforePlay: form.depositDueDaysBeforePlay === '' ? null : toInt(form.depositDueDaysBeforePlay, null),
    balanceDueDaysBeforePlay: form.balanceDueDaysBeforePlay === '' ? null : toInt(form.balanceDueDaysBeforePlay, null),
    creditLimit: form.creditLimit === '' ? null : Number(form.creditLimit),
  };
}

function toInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}
