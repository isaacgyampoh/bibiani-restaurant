import type { OrderView } from '@rp/contracts';
import type { PaymentMethod } from '@rp/domain';
import { useState } from 'react';
import { api } from '../../infra/session';
import { ErrorBox, Field, Modal, Money } from '../../ui/components';

const toMinor = (text: string) => Math.round(Number.parseFloat(text || '0') * 100);
const METHODS: [PaymentMethod, string][] = [
  ['cash', 'CASH'],
  ['momo', 'MOMO'],
  ['card', 'CARD'],
];

/**
 * Manual payment recording (V1): the cashier has verified the money. SPLIT is simply several
 * records against the same order until the balance is zero; "pay for selected items" fills the
 * amount from the chosen lines (the kitchen still sees one order).
 */
export function PaymentModal({
  order,
  currency,
  onClose,
  onPaid,
}: {
  order: OrderView;
  currency: string;
  onClose: () => void;
  onPaid: (o: OrderView) => void | Promise<void>;
}) {
  const [method, setMethod] = useState<PaymentMethod | null>(null);
  const [split, setSplit] = useState(false);
  const [byItems, setByItems] = useState<string[]>([]);
  const [amount, setAmount] = useState('');
  const [tendered, setTendered] = useState('');
  const [reference, setReference] = useState('');
  const [paymentId, setPaymentId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [current, setCurrent] = useState(order);

  const due = current.balanceDue;
  const applied = split ? toMinor(amount) : due;
  const cashGiven = toMinor(tendered);
  const change = method === 'cash' ? Math.max(0, cashGiven - Math.min(applied, due)) : 0;
  const quick = [applied || due, ...[5000, 10000, 20000].filter((v) => v > (applied || due))].slice(0, 4);
  const valid =
    method !== null && applied > 0 && applied <= due && (method !== 'cash' || cashGiven >= applied);
  const live = current.items.filter((i) => i.status !== 'voided' && i.status !== 'cancelled');
  // Line totals are pre-exclusive-tax; scale to the order's grand total so tax is shared fairly.
  const scale = current.subtotal > 0 ? current.grandTotal / current.subtotal : 1;

  function pickItems(ids: string[]) {
    setByItems(ids);
    const sum = live.filter((i) => ids.includes(i.id)).reduce((a, i) => a + i.lineTotal, 0);
    setAmount(ids.length ? (Math.min(due, Math.round(sum * scale)) / 100).toFixed(2) : '');
  }

  async function record() {
    if (!method) return;
    setBusy(true);
    setError(null);
    try {
      const o = await api.recordPayment(current.id, {
        paymentId, // kept until the server confirms, so a retry can never record twice
        method,
        amount: applied,
        tendered: method === 'cash' ? cashGiven : null,
        reference: reference.trim() || null,
      });
      setCurrent(o);
      setPaymentId(crypto.randomUUID());
      setAmount('');
      setTendered('');
      setReference('');
      setMethod(null);
      setByItems([]);
      await onPaid(o);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Payment — #${current.orderNumber}`}
      onClose={onClose}
      wide
      footer={
        due === 0 ? (
          <button type="button" className="btn primary lg" onClick={onClose}>
            Close
          </button>
        ) : (
          <>
            <button type="button" className="btn lg" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn primary lg"
              disabled={!valid || busy}
              onClick={() => void record()}
            >
              {busy ? 'Recording…' : split ? 'Record this payment' : 'Complete payment'}
            </button>
          </>
        )
      }
    >
      <div className="pay-summary">
        <span>Total</span>
        <Money minor={current.grandTotal} currency={currency} />
        <span>Paid</span>
        <Money minor={current.paidTotal - current.refundedTotal} currency={currency} />
        <strong>Balance due</strong>
        <span className="due">
          <Money minor={due} currency={currency} />
        </span>
      </div>
      {current.payments
        .filter((p) => p.status === 'recorded')
        .map((p) => (
          <div key={p.id} className="row small muted">
            <span className="grow">
              {p.method === 'momo' ? 'Mobile money' : p.method === 'card' ? 'Card' : 'Cash'}
              {p.reference ? ` · ${p.reference}` : ''}
            </span>
            <Money minor={p.amount} currency={currency} />
          </div>
        ))}
      {due === 0 ? (
        <div className="info-box ok">Fully paid.</div>
      ) : (
        <>
          <div className="pay-methods">
            {METHODS.map(([m, label]) => (
              <button
                key={m}
                type="button"
                className={`btn ${method === m ? 'on' : ''}`}
                aria-pressed={method === m}
                onClick={() => setMethod(m)}
              >
                {label}
              </button>
            ))}
            <button
              type="button"
              className={`btn ${split ? 'on' : ''}`}
              aria-pressed={split}
              onClick={() => {
                setSplit((s) => !s);
                setByItems([]);
                setAmount('');
              }}
            >
              SPLIT
            </button>
          </div>
          {split ? (
            <>
              <Field label={`Amount for this payment (remaining ${(due / 100).toFixed(2)} ${currency})`}>
                <input
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                />
              </Field>
              <details>
                <summary className="small" style={{ cursor: 'pointer', fontWeight: 600 }}>
                  Pay for selected items
                </summary>
                <div className="split-items" style={{ marginTop: 8 }}>
                  {live.map((i) => (
                    <label key={i.id}>
                      <span className="row">
                        <input
                          type="checkbox"
                          checked={byItems.includes(i.id)}
                          onChange={() =>
                            pickItems(
                              byItems.includes(i.id) ? byItems.filter((x) => x !== i.id) : [...byItems, i.id],
                            )
                          }
                        />
                        {i.quantity} × {i.name}
                      </span>
                      <Money minor={Math.round(i.lineTotal * scale)} currency={currency} />
                    </label>
                  ))}
                </div>
              </details>
            </>
          ) : null}
          {method === 'cash' ? (
            <>
              <Field label="Cash received">
                <input
                  inputMode="decimal"
                  value={tendered}
                  onChange={(e) => setTendered(e.target.value)}
                  placeholder="0.00"
                />
              </Field>
              <div className="chips">
                {quick.map((v) => (
                  <button
                    key={v}
                    type="button"
                    className="btn"
                    onClick={() => setTendered((v / 100).toFixed(2))}
                  >
                    <Money minor={v} currency={currency} />
                  </button>
                ))}
              </div>
              <div className="totals pay-summary">
                <strong>Change</strong>
                <span className="due">
                  <Money minor={change} currency={currency} />
                </span>
              </div>
            </>
          ) : null}
          {method === 'momo' || method === 'card' ? (
            <Field
              label={`${method === 'momo' ? 'MoMo transaction ID (from the customer’s phone)' : 'Card slip reference'} (optional)`}
            >
              <input value={reference} onChange={(e) => setReference(e.target.value)} />
            </Field>
          ) : null}
          {method === 'momo' ? (
            <div className="info-box warn small">
              Confirm the money has arrived before recording. The system does not check MoMo.
            </div>
          ) : null}
          <ErrorBox error={error} />
        </>
      )}
    </Modal>
  );
}
