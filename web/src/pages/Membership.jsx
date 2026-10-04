import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, membershipExportUrl } from '../lib/api.js';
import { formatCurrency, formatDate, formatNumber } from '../lib/format.js';
import { PIPELINE_RAMP } from '../lib/palette.js';
import { APPLICATION_FILTERS, MEMBERSHIP_STATUS_COLORS } from '../lib/membership.js';
import KpiTile from '../components/KpiTile.jsx';
import { Segmented } from '../components/analytics/Segmented.jsx';
import MembershipToggle from '../components/MembershipToggle.jsx';
import MembershipDrawer from '../components/MembershipDrawer.jsx';
import MembershipStatusPill from '../components/MembershipStatusPill.jsx';

const TABS = [
  { id: 'applications', label: 'Applications' },
  { id: 'waitlist', label: 'Waitlist' },
  { id: 'categories', label: 'Categories' },
];

/**
 * Membership, from enquiry to welcome.
 *
 * The switch at the top decides what an enquiry to the membership address
 * receives: on, the categories and a link to apply; off, a link to join the
 * waitlist. Below it, the pipeline the committee works through.
 */
export default function Membership({ user }) {
  const [settings, setSettings] = useState(null);
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('applications');
  const [openId, setOpenId] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const isAdmin = user?.role === 'admin';

  const loadHeader = useCallback(async () => {
    try {
      const [s, k] = await Promise.all([api.membershipSettings(), api.membershipSummary()]);
      setSettings(s);
      setSummary(k);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    loadHeader();
  }, [loadHeader]);

  const changed = useCallback(() => {
    loadHeader();
    setRefreshKey((key) => key + 1);
  }, [loadHeader]);

  if (!settings || !summary) return <div className="empty">{error ?? 'Loading membership…'}</div>;

  return (
    <div className="stack">
      <header className="between">
        <div>
          <h1>Membership</h1>
          <p className="muted" style={{ margin: '0.25rem 0 0' }}>
            Enquiry → instant tailored reply → guided application → committee review → welcome to the club
          </p>
        </div>
      </header>

      {error && <div className="banner error">{error}</div>}

      <MembershipToggle
        enabled={settings.enabled}
        canEdit={settings.canEdit}
        updatedBy={settings.updatedBy}
        updatedAt={settings.updatedAt}
        onChange={async (enabled) => {
          const next = await api.saveMembershipSettings({ enabled });
          setSettings((current) => ({ ...current, ...next }));
          changed();
        }}
      />

      {(!settings.linksConfigured || !settings.emailConfigured) && (
        <div className="banner error">
          {!settings.linksConfigured &&
            'Application links cannot be made yet: BOOKING_LINK_SECRET and MEMBERSHIP_FORM_BASE_URL must be set on the server. '}
          {!settings.emailConfigured &&
            'Email sending is not set up, so decisions are recorded but applicants are not emailed.'}
        </div>
      )}

      <div className="kpi-row">
        <KpiTile
          label="New submissions"
          value={formatNumber(summary.newSubmissions)}
          sub="Waiting for review to start"
          accent={PIPELINE_RAMP[1]}
        />
        <KpiTile
          label="Under review"
          value={formatNumber(summary.underReview)}
          sub="With the committee"
          accent={PIPELINE_RAMP[2]}
        />
        <KpiTile
          label="Approved"
          value={formatNumber(summary.awaitingWelcome)}
          sub="Awaiting their welcome"
          accent={PIPELINE_RAMP[3]}
        />
        <KpiTile
          label="Waitlist"
          value={formatNumber(summary.waitlist)}
          sub={settings.enabled ? 'Ready to invite' : 'Invite once you reopen'}
          accent={MEMBERSHIP_STATUS_COLORS.waitlisted}
        />
        <KpiTile
          label="Enquiries this month"
          value={formatNumber(summary.enquiriesThisMonth)}
          sub={`${formatNumber(summary.welcomedThisYear)} welcomed this year`}
          accent={PIPELINE_RAMP[0]}
        />
      </div>

      <div>
        <Segmented label="Membership sections" options={TABS} value={tab} onChange={setTab} />
      </div>

      {tab === 'applications' && <Applications key={refreshKey} onOpen={setOpenId} />}
      {tab === 'waitlist' && (
        <WaitlistTab
          key={refreshKey}
          enabled={settings.enabled}
          isAdmin={isAdmin}
          onOpen={setOpenId}
          onChanged={changed}
        />
      )}
      {tab === 'categories' && <Categories isAdmin={isAdmin} />}

      {openId && (
        <MembershipDrawer
          applicationId={openId}
          enabled={settings.enabled}
          onClose={() => setOpenId(null)}
          onChanged={changed}
        />
      )}
    </div>
  );
}

/* ---------- applications ---------- */

function Applications({ onOpen }) {
  const [filter, setFilter] = useState('action');
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const statuses = APPLICATION_FILTERS.find((f) => f.id === filter)?.statuses;
  const status = statuses ? statuses.join(',') : 'all';

  useEffect(() => {
    let live = true;
    api
      .membershipApplications({ status, q: search })
      .then((result) => live && (setData(result), setError(null)))
      .catch((err) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [status, search]);

  useEffect(() => {
    const timer = setTimeout(() => setSearch(q.trim()), 250);
    return () => clearTimeout(timer);
  }, [q]);

  const options = useMemo(
    () =>
      APPLICATION_FILTERS.map((f) => {
        if (!data) return f;
        const count = f.statuses
          ? f.statuses.reduce((sum, s) => sum + (data.counts[s] ?? 0), 0)
          : Object.values(data.counts).reduce((sum, n) => sum + n, 0);
        return { ...f, label: `${f.label} (${count})` };
      }),
    [data],
  );

  return (
    <div className="stack">
      <div className="toolbar">
        <Segmented label="Filter by status" options={options} value={filter} onChange={setFilter} />
        <input
          type="search"
          className="grow"
          aria-label="Search applications"
          placeholder="Search name, email or reference"
          value={q}
          onChange={(event) => setQ(event.target.value)}
          style={{ maxWidth: '320px' }}
        />
        <a className="button-link btn-sm" href={membershipExportUrl({ status, q: search })}>
          Export CSV
        </a>
      </div>
      {error && <div className="banner error">{error}</div>}
      {!data ? (
        <div className="empty">Loading applications…</div>
      ) : !data.applications.length ? (
        <div className="empty">No applications here{search ? ` matching “${search}”` : ''}.</div>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Applicant</th>
                <th>Reference</th>
                <th>Category</th>
                <th>Status</th>
                <th>Received</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.applications.map((application) => (
                <tr key={application.id} onClick={() => onOpen(application.id)} style={{ cursor: 'pointer' }}>
                  <td>
                    <div>{application.name || '—'}</div>
                    <div className="muted" style={{ fontSize: '0.75rem' }}>
                      {application.email}
                    </div>
                  </td>
                  <td className="mono">{application.reference}</td>
                  <td>{application.categoryName ?? <span className="muted">Not chosen</span>}</td>
                  <td>
                    <MembershipStatusPill status={application.status} />
                  </td>
                  <td>{formatDate((application.submittedAt ?? application.createdAt)?.slice(0, 10))}</td>
                  <td className="num">
                    <button
                      type="button"
                      className="btn-sm"
                      onClick={(event) => {
                        event.stopPropagation();
                        onOpen(application.id);
                      }}
                    >
                      Open
                    </button>
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

/* ---------- waitlist ---------- */

function WaitlistTab({ enabled, isAdmin, onOpen, onChanged }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.membershipApplications({ status: 'waitlisted,invited' }));
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function run(action) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setNotice(await action());
      setConfirm(null);
      await load();
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <div className="empty">{error ?? 'Loading the waitlist…'}</div>;
  const waiting = data.applications.filter((a) => a.status === 'waitlisted');
  const invited = data.applications.filter((a) => a.status === 'invited');

  return (
    <div className="stack">
      <div className="between">
        <p className="muted" style={{ margin: 0 }}>
          {enabled
            ? 'Applications are open. Invite people to apply — each gets an email with a signed link to the full form.'
            : 'Applications are closed, so new enquiries are offered this waitlist. Switch applications on to invite them.'}
        </p>
        {isAdmin && enabled && waiting.length > 0 && (
          <button
            type="button"
            className="btn-primary btn-sm"
            disabled={busy}
            onClick={() => setConfirm({ all: true })}
          >
            Invite all ({waiting.length})
          </button>
        )}
      </div>

      {error && <div className="banner error">{error}</div>}
      {notice && <div className="banner success">{notice}</div>}

      {confirm && (
        <div className="confirm-panel stack" role="alertdialog" aria-label="Confirm invitation">
          <div style={{ fontWeight: 700 }}>
            {confirm.all
              ? `Invite all ${waiting.length} people on the waitlist to apply?`
              : `Invite ${confirm.application.name || confirm.application.email} to apply?`}
          </div>
          <div className="secondary" style={{ fontSize: '0.875rem' }}>
            {confirm.all ? 'Each will receive' : 'They will receive'} an email saying applications are open, with a
            signed link to the application form under their existing reference.
          </div>
          <div className="row" style={{ gap: '0.5rem' }}>
            <button
              type="button"
              className="btn-primary"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  if (confirm.all) {
                    const result = await api.inviteMembershipWaitlist();
                    return `${result.invited} invited, ${result.emailed} emailed.${result.emailConfigured ? '' : ' Email sending is not set up — let them know yourself.'}`;
                  }
                  const result = await api.inviteMembershipApplicant(confirm.application.id);
                  return result.emailed
                    ? 'Invited — the email with their application link is on its way.'
                    : `Invited. ${result.emailNotice ?? 'No email was sent'} — let them know yourself.`;
                })
              }
            >
              {busy ? 'Sending…' : 'Yes, send the invitation'}
            </button>
            <button type="button" disabled={busy} onClick={() => setConfirm(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {!waiting.length ? (
        <div className="empty">Nobody is waiting.</div>
      ) : (
        <WaitTable
          rows={waiting}
          onOpen={onOpen}
          action={(application) => (
            <button
              type="button"
              className="btn-sm"
              disabled={!enabled || busy}
              title={enabled ? undefined : 'Switch applications on to invite'}
              onClick={(event) => {
                event.stopPropagation();
                setConfirm({ application });
              }}
            >
              Invite to apply
            </button>
          )}
        />
      )}

      {invited.length > 0 && (
        <>
          <h3>Invited, not yet applied</h3>
          <WaitTable rows={invited} onOpen={onOpen} />
        </>
      )}
    </div>
  );
}

function WaitTable({ rows, onOpen, action }) {
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>Name</th>
            <th>Interested in</th>
            <th>Message</th>
            <th>Since</th>
            <th>Status</th>
            {action && <th />}
          </tr>
        </thead>
        <tbody>
          {rows.map((application) => (
            <tr key={application.id} onClick={() => onOpen(application.id)} style={{ cursor: 'pointer' }}>
              <td>
                <div>{application.name || '—'}</div>
                <div className="muted" style={{ fontSize: '0.75rem' }}>
                  {application.email}
                </div>
              </td>
              <td>{application.categoryName ?? <span className="muted">Any</span>}</td>
              <td className="muted" style={{ maxWidth: '320px', fontSize: '0.8125rem' }}>
                {application.message
                  ? application.message.length > 140
                    ? `${application.message.slice(0, 140)}…`
                    : application.message
                  : '—'}
              </td>
              <td>{formatDate(application.createdAt?.slice(0, 10))}</td>
              <td>
                <MembershipStatusPill status={application.status} />
              </td>
              {action && <td className="num">{action(application)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------- categories ---------- */

const BLANK_CATEGORY = {
  name: '',
  description: '',
  eligibility: '',
  joiningFee: '',
  annualFee: '',
  minAge: '',
  maxAge: '',
  sortOrder: '',
  active: true,
};

function Categories({ isAdmin }) {
  const [categories, setCategories] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setCategories((await api.membershipCategories()).categories);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function run(action, text) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await action();
      setNotice(typeof text === 'function' ? text(result) : text);
      setEditing(null);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!categories) return <div className="empty">{error ?? 'Loading categories…'}</div>;

  return (
    <div className="stack">
      <div className="between">
        <p className="muted" style={{ margin: 0 }}>
          What the instant reply offers and the application form lists. Fees are in the club’s currency.
          {!isAdmin && ' Only an administrator can change them.'}
        </p>
        {isAdmin && !editing && (
          <button type="button" className="btn-primary btn-sm" onClick={() => setEditing({ ...BLANK_CATEGORY })}>
            Add category
          </button>
        )}
      </div>
      {error && <div className="banner error">{error}</div>}
      {notice && <div className="banner success">{notice}</div>}

      {editing && (
        <CategoryForm
          value={editing}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSave={(form) =>
            run(
              () => (form.id ? api.updateMembershipCategory(form.id, form) : api.createMembershipCategory(form)),
              form.id ? `${form.name} saved.` : `${form.name} added.`,
            )
          }
        />
      )}

      {!categories.length ? (
        <div className="empty">No categories yet.</div>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Category</th>
                <th>Eligibility</th>
                <th className="num">Joining fee</th>
                <th className="num">Annual</th>
                <th>Ages</th>
                <th className="num">Applications</th>
                {isAdmin && <th />}
              </tr>
            </thead>
            <tbody>
              {categories.map((category) => (
                <tr key={category.id} style={{ opacity: category.active ? 1 : 0.55 }}>
                  <td>
                    <strong>{category.name}</strong>
                    {!category.active && <span className="muted"> · retired</span>}
                    {category.description && (
                      <div className="muted" style={{ fontSize: '0.75rem' }}>
                        {category.description}
                      </div>
                    )}
                  </td>
                  <td>{category.eligibility || '—'}</td>
                  <td className="num">{formatCurrency(category.joiningFee)}</td>
                  <td className="num">{formatCurrency(category.annualFee)}</td>
                  <td>{ages(category)}</td>
                  <td className="num">{formatNumber(category.applications ?? 0)}</td>
                  {isAdmin && (
                    <td className="num">
                      <div className="row" style={{ justifyContent: 'flex-end', gap: '0.4rem' }}>
                        <button type="button" className="btn-sm" disabled={busy} onClick={() => setEditing(category)}>
                          Edit
                        </button>
                        {category.active && (
                          <button
                            type="button"
                            className="btn-sm btn-danger"
                            disabled={busy}
                            onClick={() =>
                              run(
                                () => api.deleteMembershipCategory(category.id),
                                (result) =>
                                  result.retired
                                    ? `${category.name} is used by applications, so it was retired rather than deleted.`
                                    : `${category.name} deleted.`,
                              )
                            }
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ages(category) {
  if (category.minAge != null && category.maxAge != null) return `${category.minAge}–${category.maxAge}`;
  if (category.minAge != null) return `${category.minAge}+`;
  if (category.maxAge != null) return `Under ${category.maxAge + 1}`;
  return 'Any';
}

function CategoryForm({ value, busy, onSave, onCancel }) {
  const [form, setForm] = useState({
    ...value,
    joiningFee: value.joiningFee ?? '',
    annualFee: value.annualFee ?? '',
    minAge: value.minAge ?? '',
    maxAge: value.maxAge ?? '',
    sortOrder: value.sortOrder ?? '',
  });
  const set = (key) => (event) =>
    setForm({ ...form, [key]: event.target.type === 'checkbox' ? event.target.checked : event.target.value });
  const field = (key, label, props = {}) => (
    <label className="stack" style={{ gap: '0.35rem', flex: props.grow ? 1 : undefined }}>
      <span className="label">{label}</span>
      <input value={form[key]} onChange={set(key)} {...props.input} />
    </label>
  );

  return (
    <form
      className="card stack"
      style={{ gap: '0.75rem' }}
      onSubmit={(event) => {
        event.preventDefault();
        onSave(form);
      }}
    >
      <h3>{form.id ? `Edit ${value.name}` : 'New category'}</h3>
      <div className="toolbar">
        {field('name', 'Name', { grow: true, input: { required: true, maxLength: 80 } })}
        {field('joiningFee', 'Joining fee', { input: { type: 'number', min: 0, max: 100000, step: '0.01' } })}
        {field('annualFee', 'Annual subscription', { input: { type: 'number', min: 0, max: 100000, step: '0.01' } })}
      </div>
      <div className="toolbar">
        {field('eligibility', 'Eligibility', { grow: true, input: { maxLength: 500 } })}
        {field('minAge', 'Min age', { input: { type: 'number', min: 0, max: 120, style: { width: '6rem' } } })}
        {field('maxAge', 'Max age', { input: { type: 'number', min: 0, max: 120, style: { width: '6rem' } } })}
        {field('sortOrder', 'Order', { input: { type: 'number', style: { width: '5rem' } } })}
      </div>
      <label className="stack" style={{ gap: '0.35rem' }}>
        <span className="label">Description</span>
        <textarea rows={2} maxLength={1000} value={form.description} onChange={set('description')} />
      </label>
      <label className="row" style={{ gap: '0.5rem' }}>
        <input type="checkbox" checked={form.active} onChange={set('active')} style={{ width: 'auto' }} />
        Offered to new applicants
      </label>
      <div className="row" style={{ gap: '0.5rem' }}>
        <button type="submit" className="btn-primary" disabled={busy}>
          {form.id ? 'Save category' : 'Add category'}
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
