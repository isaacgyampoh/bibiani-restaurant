import type { Session } from '@supabase/supabase-js';
import { type FormEvent, useEffect, useState } from 'react';
import { navigate } from '../../infra/router';
import {
  acceptOwnerInvitation,
  currentSession,
  setNewPassword,
  startOwnerOnboarding,
} from '../../infra/session';
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
  const [password, setPassword] = useState('');
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
    if (password !== confirm) {
      setError(new Error('The two passwords do not match'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Become Owner while the email-link session is fresh, then set the password.
      await acceptOwnerInvitation(fullName);
      await setNewPassword(password);
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
          Email verified: <strong>{session.user.email}</strong>. Finish your owner account.
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
            label="Choose a password"
            required
            hint="At least 10 characters. Passwords known from data breaches are refused."
          >
            <input
              type="password"
              autoComplete="new-password"
              minLength={10}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Field label="Repeat the password" required>
            <input
              type="password"
              autoComplete="new-password"
              minLength={10}
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
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
