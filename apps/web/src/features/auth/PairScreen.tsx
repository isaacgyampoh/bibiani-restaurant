import type { PairDeviceResult } from '@rp/contracts';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { navigate } from '../../infra/router';
import { collectPairing, pairDevice, requestPairing } from '../../infra/session';
import { ErrorBox } from '../../ui/components';
import { Icon } from '../../ui/icons';
import { InstallAppButton } from '../../ui/install';
import { BrandPanel } from './LoginScreen';

const homeOf = (r: PairDeviceResult) =>
  r.device.kind === 'kds' ? '/kds' : r.device.kind === 'customer_display' ? '/display' : '/login';

/**
 * "Pair this device". By default the device shows a short code; a manager enters it in Settings,
 * Devices, and this screen continues by itself. A code from a manager can be typed instead.
 */
export function PairScreen({ onPaired }: { onPaired: () => void }) {
  const [mode, setMode] = useState<'show' | 'enter'>('show');
  const done = useCallback(
    (r: PairDeviceResult) => {
      onPaired();
      navigate(homeOf(r), true);
    },
    [onPaired],
  );
  return (
    <div className="auth">
      <BrandPanel />
      <div className="auth-card">
        {mode === 'show' ? <ShowCode onPaired={done} /> : <EnterCode onPaired={done} />}
        <InstallAppButton className="btn block" />
        <div className="auth-foot">
          <button type="button" className="link" onClick={() => setMode(mode === 'show' ? 'enter' : 'show')}>
            {mode === 'show' ? 'I have a code from a manager' : 'Show a code on this device instead'}
          </button>
          <a href="/login" className="back-link">
            <Icon name="arrow-left" size={16} /> Sign in
          </a>
        </div>
      </div>
    </div>
  );
}

function ShowCode({ onPaired }: { onPaired: (r: PairDeviceResult) => void }) {
  const [request, setRequest] = useState<{ code: string; expiresAt: string } | null>(null);
  const secret = useRef<string | null>(null); // kept in memory only, never stored
  const [error, setError] = useState<unknown>(null);
  const fresh = useCallback(async () => {
    setError(null);
    try {
      const r = await requestPairing();
      secret.current = r.secret;
      setRequest({ code: r.code, expiresAt: r.expiresAt });
    } catch (e) {
      setError(e);
    }
  }, []);
  useEffect(() => {
    void fresh();
  }, [fresh]);
  useEffect(() => {
    if (!request) return;
    let stopped = false;
    const tick = async () => {
      if (stopped || !secret.current) return;
      try {
        const result = await collectPairing(secret.current);
        if (result) {
          stopped = true;
          onPaired(result);
        }
      } catch (e) {
        // Expired (or already used): show a new code.
        if ((e as { code?: string }).code === 'PAIRING_CODE_INVALID') void fresh();
        else setError(e);
      }
    };
    const t = setInterval(() => void tick(), 3000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [request, fresh, onPaired]);
  return (
    <>
      <h1>Pair this device</h1>
      <p className="lead">
        On a manager's screen open <strong>Devices &amp; printing</strong>, choose this device and press{' '}
        <strong>Enter code from device</strong>. Type this code:
      </p>
      <div className="pair-code" aria-live="polite">
        {request ? request.code : '····-····'}
      </div>
      <p className="small muted center-text" role="status">
        {request
          ? `Waiting for approval · a new code appears after ${new Date(request.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
          : 'Getting a code…'}
      </p>
      <ErrorBox error={error} />
    </>
  );
}

function EnterCode({ onPaired }: { onPaired: (r: PairDeviceResult) => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onPaired(await pairDevice(code));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <h1>Enter a pairing code</h1>
      <p className="lead">
        The 8-character code a manager created in Devices &amp; printing. It works once and expires after 10
        minutes.
      </p>
      <form className="form" onSubmit={submit}>
        <input
          className="code-input"
          aria-label="Pairing code"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="e.g. K7M4Q2RT"
          maxLength={12}
          autoComplete="off"
        />
        <ErrorBox error={error} />
        <button className="btn primary lg block" disabled={busy || code.length < 6} type="submit">
          {busy ? 'Pairing…' : 'Pair device'}
        </button>
      </form>
    </>
  );
}
