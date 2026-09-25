import { type FormEvent, useState } from 'react';
import { navigate } from '../../infra/router';
import { pairDevice } from '../../infra/session';
import { ErrorBox } from '../../ui/components';
import { Brand } from './LoginScreen';

/** Run on the device itself. A manager generates the one-time code in Admin → Devices. */
export function PairScreen({ onPaired }: { onPaired: () => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await pairDevice(code);
      onPaired();
      navigate(
        result.device.kind === 'kds'
          ? '/kds'
          : result.device.kind === 'customer_display'
            ? '/display'
            : '/login',
        true,
      );
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <div className="auth-card">
        <Brand />
        <h1>Set up this device</h1>
        <p className="lead">
          Enter the 8-character code from Devices &amp; printing. A code works once and expires after 10
          minutes.
        </p>
        <form className="form" onSubmit={submit}>
          <input
            aria-label="Pairing code"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="e.g. K7M4Q2RT"
            style={{ height: 64, fontSize: 28, letterSpacing: '0.2em', textAlign: 'center', fontWeight: 800 }}
            maxLength={12}
          />
          <ErrorBox error={error} />
          <button className="btn primary lg block" disabled={busy || code.length < 6} type="submit">
            {busy ? 'Pairing…' : 'Pair device'}
          </button>
        </form>
        <div className="auth-foot">
          <a href="/login">← Back to sign in</a>
        </div>
      </div>
    </div>
  );
}
