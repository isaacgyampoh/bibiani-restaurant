import type { PairDeviceResult } from '@rp/contracts';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { navigate } from '../../infra/router';
import { collectPairing, onHub, pairDevice, posDevice, requestPairing } from '../../infra/session';
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
  // Already paired: say so, and pair again only on purpose (no code is requested until then).
  const [again, setAgain] = useState(false);
  const till = posDevice();
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
        {till && !again ? (
          <>
            <h1>This device is already paired</h1>
            <p className="lead">
              It is <strong>{till.name}</strong>. Staff sign in with their PIN.
            </p>
            <a className="btn primary lg block" href="/login">
              Go to sign-in
            </a>
            <button type="button" className="btn block" onClick={() => setAgain(true)}>
              Pair this device again
            </button>
          </>
        ) : mode === 'show' ? (
          <ShowCode onPaired={done} />
        ) : (
          <EnterCode onPaired={done} />
        )}
        <InstallAppButton className="btn block" />
        <div className="auth-foot">
          {onHub ? null : (
            <button
              type="button"
              className="link"
              onClick={() => setMode(mode === 'show' ? 'enter' : 'show')}
            >
              {mode === 'show' ? 'I have a code from a manager' : 'Show a code on this device instead'}
            </button>
          )}
          <a href="/login" className="back-link">
            <Icon name="arrow-left" size={16} /> Sign in
          </a>
        </div>
      </div>
    </div>
  );
}

/**
 * The device's own code. State machine: requesting → showing (asks every 3 s whether the code was
 * entered) → paired (stops, leaves this screen for good). One code per screen at a time: a new code
 * comes only when the server says the current one expired, or when "Show a new code" is pressed,
 * and the previous code then stops working. Network trouble keeps the same code on screen.
 */
function ShowCode({ onPaired }: { onPaired: (r: PairDeviceResult) => void }) {
  const [request, setRequest] = useState<{ code: string; shownAt: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const secret = useRef<string | null>(null); // kept in memory only, never stored
  const requesting = useRef(false);
  const paired = useRef(false);
  const fresh = useCallback(async (replace: boolean) => {
    if (requesting.current || paired.current) return;
    requesting.current = true;
    setError(null);
    try {
      const r = await requestPairing(replace ? secret.current : null);
      secret.current = r.secret;
      setRequest({ code: r.code, shownAt: Date.now() });
    } catch (e) {
      setError(e);
    } finally {
      requesting.current = false;
    }
  }, []);
  useEffect(() => {
    if (!secret.current) void fresh(false);
  }, [fresh]);
  useEffect(() => {
    if (!request) return;
    let stopped = false;
    let inFlight = false;
    const tick = async () => {
      if (stopped || inFlight || paired.current || !secret.current) return;
      inFlight = true;
      try {
        const result = await collectPairing(secret.current);
        if (result && !stopped) {
          stopped = true;
          paired.current = true;
          onPaired(result);
        } else setNotice(null);
      } catch (e) {
        if ((e as { code?: string }).code === 'PAIRING_CODE_INVALID') {
          // The server ended this code (expired or replaced): exactly one new code.
          stopped = true;
          void fresh(true);
        } else setNotice('No connection to MY FOOD right now. This code still works; waiting…');
      } finally {
        inFlight = false;
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
      {onHub ? (
        <p className="lead">
          On the <strong>MY FOOD Hub</strong> computer, in the hub window, choose this device, type this code
          and a manager's PIN:
        </p>
      ) : (
        <p className="lead">
          On a manager's screen open <strong>Devices &amp; printing</strong>, find <strong>this</strong>{' '}
          device (e.g. the till's name) and press <strong>Enter code from device</strong>. Type this code:
        </p>
      )}
      <div className="pair-code" aria-live="polite">
        {request ? request.code : '····-····'}
      </div>
      <p className="small muted center-text" role="status">
        {request ? 'Waiting for approval · the code works for 10 minutes' : 'Getting a code…'}
      </p>
      {notice ? <p className="small muted center-text">{notice}</p> : null}
      <ErrorBox error={error} />
      {request || error ? (
        <button type="button" className="btn block" onClick={() => void fresh(true)}>
          Show a new code
        </button>
      ) : null}
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
