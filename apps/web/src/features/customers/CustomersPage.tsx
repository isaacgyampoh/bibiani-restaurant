import type { CustomerDetailView, CustomerSummaryView, MeView } from '@rp/contracts';
import { formatMinor } from '@rp/domain';
import { useCallback, useEffect, useState } from 'react';
import { api, hasPermission } from '../../infra/session';
import { Badge, ErrorBox, Field, Modal, useToast } from '../../ui/components';
import { Empty, Shell, Skeleton } from '../../ui/Shell';

const day = (d: string | null) =>
  d
    ? new Date(`${d}T12:00:00Z`).toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' })
    : '—';

/**
 * The restaurant's customers: search by name or telephone number, see visits, spend and order
 * history, call the customer (the phone's own dialler; nothing is sent automatically), add,
 * correct and merge records. Telephone numbers are private: this page needs customer.view.
 */
export function CustomersPage({ me }: { me: MeView }) {
  const manage = hasPermission(me, 'customer.manage');
  const canAdd = manage || hasPermission(me, 'customer.attach');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [list, setList] = useState<CustomerSummaryView[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<CustomerDetailView | 'new' | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);
  const load = useCallback(async () => {
    setError(null);
    try {
      const page = await api.customers(query);
      setList(page.customers);
      setTotal(page.total);
    } catch (e) {
      setError(e);
    }
  }, [query]);
  useEffect(() => {
    void load();
  }, [load]);

  async function more() {
    setLoadingMore(true);
    try {
      const page = await api.customers(query, list?.length ?? 0);
      setList([...(list ?? []), ...page.customers]);
    } catch (e) {
      setError(e);
    } finally {
      setLoadingMore(false);
    }
  }

  const money = (m: number) => formatMinor(m, me.restaurant.currency);
  return (
    <Shell
      me={me}
      title="Customers"
      subtitle={list ? `${total} ${total === 1 ? 'customer' : 'customers'}` : ' '}
      actions={
        canAdd ? (
          <button type="button" className="btn primary" onClick={() => setEditing('new')}>
            Add customer
          </button>
        ) : null
      }
    >
      <div className="search-bar">
        <input
          type="search"
          inputMode="search"
          placeholder="Search by name or phone number"
          aria-label="Search customers"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <ErrorBox error={error} />
      {!list ? (
        <Skeleton rows={6} />
      ) : list.length === 0 ? (
        <section className="card">
          <Empty title={query ? 'No customer matches' : 'No customers yet'}>
            {query
              ? 'Check the spelling or the number.'
              : 'Customers are added here, or automatically when an order is taken with a telephone number.'}
          </Empty>
        </section>
      ) : (
        <ul className="customer-list">
          {list.map((c) => (
            <li key={c.id}>
              <button type="button" className="customer-row" onClick={() => setOpen(c.id)}>
                <span className="avatar" aria-hidden>
                  {(c.fullName ?? '?').slice(0, 1).toUpperCase()}
                </span>
                <span className="grow">
                  <strong>{c.fullName ?? 'No name'}</strong>
                  <span className="tabular">{c.phoneDisplay}</span>
                </span>
                <span className="customer-stats">
                  <strong>
                    {c.orders} {c.orders === 1 ? 'order' : 'orders'}
                  </strong>
                  <span>{c.lastVisit ? `Last ${day(c.lastVisit)}` : 'No visits yet'}</span>
                </span>
              </button>
              <a className="call" href={`tel:${c.phone}`} aria-label={`Call ${c.fullName ?? c.phoneDisplay}`}>
                Call
              </a>
            </li>
          ))}
        </ul>
      )}
      {list && list.length < total ? (
        <button type="button" className="btn" disabled={loadingMore} onClick={() => void more()}>
          {loadingMore ? 'Loading…' : `Show more (${total - list.length} left)`}
        </button>
      ) : null}
      {open ? (
        <CustomerDetail
          customerId={open}
          money={money}
          manage={manage}
          onClose={() => setOpen(null)}
          onEdit={(c) => setEditing(c)}
          onChanged={() => void load()}
          onOpen={(id) => setOpen(id)}
        />
      ) : null}
      {editing ? (
        <CustomerForm
          customer={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(c) => {
            setEditing(null);
            setOpen(c.id);
            void load();
          }}
          onExisting={(id) => {
            setEditing(null);
            setOpen(id);
          }}
        />
      ) : null}
    </Shell>
  );
}

function CustomerDetail({
  customerId,
  money,
  manage,
  onClose,
  onEdit,
  onChanged,
  onOpen,
}: {
  customerId: string;
  money: (m: number) => string;
  manage: boolean;
  onClose: () => void;
  onEdit: (c: CustomerDetailView) => void;
  onChanged: () => void;
  onOpen: (id: string) => void;
}) {
  const [c, setC] = useState<CustomerDetailView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [merging, setMerging] = useState(false);
  useEffect(() => {
    setC(null);
    api.customer(customerId).then(setC).catch(setError);
  }, [customerId]);
  const METHOD: Record<string, string> = { cash: 'Cash', momo: 'MoMo', card: 'Card' };
  return (
    <Modal
      wide
      title={c?.fullName ?? 'Customer'}
      onClose={onClose}
      footer={
        c && manage ? (
          <>
            <button type="button" className="btn" onClick={() => setMerging(true)}>
              Merge duplicate…
            </button>
            <button type="button" className="btn primary" onClick={() => onEdit(c)}>
              Edit
            </button>
          </>
        ) : null
      }
    >
      <ErrorBox error={error} />
      {!c ? (
        error ? null : (
          <Skeleton rows={5} />
        )
      ) : (
        <>
          <div className="customer-head">
            <a className="btn big call-btn" href={`tel:${c.phone}`}>
              Call {c.phoneDisplay}
            </a>
            {c.email ? <span className="muted">{c.email}</span> : null}
          </div>
          <div className="customer-kpis">
            <div>
              <span>Orders</span>
              <strong>{c.orders}</strong>
            </div>
            <div>
              <span>Total spend</span>
              <strong>{money(c.totalSpend)}</strong>
            </div>
            <div>
              <span>First visit</span>
              <strong>{day(c.firstVisit)}</strong>
            </div>
            <div>
              <span>Last visit</span>
              <strong>{day(c.lastVisit)}</strong>
            </div>
          </div>
          {c.notes ? <p className="customer-notes">{c.notes}</p> : null}
          {c.mergedFrom.length ? (
            <p className="muted small">
              Includes merged records:{' '}
              {c.mergedFrom.map((m) => `${m.fullName ?? 'No name'} (${m.phoneDisplay})`).join(', ')}
            </p>
          ) : null}
          <h3>Order history</h3>
          {c.recentOrders.length === 0 ? (
            <p className="muted">No orders yet.</p>
          ) : (
            <ul className="customer-orders">
              {c.recentOrders.map((o) => (
                <li key={o.id}>
                  <div className="row">
                    <strong>#{o.orderNumber}</strong>
                    <span className="muted small">
                      {day(o.businessDay)} · {o.channel === 'dine_in' ? 'Dine-in' : 'Takeaway'}
                    </span>
                    <span className="grow" />
                    <strong className="tabular">{money(o.total)}</strong>
                  </div>
                  <div className="small muted">{o.items || '—'}</div>
                  <div className="row small">
                    <Badge value={o.status} />
                    {o.methods.length ? (
                      <span className="muted">{o.methods.map((m) => METHOD[m] ?? m).join(' + ')}</span>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {merging ? (
            <MergeCustomer
              duplicate={c}
              onClose={() => setMerging(false)}
              onMerged={(kept) => {
                setMerging(false);
                onChanged();
                onOpen(kept);
              }}
            />
          ) : null}
        </>
      )}
    </Modal>
  );
}

function CustomerForm({
  customer,
  onClose,
  onSaved,
  onExisting,
}: {
  customer: CustomerDetailView | null;
  onClose: () => void;
  onSaved: (c: CustomerDetailView) => void;
  onExisting: (id: string) => void;
}) {
  const [f, setF] = useState({
    fullName: customer?.fullName ?? '',
    phone: customer?.phoneDisplay ?? '',
    email: customer?.email ?? '',
    notes: customer?.notes ?? '',
  });
  const [id] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [existing, setExisting] = useState<{ id: string; name: string | null } | null>(null);
  const toast = useToast();
  async function save() {
    setBusy(true);
    setError(null);
    setExisting(null);
    const body = { fullName: f.fullName, phone: f.phone, email: f.email || null, notes: f.notes || null };
    try {
      const saved = customer
        ? await api.updateCustomer(customer.id, { ...body, version: customer.version })
        : await api.createCustomer({ customerId: id, ...body });
      toast(customer ? 'Customer saved' : 'Customer added');
      onSaved(saved);
    } catch (e) {
      const err = e as { code?: string; message?: string };
      if (err.code === 'CUSTOMER_EXISTS') {
        // The server names the existing record; offer to open it instead of making a duplicate.
        const found = await api.lookupCustomer(f.phone).catch(() => null);
        const match = found?.matches.find((m) => m.exact);
        if (match && match.id !== customer?.id) setExisting({ id: match.id, name: match.fullName });
      }
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={customer ? 'Edit customer' : 'Add customer'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy || !f.fullName.trim() || !f.phone.trim()}
            onClick={() => void save()}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <Field label="Full name" required>
        <input
          value={f.fullName}
          maxLength={80}
          autoComplete="off"
          onChange={(e) => setF({ ...f, fullName: e.target.value })}
        />
      </Field>
      <Field label="Telephone number" required hint="e.g. 024 123 4567">
        <input
          type="tel"
          inputMode="tel"
          autoComplete="off"
          value={f.phone}
          maxLength={30}
          onChange={(e) => setF({ ...f, phone: e.target.value })}
        />
      </Field>
      <Field label="Email (optional)">
        <input
          type="email"
          inputMode="email"
          value={f.email}
          maxLength={120}
          onChange={(e) => setF({ ...f, email: e.target.value })}
        />
      </Field>
      <Field label="Notes (optional)" hint="Preferences, allergies. Visible to managers.">
        <textarea
          rows={3}
          value={f.notes}
          maxLength={500}
          onChange={(e) => setF({ ...f, notes: e.target.value })}
        />
      </Field>
      <ErrorBox error={error} />
      {existing ? (
        <button type="button" className="btn" onClick={() => onExisting(existing.id)}>
          Open {existing.name ?? 'the existing customer'}
        </button>
      ) : null}
    </Modal>
  );
}

function MergeCustomer({
  duplicate,
  onClose,
  onMerged,
}: {
  duplicate: CustomerDetailView;
  onClose: () => void;
  onMerged: (keptId: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [matches, setMatches] = useState<CustomerSummaryView[]>([]);
  const [target, setTarget] = useState<CustomerSummaryView | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (search.trim().length < 2) {
      setMatches([]);
      return;
    }
    const t = setTimeout(() => {
      api
        .customers(search.trim())
        .then((p) => setMatches(p.customers.filter((c) => c.id !== duplicate.id).slice(0, 8)))
        .catch(setError);
    }, 250);
    return () => clearTimeout(t);
  }, [search, duplicate.id]);
  async function merge() {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      await api.mergeCustomer(duplicate.id, { intoCustomerId: target.id, reason: reason.trim() });
      onMerged(target.id);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Merge duplicate customer"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!target || reason.trim().length < 3 || busy}
            onClick={() => void merge()}
          >
            {busy ? 'Merging…' : 'Merge'}
          </button>
        </>
      }
    >
      <p className="small">
        <strong>{duplicate.fullName ?? 'No name'}</strong> ({duplicate.phoneDisplay}) will be merged into the
        customer you choose. Its orders move to that customer. Nothing is deleted and the merge is recorded in
        the audit history.
      </p>
      <Field label="Keep this customer">
        <input
          type="search"
          placeholder="Search by name or number"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </Field>
      <ul className="pick-list">
        {matches.map((m) => (
          <li key={m.id}>
            <button type="button" className={target?.id === m.id ? 'on' : ''} onClick={() => setTarget(m)}>
              <strong>{m.fullName ?? 'No name'}</strong> <span className="muted">{m.phoneDisplay}</span>
            </button>
          </li>
        ))}
      </ul>
      <Field label="Reason" required>
        <input
          value={reason}
          maxLength={200}
          placeholder="e.g. Same person, second number"
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>
      <ErrorBox error={error} />
    </Modal>
  );
}
