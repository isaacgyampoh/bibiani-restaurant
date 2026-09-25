import type { Session } from '@supabase/supabase-js';
import { type FormEvent, useEffect, useState } from 'react';
import { navigate } from '../../infra/router';
import { currentSession, setNewPassword } from '../../infra/session';
import { ErrorBox } from '../../ui/components';
import { Brand } from './LoginScreen';

/**
 * Landing page of a password reset / invitation email. Supabase signs the person in from the link;
 * they choose their own password here. Nobody else ever sees or sets it.
 */
export function SetPasswordScreen({ onDone }: { onDone: () => void }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const linkError = new URLSearchParams(window.location.hash.slice(1)).get('error_description');

  useEffect(() => {
    // The session from the link is picked up asynchronously; give it a moment.
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
      await setNewPassword(password);
      navigate('/', true);
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
        <div className="auth-card">
          <Brand />
          <p className="lead">Checking your link…</p>
        </div>
      </div>
    );
  if (!session)
    return (
      <div className="auth">
        <div className="auth-card">
          <Brand />
          <h1>Link expired</h1>
          <p className="lead">
            {linkError ?? 'This link is no longer valid.'} Links work once and expire after an hour. Go to
            sign in, enter your email and press "Forgot password?" to get a new one.
          </p>
          <a className="btn primary lg block" href="/login">
            Go to sign in
          </a>
        </div>
      </div>
    );
  return (
    <div className="auth">
      <div className="auth-card">
        <Brand />
        <h1>Set your password</h1>
        <p className="lead">{session.user.email}</p>
        <form className="form" onSubmit={submit}>
          <label>
            New password
            <input
              type="password"
              autoComplete="new-password"
              minLength={10}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          <label>
            Repeat new password
            <input
              type="password"
              autoComplete="new-password"
              minLength={10}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
          </label>
          <div className="small muted">
            At least 10 characters. Passwords known from data breaches are refused.
          </div>
          <ErrorBox error={error} />
          <button className="btn primary lg block" disabled={busy} type="submit">
            {busy ? 'Saving…' : 'Save password'}
          </button>
        </form>
      </div>
    </div>
  );
}
