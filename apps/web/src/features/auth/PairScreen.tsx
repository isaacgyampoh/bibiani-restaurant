import { type FormEvent, useState } from 'react';
import { navigate } from '../../infra/router';
import { pairDevice } from '../../infra/session';
import { ErrorBox } from '../../ui/components';

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
    <div className="page" style={{ maxWidth: 460, margin: '8vh auto' }}>
      <img className="brand-logo" src="/logo-192.png" alt="" />
      <h1 style={{ margin: 0 }}>Set up this device</h1>
      <p className="muted">
        Enter the 8-character code shown in Admin → Devices. Codes work once and expire after 10 minutes.
      </p>
      <form className="panel" onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <input
          aria-label="Pairing code"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="e.g. K7M4Q2RT"
          style={{ fontSize: 32, letterSpacing: '0.2em', textAlign: 'center', fontWeight: 800 }}
          maxLength={12}
        />
        <ErrorBox error={error} />
        <button className="btn primary big" disabled={busy || code.length < 6} type="submit">
          {busy ? 'Pairing…' : 'Pair device'}
        </button>
      </form>
    </div>
  );
}
