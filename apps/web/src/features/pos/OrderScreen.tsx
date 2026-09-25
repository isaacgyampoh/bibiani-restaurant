import type { MenuView, MeView, OrderView } from '@rp/contracts';
import { useMemo, useState } from 'react';
import { api, hasPermission, topics } from '../../infra/session';
import { useFeed } from '../../infra/use-feed';
import { Badge, ConnectionDot, ErrorBox, Modal, Money } from '../../ui/components';
import { PaymentModal } from './PaymentModal';

type Product = MenuView['products'][number];
type Area = MenuView['areas'][number];
interface CartLine {
  id: string;
  product: Product;
  quantity: number;
  modifierIds: string[];
  notes: string;
}

const uuid = () => crypto.randomUUID();

/**
 * One screen for hall and takeaway: the same order domain, different area
 * configuration. Totals shown after sending come from the server; the cart
 * shows an estimate only.
 */
export function OrderScreen({
  me,
  menu,
  area,
  tableId,
  existingOrderId,
  onClose,
}: {
  me: MeView;
  menu: MenuView;
  area: Area;
  tableId: string | null;
  existingOrderId: string | null;
  onClose: () => void;
}) {
  const branchId = menu.branchId;
  const [orderId] = useState(() => existingOrderId ?? uuid());
  const [known, setKnown] = useState(Boolean(existingOrderId));
  const [cart, setCart] = useState<CartLine[]>([]);
  const [submissionId, setSubmissionId] = useState(uuid);
  const [category, setCategory] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [modFor, setModFor] = useState<Product | null>(null);
  const [paying, setPaying] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const [receipt, setReceipt] = useState<string[] | null>(null);

  const feed = useFeed<OrderView | null>(known ? `order:${orderId}` : null, () => api.getOrder(orderId), {
    topic: topics.orders(branchId),
    pollMs: 30_000,
  });
  const order = feed.data;

  const topCategories = menu.categories.filter((c) => !c.parentId);
  const descendants = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const c of menu.categories) {
      let cur: string | null = c.id;
      while (cur) {
        const set = map.get(cur) ?? new Set<string>();
        set.add(c.id);
        map.set(cur, set);
        cur = menu.categories.find((x) => x.id === cur)?.parentId ?? null;
      }
    }
    return map;
  }, [menu.categories]);
  const products = menu.products.filter((p) => {
    if (search) return p.name.toLowerCase().includes(search.toLowerCase());
    return !category || descendants.get(category)?.has(p.categoryId);
  });

  function add(product: Product, modifierIds: string[] = [], notes = '') {
    setCart((lines) => {
      const same = lines.find(
        (l) =>
          l.product.id === product.id && !l.notes && l.modifierIds.join() === modifierIds.join() && !notes,
      );
      if (same) return lines.map((l) => (l === same ? { ...l, quantity: l.quantity + 1 } : l));
      return [...lines, { id: uuid(), product, quantity: 1, modifierIds, notes }];
    });
  }
  const unitPrice = (l: CartLine) =>
    l.product.price +
    l.product.modifierGroups
      .flatMap((g) => g.modifiers)
      .filter((m) => l.modifierIds.includes(m.id))
      .reduce((a, m) => a + m.priceDelta, 0);
  const cartEstimate = cart.reduce((acc, l) => acc + unitPrice(l) * l.quantity, 0);

  async function run(label: string, fn: () => Promise<OrderView | unknown>) {
    setBusy(label);
    setError(null);
    try {
      const result = await fn();
      if (result && typeof result === 'object' && 'orderNumber' in result) {
        setKnown(true);
        feed.refresh();
      }
      return result;
    } catch (e) {
      setError(e);
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function send(sendToKitchen: boolean) {
    if (area.requiresCustomerName && !customerName.trim() && !known) {
      setError(new Error('Enter the customer name'));
      return;
    }
    const result = await run(sendToKitchen ? 'send' : 'save', () =>
      api.submitOrder({
        orderId,
        branchId,
        areaId: area.id,
        tableId,
        customerName: customerName.trim() || null,
        customerPhone: customerPhone.trim() || null,
        items: cart.map((l) => ({
          id: l.id,
          productId: l.product.id,
          quantity: l.quantity,
          modifierIds: l.modifierIds,
          notes: l.notes || null,
        })),
        send: sendToKitchen ? { submissionId } : null,
      }),
    );
    // Same ids are reused on retry until the server confirms, so a lost response never duplicates anything.
    if (result) {
      setCart([]);
      setSubmissionId(uuid());
    }
  }

  const pendingOnServer = order?.items.filter((i) => i.status === 'pending').length ?? 0;
  const canPayFirst = area.requirePaymentBeforeProduction;
  const readyItems = order?.items.filter((i) => i.status === 'ready').length ?? 0;
  const closed = order ? ['completed', 'cancelled', 'voided'].includes(order.status) : false;

  return (
    <div className="pos">
      <div className="menu">
        <div className="row">
          <button type="button" className="btn" onClick={onClose}>
            ← Back
          </button>
          <input
            className="grow"
            placeholder="Search products"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search products"
          />
        </div>
        <div className="cats">
          <button
            type="button"
            className={`cat ${!category ? 'active' : ''}`}
            onClick={() => setCategory(null)}
          >
            All
          </button>
          {topCategories.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`cat ${category === c.id ? 'active' : ''}`}
              onClick={() => setCategory(c.id)}
            >
              {c.name}
            </button>
          ))}
        </div>
        <div className="products">
          {products.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`product ${p.isAvailable ? '' : 'unavailable'}`}
              disabled={!p.isAvailable || closed}
              onClick={() => (p.modifierGroups.length ? setModFor(p) : add(p))}
            >
              <span className="name">{p.name}</span>
              <span className="price">
                {p.isAvailable ? <Money minor={p.price} currency={menu.currency} /> : 'Sold out'}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="cart panel">
        <div className="row">
          <strong className="grow" style={{ fontSize: 20 }}>
            {order
              ? `${area.channel === 'takeaway' ? 'Takeaway' : 'Order'} #${order.orderNumber}`
              : `New ${area.name.toLowerCase()} order`}
            {order?.table ? ` · Table ${order.table.label}` : ''}
          </strong>
          {known ? <ConnectionDot state={feed.connection} /> : null}
        </div>
        {order ? (
          <div className="row">
            <Badge value={order.status} />
            <Badge value={order.paymentStatus} />
          </div>
        ) : null}

        {area.channel === 'takeaway' && !known ? (
          <div className="row">
            <input
              className="grow"
              placeholder={area.requiresCustomerName ? 'Customer name (required)' : 'Customer name'}
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              aria-label="Customer name"
            />
            <input
              className="grow"
              placeholder="Phone"
              value={customerPhone}
              onChange={(e) => setCustomerPhone(e.target.value)}
              aria-label="Customer phone"
            />
          </div>
        ) : null}

        <div className="lines">
          {order?.items.map((i) => {
            const ticket = order.tickets.find((t) => t.id === i.ticketId);
            return (
              <div
                key={i.id}
                className="line"
                style={{ opacity: i.status === 'voided' || i.status === 'cancelled' ? 0.5 : 1 }}
              >
                <div className="row">
                  <strong className="grow">
                    {i.quantity} × {i.name}
                  </strong>
                  <Money minor={i.lineTotal} currency={menu.currency} />
                </div>
                {i.modifiers.map((m) => (
                  <div key={m.modifierId} className="small muted">
                    + {m.name}
                  </div>
                ))}
                {i.notes ? <div className="small">“{i.notes}”</div> : null}
                <div className="row small">
                  <Badge value={i.status} />
                  {ticket ? <span className="muted">{ticket.stationName}</span> : null}
                  {ticket?.printJobs.some((j) => j.status === 'failed' || j.status === 'dead') ? (
                    <span className="badge failed">printer problem</span>
                  ) : null}
                </div>
              </div>
            );
          })}
          {cart.map((l) => (
            <div key={l.id} className="line" style={{ borderColor: 'var(--brand)' }}>
              <div className="row">
                <strong className="grow">{l.product.name}</strong>
                <Money minor={unitPrice(l) * l.quantity} currency={menu.currency} />
              </div>
              {l.product.modifierGroups
                .flatMap((g) => g.modifiers)
                .filter((m) => l.modifierIds.includes(m.id))
                .map((m) => (
                  <div key={m.id} className="small muted">
                    + {m.name}
                  </div>
                ))}
              <div className="row">
                <div className="qty">
                  <button
                    type="button"
                    aria-label="Less"
                    onClick={() =>
                      setCart((c) =>
                        c.flatMap((x) =>
                          x.id === l.id ? (x.quantity > 1 ? [{ ...x, quantity: x.quantity - 1 }] : []) : [x],
                        ),
                      )
                    }
                  >
                    −
                  </button>
                  <strong style={{ minWidth: 28, textAlign: 'center' }}>{l.quantity}</strong>
                  <button
                    type="button"
                    aria-label="More"
                    onClick={() =>
                      setCart((c) => c.map((x) => (x.id === l.id ? { ...x, quantity: x.quantity + 1 } : x)))
                    }
                  >
                    +
                  </button>
                </div>
                <input
                  className="grow"
                  placeholder="Note (e.g. no onions)"
                  value={l.notes}
                  onChange={(e) =>
                    setCart((c) => c.map((x) => (x.id === l.id ? { ...x, notes: e.target.value } : x)))
                  }
                />
              </div>
            </div>
          ))}
          {!order && cart.length === 0 ? <div className="muted">Tap products to add them.</div> : null}
        </div>

        <div className="totals">
          {cart.length > 0 ? (
            <>
              <span className="muted">New items (estimate)</span>
              <Money minor={cartEstimate} currency={menu.currency} />
            </>
          ) : null}
          {order ? (
            <>
              <span className="muted">Tax (included)</span>
              <Money minor={order.taxTotal} currency={menu.currency} />
              <span className="grand">Total</span>
              <span className="grand">
                <Money minor={order.grandTotal} currency={menu.currency} />
              </span>
              <span className="muted">Paid</span>
              <Money minor={order.paidTotal - order.refundedTotal} currency={menu.currency} />
              <strong>Balance due</strong>
              <strong>
                <Money minor={order.balanceDue} currency={menu.currency} />
              </strong>
            </>
          ) : null}
        </div>

        <ErrorBox error={error} />

        {cart.length > 0 ? (
          canPayFirst ? (
            <button
              type="button"
              className="btn primary big block"
              disabled={!!busy}
              onClick={() => void send(false)}
            >
              {busy ? 'Saving…' : 'Save order, then take payment'}
            </button>
          ) : (
            <button
              type="button"
              className="btn primary big block"
              disabled={!!busy}
              onClick={() => void send(true)}
            >
              {busy === 'send' ? 'Sending…' : error ? 'Retry send' : 'Send to kitchen'}
            </button>
          )
        ) : null}

        {order && !closed ? (
          <div className="row wrap">
            {pendingOnServer > 0 ? (
              <button
                type="button"
                className="btn primary"
                disabled={!!busy}
                onClick={() =>
                  void run('send', () =>
                    api.sendToKitchen(orderId, { submissionId }).then((o) => {
                      setSubmissionId(uuid());
                      return o;
                    }),
                  )
                }
              >
                Send to kitchen
              </button>
            ) : null}
            {order.balanceDue > 0 && hasPermission(me, 'payment.record') ? (
              <button type="button" className="btn primary" onClick={() => setPaying(true)}>
                Take payment
              </button>
            ) : null}
            {readyItems > 0 ? (
              <button
                type="button"
                className="btn"
                disabled={!!busy}
                onClick={() => void run('fulfil', () => api.fulfilOrder(orderId))}
              >
                {area.channel === 'takeaway' ? 'Picked up' : 'Served'}
              </button>
            ) : null}
            {hasPermission(me, 'kitchen.operate') &&
            order.tickets.some((t) => !['ready', 'completed', 'cancelled'].includes(t.status)) ? (
              <button
                type="button"
                className="btn"
                disabled={!!busy}
                onClick={() => void run('ready', () => api.markReady(orderId))}
              >
                Mark ready
              </button>
            ) : null}
            {hasPermission(me, 'order.cancel') || hasPermission(me, 'order.void') ? (
              <button type="button" className="btn" onClick={() => setCorrecting(true)}>
                Cancel / void…
              </button>
            ) : null}
          </div>
        ) : null}
        {order ? (
          <div className="row wrap">
            {hasPermission(me, 'receipt.print') ? (
              <button
                type="button"
                className="btn"
                disabled={!!busy}
                onClick={() => void run('receipt', () => api.printReceipt(orderId, { requestId: uuid() }))}
              >
                Print receipt
              </button>
            ) : null}
            <button
              type="button"
              className="btn"
              onClick={() =>
                void api
                  .receipt(orderId)
                  .then((r) =>
                    setReceipt(
                      r.document.blocks
                        .map((b) =>
                          'text' in b
                            ? b.text
                            : 'left' in b
                              ? `${b.left}  ${b.right}`
                              : b.type === 'divider'
                                ? '—'.repeat(20)
                                : '',
                        )
                        .filter(Boolean),
                    ),
                  )
              }
            >
              View receipt
            </button>
            {closed ? (
              <button type="button" className="btn primary" onClick={onClose}>
                Done
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {modFor ? (
        <ModifierModal
          product={modFor}
          currency={menu.currency}
          onClose={() => setModFor(null)}
          onAdd={(ids, notes) => {
            add(modFor, ids, notes);
            setModFor(null);
          }}
        />
      ) : null}
      {paying && order ? (
        <PaymentModal
          order={order}
          currency={menu.currency}
          onClose={() => setPaying(false)}
          onPaid={async (o) => {
            feed.refresh();
            if (o.balanceDue === 0) setPaying(false);
            if (canPayFirst && o.items.some((i) => i.status === 'pending') && o.balanceDue === 0) {
              await run('send', () => api.sendToKitchen(orderId, { submissionId }));
              setSubmissionId(uuid());
            }
          }}
        />
      ) : null}
      {correcting && order ? (
        <CorrectionModal
          me={me}
          order={order}
          onClose={() => setCorrecting(false)}
          onChanged={() => feed.refresh()}
        />
      ) : null}
      {receipt ? (
        <Modal title="Receipt" onClose={() => setReceipt(null)}>
          <pre style={{ fontFamily: 'ui-monospace, monospace', whiteSpace: 'pre-wrap', margin: 0 }}>
            {receipt.join('\n')}
          </pre>
          <button type="button" className="btn" onClick={() => window.print()}>
            Print from this browser
          </button>
        </Modal>
      ) : null}
    </div>
  );
}

function ModifierModal({
  product,
  currency,
  onClose,
  onAdd,
}: {
  product: Product;
  currency: string;
  onClose: () => void;
  onAdd: (modifierIds: string[], notes: string) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [notes, setNotes] = useState('');
  const problems = product.modifierGroups.filter((g) => {
    const n = g.modifiers.filter((m) => selected.includes(m.id)).length;
    return n < g.minSelect || (g.maxSelect !== null && n > g.maxSelect);
  });
  function toggle(groupId: string, id: string) {
    const group = product.modifierGroups.find((g) => g.id === groupId)!;
    setSelected((s) => {
      if (s.includes(id)) return s.filter((x) => x !== id);
      const inGroup = s.filter((x) => group.modifiers.some((m) => m.id === x));
      if (group.maxSelect === 1) return [...s.filter((x) => !inGroup.includes(x)), id];
      return [...s, id];
    });
  }
  return (
    <Modal title={product.name} onClose={onClose}>
      {product.modifierGroups.map((g) => (
        <div key={g.id}>
          <strong>{g.name}</strong>{' '}
          <span className="muted small">
            {g.minSelect > 0 ? `choose ${g.minSelect}` : 'optional'}
            {g.maxSelect ? `, max ${g.maxSelect}` : ''}
          </span>
          <div className="row wrap" style={{ marginTop: 6 }}>
            {g.modifiers.map((m) => (
              <button
                key={m.id}
                type="button"
                className={`btn ${selected.includes(m.id) ? 'primary' : ''}`}
                onClick={() => toggle(g.id, m.id)}
              >
                {m.name}
                {m.priceDelta ? (
                  <>
                    {' '}
                    (+
                    <Money minor={m.priceDelta} currency={currency} />)
                  </>
                ) : null}
              </button>
            ))}
          </div>
        </div>
      ))}
      <input placeholder="Special instructions" value={notes} onChange={(e) => setNotes(e.target.value)} />
      <button
        type="button"
        className="btn primary big"
        disabled={problems.length > 0}
        onClick={() => onAdd(selected, notes.trim())}
      >
        Add to order
      </button>
    </Modal>
  );
}

/** Cancel (nothing started, nothing paid), void items, void a payment. Distinct actions with distinct permissions. */
function CorrectionModal({
  me,
  order,
  onClose,
  onChanged,
}: {
  me: MeView;
  order: OrderView;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [reason, setReason] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [requestId] = useState(uuid);
  const [error, setError] = useState<unknown>(null);
  const active = order.items.filter((i) => i.status !== 'voided' && i.status !== 'cancelled');
  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      onChanged();
      onClose();
    } catch (e) {
      setError(e);
    }
  }
  const ok = reason.trim().length >= 3;
  return (
    <Modal title={`Corrections — #${order.orderNumber}`} onClose={onClose}>
      <label>
        Reason (required, recorded in the audit log)
        <input value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      {hasPermission(me, 'order.void') ? (
        <div className="panel">
          <strong>Void items</strong>
          {active.map((i) => (
            <label key={i.id} className="row" style={{ flexDirection: 'row', color: 'var(--ink)' }}>
              <input
                type="checkbox"
                checked={picked.includes(i.id)}
                onChange={() =>
                  setPicked((p) => (p.includes(i.id) ? p.filter((x) => x !== i.id) : [...p, i.id]))
                }
              />
              {i.quantity} × {i.name} <Badge value={i.status} />
            </label>
          ))}
          <button
            type="button"
            className="btn danger"
            disabled={!ok || picked.length === 0}
            onClick={() =>
              void act(() => api.voidItems(order.id, { requestId, itemIds: picked, reason: reason.trim() }))
            }
          >
            Void selected items
          </button>
        </div>
      ) : null}
      {hasPermission(me, 'order.cancel') ? (
        <button
          type="button"
          className="btn danger"
          disabled={!ok}
          onClick={() => void act(() => api.cancelOrder(order.id, { reason: reason.trim() }))}
        >
          Cancel whole order (only before cooking and payment)
        </button>
      ) : null}
      {hasPermission(me, 'payment.void')
        ? order.payments
            .filter((p) => p.status === 'recorded' && p.direction === 'charge')
            .map((p) => (
              <button
                key={p.id}
                type="button"
                className="btn"
                disabled={!ok}
                onClick={() => void act(() => api.voidPayment(p.id, { reason: reason.trim() }))}
              >
                Void payment: {p.method.toUpperCase()} {(p.amount / 100).toFixed(2)}
              </button>
            ))
        : null}
      <ErrorBox error={error} />
    </Modal>
  );
}
