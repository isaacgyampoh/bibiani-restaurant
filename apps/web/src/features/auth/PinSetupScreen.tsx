import type { MeView } from '@rp/contracts';
import { useState } from 'react';
import { navigate } from '../../infra/router';
import { api, signOut } from '../../infra/session';
import { ErrorBox, PinPad } from '../../ui/components';
import { Brand } from './LoginScreen';

/**
 * The staff member chooses their own PIN: on first sign-in (activation) after the owner assigned
 * one, after an owner reset, or from an emailed recovery link. The previous PIN stops working.
 */
export function PinSetupScreen({
  me,
  reason,
  onDone,
}: {
  me: MeView;
  reason: 'activation' | 'recovery' | 'change';
  onDone: () => void;
}) {
  const [step, setStep] = useState<'current' | 'new' | 'confirm'>(reason === 'change' ? 'current' : 'new');
  const [current, setCurrent] = useState('');
  const [first, setFirst] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);

  async function next() {
    setError(null);
    if (step === 'current') {
      setCurrent(value);
      setValue('');
      setStep('new');
      return;
    }
    if (step === 'new') {
      setFirst(value);
      setValue('');
      setStep('confirm');
      return;
    }
    if (value !== first) {
      setError(new Error('The two PINs do not match. Start again.'));
      setFirst('');
      setValue('');
      setStep('new');
      return;
    }
    setBusy(true);
    try {
      await api.changePin({ currentPin: reason === 'change' ? current : null, newPin: value });
      setDone(true);
    } catch (e) {
      setError(e);
      setFirst('');
      setValue('');
      setStep(reason === 'change' ? 'current' : 'new');
    } finally {
      setBusy(false);
    }
  }

  const title =
    reason === 'activation'
      ? `Welcome, ${me.displayName.split(' ')[0]}`
      : reason === 'recovery'
        ? 'Choose a new PIN'
        : 'Change your PIN';
  const prompt =
    step === 'current'
      ? 'Enter your current PIN'
      : step === 'new'
        ? reason === 'activation'
          ? 'Choose your own PIN (4–6 digits). Only you will know it.'
          : 'Enter your new PIN (4–6 digits)'
        : 'Enter the new PIN again';
  return (
    <div className="auth">
      <div className="auth-card">
        <Brand />
        <h1>{title}</h1>
        {done ? (
          <>
            <div className="info-box ok" role="status">
              Your PIN is set. Use it to sign in on any till here; your old PIN no longer works.
            </div>
            <button
              type="button"
              className="btn primary lg block"
              onClick={() => {
                navigate('/', true);
                onDone();
              }}
            >
              Continue
            </button>
          </>
        ) : (
          <>
            <p className="lead">{prompt}</p>
            {reason === 'activation' && step === 'new' ? (
              <div className="info-box small">
                Your manager gave you a starting PIN. Replace it now with one only you know. Avoid 1234, 1111
                or your birthday.
              </div>
            ) : null}
            <PinPad value={value} onChange={setValue} onSubmit={() => void next()} disabled={busy} />
            <ErrorBox error={error} />
            <button
              type="button"
              className="btn primary xl block"
              disabled={value.length < 4 || busy}
              onClick={() => void next()}
            >
              {busy ? 'Saving…' : step === 'confirm' ? 'Save PIN' : 'Next'}
            </button>
            <div className="auth-foot">
              {reason === 'change' ? (
                <button type="button" className="link" onClick={onDone}>
                  Cancel
                </button>
              ) : (
                <button type="button" className="link" onClick={() => void signOut()}>
                  Sign out
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
