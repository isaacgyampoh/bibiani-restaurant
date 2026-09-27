import type { MeView } from '@rp/contracts';
import { type FormEvent, useEffect, useState } from 'react';
import { navigate } from '../../infra/router';
import { api, currentSession, registerThisDevice, signInWithPin } from '../../infra/session';
import { ErrorBox, Field } from '../../ui/components';
import { BrandPanel } from './LoginScreen';

/**
 * Landing page of an emailed sign-in link (owners and managers). The email proves who you are;
 * here you register this device for PIN sign-in and, if you forgot your PIN or have none yet,
 * choose a new one. The old PIN is never shown or sent; a new one replaces it at once.
 */
export function DeviceSetupScreen({ onDone }: { onDone: () => void }) {
  const [me, setMe] = useState<MeView | null | undefined>(undefined);
  const [newPin, setNewPin] = useState(false);
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const linkError = new URLSearchParams(window.location.hash.slice(1)).get('error_description');

  useEffect(() => {
    const t = setTimeout(async () => {
      if (!(await currentSession())) return setMe(null);
      try {
        setMe(await api.me());
      } catch (e) {
        setError(e);
        setMe(null);
      }
    }, 300);
    return () => clearTimeout(t);
  }, []);

  const needsPin = !!me && (!me.pin?.hasPin || me.pin.mustChange);

  async function finish(e?: FormEvent) {
    e?.preventDefault();
    if ((needsPin || newPin) && pin !== confirm) {
      setError(new Error('The two PINs do not match'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (needsPin || newPin) await api.changePin({ newPin: pin });
      await registerThisDevice();
      if (needsPin || newPin) {
        await signInWithPin(pin);
        onDone();
        navigate('/', true);
      } else {
        onDone();
        navigate('/login', true);
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const frame = (content: React.ReactNode) => (
    <div className="auth">
      <BrandPanel />
      <div className="auth-card">{content}</div>
    </div>
  );

  if (me === undefined && !linkError) return frame(<p className="lead">Checking your link…</p>);
  if (!me)
    return frame(
      <>
        <h1>Link expired</h1>
        <p className="lead">
          {linkError ?? 'This link is no longer valid.'} Links work once and expire after an hour.
        </p>
        <ErrorBox error={error} />
        <a className="btn primary lg block" href="/login">
          Get a new link
        </a>
      </>,
    );

  const pinFields = (
    <>
      <Field label="Choose your PIN" required hint="4 to 6 digits. Not 1234 or 1111. Nobody else can see it.">
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
    </>
  );

  return frame(
    <>
      <h1>Set up this device</h1>
      <p className="lead">Hello {me.displayName}. From now on you sign in on this device with your PIN.</p>
      {needsPin || newPin ? (
        <form className="form" onSubmit={finish}>
          {pinFields}
          <ErrorBox error={error} />
          <button className="btn primary lg block" disabled={busy} type="submit">
            {busy ? 'Saving…' : 'Save PIN and use this device'}
          </button>
        </form>
      ) : (
        <>
          <ErrorBox error={error} />
          <button
            className="btn primary lg block"
            disabled={busy}
            type="button"
            onClick={() => void finish()}
          >
            {busy ? 'Setting up…' : 'Use this device with my PIN'}
          </button>
          <div className="auth-foot">
            <button type="button" className="link" onClick={() => setNewPin(true)}>
              Forgot your PIN? Choose a new one
            </button>
          </div>
        </>
      )}
    </>,
  );
}
