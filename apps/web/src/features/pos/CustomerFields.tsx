import type { CustomerLookupView, OrderView } from '@rp/contracts';
import { canonicalPhone } from '@rp/domain';
import { useEffect, useState } from 'react';
import { api } from '../../infra/session';
import { ErrorBox, Modal } from '../../ui/components';

/**
 * Customer name and telephone on the till. Typing a full number looks the customer up: a known
 * customer is offered (name and visits) so staff do not create a duplicate; a new number becomes a
 * new customer when the order is sent. Fast path: both fields stay optional unless the area
 * requires a name.
 */
export function CustomerFields({
  name,
  phone,
  onName,
  onPhone,
  nameRequired,
}: {
  name: string;
  phone: string;
  onName: (v: string) => void;
  onPhone: (v: string) => void;
  nameRequired?: boolean;
}) {
  const [found, setFound] = useState<CustomerLookupView['matches'][number] | null>(null);
  const canonical = canonicalPhone(phone);
  const invalid = phone.trim().length >= 3 && !canonical && phone.replace(/\D/g, '').length >= 10;
  useEffect(() => {
    setFound(null);
    if (!canonical) return;
    let current = true;
    const t = setTimeout(() => {
      api
        .lookupCustomer(phone)
        .then((r) => current && setFound(r.matches.find((m) => m.exact) ?? null))
        .catch(() => undefined);
    }, 300);
    return () => {
      current = false;
      clearTimeout(t);
    };
  }, [canonical, phone]);
  return (
    <div className="customer-fields">
      <div className="row">
        <input
          type="tel"
          inputMode="tel"
          autoComplete="off"
          placeholder="Phone number"
          value={phone}
          onChange={(e) => onPhone(e.target.value)}
          aria-label="Customer phone"
          aria-invalid={invalid || undefined}
        />
        <input
          placeholder={nameRequired ? 'Customer name (required)' : 'Customer name'}
          value={name}
          autoComplete="off"
          onChange={(e) => onName(e.target.value)}
          aria-label="Customer name"
        />
      </div>
      {found ? (
        <div className="customer-found" role="status">
          <span className="grow">
            <strong>{found.fullName ?? 'Known customer'}</strong> · {found.orders}{' '}
            {found.orders === 1 ? 'order' : 'orders'} before
          </span>
          {found.fullName && found.fullName !== name ? (
            <button type="button" className="btn sm" onClick={() => onName(found.fullName ?? '')}>
              Use
            </button>
          ) : (
            <span className="small muted">Linked</span>
          )}
        </div>
      ) : canonical ? (
        <div className="customer-found new small muted">New customer: saved with this order.</div>
      ) : invalid ? (
        <div className="small field-error">Check the number (e.g. 024 123 4567).</div>
      ) : null}
    </div>
  );
}

/** Adds or changes the customer of an open order (e.g. at checkout). */
export function OrderCustomerDialog({
  order,
  onClose,
  onSaved,
}: {
  order: OrderView;
  onClose: () => void;
  onSaved: (o: OrderView) => void;
}) {
  const [name, setName] = useState(order.customerName ?? '');
  const [phone, setPhone] = useState(order.customerPhone ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function save() {
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await api.setOrderCustomer(order.id, {
          customerName: name.trim() || null,
          customerPhone: phone.trim() || null,
        }),
      );
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Customer"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <CustomerFields name={name} phone={phone} onName={setName} onPhone={setPhone} />
      <ErrorBox error={error} />
    </Modal>
  );
}
