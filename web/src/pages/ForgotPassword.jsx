import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import Wordmark from '../components/Wordmark.jsx';

/**
 * "I forgot my password", signed out.
 *
 * The API answers the same way whether or not the account exists, and this
 * page repeats that answer verbatim — anything more helpful would turn the
 * form into a way of checking who has an account here.
 */
export default function ForgotPassword() {
  const [username, setUsername] = useState('');
  const [sent, setSent] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [config, setConfig] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api
      .resetConfig()
      .then((payload) => !cancelled && setConfig(payload))
      .catch(() => !cancelled && setConfig({ available: false, missing: [] }));
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload = await api.forgotPassword(username.trim());
      setSent(payload.message);
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

        <h1 style={{ fontSize: '1.125rem' }}>Reset your password</h1>
        <p className="muted" style={{ margin: 0, fontSize: '0.8125rem' }}>
          Enter the email address you sign in with and we will send you a link to set a new password.
        </p>

        {error && <div className="banner error">{error}</div>}
        {sent && <div className="banner success">{sent}</div>}
        {config && !config.available && <UnavailableNotice config={config} />}

        {!sent && (
          <>
            <label className="stack" style={{ gap: '0.35rem' }}>
              <span className="label">Email address</span>
              <input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="email"
                inputMode="email"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck="false"
                autoFocus
                required
              />
            </label>

            <button type="submit" className="btn-primary" disabled={busy}>
              {busy ? 'Sending…' : 'Email me a reset link'}
            </button>
          </>
        )}

        <Link to="/" className="muted" style={{ fontSize: '0.8125rem', textAlign: 'center' }}>
          Back to sign in
        </Link>
      </form>
    </div>
  );
}

/**
 * Says what an administrator has to do, rather than letting somebody submit a
 * form that quietly cannot send anything.
 */
function UnavailableNotice({ config }) {
  return (
    <div className="banner">
      <strong>Reset email is not set up yet.</strong>
      <div style={{ marginTop: '0.35rem', fontSize: '0.8125rem' }}>
        {config.missing?.length > 0 && <div>Set {config.missing.join(', ')} in the server environment.</div>}
      </div>
    </div>
  );
}
