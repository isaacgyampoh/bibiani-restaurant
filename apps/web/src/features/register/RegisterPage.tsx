import type { MeView, RegisterSessionView, ReportView } from '@rp/contracts';
import { formatMinor } from '@rp/domain';
import { useCallback, useEffect, useState } from 'react';
import { api, hasPermission, posDevice } from '../../infra/session';
import { ErrorBox, Field, Modal, useToast } from '../../ui/components';
import { Empty, Shell, Skeleton } from '../../ui/Shell';
import { ExportMenu, ReportViewer } from '../reports/ReportViewer';

/** "12.50" / "1,200" → minor units; null when it is not a valid amount. */
export function parseAmount(text: string): number | null {
  const clean = text.replace(/[,\s]/g, '').replace(/^GH[S₵]?/i, '');
  if (!/^\d+(\.\d{0,2})?$/.test(clean)) return null;
  return Math.round(Number(clean) * 100);
}

const time = (iso: string) =>
  new Date(iso).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

/**
 * Cash register: a cashier opens their register with the opening float, sees the running totals,
 * and at the end of the shift counts the drawer. Expected cash and the variance are computed by
 * the server and recorded as they are; the closing report can be downloaded or printed.
 */
export function RegisterPage({ me }: { me: MeView }) {
  const branchId = me.branches[0]?.id ?? '';
  const operate = hasPermission(me, 'register.operate');
  const manage = hasPermission(me, 'register.manage');
  const [current, setCurrent] = useState<RegisterSessionView | null | undefined>(undefined);
  const [history, setHistory] = useState<RegisterSessionView[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [closing, setClosing] = useState(false);
  const [report, setReport] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [cur, list] = await Promise.all([
        operate ? api.currentRegister(branchId).then((r) => r.register) : Promise.resolve(null),
        api.registers(branchId),
      ]);
      setCurrent(cur);
      setHistory(list.sessions);
    } catch (e) {
      setError(e);
      setCurrent((c) => (c === undefined ? null : c));
    }
  }, [branchId, operate]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  const money = (m: number) => formatMinor(m, me.restaurant.currency);
  const others = (history ?? []).filter((s) => s.id !== current?.id);

  return (
    <Shell
      me={me}
      title="Cash register"
      subtitle={
        current
          ? `Open since ${time(current.openedAt)} · ${current.terminalName}`
          : 'Open, count and close the cash drawer'
      }
    >
      <ErrorBox error={error} />
      {current === undefined ? (
        <Skeleton rows={5} />
      ) : operate && !current ? (
        <OpenRegister branchId={branchId} currency={me.restaurant.currency} onOpened={(r) => setCurrent(r)} />
      ) : current ? (
        <section className="card register-live">
          <div className="register-expected">
            <span>Expected cash in drawer</span>
            <strong>{money(current.expectedCash)}</strong>
            <small>
              Opening {money(current.openingCash)} + cash sales {money(current.cashSales)}
              {current.cashRefunds ? ` − refunds ${money(current.cashRefunds)}` : ''}
            </small>
          </div>
          <dl className="register-figures">
            <div>
              <dt>Cash sales</dt>
              <dd>{money(current.cashSales)}</dd>
            </div>
            <div>
              <dt>MoMo</dt>
              <dd>{money(current.byMethod.find((m) => m.method === 'momo')?.net ?? 0)}</dd>
            </div>
            <div>
              <dt>Card</dt>
              <dd>{money(current.byMethod.find((m) => m.method === 'card')?.net ?? 0)}</dd>
            </div>
            <div>
              <dt>Total sales</dt>
              <dd>{money(current.totalNet)}</dd>
            </div>
            <div>
              <dt>Orders</dt>
              <dd>
                {current.orders.total}{' '}
                <span className="muted small">
                  ({current.orders.dineIn} dine-in · {current.orders.takeaway} takeaway)
                </span>
              </dd>
            </div>
            <div>
              <dt>Cashier</dt>
              <dd>{current.cashierName}</dd>
            </div>
          </dl>
          <div className="register-actions">
            <button type="button" className="btn" onClick={() => void load()}>
              Refresh
            </button>
            <button type="button" className="btn primary big" onClick={() => setClosing(true)}>
              Close register
            </button>
          </div>
        </section>
      ) : !manage ? (
        <section className="card">
          <Empty title="No register here">Registers are opened by cashiers.</Empty>
        </section>
      ) : null}

      {history && others.length ? (
        <section className="register-history">
          <h2>{manage ? 'Registers' : 'My registers'}</h2>
          <ul className="register-list">
            {others.map((s) => (
              <li key={s.id}>
                <button type="button" onClick={() => setReport(s.id)}>
                  <div className="grow">
                    <strong>{s.cashierName}</strong>
                    <span className="muted small">
                      {s.terminalName} · {time(s.openedAt)}
                      {s.closedAt ? ` – ${time(s.closedAt)}` : ''}
                    </span>
                  </div>
                  {s.status === 'open' ? (
                    <span className="badge status tone-info">Open</span>
                  ) : (
                    <span
                      className={`variance ${s.variance && s.variance < 0 ? 'neg' : s.variance ? 'pos' : 'zero'}`}
                    >
                      {s.variance === 0
                        ? 'Balanced'
                        : `${s.variance! > 0 ? 'Over' : 'Short'} ${money(Math.abs(s.variance ?? 0))}`}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : history && !current && others.length === 0 && !operate ? (
        <section className="card">
          <Empty title="No registers yet">When a cashier opens a register it appears here.</Empty>
        </section>
      ) : null}

      {closing && current ? (
        <CloseRegister
          register={current}
          currency={me.restaurant.currency}
          onCancel={() => setClosing(false)}
          onClosed={(r) => {
            setClosing(false);
            setCurrent(null);
            setReport(r.id);
            void load();
          }}
        />
      ) : null}
      {report ? (
        <RegisterReport
          sessionId={report}
          canReopen={manage}
          onClose={() => setReport(null)}
          onReopened={() => {
            setReport(null);
            void load();
          }}
        />
      ) : null}
    </Shell>
  );
}

function OpenRegister({
  branchId,
  currency,
  onOpened,
}: {
  branchId: string;
  currency: string;
  onOpened: (r: RegisterSessionView) => void;
}) {
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [sessionId] = useState(() => crypto.randomUUID());
  const value = parseAmount(amount);
  const till = posDevice();
  async function open() {
    if (value === null) return;
    setBusy(true);
    setError(null);
    try {
      onOpened(
        await api.openRegister({ sessionId, branchId, openingCash: value, note: note.trim() || null }),
      );
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card register-open">
      <h2>Open your register</h2>
      <p className="muted">
        Count the cash in the drawer before you start. Cash payments you take are counted in this register
        until you close it.
      </p>
      <p className="small">
        Terminal: <strong>{till?.name ?? 'This browser (not a paired till)'}</strong>
      </p>
      <Field label={`Opening cash (${currency})`} required>
        <input
          className="amount-input"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.00"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </Field>
      <Field label="Note (optional)">
        <input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <ErrorBox error={error} />
      <button
        type="button"
        className="btn primary big"
        disabled={value === null || busy}
        onClick={() => void open()}
      >
        {busy
          ? 'Opening…'
          : value === null
            ? 'Enter the opening cash'
            : `Open register with ${formatMinor(value, currency)}`}
      </button>
    </section>
  );
}

/** Count → see the variance → confirm. The confirm is sent once (double taps are ignored). */
function CloseRegister({
  register,
  currency,
  onCancel,
  onClosed,
}: {
  register: RegisterSessionView;
  currency: string;
  onCancel: () => void;
  onClosed: (r: RegisterSessionView) => void;
}) {
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const [step, setStep] = useState<'count' | 'confirm'>('count');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const money = (m: number) => formatMinor(m, currency);
  const value = parseAmount(counted);
  const variance = value === null ? null : value - register.expectedCash;
  const label =
    variance === null
      ? ''
      : variance === 0
        ? 'Balanced'
        : variance < 0
          ? `Short by ${money(-variance)}`
          : `Over by ${money(variance)}`;
  async function close() {
    if (value === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      onClosed(
        await api.closeRegister(register.id, {
          countedCash: value,
          note: note.trim() || null,
          version: register.version,
        }),
      );
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }
  return (
    <Modal
      title={step === 'count' ? 'Count the cash' : 'Confirm closing'}
      onClose={() => !busy && onCancel()}
      footer={
        step === 'count' ? (
          <>
            <button type="button" className="btn" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={value === null}
              onClick={() => setStep('confirm')}
            >
              Review
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn" disabled={busy} onClick={() => setStep('count')}>
              Back
            </button>
            <button type="button" className="btn primary" disabled={busy} onClick={() => void close()}>
              {busy ? 'Closing…' : 'Close register'}
            </button>
          </>
        )
      }
    >
      <dl className="register-figures compact">
        <div>
          <dt>Opening cash</dt>
          <dd>{money(register.openingCash)}</dd>
        </div>
        <div>
          <dt>Cash sales</dt>
          <dd>{money(register.cashSales)}</dd>
        </div>
        {register.cashRefunds ? (
          <div>
            <dt>Cash refunds</dt>
            <dd>−{money(register.cashRefunds)}</dd>
          </div>
        ) : null}
        <div className="strong">
          <dt>Expected cash</dt>
          <dd>{money(register.expectedCash)}</dd>
        </div>
      </dl>
      {step === 'count' ? (
        <>
          <Field
            label={`Actual cash counted (${currency})`}
            required
            hint="Count every note and coin in the drawer."
          >
            <input
              className="amount-input"
              inputMode="decimal"
              autoComplete="off"
              // biome-ignore lint/a11y/noAutofocus: the count is the only thing to do here
              autoFocus
              placeholder="0.00"
              value={counted}
              onChange={(e) => setCounted(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && value !== null && setStep('confirm')}
            />
          </Field>
          {variance !== null ? (
            <div
              className={`variance-box ${variance < 0 ? 'neg' : variance > 0 ? 'pos' : 'zero'}`}
              role="status"
            >
              {label}
            </div>
          ) : null}
          <Field label="Note (optional)" hint={variance ? 'Explain the difference if you can.' : undefined}>
            <input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </>
      ) : (
        <>
          <dl className="register-figures compact">
            <div className="strong">
              <dt>Actual cash</dt>
              <dd>{money(value ?? 0)}</dd>
            </div>
            <div className={`strong ${variance && variance < 0 ? 'neg' : variance ? 'pos' : ''}`}>
              <dt>Variance</dt>
              <dd>{label}</dd>
            </div>
          </dl>
          <p className="muted small">
            After closing, this register cannot be changed. The variance is recorded as it is; only a manager
            can reopen the register.
          </p>
        </>
      )}
      <ErrorBox error={error} />
    </Modal>
  );
}

function RegisterReport({
  sessionId,
  canReopen,
  onClose,
  onReopened,
}: {
  sessionId: string;
  canReopen: boolean;
  onClose: () => void;
  onReopened: () => void;
}) {
  const [view, setView] = useState<ReportView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reason, setReason] = useState('');
  const [reopening, setReopening] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  useEffect(() => {
    api.registerReport(sessionId).then(setView).catch(setError);
  }, [sessionId]);
  const closed = view?.summary[0]?.metrics.find((m) => m.label === 'Status')?.value === 'Closed';
  async function reopen() {
    setBusy(true);
    setError(null);
    try {
      await api.reopenRegister(sessionId, reason.trim());
      toast('Register reopened');
      onReopened();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      wide
      title="Register closing report"
      onClose={onClose}
      footer={
        <>
          {canReopen && closed && !reopening ? (
            <button type="button" className="btn" onClick={() => setReopening(true)}>
              Reopen…
            </button>
          ) : null}
          <ExportMenu disabled={!view} onExport={(format) => api.exportRegisterReport(sessionId, format)} />
        </>
      }
    >
      <ErrorBox error={error} />
      {reopening ? (
        <div className="card reopen-box">
          <Field
            label="Why is this register being reopened?"
            required
            hint="Recorded in the audit history with your name."
          >
            <input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <div className="row">
            <button type="button" className="btn" onClick={() => setReopening(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn danger"
              disabled={reason.trim().length < 3 || busy}
              onClick={() => void reopen()}
            >
              {busy ? 'Reopening…' : 'Reopen register'}
            </button>
          </div>
        </div>
      ) : null}
      {view ? <ReportViewer view={view} /> : error ? null : <Skeleton rows={6} />}
    </Modal>
  );
}
