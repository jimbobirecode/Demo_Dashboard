import { useState } from 'react';

/**
 * Two uses. Forced (the default): somebody signed in with a temporary password
 * and may do nothing else until they choose one, so it fills the screen and
 * asks only for the new password. Voluntary (`requireCurrent`): a signed-in
 * member of staff changing their own, who must prove the current one first —
 * an unlocked screen is not enough to take an account over.
 */
export default function ChangePassword({ onSubmit, requireCurrent = false, onDone }) {
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    if (requireCurrent && !current) return setError('Enter your current password');
    if (password !== confirm) return setError('Passwords do not match');
    if (password.length < 8) return setError('Password must be at least 8 characters');

    setBusy(true);
    setError(null);
    try {
      await onSubmit(password, requireCurrent ? current : undefined);
      setDone(true);
      setCurrent('');
      setPassword('');
      setConfirm('');
      onDone?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const form = (
    <form className="card login-card" onSubmit={handleSubmit}>
      <h1 style={{ fontSize: '1.125rem' }}>{requireCurrent ? 'Change your password' : 'Set a permanent password'}</h1>
      <p className="muted" style={{ margin: 0, fontSize: '0.8125rem' }}>
        {requireCurrent
          ? 'You will stay signed in here; any other device signed in as you is signed out.'
          : 'You signed in with a temporary password. Choose a permanent one to continue.'}
      </p>

      {error && <div className="banner error">{error}</div>}
      {done && requireCurrent && <div className="banner success">Password changed.</div>}

      {requireCurrent && (
        <label className="stack" style={{ gap: '0.35rem' }}>
          <span className="label">Current password</span>
          <input
            type="password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
            autoComplete="current-password"
            autoFocus
            required
          />
        </label>
      )}

      <label className="stack" style={{ gap: '0.35rem' }}>
        <span className="label">New password</span>
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="new-password"
          autoFocus={!requireCurrent}
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
        {busy ? 'Saving…' : 'Save password'}
      </button>
    </form>
  );

  // Inside the dashboard the page is one card among the app's chrome; on the
  // forced change it is the whole screen, like the login it follows.
  return requireCurrent ? <div className="stack">{form}</div> : <div className="login-page">{form}</div>;
}
