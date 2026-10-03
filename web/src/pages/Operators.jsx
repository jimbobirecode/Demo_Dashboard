import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { formatCurrency, formatDate, formatNumber } from '../lib/format.js';
import { OVERDUE } from '../lib/palette.js';
import KpiTile from '../components/KpiTile.jsx';
import OperatorForm from '../components/OperatorForm.jsx';
import StatusPill from '../components/StatusPill.jsx';
import PaymentPill from '../components/PaymentPill.jsx';
import { describeDue } from '../lib/payments.js';

/**
 * Tour operators: the trade book.
 *
 * Three questions, in the order somebody actually asks them. Who do we trade
 * with and on what terms; who owes us what, and how old is it; and who are we
 * clearly trading with but have never set up as an account.
 *
 * That last one is the point of the Unrecognised tab. The club does not have to
 * remember its operators — the repeat business names them, and an account is
 * opened from the suggestion with the domain already filled in.
 */
export default function Operators() {
  const [data, setData] = useState(null);
  const [suggestions, setSuggestions] = useState(null);
  const [tab, setTab] = useState('accounts');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [editing, setEditing] = useState(null); // { operator } | { seed } | null
  const [openId, setOpenId] = useState(null);
  const [statement, setStatement] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const payload = await api.operators();
      setData(payload);
      setError(null);
      // Suggestions need the same full scan, so they are fetched alongside
      // rather than only when the tab is opened — the count belongs on the tab.
      setSuggestions(await api.operatorSuggestions());
    } catch (err) {
      setError(err.message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (openId === null) return setStatement(null);
    let live = true;
    api
      .operator(openId)
      .then((payload) => live && setStatement(payload))
      .catch((err) => live && setNotice({ kind: 'error', text: err.message }));
    return () => {
      live = false;
    };
  }, [openId]);

  const operators = useMemo(() => data?.operators ?? [], [data]);
  const totals = data?.totals;
  const bands = data?.ageingBands ?? [];

  const worstFirst = useMemo(
    () =>
      [...operators].sort(
        (a, b) =>
          b.account.overdueAmount - a.account.overdueAmount ||
          b.account.outstanding - a.account.outstanding ||
          a.name.localeCompare(b.name),
      ),
    [operators],
  );

  async function save(payload) {
    const existing = editing?.operator;
    const { operator } = existing
      ? await api.updateOperator(existing.id, payload)
      : await api.createOperator(payload);

    setEditing(null);
    setNotice({
      kind: 'success',
      text: existing ? `${operator.name} updated.` : `${operator.name} added as a trade account.`,
    });
    await load();
  }

  async function remove(operator) {
    try {
      const result = await api.deleteOperator(operator.id);
      setEditing(null);
      setNotice({
        kind: 'success',
        text: result.message ?? `${operator.name} deleted.`,
      });
      await load();
    } catch (err) {
      setNotice({ kind: 'error', text: err.message });
    }
  }

  async function assign(bookingIds, operatorId, label) {
    try {
      const { updated } = await api.assignOperator(bookingIds, operatorId);
      setNotice({ kind: 'success', text: `${updated} booking(s) moved to ${label}.` });
      await load();
    } catch (err) {
      setNotice({ kind: 'error', text: err.message });
    }
  }

  return (
    <div className="stack">
      <div className="between">
        <div>
          <h1>Tour Operators</h1>
          <p className="muted" style={{ margin: '0.25rem 0 0' }}>
            Trade accounts, their credit terms and what they owe
            {data?.today && ` · as at ${formatDate(data.today)}`}
          </p>
        </div>
        <div className="row">
          <button type="button" className="btn-primary" onClick={() => setEditing({ seed: {} })}>
            New operator
          </button>
          <button type="button" onClick={load} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && <div className="banner error">{error}</div>}
      {notice && <div className={`banner ${notice.kind}`}>{notice.text}</div>}

      {totals && (
        <div className="kpi-row">
          <KpiTile
            label="Trade accounts"
            value={formatNumber(totals.operators)}
            sub={`${formatNumber(totals.bookings)} booking(s) on account`}
            accent="var(--brand-gold)"
          />
          <KpiTile
            label="Outstanding"
            value={formatCurrency(totals.outstanding)}
            sub="Committed bookings not yet paid"
            accent="var(--north-sea)"
          />
          <KpiTile
            label="Overdue"
            value={formatCurrency(totals.overdueAmount)}
            sub={`${formatNumber(totals.overdueCount)} booking(s) past their due date`}
            accent={totals.overdueAmount > 0 ? OVERDUE : 'var(--links-green)'}
          />
          <KpiTile
            label="Awaiting confirmation"
            value={formatNumber(totals.unconfirmed)}
            sub="Operator bookings still open"
            accent="var(--links-green)"
          />
          <KpiTile
            label="Accounts to watch"
            value={formatNumber(totals.overLimit + totals.onHold)}
            sub={`${totals.overLimit} over limit · ${totals.onHold} on hold`}
            accent={totals.overLimit + totals.onHold > 0 ? OVERDUE : 'var(--muted, #8a8a8a)'}
          />
        </div>
      )}

      <div className="segmented" role="group" aria-label="View">
        <button type="button" aria-pressed={tab === 'accounts'} onClick={() => setTab('accounts')}>
          Accounts ({operators.length})
        </button>
        <button type="button" aria-pressed={tab === 'ageing'} onClick={() => setTab('ageing')}>
          Debtor ageing
        </button>
        <button type="button" aria-pressed={tab === 'unmatched'} onClick={() => setTab('unmatched')}>
          Unrecognised ({(suggestions?.suggestions?.length ?? 0) + (suggestions?.needsConfirming?.length ?? 0)})
        </button>
      </div>

      {loading && !data && <div className="empty">Loading…</div>}

      {tab === 'accounts' && data && (
        <AccountsTable
          operators={worstFirst}
          direct={data.direct}
          onEdit={(operator) => setEditing({ operator })}
          onOpen={setOpenId}
        />
      )}

      {tab === 'ageing' && data && <AgeingTable operators={worstFirst} bands={bands} totals={totals} />}

      {tab === 'unmatched' && (
        <Unrecognised
          suggestions={suggestions}
          operators={operators}
          onOpenAccount={(seed) => setEditing({ seed })}
          onAssign={assign}
        />
      )}

      {editing && (
        <OperatorForm
          operator={editing.operator}
          account={editing.operator?.account}
          seed={editing.seed}
          onSave={save}
          onDelete={editing.operator ? remove : undefined}
          onClose={() => setEditing(null)}
        />
      )}

      {statement && (
        <Statement statement={statement} onClose={() => setOpenId(null)} />
      )}
    </div>
  );
}

function AccountsTable({ operators, direct, onEdit, onOpen }) {
  if (!operators.length) {
    return (
      <div className="empty">
        No trade accounts yet. Open the Unrecognised tab — the domains the club already books with
        are listed there, ready to become accounts.
      </div>
    );
  }

  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>Operator</th>
            <th>Credit terms</th>
            <th className="num">Bookings</th>
            <th className="num">Committed</th>
            <th className="num">Outstanding</th>
            <th className="num">Overdue</th>
            <th>Credit limit</th>
            <th>State</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {operators.map((operator) => {
            const account = operator.account;
            return (
              <tr key={operator.id} style={{ cursor: 'pointer' }} onClick={() => onOpen(operator.id)}>
                <td>
                  <div style={{ fontWeight: 600 }}>{operator.name}</div>
                  <div className="muted" style={{ fontSize: '0.75rem' }}>
                    {operator.contactEmail || 'No contact email'}
                    {operator.emailDomains.length ? ` · ${operator.emailDomains.join(', ')}` : ''}
                  </div>
                </td>
                <td className="secondary" style={{ fontSize: '0.8125rem' }}>
                  {operator.terms}
                </td>
                <td className="num">{formatNumber(account.bookings)}</td>
                <td className="num">{formatCurrency(account.committedGross)}</td>
                <td className="num">{formatCurrency(account.outstanding)}</td>
                <td className="num" style={account.overdueAmount > 0 ? { color: OVERDUE, fontWeight: 600 } : undefined}>
                  {account.overdueAmount > 0
                    ? `${formatCurrency(account.overdueAmount)} · ${account.maxDaysOverdue}d`
                    : '—'}
                </td>
                <td>
                  {account.creditLimit === null ? (
                    <span className="muted">No limit</span>
                  ) : (
                    <>
                      {formatCurrency(account.creditLimit)}
                      <div
                        className={account.overLimit ? undefined : 'muted'}
                        style={{ fontSize: '0.75rem', color: account.overLimit ? OVERDUE : undefined }}
                      >
                        {account.overLimit
                          ? `${formatCurrency(-account.headroom)} over`
                          : `${formatCurrency(account.headroom)} left`}
                      </div>
                    </>
                  )}
                </td>
                <td>
                  {operator.active === false ? (
                    <span className="muted">Retired</span>
                  ) : operator.onHold ? (
                    <span style={{ color: OVERDUE, fontWeight: 600 }}>On hold</span>
                  ) : (
                    <span>Trading</span>
                  )}
                </td>
                <td>
                  <button
                    type="button"
                    className="btn-sm"
                    onClick={(event) => {
                      event.stopPropagation();
                      onEdit(operator);
                    }}
                  >
                    Edit
                  </button>
                </td>
              </tr>
            );
          })}
          {direct && direct.bookings > 0 && (
            <tr>
              <td>
                <div style={{ fontWeight: 600 }}>Direct bookings</div>
                <div className="muted" style={{ fontSize: '0.75rem' }}>
                  Not on any trade account
                </div>
              </td>
              <td className="secondary" style={{ fontSize: '0.8125rem' }}>
                Net 30 days (default)
              </td>
              <td className="num">{formatNumber(direct.bookings)}</td>
              <td className="num">{formatCurrency(direct.committedGross)}</td>
              <td className="num">{formatCurrency(direct.outstanding)}</td>
              <td className="num">
                {direct.overdueAmount > 0 ? formatCurrency(direct.overdueAmount) : '—'}
              </td>
              <td className="muted">—</td>
              <td className="muted">—</td>
              <td />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The debtor ledger, aged. Every row sums across to that account's outstanding
 * balance, and the foot sums down — so the same money is never counted twice
 * and a column that looks wrong can be checked against the row.
 */
function AgeingTable({ operators, bands, totals }) {
  const withDebt = operators.filter((operator) => operator.account.outstanding > 0);

  if (!withDebt.length) {
    return <div className="empty">Nothing is outstanding on any trade account.</div>;
  }

  return (
    <div className="stack">
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Operator</th>
              {bands.map((band) => (
                <th key={band.id} className="num">
                  {band.label}
                </th>
              ))}
              <th className="num">Total</th>
            </tr>
          </thead>
          <tbody>
            {withDebt.map((operator) => (
              <tr key={operator.id}>
                <td>
                  <div style={{ fontWeight: 600 }}>{operator.name}</div>
                  <div className="muted" style={{ fontSize: '0.75rem' }}>
                    {operator.terms}
                  </div>
                </td>
                {bands.map((band) => (
                  <td
                    key={band.id}
                    className="num"
                    style={
                      band.id !== 'current' && operator.account.ageing[band.id] > 0
                        ? { color: OVERDUE, fontWeight: 600 }
                        : undefined
                    }
                  >
                    {operator.account.ageing[band.id] > 0
                      ? formatCurrency(operator.account.ageing[band.id])
                      : '—'}
                  </td>
                ))}
                <td className="num" style={{ fontWeight: 700 }}>
                  {formatCurrency(operator.account.outstanding)}
                </td>
              </tr>
            ))}
            {totals && (
              <tr>
                <td style={{ fontWeight: 700 }}>All accounts</td>
                {bands.map((band) => (
                  <td key={band.id} className="num" style={{ fontWeight: 700 }}>
                    {formatCurrency(totals.ageing[band.id])}
                  </td>
                ))}
                <td className="num" style={{ fontWeight: 700 }}>
                  {formatCurrency(totals.outstanding)}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="secondary" style={{ fontSize: '0.8125rem', margin: 0 }}>
        Bands are counted from each booking&apos;s own due date under its operator&apos;s terms, and only
        committed bookings are included — an open enquiry is not money anybody owes.
      </p>
    </div>
  );
}

/**
 * Two different kinds of "we do not know whose this is", kept apart because they
 * need different answers: a domain with no account at all, and a booking whose
 * text names an account it has not been attached to.
 */
function Unrecognised({ suggestions, operators, onOpenAccount, onAssign }) {
  const [assigning, setAssigning] = useState({});

  if (!suggestions) return <div className="empty">Loading…</div>;

  const { suggestions: domains, needsConfirming } = suggestions;

  return (
    <div className="stack">
      <div className="card stack">
        <div>
          <h2 style={{ margin: 0 }}>Domains with no account</h2>
          <p className="secondary" style={{ margin: '0.25rem 0 0', fontSize: '0.8125rem' }}>
            Business addresses the club has taken more than one booking from. Personal mailboxes are
            never listed — a family that books twice from Gmail is not a tour operator.
          </p>
        </div>

        {domains.length ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Domain</th>
                  <th className="num">Bookings</th>
                  <th className="num">Players</th>
                  <th className="num">Value</th>
                  <th>Seen</th>
                  <th>Addresses</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {domains.map((group) => (
                  <tr key={group.domain}>
                    <td>
                      <div className="mono" style={{ fontWeight: 600 }}>
                        {group.domain}
                      </div>
                      <div className="muted" style={{ fontSize: '0.75rem' }}>
                        Suggested name: {group.proposedName}
                      </div>
                    </td>
                    <td className="num">{formatNumber(group.bookings)}</td>
                    <td className="num">{formatNumber(group.players)}</td>
                    <td className="num">{formatCurrency(group.gross)}</td>
                    <td className="secondary" style={{ fontSize: '0.8125rem' }}>
                      {group.firstDate ? formatDate(group.firstDate) : '—'} –{' '}
                      {group.lastDate ? formatDate(group.lastDate) : '—'}
                    </td>
                    <td className="secondary" style={{ fontSize: '0.75rem' }}>
                      {group.contacts.join(', ')}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn-sm"
                        onClick={() =>
                          onOpenAccount({
                            name: group.proposedName,
                            emailDomains: group.domain,
                            contactEmail: group.contacts[0] ?? '',
                          })
                        }
                      >
                        Open account
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty">
            Every business domain the club books with already has an account.
          </div>
        )}
      </div>

      {needsConfirming?.length > 0 && (
        <div className="card stack">
          <div>
            <h2 style={{ margin: 0 }}>Bookings that name an operator</h2>
            <p className="secondary" style={{ margin: '0.25rem 0 0', fontSize: '0.8125rem' }}>
              An operator&apos;s name appears in these enquiries, but the booking did not come from one of
              their domains. A name in prose is not evidence of an account, so nothing has been
              attached — confirm each one, or leave it as a direct booking.
            </p>
          </div>

          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Booking</th>
                  <th>Guest</th>
                  <th>Tee date</th>
                  <th className="num">Total</th>
                  <th>Status</th>
                  <th>Named</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {needsConfirming.map((booking) => (
                  <tr key={booking.bookingId}>
                    <td className="mono">{booking.bookingId}</td>
                    <td>
                      <div>{booking.guestName || '—'}</div>
                      <div className="muted" style={{ fontSize: '0.75rem' }}>
                        {booking.guestEmail}
                      </div>
                    </td>
                    <td>{formatDate(booking.date)}</td>
                    <td className="num">{formatCurrency(booking.total)}</td>
                    <td>
                      <StatusPill status={booking.status} />
                    </td>
                    <td>{booking.operatorName}</td>
                    <td>
                      <div className="row">
                        <select
                          aria-label={`Account for ${booking.bookingId}`}
                          value={assigning[booking.bookingId] ?? booking.operatorId ?? ''}
                          onChange={(event) =>
                            setAssigning((current) => ({
                              ...current,
                              [booking.bookingId]: event.target.value,
                            }))
                          }
                          style={{ width: 'auto' }}
                        >
                          <option value="">Direct booking</option>
                          {operators.map((operator) => (
                            <option key={operator.id} value={operator.id}>
                              {operator.name}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="btn-sm"
                          onClick={() => {
                            const raw = assigning[booking.bookingId] ?? String(booking.operatorId ?? '');
                            const id = raw === '' ? null : Number(raw);
                            const label =
                              operators.find((operator) => operator.id === id)?.name ?? 'direct bookings';
                            onAssign([booking.bookingId], id, label);
                          }}
                        >
                          Assign
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/** One account's bookings, with what each owes and when. */
function Statement({ statement, onClose }) {
  const { operator, account, bookings } = statement;

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={`${operator.name} statement`}>
        <div className="between">
          <div>
            <h2 style={{ margin: 0 }}>{operator.name}</h2>
            <div className="secondary">{operator.terms}</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="detail-grid">
          <Cell label="Bookings" value={formatNumber(account.bookings)} />
          <Cell label="Committed" value={formatCurrency(account.committedGross)} />
          <Cell label="Paid" value={formatCurrency(account.paid)} />
          <Cell label="Outstanding" value={formatCurrency(account.outstanding)} accent />
          <Cell
            label="Overdue"
            value={account.overdueAmount > 0 ? formatCurrency(account.overdueAmount) : 'None'}
          />
          <Cell
            label="Credit headroom"
            value={account.headroom === null ? 'No limit' : formatCurrency(account.headroom)}
          />
        </div>

        {operator.contactEmail ? (
          <div className="secondary" style={{ fontSize: '0.8125rem' }}>
            Reminders go to {operator.contactName ? `${operator.contactName}, ` : ''}
            {operator.contactEmail}
          </div>
        ) : (
          <div className="banner error">
            No contact email on this account, so it cannot be sent a reminder.
          </div>
        )}

        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Booking</th>
                <th>Tee date</th>
                <th>Status</th>
                <th className="num">Total</th>
                <th className="num">Outstanding</th>
                <th>Due</th>
              </tr>
            </thead>
            <tbody>
              {bookings.map((booking) => (
                <tr key={booking.bookingId}>
                  <td className="mono">{booking.bookingId}</td>
                  <td>{formatDate(booking.date)}</td>
                  <td>
                    <StatusPill status={booking.status} />
                    <div style={{ marginTop: '0.25rem' }}>
                      <PaymentPill payment={booking.payment} />
                    </div>
                  </td>
                  <td className="num">{formatCurrency(booking.total)}</td>
                  <td className="num">{formatCurrency(booking.payment.outstanding)}</td>
                  <td className="secondary" style={{ fontSize: '0.8125rem' }}>
                    {booking.payment.dueDate ? formatDate(booking.payment.dueDate) : '—'}
                    <div className={booking.payment.overdue ? undefined : 'muted'} style={{ color: booking.payment.overdue ? OVERDUE : undefined }}>
                      {describeDue(booking.payment)}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!bookings.length && <div className="empty">No bookings on this account yet.</div>}
        </div>
      </aside>
    </>
  );
}

function Cell({ label, value, accent }) {
  return (
    <div>
      <div className="label">{label}</div>
      <div
        style={{
          fontSize: accent ? '1.25rem' : '0.9375rem',
          fontWeight: accent ? 700 : 600,
          color: accent ? 'var(--brand-gold-bright)' : 'var(--text-primary)',
        }}
      >
        {value}
      </div>
    </div>
  );
}
