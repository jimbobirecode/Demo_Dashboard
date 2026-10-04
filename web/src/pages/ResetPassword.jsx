import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import Wordmark from '../components/Wordmark.jsx';

/**
 * The page an emailed reset link lands on.
 *
 * The token is checked before the form is drawn, so an expired or already-used
 * link says so straight away rather than after the reader has typed a new
 * password twice. Redeeming it does not sign anybody in — the new password is
 * proved at the login screen, which keeps the emailed link from being a way in
 * on its own.
 */
export default function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';

  const [state, setState] = useState({ status: 'checking' });
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setState({ status: 'invalid', reason: 'This link is missing its token. Request a new one.' });
      return undefined;
    }

    api
      .checkResetToken(token)
      .then((payload) => !cancelled && setState({ status: 'ready', ...payload }))
      .catch((err) => !cancelled && setState({ status: 'invalid', reason: err.message }));

    return () => {
      cancelled = true;
    };
  }, [token]);

  async function handleSubmit(event) {
    event.preventDefault();
    if (password !== confirm) return setError('Passwords do not match');
    if (password.length < 8) return setError('Password must be at least 8 characters');

    setBusy(true);
    setError(null);
    try {
      const result = await api.resetPassword(token, password, confirm);
      setState((current) => ({ ...current, status: 'done', purpose: result?.purpose ?? current.purpose }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <form className="card login-card" onSubmit={handleSubmit}>
        <Wordmark />

        {state.status === 'checking' && <div className="empty">Checking your link…</div>}

        {state.status === 'invalid' && (
          <>
            <div className="banner error">{state.reason}</div>
            <Link to="/forgot-password" className="btn-primary" style={{ textAlign: 'center' }}>
              Request a new link
            </Link>
          </>
        )}

        {state.status === 'done' && (
          <>
            <div className="banner success">
              {state.purpose === 'invite'
                ? 'Your password is set. Sign in to reach the dashboard.'
                : 'Your password has been changed. Sign in with your new password.'}
            </div>
            <Link to="/" className="btn-primary" style={{ textAlign: 'center' }}>
              Go to sign in
            </Link>
          </>
        )}

        {state.status === 'ready' && (
          <>
            <h1 style={{ fontSize: '1.125rem' }}>
              {state.purpose === 'invite' ? 'Set your password' : 'Choose a new password'}
            </h1>
            <p className="muted" style={{ margin: 0, fontSize: '0.8125rem' }}>
              {state.purpose === 'invite' && (
                <>You have been given access to the {state.clubName ?? 'club'} dashboard. </>
              )}
              For {state.username}
              {state.email ? ` (${state.email})` : ''}. At least 8 characters.
            </p>

            {error && <div className="banner error">{error}</div>}

            <label className="stack" style={{ gap: '0.35rem' }}>
              <span className="label">New password</span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
                autoFocus
                required
              />
            </label>

            <label className="stack" style={{ gap: '0.35rem' }}>
              <span className="label">Confirm password</span>
              <input
                type="password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                autoComplete="new-password"
                required
              />
            </label>

            <button type="submit" className="btn-primary" disabled={busy}>
              {busy ? 'Saving…' : state.purpose === 'invite' ? 'Set password' : 'Set new password'}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
