import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { formatDateTime } from '../lib/format.js';

/**
 * Who can sign in to this club's dashboard.
 *
 * A new account is created without a password: it is emailed a one-time link
 * and sets its own. So this page never shows, stores or invents a credential —
 * the worst it can leak is somebody's name.
 *
 * The destructive controls are the ones worth being careful about, so each
 * says what it will do in words and asks before doing it. The server enforces
 * the same rules again; nothing here is the only thing standing between an
 * administrator and locking the club out.
 */
export default function Users() {
  const [state, setState] = useState({ loading: true, users: [], config: null });
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(null);

  async function load({ silent } = {}) {
    if (!silent) setState((s) => ({ ...s, loading: true }));
    try {
      const [config, payload] = await Promise.all([api.usersConfig(), api.users()]);
      setState({ loading: false, users: payload.users, config, club: payload.club });
      setError(null);
    } catch (err) {
      setError(err.message);
      setState((s) => ({ ...s, loading: false }));
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function act(label, fn) {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      const result = await fn();
      if (result?.message) setNotice(result.message);
      await load({ silent: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  if (state.loading) return <div className="empty">Loading accounts…</div>;

  return (
    <div className="stack">
      <header className="between">
        <div>
          <h1>Users</h1>
          <p className="muted" style={{ margin: '0.25rem 0 0' }}>
            Who can sign in to {state.club ?? 'this dashboard'}
          </p>
        </div>
      </header>

      {error && <div className="banner error">{error}</div>}
      {notice && <div className="banner success">{notice}</div>}
      {state.config && !state.config.canInvite && (
        <div className="banner">
          <strong>Invitation email is not configured.</strong> An account can still be created, but nobody can be
          emailed a link until you set {state.config.missing.join(', ')}.
        </div>
      )}
      {state.config?.linkBase && (
        <p className="muted" style={{ fontSize: '0.8125rem', margin: 0 }}>
          Invitation and password links open <strong className="secondary">{state.config.linkBase}</strong> (the
          dashboard&rsquo;s APP_URL setting).
        </p>
      )}

      <NewUserForm
        disabled={!state.config || busy !== null}
        onCreate={(user) =>
          act('create', async () => {
            const result = await api.createUser(user);
            return { message: result.invite?.message ?? `${result.user.username} created` };
          })
        }
      />

      <UserTable
        users={state.users}
        busy={busy}
        onInvite={(user) => act(`invite-${user.id}`, async () => (await api.inviteUser(user.id)).invite)}
        onPatch={(user, patch, message) =>
          act(`patch-${user.id}`, async () => {
            await api.updateUser(user.id, patch);
            return { message };
          })
        }
        onDelete={(user) =>
          act(`delete-${user.id}`, async () => {
            await api.deleteUser(user.id);
            return { message: `${user.username} deleted` };
          })
        }
      />
    </div>
  );
}

function NewUserForm({ onCreate, disabled }) {
  const blank = { email: '', fullName: '', role: 'staff' };
  const [form, setForm] = useState(blank);

  function handleSubmit(event) {
    event.preventDefault();
    onCreate(form);
    setForm(blank);
  }

  const set = (key) => (event) => setForm({ ...form, [key]: event.target.value });

  return (
    <form className="card stack" style={{ gap: '0.75rem' }} onSubmit={handleSubmit}>
      <div>
        <h3>Add someone</h3>
        <p className="muted" style={{ margin: '0.15rem 0 0', fontSize: '0.8125rem' }}>
          Their email address is their sign-in. They are emailed a link and choose their own password — you never see
          it, and no password travels through an inbox.
        </p>
      </div>

      <div className="toolbar">
        <label className="stack grow" style={{ gap: '0.35rem' }}>
          <span className="label">Full name</span>
          <input value={form.fullName} onChange={set('fullName')} required />
        </label>
        <label className="stack grow" style={{ gap: '0.35rem' }}>
          <span className="label">Email address</span>
          <input
            type="email"
            value={form.email}
            onChange={set('email')}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck="false"
            required
          />
        </label>
        <label className="stack" style={{ gap: '0.35rem' }}>
          <span className="label">Role</span>
          <select value={form.role} onChange={set('role')} style={{ width: 'auto' }}>
            <option value="staff">Staff</option>
            <option value="admin">Administrator</option>
          </select>
        </label>
        <button type="submit" className="btn-primary" disabled={disabled}>
          Create and invite
        </button>
      </div>
    </form>
  );
}

function UserTable({ users, busy, onInvite, onPatch, onDelete }) {
  const sorted = useMemo(
    () => [...users].sort((a, b) => Number(b.active) - Number(a.active) || a.username.localeCompare(b.username)),
    [users],
  );

  if (!sorted.length) return <div className="empty">No accounts yet.</div>;

  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>Name</th>
            <th>Signs in with</th>
            <th>Username</th>
            <th>Role</th>
            <th>State</th>
            <th>Last signed in</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {sorted.map((user) => (
            <tr key={user.id} style={{ opacity: user.active ? 1 : 0.55 }}>
              <td>{user.fullName || '—'}</td>
              <td className="mono">{user.email ?? user.username}</td>
              {/* Only worth showing where it differs from the address — for an
                  account created before addresses, it is the only way in. */}
              <td className="mono muted">
                {user.email && user.email !== user.username ? user.username : ''}
                {!user.email ? user.username : ''}
              </td>
              <td>
                <select
                  value={user.role}
                  aria-label={`Role for ${user.username}`}
                  disabled={busy !== null}
                  onChange={(event) =>
                    onPatch(
                      user,
                      { role: event.target.value },
                      `${user.username} is now ${event.target.value === 'admin' ? 'an administrator' : 'staff'}`,
                    )
                  }
                  style={{ width: 'auto' }}
                >
                  <option value="staff">Staff</option>
                  <option value="admin">Administrator</option>
                </select>
              </td>
              <td>{describeState(user)}</td>
              <td>{user.lastLogin ? formatDateTime(user.lastLogin) : 'Never'}</td>
              <td className="num">
                <div className="row" style={{ justifyContent: 'flex-end', gap: '0.4rem' }}>
                  {user.active && (
                    <button type="button" className="btn-sm" disabled={busy !== null} onClick={() => onInvite(user)}>
                      {user.pending ? 'Resend invite' : 'Send reset link'}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn-sm"
                    disabled={busy !== null}
                    onClick={() =>
                      onPatch(
                        user,
                        { active: !user.active },
                        `${user.username} ${user.active ? 'deactivated' : 'reactivated'}`,
                      )
                    }
                  >
                    {user.active ? 'Deactivate' : 'Reactivate'}
                  </button>
                  <button
                    type="button"
                    className="btn-sm btn-danger"
                    disabled={busy !== null}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Delete ${user.username}? They lose access immediately and any outstanding ` +
                            'invitation stops working. Deactivating keeps the account and its history.',
                        )
                      )
                        onDelete(user);
                    }}
                  >
                    Delete
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The one thing a reader actually scans this table for. */
function describeState(user) {
  if (!user.active) return 'Deactivated';
  if (user.pending) return user.invitedAt ? 'Invited, not yet accepted' : 'No password set';
  if (user.mustChangePassword) return 'Must change password';
  return 'Active';
}
