import { type FormEvent, useState } from 'react';
import { posDevice, requestPasswordReset, signInStaff, signInWithPin, tillApi } from '../../infra/session';
import { ErrorBox, Field, PinPad } from '../../ui/components';

export function Brand() {
  return (
    <div className="auth-brand">
      <img className="brand-logo" src="/logo-192.png" alt="MY FOOD — Chefelisha Restaurant" />
      <span className="brand-title">Chefelisha Restaurant</span>
    </div>
  );
}

/**
 * Sign-in. On a registered till, staff unlock it with their PIN (the till proves where they are);
 * managers and owners can always use email and password, which is the only way in elsewhere.
 */
export function LoginScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const till = posDevice();
  const [mode, setMode] = useState<'pin' | 'email' | 'forgot-pin'>(till?.pinReady ? 'pin' : 'email');
  return (
    <div className="auth">
      <div className="auth-card">
        <Brand />
        {mode === 'pin' && till ? (
          <PinSignIn
            tillName={till.name}
            onSignedIn={onSignedIn}
            onEmail={() => setMode('email')}
            onForgot={() => setMode('forgot-pin')}
          />
        ) : mode === 'forgot-pin' ? (
          <ForgotPin onBack={() => setMode('pin')} />
        ) : (
          <EmailSignIn
            tillName={till?.name ?? null}
            onSignedIn={onSignedIn}
            onPin={till?.pinReady ? () => setMode('pin') : null}
          />
        )}
      </div>
    </div>
  );
}

function PinSignIn({
  tillName,
  onSignedIn,
  onEmail,
  onForgot,
}: {
  tillName: string;
  onSignedIn: () => void;
  onEmail: () => void;
  onForgot: () => void;
}) {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [shake, setShake] = useState(false);
  async function submit() {
    if (pin.length < 4 || busy) return;
    setBusy(true);
    setError(null);
    try {
      await signInWithPin(pin);
      onSignedIn();
    } catch (e) {
      setError(e);
      setPin('');
      setShake(true);
      setTimeout(() => setShake(false), 350);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <h1>Enter your staff PIN</h1>
      <p className="lead">{tillName}</p>
      <PinPad
        value={pin}
        onChange={(v) => {
          setError(null);
          setPin(v);
        }}
        onSubmit={() => void submit()}
        disabled={busy}
        shake={shake}
      />
      <ErrorBox error={error} />
      <button
        type="button"
        className="btn primary xl block"
        disabled={pin.length < 4 || busy}
        onClick={() => void submit()}
      >
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
      <div className="auth-foot">
        <button type="button" className="link" onClick={onForgot}>
          Forgot PIN?
        </button>
        <button type="button" className="link" onClick={onEmail}>
          Manager sign-in (email)
        </button>
      </div>
    </>
  );
}

function ForgotPin({ onBack }: { onBack: () => void }) {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await tillApi.pinRecovery(email.trim());
      setSent(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <h1>Forgot your PIN?</h1>
      {sent ? (
        <div className="info-box ok" role="status">
          If <strong>{email.trim()}</strong> belongs to a staff member here, a link to choose a new PIN is on
          its way. Your old PIN stops working once you set the new one. A manager can also reset it for you.
        </div>
      ) : (
        <form className="form" onSubmit={submit}>
          <p className="lead">We will email a link to the address your manager registered for you.</p>
          <Field label="Your email" required>
            <input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </Field>
          <ErrorBox error={error} />
          <button type="submit" className="btn primary lg block" disabled={busy}>
            {busy ? 'Sending…' : 'Email me a link'}
          </button>
        </form>
      )}
      <div className="auth-foot">
        <button type="button" className="link" onClick={onBack}>
          ← Back to PIN
        </button>
      </div>
    </>
  );
}

function EmailSignIn({
  tillName,
  onSignedIn,
  onPin,
}: {
  tillName: string | null;
  onSignedIn: () => void;
  onPin: (() => void) | null;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [resetSent, setResetSent] = useState(false);

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
    <>
      <h1>Sign in</h1>
      {tillName ? <p className="lead">This till: {tillName}</p> : null}
      <form className="form" onSubmit={submit}>
        <Field label="Email">
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </Field>
        <Field label="Password">
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </Field>
        <ErrorBox error={error} />
        <button className="btn primary lg block" disabled={busy} type="submit">
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      {resetSent ? (
        <div className="info-box ok" role="status">
          If {email.trim()} has an account, an email with a link to set a new password is on its way.
        </div>
      ) : null}
      <div className="auth-foot">
        {resetSent ? (
          <span />
        ) : (
          <button type="button" className="link" disabled={busy} onClick={() => void forgot()}>
            Forgot password?
          </button>
        )}
        {onPin ? (
          <button type="button" className="link" onClick={onPin}>
            Staff PIN sign-in
          </button>
        ) : (
          <a href="/pair">Set up this device</a>
        )}
      </div>
    </>
  );
}
