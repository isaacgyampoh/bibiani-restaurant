import type { OrderView } from '@rp/contracts';
import type { PaymentMethod } from '@rp/domain';
import { useState } from 'react';
import { api } from '../../infra/session';
import { ErrorBox, Modal, Money } from '../../ui/components';

const toMinor = (text: string) => Math.round(Number.parseFloat(text || '0') * 100);

/**
 * Manual payment recording (V1): the cashier has verified the money. SPLIT is
 * simply several records against the same order, until the balance is zero.
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
  const quick = [due, ...[5000, 10000, 20000].filter((v) => v > due)].slice(0, 4);

  const valid =
    method !== null && applied > 0 && applied <= due && (method !== 'cash' || cashGiven >= applied);

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
      await onPaid(o);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Payment — #${current.orderNumber}`} onClose={onClose}>
      <div className="totals">
        <span>Total</span>
        <Money minor={current.grandTotal} currency={currency} />
        <span>Paid</span>
        <Money minor={current.paidTotal - current.refundedTotal} currency={currency} />
        <span className="grand">Balance</span>
        <span className="grand">
          <Money minor={due} currency={currency} />
        </span>
      </div>
      {current.payments
        .filter((p) => p.status === 'recorded')
        .map((p) => (
          <div key={p.id} className="row small muted">
            <span className="grow">
              {p.method.toUpperCase()}
              {p.reference ? ` · ${p.reference}` : ''}
            </span>
            <Money minor={p.amount} currency={currency} />
          </div>
        ))}
      {due === 0 ? (
        <div className="notice">Fully paid.</div>
      ) : (
        <>
          <div className="row wrap">
            {(['cash', 'momo', 'card'] as const).map((m) => (
              <button
                key={m}
                type="button"
                className={`btn big grow ${method === m ? 'primary' : ''}`}
                onClick={() => setMethod(m)}
              >
                {m === 'momo' ? 'MOMO' : m.toUpperCase()}
              </button>
            ))}
            <button
              type="button"
              className={`btn big grow ${split ? 'primary' : ''}`}
              onClick={() => setSplit((s) => !s)}
            >
              SPLIT
            </button>
          </div>
          {split ? (
            <label>
              Amount for this payment (remaining <Money minor={due} currency={currency} />)
              <input
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
              />
            </label>
          ) : null}
          {method === 'cash' ? (
            <>
              <label>
                Cash received
                <input
                  inputMode="decimal"
                  value={tendered}
                  onChange={(e) => setTendered(e.target.value)}
                  placeholder="0.00"
                />
              </label>
              <div className="row wrap">
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
              <div className="totals">
                <strong>Change</strong>
                <strong>
                  <Money minor={change} currency={currency} />
                </strong>
              </div>
            </>
          ) : null}
          {method === 'momo' || method === 'card' ? (
            <label>
              {method === 'momo' ? 'MoMo transaction ID (from the customer’s phone)' : 'Card slip reference'}{' '}
              (optional)
              <input value={reference} onChange={(e) => setReference(e.target.value)} />
            </label>
          ) : null}
          {method === 'momo' ? (
            <div className="notice small">
              Confirm the money has arrived before recording. The system does not check MoMo.
            </div>
          ) : null}
          <ErrorBox error={error} />
          <button
            type="button"
            className="btn primary big"
            disabled={!valid || busy}
            onClick={() => void record()}
          >
            {busy ? 'Recording…' : split ? 'Record this payment' : 'Complete payment'}
          </button>
        </>
      )}
    </Modal>
  );
}
