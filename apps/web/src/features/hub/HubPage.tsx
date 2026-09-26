import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { Alert, Badge, ErrorBox, Modal } from '../../ui/components';

/** What the hub reports about itself (GET /hub/status on the hub). */
export interface HubStatus {
  cloud: 'connected' | 'offline' | 'refused';
  lastSuccessAt: string | null;
  lastError: string | null;
  identity: { branchId: string; attached: boolean } | null;
  outbox: { pending: number; retrying: number; conflicts: number; oldestPendingAt: string | null };
  cloudPairing?: { status: 'waiting' | 'error'; code?: string; expiresAt?: string; message?: string } | null;
  addresses?: string[];
  release: string;
}

interface HubDevice {
  id: string;
  name: string;
  kind: string;
  isActive: boolean;
  paired: boolean;
}

const KIND: Record<string, string> = {
  pos: 'Till',
  kds: 'Kitchen screen',
  customer_display: 'Customer display',
};

async function getJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error?.message ?? 'Something went wrong');
  return json as T;
}

export function useHubStatus(everyMs = 5000): HubStatus | null {
  const [status, setStatus] = useState<HubStatus | null>(null);
  useEffect(() => {
    let stopped = false;
    const load = () =>
      getJson<HubStatus>('/hub/status')
        .then((s) => !stopped && setStatus(s))
        .catch(() => {});
    void load();
    const t = window.setInterval(load, everyMs);
    return () => {
      stopped = true;
      window.clearInterval(t);
    };
  }, [everyMs]);
  return status;
}

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'never';

/**
 * The MY FOOD Hub window, shown on the hub PC by the desktop app. For the restaurant manager:
 * is the hub connected, is everything sent, where do tills connect, and approve new devices.
 */
export function HubPage() {
  const status = useHubStatus();
  const [devices, setDevices] = useState<HubDevice[]>([]);
  const [approving, setApproving] = useState<HubDevice | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const loadDevices = useCallback(
    () =>
      getJson<{ devices: HubDevice[] }>('/hub/console/devices')
        .then((d) => setDevices(d.devices))
        .catch(() => {}),
    [],
  );
  useEffect(() => {
    void loadDevices();
  }, [loadDevices]);

  const pairing = status?.cloudPairing;
  const out = status?.outbox;
  return (
    <div className="hub-page">
      <header className="hub-head">
        <img src="/logo-192.png" alt="" />
        <div>
          <h1>MY FOOD Hub</h1>
          <span className="muted">
            Chefelisha Restaurant · keeps the restaurant running, also without internet
          </span>
        </div>
      </header>

      {!status ? (
        <p className="muted">Starting…</p>
      ) : pairing ? (
        <section className="hub-card">
          <h2>Connect this hub to MY FOOD</h2>
          <p>
            In the MY FOOD back office open <strong>Devices &amp; printing</strong>, find the device of type{' '}
            <strong>MY FOOD Hub</strong> and press <strong>Enter code from device</strong>. Type:
          </p>
          <div className="pair-code">{pairing.code ?? '····-····'}</div>
          {pairing.message ? <Alert tone="warn">{pairing.message}</Alert> : null}
        </section>
      ) : (
        <>
          <section className="hub-grid">
            <div className="hub-card">
              <span className="hub-label">Internet and MY FOOD cloud</span>
              <strong className={`hub-state ${status.cloud}`}>
                {status.cloud === 'connected'
                  ? 'Connected'
                  : status.cloud === 'offline'
                    ? 'Offline'
                    : 'Needs attention'}
              </strong>
              <span className="muted">Last sync {when(status.lastSuccessAt)}</span>
              {status.cloud === 'offline' ? (
                <span className="small">
                  Tills keep working. Everything is sent when the internet is back.
                </span>
              ) : null}
              {status.cloud === 'refused' ? <span className="small">{status.lastError}</span> : null}
            </div>
            <div className="hub-card">
              <span className="hub-label">Sent to the cloud</span>
              <strong
                className={`hub-state ${out && out.conflicts > 0 ? 'refused' : out && out.pending > 0 ? 'offline' : 'connected'}`}
              >
                {out && out.conflicts > 0
                  ? 'Needs attention'
                  : out && out.pending > 0
                    ? `${out.pending} waiting`
                    : 'All sent'}
              </strong>
              {out && out.pending > 0 ? (
                <span className="muted">Oldest from {when(out.oldestPendingAt)}</span>
              ) : null}
              {out && out.conflicts > 0 ? (
                <span className="small">
                  {out.conflicts} record{out.conflicts === 1 ? '' : 's'} could not be sent. Contact MY FOOD
                  support.
                </span>
              ) : null}
            </div>
            <div className="hub-card">
              <span className="hub-label">Runs this branch</span>
              <strong className={`hub-state ${status.identity?.attached ? 'connected' : 'offline'}`}>
                {status.identity?.attached ? 'Yes' : 'Not yet'}
              </strong>
              {!status.identity?.attached ? (
                <span className="small">
                  In the back office, Devices &amp; printing, press <strong>Run branch from hub</strong>.
                </span>
              ) : null}
            </div>
          </section>

          <section className="hub-card">
            <h2>Open MY FOOD on tills and screens</h2>
            <p>On each till, kitchen screen and the customer display, open this address in Chrome or Edge:</p>
            <ul className="hub-addresses">
              {(status.addresses ?? []).map((a) => (
                <li key={a}>
                  <code>{a}</code>
                </li>
              ))}
            </ul>
            <p className="muted small">The device then shows a code. Approve it below.</p>
          </section>

          <section className="hub-card">
            <h2>Devices</h2>
            {notice ? (
              <p className="notice" role="status">
                {notice}
              </p>
            ) : null}
            <table className="list">
              <thead>
                <tr>
                  <th>Device</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {devices.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <strong>{d.name}</strong>
                    </td>
                    <td>{KIND[d.kind] ?? d.kind}</td>
                    <td>
                      <Badge
                        value={d.paired ? 'paired' : 'pending'}
                        label={d.paired ? 'Connected' : 'Not connected'}
                      />
                    </td>
                    <td>
                      {d.isActive ? (
                        <button type="button" className="btn sm" onClick={() => setApproving(d)}>
                          {d.paired ? 'Connect again' : 'Enter code from device'}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
      {approving ? (
        <ApproveDevice
          device={approving}
          onClose={() => setApproving(null)}
          onDone={() => {
            setNotice(`${approving.name} is connected. It continues by itself.`);
            setApproving(null);
            void loadDevices();
          }}
        />
      ) : null}
      <footer className="muted small">Version {status?.release ?? ''}</footer>
    </div>
  );
}

function ApproveDevice({
  device,
  onClose,
  onDone,
}: {
  device: HubDevice;
  onClose: () => void;
  onDone: () => void;
}) {
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await getJson('/hub/console/approve-pairing', { deviceId: device.id, code, managerPin: pin });
      onDone();
    } catch (err) {
      setError(err);
      setPin('');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={`Connect ${device.name}`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>
          Code shown on the device
          <input
            className="code-input"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="XXXX-XXXX"
            maxLength={12}
            autoComplete="off"
          />
        </label>
        <label>
          Manager PIN
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
          />
          <span className="hint">Someone whose role may manage devices.</span>
        </label>
        <ErrorBox error={error} />
        <div className="row end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn primary"
            disabled={busy || code.replace(/[^A-Z0-9]/g, '').length < 8 || pin.length < 4}
          >
            {busy ? 'Connecting…' : 'Connect device'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * On tills and kitchen screens served by the hub: a plain line when the internet is down, so staff
 * know sales are safe on the hub and will be sent later. Never shown on the customer display.
 */
export function HubBanner() {
  const status = useHubStatus(10_000);
  if (!status || status.cloud === 'connected') return null;
  const waiting = status.outbox.pending;
  return (
    <div className="hub-banner" role="status">
      {status.cloud === 'offline'
        ? `Offline · everything keeps working and is saved on the hub${waiting ? ` · ${waiting} change${waiting === 1 ? '' : 's'} to send` : ''}`
        : 'The hub needs attention · tell a manager'}
    </div>
  );
}
