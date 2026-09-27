import type { Session } from '@supabase/supabase-js';
import { type FormEvent, useEffect, useState } from 'react';
import { navigate } from '../../infra/router';
import { acceptOwnerInvitation, currentSession, startOwnerOnboarding } from '../../infra/session';
import { ErrorBox, Field } from '../../ui/components';
import { BrandPanel } from './LoginScreen';

/**
 * Owner sign-up, step 1: "Set up your restaurant". The owner enters the email their MY FOOD contact
 * invited. The answer is the same for every address (nobody can probe which emails are invited).
 */
export function WelcomeScreen() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await startOwnerOnboarding(email);
      setSent(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth">
      <BrandPanel />
      <div className="auth-card">
        {sent ? (
          <>
            <h1>Check your email</h1>
            <p className="lead">
              If <strong>{email.trim()}</strong> was invited, a verification link is on its way. It works once
              and expires after an hour. Open it on this device to continue.
            </p>
            <p className="small muted">
              Nothing after a few minutes? Check spam, then ask your MY FOOD contact to confirm the
              invitation.
            </p>
            <button type="button" className="btn lg block" onClick={() => setSent(false)}>
              Use a different email
            </button>
          </>
        ) : (
          <>
            <h1>Set up your restaurant</h1>
            <p className="lead">
              Enter the email address your MY FOOD contact invited as the restaurant owner.
            </p>
            <form className="form" onSubmit={submit}>
              <Field label="Owner email" required>
                <input
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </Field>
              <ErrorBox error={error} />
              <button className="btn primary lg block" disabled={busy} type="submit">
                {busy ? 'Sending…' : 'Send verification link'}
              </button>
            </form>
            <a className="small" href="/login">
              Already set up? Sign in
            </a>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Owner sign-up, step 2 (landing page of the verification email): the link has proved the email.
 * The owner gives their name and chooses their own password; they then become the Owner.
 */
export function WelcomeVerifyScreen({ onDone }: { onDone: () => void }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [fullName, setFullName] = useState('');
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const linkError = new URLSearchParams(window.location.hash.slice(1)).get('error_description');
  useEffect(() => {
    const t = setTimeout(() => void currentSession().then(setSession), 300);
    return () => clearTimeout(t);
  }, []);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (pin !== confirm) {
      setError(new Error('The two PINs do not match'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Become Owner with your own PIN; this device is registered and signed in with the PIN.
      await acceptOwnerInvitation(fullName, pin);
      navigate('/setup', true);
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  if (session === undefined && !linkError)
    return (
      <div className="auth">
        <BrandPanel />
        <div className="auth-card">
          <p className="lead">Checking your link…</p>
        </div>
      </div>
    );
  if (!session)
    return (
      <div className="auth">
        <BrandPanel />
        <div className="auth-card">
          <h1>Link expired</h1>
          <p className="lead">
            {linkError ?? 'This link is no longer valid.'} Links work once and expire after an hour.
          </p>
          <a className="btn primary lg block" href="/welcome">
            Send a new link
          </a>
        </div>
      </div>
    );
  return (
    <div className="auth">
      <BrandPanel />
      <div className="auth-card">
        <h1>Welcome to MY FOOD</h1>
        <p className="lead">
          Email verified: <strong>{session.user.email}</strong>. Finish your owner account: every day you will
          sign in with your PIN. Your email stays your way back in if you forget it.
        </p>
        <form className="form" onSubmit={submit}>
          <Field label="Your full name" required>
            <input
              autoComplete="name"
              required
              minLength={2}
              maxLength={80}
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
            />
          </Field>
          <Field
            label="Choose your PIN"
            required
            hint="4 to 6 digits. Not 1234 or 1111. Nobody else can see it."
          >
            <input
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              pattern="[0-9]{4,6}"
              maxLength={6}
              required
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
            />
          </Field>
          <Field label="Repeat the PIN" required>
            <input
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              pattern="[0-9]{4,6}"
              maxLength={6}
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value.replace(/\D/g, '').slice(0, 6))}
            />
          </Field>
          <ErrorBox error={error} />
          <button className="btn primary lg block" disabled={busy} type="submit">
            {busy ? 'Setting up…' : 'Create owner account'}
          </button>
        </form>
      </div>
    </div>
  );
}
