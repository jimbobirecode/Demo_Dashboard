import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { formatCurrency, formatDate, formatNumber } from '../lib/format.js';
import { OVERDUE } from '../lib/palette.js';
import KpiTile from '../components/KpiTile.jsx';
import OperatorForm from '../components/OperatorForm.jsx';
import StatusPill from '../components/StatusPill.jsx';
import PaymentPill from '../components/PaymentPill.jsx';
import { describeDue } from '../lib/payments.js';
import Correspondent from '../components/Correspondent.jsx';

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
export default function Operators({ user }) {
  const [data, setData] = useState(null);
  const [suggestions, setSuggestions] = useState(null);
  const [tab, setTab] = useState('accounts');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [editing, setEditing] = useState(null); // { operator } | { seed } | null
  const [openId, setOpenId] = useState(null);
  const [statement, setStatement] = useState(null);
  const [search, setSearch] = useState('');

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
  // Nothing is recorded as paid, so there is no ledger to show, and a column
  // of the whole booking value headed "Outstanding" is a false one. See
  // tracksPayments in server/src/lib/operators-domain.js: with it off the page
  // answers what it is really read for, which is what is booked.
  const money = data?.tracksPayments ?? false;
  const totals = data?.totals;
  const bands = data?.ageingBands ?? [];

  // Found by typing, not by scrolling: the club trades with 138 accounts, and
  // the question is nearly always about one of them by name. Searching what
  // the row already shows - and the account code and contact, which staff know
  // the operator by even where the screen does not - means anything a person
  // can see or quote finds the account.
  const matching = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return operators;
    return operators.filter((operator) =>
      [
        operator.name,
        operator.accountCode,
        operator.contactName,
        operator.contactEmail,
        operator.contactPhone,
        ...(operator.emailDomains ?? []),
      ]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(needle)),
    );
  }, [operators, search]);

  const worstFirst = useMemo(
    () =>
      [...matching].sort(
        (a, b) =>
          b.account.overdueAmount - a.account.overdueAmount ||
          b.account.outstanding - a.account.outstanding ||
          a.name.localeCompare(b.name),
      ),
    [matching],
  );

  async function save(payload) {
    const existing = editing?.operator;
    const { operator } = existing ? await api.updateOperator(existing.id, payload) : await api.createOperator(payload);

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
            {money
              ? 'Trade accounts, their credit terms and what they owe'
              : 'Trade accounts and what they have booked'}
            {data?.today && ` · as at ${formatDate(data.today)}`}
            {money && data?.paymentsTrackedFrom && (
              <>
                {' · '}
                <span title="Bookings taken before this date carry a value but no balance">
                  balances from {formatDate(data.paymentsTrackedFrom)}
                </span>
              </>
            )}
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
            sub={`${formatNumber(totals.booked)} booked · ${formatNumber(totals.unconfirmed)} enquiries`}
            accent="var(--brand-gold)"
          />
          {money && (
            <KpiTile
              label="Outstanding"
              value={formatCurrency(totals.outstanding)}
              sub="Booked rounds not yet paid"
              accent="var(--north-sea)"
            />
          )}
          {money && (
            <KpiTile
              label="Overdue"
              value={formatCurrency(totals.overdueAmount)}
              sub={`${formatNumber(totals.overdueCount)} booking(s) past their due date`}
              accent={totals.overdueAmount > 0 ? OVERDUE : 'var(--links-green)'}
            />
          )}
          <KpiTile
            label="Enquiries open"
            value={formatNumber(totals.unconfirmed)}
            sub="On account, not yet booked"
            accent="var(--links-green)"
          />
          {money ? (
            <KpiTile
              label="Accounts to watch"
              value={formatNumber(totals.overLimit + totals.onHold)}
              sub={`${totals.overLimit} over limit · ${totals.onHold} on hold`}
              accent={totals.overLimit + totals.onHold > 0 ? OVERDUE : 'var(--muted, #8a8a8a)'}
            />
          ) : (
            // Over-limit is a credit judgement and there is no credit to
            // judge; on hold is a decision somebody made, and still stands.
            <KpiTile
              label="On hold"
              value={formatNumber(totals.onHold)}
              sub="Accounts not taking new bookings"
              accent={totals.onHold > 0 ? OVERDUE : 'var(--muted, #8a8a8a)'}
            />
          )}
        </div>
      )}

      <div className="toolbar">
        <div className="segmented" role="group" aria-label="View">
          <button type="button" aria-pressed={tab === 'accounts'} onClick={() => setTab('accounts')}>
            Accounts ({search.trim() ? `${matching.length} of ${operators.length}` : operators.length})
          </button>
          {/* Nothing but balances, so it has nothing to show. */}
          {money && (
            <button type="button" aria-pressed={tab === 'ageing'} onClick={() => setTab('ageing')}>
              Debtor ageing
            </button>
          )}
          <button type="button" aria-pressed={tab === 'unmatched'} onClick={() => setTab('unmatched')}>
            Unrecognised ({(suggestions?.suggestions?.length ?? 0) + (suggestions?.needsConfirming?.length ?? 0)})
          </button>
        </div>
        {/* Searching an account is not searching the unrecognised domains,
            which are by definition nobody's account yet, so the box belongs to
            the two tabs that list accounts. */}
        {tab !== 'unmatched' && (
          <div className="grow">
            <label className="sr-only" htmlFor="operator-search">
              Search tour operators
            </label>
            <input
              id="operator-search"
              type="search"
              placeholder="Search by name, account code, contact or domain…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              style={{ maxWidth: '340px' }}
            />
          </div>
        )}
      </div>

      {loading && !data && <div className="empty">Loading…</div>}

      {/* A search that matches nothing says so, rather than showing the empty
          state for a club with no accounts at all. */}
      {data && search.trim() && !matching.length && tab !== 'unmatched' ? (
        <div className="empty">
          No tour operator matching “{search.trim()}”.{' '}
          <button type="button" className="link-button" onClick={() => setSearch('')}>
            Show all {operators.length}
          </button>
        </div>
      ) : (
        <>
          {tab === 'accounts' && data && (
            <AccountsTable
              operators={worstFirst}
              money={money}
              direct={data.direct}
              onEdit={(operator) => setEditing({ operator })}
              onOpen={setOpenId}
            />
          )}

          {tab === 'ageing' && data && money && <AgeingTable operators={worstFirst} bands={bands} totals={totals} />}
        </>
      )}

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
          onDelete={editing.operator && user?.role === 'admin' ? remove : undefined}
          onClose={() => setEditing(null)}
        />
      )}

      {statement && <Statement statement={statement} onClose={() => setOpenId(null)} />}
    </div>
  );
}

/**
 * Click-to-sort column headings, for the two tables below.
 *
 * Both are read to answer a question that IS a sort -- who owes us the most,
 * who is furthest overdue, who books the most -- and the club was doing that
 * by eye down a list of 138 accounts.
 *
 * Blanks sort last whichever way the column is pointing, so reversing to find
 * the smallest figure does not first wade through every account that has no
 * figure at all. Numeric columns open on the largest, text columns A to Z,
 * because that is the direction each is nearly always wanted in first.
 */
function useSort(initialKey, initialDir = 'desc') {
  const [sort, setSort] = useState({ key: initialKey, dir: initialDir });
  const by = useCallback(
    (key, firstDir) =>
      setSort((current) =>
        current.key === key ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: firstDir },
      ),
    [],
  );
  return [sort, by];
}

/** Order rows by the current sort. `value(row, key)` reads the sorted column. */
function sortRows(rows, sort, value) {
  const direction = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = value(a, sort.key);
    const right = value(b, sort.key);
    const leftBlank = left === null || left === undefined || left === '';
    const rightBlank = right === null || right === undefined || right === '';
    if (leftBlank && rightBlank) return 0;
    if (leftBlank) return 1;
    if (rightBlank) return -1;
    if (typeof left === 'string' || typeof right === 'string') {
      return String(left).localeCompare(String(right)) * direction;
    }
    return (left - right) * direction;
  });
}

/**
 * A heading that sorts its column, in the same markup as the bookings table's
 * so the two read and behave alike (theme.css styles th[data-sortable]).
 */
function SortTh({ sort, onSort, column, children, numeric = false }) {
  const active = sort.key === column;
  return (
    <th
      data-sortable="true"
      className={numeric ? 'num' : undefined}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      onClick={() => onSort(column, numeric ? 'desc' : 'asc')}
    >
      {children}
      {active ? (sort.dir === 'asc' ? ' \u25b2' : ' \u25bc') : ''}
    </th>
  );
}

/** What each sortable column of the accounts table reads. */
/**
 * Rounds this account has actually booked.
 *
 * Not account.bookings, which is every row on the account whatever became of
 * it. Two thirds of County Louth's are open enquiries and a few are rejected,
 * so that figure sat beside a value counting only the booked ones and looked
 * like its denominator.
 */
function bookedCount(account) {
  return account?.byStatus?.Booked ?? 0;
}

function accountValue(operator, key) {
  const account = operator.account;
  if (key === 'name') return operator.name;
  if (key === 'terms') return operator.terms;
  if (key === 'booked') return bookedCount(account);
  if (key === 'enquiries') return account.unconfirmed ?? 0;
  if (key === 'committed') return account.committedGross;
  if (key === 'outstanding') return account.outstanding;
  // Sorted by money owed, not by days: two accounts can both be 30 days late
  // and only one of them matter.
  if (key === 'overdue') return account.overdueAmount;
  if (key === 'limit') return account.creditLimit;
  // Worst first, so anything needing attention is at the top.
  if (key === 'state') return operator.active === false ? 2 : operator.onHold ? 0 : 1;
  return null;
}

function AccountsTable({ operators, money, direct, onEdit, onOpen }) {
  // Without balances the useful order is who books the most, not who owes the
  // most - and 'outstanding' would sort a column nobody can see.
  const [sort, by] = useSort(money ? 'outstanding' : 'booked');
  // Enquiries are most of the trade book and none of the money. Hiding them
  // leaves the accounts that have actually booked something, which is the
  // list somebody chasing business or balances wants; the count of what went
  // is said out loud, so a shorter list is never a mystery.
  const [bookedOnly, setBookedOnly] = useState(false);
  const shown = useMemo(
    () => (bookedOnly ? operators.filter((operator) => bookedCount(operator.account) > 0) : operators),
    [operators, bookedOnly],
  );
  const hidden = operators.length - shown.length;
  const ordered = useMemo(() => sortRows(shown, sort, accountValue), [shown, sort]);

  if (!operators.length) {
    return (
      <div className="empty">
        No trade accounts yet. Open the Unrecognised tab — the domains the club already books with are listed there,
        ready to become accounts.
      </div>
    );
  }

  return (
    <>
      <div className="between" style={{ marginBottom: '0.6rem', gap: '0.75rem' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8125rem' }}>
          <input
            type="checkbox"
            style={{ width: 'auto' }}
            checked={bookedOnly}
            onChange={(event) => setBookedOnly(event.target.checked)}
          />
          Accounts that have booked something
        </label>
        {bookedOnly && hidden > 0 && (
          <span className="muted" style={{ fontSize: '0.75rem' }}>
            {formatNumber(hidden)} account{hidden === 1 ? '' : 's'} hidden — enquiries only, nothing booked yet
          </span>
        )}
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <SortTh sort={sort} onSort={by} column="name">
                Operator
              </SortTh>
              {money && (
                <SortTh sort={sort} onSort={by} column="terms">
                  Credit terms
                </SortTh>
              )}
              {/* Booked and enquiries are counted apart, because they are not
                the same thing and the money column only ever counted the
                first. One "Bookings" column of both read as the denominator
                of a value it had nothing to do with. */}
              <SortTh sort={sort} onSort={by} column="booked" numeric>
                Booked
              </SortTh>
              {!bookedOnly && (
                <SortTh sort={sort} onSort={by} column="enquiries" numeric>
                  Enquiries
                </SortTh>
              )}
              <SortTh sort={sort} onSort={by} column="committed" numeric>
                {/* Said in the same word as the column it counts. "Committed"
                  is the club committing to a tee time, which is exactly what
                  Booked means, and nobody should have to be told that. */}
                Booked value
              </SortTh>
              {money && (
                <SortTh sort={sort} onSort={by} column="outstanding" numeric>
                  Outstanding
                </SortTh>
              )}
              {money && (
                <SortTh sort={sort} onSort={by} column="overdue" numeric>
                  Overdue
                </SortTh>
              )}
              {money && (
                <SortTh sort={sort} onSort={by} column="limit">
                  Credit limit
                </SortTh>
              )}
              <SortTh sort={sort} onSort={by} column="state">
                State
              </SortTh>
              <th />
            </tr>
          </thead>
          <tbody>
            {ordered.map((operator) => {
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
                  {money && (
                    <td className="secondary" style={{ fontSize: '0.8125rem' }}>
                      {operator.terms}
                    </td>
                  )}
                  <td className="num">{formatNumber(bookedCount(account))}</td>
                  {!bookedOnly && (
                    <td className="num">
                      {account.unconfirmed ? formatNumber(account.unconfirmed) : <span className="muted">—</span>}
                    </td>
                  )}
                  <td className="num">{formatCurrency(account.committedGross)}</td>
                  {money && <td className="num">{formatCurrency(account.outstanding)}</td>}
                  {money && (
                    <td
                      className="num"
                      style={account.overdueAmount > 0 ? { color: OVERDUE, fontWeight: 600 } : undefined}
                    >
                      {account.overdueAmount > 0
                        ? `${formatCurrency(account.overdueAmount)} · ${account.maxDaysOverdue}d`
                        : '—'}
                    </td>
                  )}
                  {money && (
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
                  )}
                  <td>
                    {operator.active === false ? (
                      <span className="muted">Retired</span>
                    ) : operator.onHold ? (
                      <span style={{ color: OVERDUE, fontWeight: 600 }}>On hold</span>
                    ) : (
                      <span>Trading</span>
                    )}
                    {operator.active !== false && operator.autoChase === false && (
                      <div className="muted" style={{ fontSize: '0.75rem' }}>
                        Not chased
                      </div>
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
                {money && (
                  <td className="secondary" style={{ fontSize: '0.8125rem' }}>
                    Net 30 days (default)
                  </td>
                )}
                <td className="num">{formatNumber(bookedCount(direct))}</td>
                {!bookedOnly && (
                  <td className="num">
                    {direct.unconfirmed ? formatNumber(direct.unconfirmed) : <span className="muted">—</span>}
                  </td>
                )}
                <td className="num">{formatCurrency(direct.committedGross)}</td>
                {money && <td className="num">{formatCurrency(direct.outstanding)}</td>}
                {money && (
                  <td className="num">{direct.overdueAmount > 0 ? formatCurrency(direct.overdueAmount) : '—'}</td>
                )}
                {money && <td className="muted">—</td>}
                <td className="muted">—</td>
                <td />
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

/**
 * The debtor ledger, aged. Every row sums across to that account's outstanding
 * balance, and the foot sums down — so the same money is never counted twice
 * and a column that looks wrong can be checked against the row.
 */
function AgeingTable({ operators, bands, totals }) {
  const [sort, by] = useSort('total');
  const withDebt = useMemo(
    () =>
      sortRows(
        operators.filter((operator) => operator.account.outstanding > 0),
        sort,
        (operator, key) => {
          if (key === 'name') return operator.name;
          if (key === 'total') return operator.account.outstanding;
          // Any other key is one of the ageing bands.
          return operator.account.ageing[key] ?? 0;
        },
      ),
    [operators, sort],
  );

  if (!withDebt.length) {
    return <div className="empty">Nothing is outstanding on any trade account.</div>;
  }

  return (
    <div className="stack">
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <SortTh sort={sort} onSort={by} column="name">
                Operator
              </SortTh>
              {bands.map((band) => (
                <SortTh key={band.id} sort={sort} onSort={by} column={band.id} numeric>
                  {band.label}
                </SortTh>
              ))}
              <SortTh sort={sort} onSort={by} column="total" numeric>
                Total
              </SortTh>
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
                    {operator.account.ageing[band.id] > 0 ? formatCurrency(operator.account.ageing[band.id]) : '—'}
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
        Bands are counted from each booking&apos;s own due date under its operator&apos;s terms, and only committed
        bookings are included — an open enquiry is not money anybody owes.
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
            Business addresses the club has taken more than one booking from. Personal mailboxes are never listed — a
            family that books twice from Gmail is not a tour operator.
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
          <div className="empty">Every business domain the club books with already has an account.</div>
        )}
      </div>

      {needsConfirming?.length > 0 && (
        <div className="card stack">
          <div>
            <h2 style={{ margin: 0 }}>Bookings that name an operator</h2>
            <p className="secondary" style={{ margin: '0.25rem 0 0', fontSize: '0.8125rem' }}>
              An operator&apos;s name appears in these enquiries, but the booking did not come from one of their
              domains. A name in prose is not evidence of an account, so nothing has been attached — confirm each one,
              or leave it as a direct booking.
            </p>
          </div>

          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Booking</th>
                  <th>Contact</th>
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
                      <Correspondent booking={booking} />
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
                            const label = operators.find((operator) => operator.id === id)?.name ?? 'direct bookings';
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

/**
 * One account in full: the terms, the roll-up, and every booking on it.
 *
 * It was a narrow drawer with every row an account had ever sent -- Perry
 * Golf's thirty-three bookings sat among sixty-three open enquiries, two of
 * them marked "7d late" for a deposit nobody had asked for, because an
 * enquiry is not a booking and owes nothing. And the figures that answer the
 * calls this page is for -- what each owes, by when -- were off the edge of a
 * table that scrolled sideways.
 *
 * So: wide enough to read, the booked rounds first and the enquiries one
 * click away, every column sortable, and a row that opens to show who it is
 * for and how the money stands, deposit and balance apiece, with a way into
 * the booking itself to change it or take a payment.
 */
const STATEMENT_VIEWS = [
  { id: 'booked', label: 'Booked', test: (booking) => booking.status === 'Booked' },
  {
    id: 'owing',
    label: 'Owing',
    test: (booking) =>
      booking.status === 'Booked' && booking.payment?.tracked !== false && (booking.payment?.outstanding ?? 0) > 0,
  },
  { id: 'overdue', label: 'Overdue', test: (booking) => booking.status === 'Booked' && booking.payment?.overdue },
  { id: 'enquiries', label: 'Enquiries', test: (booking) => ['Inquiry', 'Requested'].includes(booking.status) },
  { id: 'all', label: 'All', test: () => true },
];

/** Only a booked round owes anything. An enquiry has no payment to be late with. */
const owes = (booking) => booking.status === 'Booked';

function statementValue(booking, key) {
  switch (key) {
    case 'booking':
      return booking.bookingId;
    case 'date':
      return booking.date;
    case 'guest':
      return (booking.guestName || '').toLowerCase() || null;
    case 'players':
      return Number(booking.players) || null;
    case 'total':
      return Number(booking.total) || 0;
    case 'outstanding':
      return owes(booking) && booking.payment?.tracked !== false ? booking.payment.outstanding : null;
    case 'due':
      return owes(booking) && !booking.payment?.settled ? booking.payment?.dueDate || null : null;
    default:
      return null;
  }
}

function Statement({ statement, onClose }) {
  const { operator, account, bookings } = statement;
  // A statement of account, where nothing is recorded as paid, is a list of
  // rounds with the whole value called "Outstanding". Without payment
  // tracking it reads as what it is: what this operator has booked.
  const money = statement.tracksPayments ?? false;
  const [view, setView] = useState('booked');
  const [sort, by] = useSort('date', 'asc');
  const [open, setOpen] = useState(null);

  useEffect(() => {
    const onKeyDown = (event) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const counts = useMemo(
    () => Object.fromEntries(STATEMENT_VIEWS.map((entry) => [entry.id, bookings.filter(entry.test).length])),
    [bookings],
  );
  const shown = useMemo(() => {
    const test = STATEMENT_VIEWS.find((entry) => entry.id === view)?.test ?? (() => true);
    return sortRows(bookings.filter(test), sort, statementValue);
  }, [bookings, view, sort]);

  // The name is only worth saying when it is a name: on some accounts the
  // contact name was filled in with the address itself.
  const contactName =
    operator.contactName && operator.contactName.toLowerCase() !== String(operator.contactEmail).toLowerCase()
      ? operator.contactName
      : '';
  const columns = money ? 9 : 6;

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer drawer-wide" role="dialog" aria-label={`${operator.name} statement`}>
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
          <Cell label="Booked" value={formatNumber(bookedCount(account))} />
          <Cell label="Enquiries open" value={formatNumber(account.unconfirmed ?? 0)} />
          <Cell label="Booked value" value={formatCurrency(account.committedGross)} accent={!money} />
          {money && <Cell label="Paid" value={formatCurrency(account.paid)} />}
          {money && <Cell label="Outstanding" value={formatCurrency(account.outstanding)} accent />}
          {money && (
            <Cell label="Overdue" value={account.overdueAmount > 0 ? formatCurrency(account.overdueAmount) : 'None'} />
          )}
          {money && (
            <Cell
              label="Credit headroom"
              value={account.headroom === null ? 'No limit' : formatCurrency(account.headroom)}
            />
          )}
        </div>

        {operator.contactEmail ? (
          <div className="secondary" style={{ fontSize: '0.8125rem' }}>
            Payment emails go to {contactName ? `${contactName}, ` : ''}
            {operator.contactEmail}
          </div>
        ) : (
          <div className="banner error">
            No contact email on this account, so its payment emails go to the guest instead.
          </div>
        )}

        <div className="segmented" role="group" aria-label="Which bookings">
          {STATEMENT_VIEWS.filter((entry) => money || !['owing', 'overdue'].includes(entry.id)).map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-pressed={view === entry.id}
              onClick={() => {
                setView(entry.id);
                setOpen(null);
              }}
            >
              {entry.label} ({formatNumber(counts[entry.id])})
            </button>
          ))}
        </div>

        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th aria-label="Details" style={{ width: '1.5rem' }} />
                <SortTh sort={sort} onSort={by} column="booking">
                  Booking
                </SortTh>
                <SortTh sort={sort} onSort={by} column="date">
                  Tee date
                </SortTh>
                <SortTh sort={sort} onSort={by} column="guest">
                  Lead guest
                </SortTh>
                <SortTh sort={sort} onSort={by} column="players" numeric>
                  Players
                </SortTh>
                <th>Status</th>
                <SortTh sort={sort} onSort={by} column="total" numeric>
                  {money ? 'Total' : 'Value'}
                </SortTh>
                {money && (
                  <SortTh sort={sort} onSort={by} column="outstanding" numeric>
                    Outstanding
                  </SortTh>
                )}
                {money && (
                  <SortTh sort={sort} onSort={by} column="due">
                    Due
                  </SortTh>
                )}
              </tr>
            </thead>
            <tbody>
              {shown.map((booking) => (
                <StatementRow
                  key={booking.bookingId}
                  booking={booking}
                  money={money}
                  columns={columns}
                  open={open === booking.bookingId}
                  onToggle={() => setOpen(open === booking.bookingId ? null : booking.bookingId)}
                />
              ))}
            </tbody>
          </table>
          {!shown.length && (
            <div className="empty">
              {bookings.length ? 'Nothing on this account in this view.' : 'No bookings on this account yet.'}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

function StatementRow({ booking, money, columns, open, onToggle }) {
  const payment = booking.payment;
  const tracked = owes(booking) && payment?.tracked !== false;
  return (
    <>
      <tr className={open ? 'selected' : undefined} onClick={onToggle} style={{ cursor: 'pointer' }}>
        <td>
          <button
            type="button"
            className="link-button"
            aria-expanded={open}
            aria-label={`${open ? 'Hide' : 'Show'} ${booking.bookingId}`}
            onClick={(event) => {
              event.stopPropagation();
              onToggle();
            }}
            style={{ textDecoration: 'none' }}
          >
            {open ? '▾' : '▸'}
          </button>
        </td>
        <td className="mono">{booking.bookingId}</td>
        <td>{formatDate(booking.date)}</td>
        <td>{booking.guestName || <span className="muted">—</span>}</td>
        <td className="num">{booking.players ?? '—'}</td>
        <td>
          <StatusPill status={booking.status} />
          {money && owes(booking) && (
            <div style={{ marginTop: '0.25rem' }}>
              <PaymentPill payment={payment} />
            </div>
          )}
        </td>
        <td className="num">{formatCurrency(booking.total)}</td>
        {money && (
          <td className="num">{tracked ? formatCurrency(payment.outstanding) : <span className="muted">—</span>}</td>
        )}
        {money && (
          <td className="secondary" style={{ fontSize: '0.8125rem' }}>
            {tracked ? (
              <>
                {payment.dueDate && !payment.settled ? formatDate(payment.dueDate) : '—'}
                <div
                  className={payment.overdue ? undefined : 'muted'}
                  style={{ color: payment.overdue ? OVERDUE : undefined }}
                >
                  {describeDue(payment)}
                </div>
              </>
            ) : (
              <span className="muted">{owes(booking) ? 'Not tracked' : 'Not booked'}</span>
            )}
          </td>
        )}
      </tr>
      {open && (
        <tr>
          <td colSpan={columns} style={{ background: 'var(--surface-0)' }}>
            <StatementDetail booking={booking} money={money} tracked={tracked} />
          </td>
        </tr>
      )}
    </>
  );
}

function StatementDetail({ booking, money, tracked }) {
  const stages = booking.payment?.stages ?? [];
  return (
    <div className="stack" style={{ gap: '0.75rem', padding: '0.25rem 0' }}>
      <div className="detail-grid">
        <Cell label="Tee time" value={booking.teeTime || '—'} />
        <Cell label="Players" value={booking.players ?? '—'} />
        <Cell label="Booked" value={formatDate(booking.bookedAt ?? booking.timestamp)} />
        {booking.contactPhone && <Cell label="Phone" value={booking.contactPhone} />}
        {booking.guestEmail && (
          <div style={{ gridColumn: '1 / -1' }}>
            <div className="label">Email we reply to</div>
            <div style={{ fontWeight: 600 }}>{booking.guestEmail}</div>
          </div>
        )}
      </div>

      {money && tracked && stages.length > 0 && (
        <table className="data" style={{ fontSize: '0.8125rem' }}>
          <thead>
            <tr>
              <th>Stage</th>
              <th className="num">Amount</th>
              <th className="num">Paid</th>
              <th className="num">Still to pay</th>
              <th>Due</th>
            </tr>
          </thead>
          <tbody>
            {stages.map((stage) => (
              <tr key={stage.id}>
                <td>{stage.label}</td>
                <td className="num">{formatCurrency(stage.amount)}</td>
                <td className="num">{formatCurrency(stage.paid)}</td>
                <td className="num">{stage.settled ? 'Settled' : formatCurrency(stage.outstanding)}</td>
                <td style={{ color: stage.overdue ? OVERDUE : undefined }}>
                  {stage.dueDate ? formatDate(stage.dueDate) : '—'}
                  {stage.overdue && ` · ${stage.daysOverdue}d late`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!owes(booking) && (
        <div className="muted" style={{ fontSize: '0.8125rem' }}>
          {booking.status === 'Inquiry' || booking.status === 'Requested'
            ? 'An enquiry, not a booking: nothing is owed until it is booked.'
            : `${booking.status}: nothing is owed.`}
        </div>
      )}

      {booking.specialRequests && (
        <div>
          <div className="label">Special requests</div>
          <div style={{ marginTop: '0.25rem' }}>{booking.specialRequests}</div>
        </div>
      )}

      <div>
        <Link className="btn-sm" to={`/bookings?booking=${encodeURIComponent(booking.bookingId)}`} style={openLink}>
          Open booking — edit it, or take a payment
        </Link>
      </div>
    </div>
  );
}

const openLink = {
  display: 'inline-block',
  textDecoration: 'none',
  color: 'var(--text-primary)',
  background: 'var(--surface-2)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  padding: '0.35rem 0.7rem',
};

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
