import { type FormEvent, useState } from 'react';
import { posDevice, requestPasswordReset, signInStaff } from '../../infra/session';
import { ErrorBox } from '../../ui/components';

export function LoginScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [resetSent, setResetSent] = useState(false);
  const till = posDevice();

  async function forgot() {
    if (!email.trim()) {
      setError(new Error('Enter your email first, then press "Forgot password?"'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await requestPasswordReset(email.trim());
      setResetSent(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signInStaff(email.trim(), password);
      onSignedIn();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page" style={{ maxWidth: 420, margin: '8vh auto' }}>
      <img className="brand-logo" src="/logo-192.png" alt="MY FOOD — Chefelisha Restaurant" />
      <h1 style={{ margin: 0 }}>Sign in</h1>
      {till ? <div className="muted">This till: {till.name}</div> : null}
      <form className="panel" onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label>
          Email
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        <ErrorBox error={error} />
        <button className="btn primary big" disabled={busy} type="submit">
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      {resetSent ? (
        <div className="small" role="status">
          If {email.trim()} has an account, an email with a link to set a new password is on its way.
        </div>
      ) : (
        <button type="button" className="link small" disabled={busy} onClick={() => void forgot()}>
          Forgot password?
        </button>
      )}
      <a className="muted small" href="/pair">
        Set up this device (pairing code)
      </a>
    </div>
  );
}
