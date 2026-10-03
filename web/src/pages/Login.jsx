import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import Wordmark from '../components/Wordmark.jsx';

export default function Login({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  // Offered only where a click would actually produce an email: the migration
  // has been run and SendGrid is configured.
  const [canReset, setCanReset] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .resetConfig()
      .then((config) => !cancelled && setCanReset(Boolean(config.available)))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onLogin(email.trim(), password);
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

        {error && <div className="banner error">{error}</div>}

        <label className="stack" style={{ gap: '0.35rem' }}>
          <span className="label">Email address</span>
          {/* Not type="email": accounts created before this dashboard had
              addresses sign in with a plain username, and the browser would
              refuse to submit one. */}
          <input
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
            inputMode="email"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck="false"
            autoFocus
            required
          />
        </label>

        <label className="stack" style={{ gap: '0.35rem' }}>
          <span className="label">Password</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
          />
        </label>

        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        {canReset && (
          <Link to="/forgot-password" className="muted" style={{ fontSize: '0.8125rem', textAlign: 'center' }}>
            Forgot your password?
          </Link>
        )}
      </form>
    </div>
  );
}
