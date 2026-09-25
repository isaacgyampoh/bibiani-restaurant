import type { MenuView, MeView, OrderSummaryView, OrderView } from '@rp/contracts';
import { useMemo, useState } from 'react';
import { api, hasPermission, topics } from '../../infra/session';
import { useFeed } from '../../infra/use-feed';
import { Badge, ConnectionDot, ErrorBox, Field, Modal, Money, useToast } from '../../ui/components';
import { ReceiptModal } from '../../ui/Receipt';
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
const CLOSED = ['completed', 'cancelled', 'voided'];

/**
 * One screen for hall and takeaway: the same order domain, different area configuration. Totals
 * shown after sending come from the server; the cart shows an estimate only.
 */
export function OrderScreen({
  me,
  menu,
  area,
  tableId,
  existingOrderId,
  onClose,
  onOpenOrder,
}: {
  me: MeView;
  menu: MenuView;
  area: Area;
  tableId: string | null;
  existingOrderId: string | null;
  onClose: () => void;
  onOpenOrder: (o: { id: string; areaId: string; tableId: string | null }) => void;
}) {
  const branchId = menu.branchId;
  const toast = useToast();
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
  const [dialog, setDialog] = useState<'pay' | 'correct' | 'receipt' | 'move' | 'merge' | null>(null);
  const [printed, setPrinted] = useState<string | null>(null);

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
    const result = (await run(sendToKitchen ? 'send' : 'save', () =>
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
    )) as OrderView | null;
    // Same ids are reused on retry until the server confirms, so a lost response never duplicates anything.
    if (result) {
      setCart([]);
      setSubmissionId(uuid());
      toast(
        sendToKitchen
          ? `Order #${result.orderNumber} sent to the kitchen`
          : `Order #${result.orderNumber} saved`,
      );
    }
  }

  async function printReceipt() {
    setPrinted(null);
    await run('receipt', async () => {
      const r = await api.printReceipt(orderId, { requestId: uuid() }).catch((e) => {
        // No printer connected yet (hardware not installed): show the receipt on screen instead.
        if (e instanceof Error && /No receipt printer/.test(e.message)) {
          setDialog('receipt');
          setPrinted('No receipt printer connected yet: showing the receipt to print from this screen');
          return null;
        }
        throw e;
      });
      if (!r) return null;
      setPrinted(
        r.isReprint ? 'Receipt sent to the printer (marked REPRINT)' : 'Receipt sent to the printer',
      );
      feed.refresh();
      return r;
    });
  }

  const pendingOnServer = order?.items.filter((i) => i.status === 'pending').length ?? 0;
  const canPayFirst = area.requirePaymentBeforeProduction;
  const readyItems = order?.items.filter((i) => i.status === 'ready').length ?? 0;
  const closed = order ? CLOSED.includes(order.status) : false;
  const title = order
    ? `${area.channel === 'takeaway' ? 'Takeaway' : 'Order'} #${order.orderNumber}${order.table ? ` · Table ${order.table.label}` : ''}`
    : `New ${area.name.toLowerCase()} order`;

  return (
    <div className="pos">
      <div className="menu">
        <div className="menu-head">
          <button type="button" className="btn lg" onClick={onClose}>
            ← Back
          </button>
          <input
            className="search"
            placeholder="Search products"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search products"
          />
        </div>
        <div className="menu-body">
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
                onClick={() => {
                  setSearch('');
                  setCategory(c.id);
                }}
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
                <span className="row">
                  <span className="price grow">
                    {p.isAvailable ? <Money minor={p.price} currency={menu.currency} /> : 'Sold out'}
                  </span>
                  {p.modifierGroups.length ? <span className="mods">OPTIONS</span> : null}
                </span>
              </button>
            ))}
            {products.length === 0 ? <div className="muted">No products match “{search}”.</div> : null}
          </div>
        </div>
      </div>

      <div className="cart">
        <div className="cart-head">
          <div className="row">
            <strong className="grow">{title}</strong>
            {order?.isRush ? <span className="rush-tag">RUSH</span> : null}
            {known ? <ConnectionDot state={feed.connection} /> : null}
          </div>
          {order ? (
            <div className="row">
              <Badge value={order.status} />
              <Badge value={order.paymentStatus} />
            </div>
          ) : null}
          {order && !closed ? (
            <div className="cart-tools">
              {hasPermission(me, 'order.send') ? (
                <button
                  type="button"
                  className="btn sm"
                  aria-pressed={order.isRush}
                  disabled={!!busy}
                  onClick={() => void run('rush', () => api.setPriority(orderId, !order.isRush))}
                >
                  {order.isRush ? 'Remove rush' : 'Rush'}
                </button>
              ) : null}
              {hasPermission(me, 'order.create') ? (
                <>
                  <button type="button" className="btn sm" onClick={() => setDialog('move')}>
                    Move
                  </button>
                  <button type="button" className="btn sm" onClick={() => setDialog('merge')}>
                    Merge
                  </button>
                </>
              ) : null}
              {hasPermission(me, 'order.cancel') || hasPermission(me, 'order.void') ? (
                <button type="button" className="btn sm" onClick={() => setDialog('correct')}>
                  Cancel / void…
                </button>
              ) : null}
            </div>
          ) : null}
          {area.channel === 'takeaway' && !known ? (
            <div className="row">
              <input
                placeholder={area.requiresCustomerName ? 'Customer name (required)' : 'Customer name'}
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                aria-label="Customer name"
              />
              <input
                placeholder="Phone"
                value={customerPhone}
                onChange={(e) => setCustomerPhone(e.target.value)}
                aria-label="Customer phone"
              />
            </div>
          ) : null}
        </div>

        <div className="lines">
          {order?.items.map((i) => {
            const ticket = order.tickets.find((t) => t.id === i.ticketId);
            const gone = i.status === 'voided' || i.status === 'cancelled';
            return (
              <div key={i.id} className={`line ${gone ? 'gone' : ''}`}>
                <div className="name-row">
                  <strong>
                    {i.quantity} × {i.name}
                  </strong>
                  <Money minor={i.lineTotal} currency={menu.currency} />
                </div>
                {i.modifiers.length ? (
                  <div className="sub">+ {i.modifiers.map((m) => m.name).join(', ')}</div>
                ) : null}
                {i.notes ? <div className="note-text">“{i.notes}”</div> : null}
                <div className="row small">
                  <Badge value={i.status} />
                  {ticket ? <span className="muted">{ticket.stationName}</span> : null}
                  {ticket?.printJobs.some((j) => j.status === 'failed' || j.status === 'dead') ? (
                    <Badge value="failed" label="Printer problem" tone="danger" />
                  ) : null}
                </div>
              </div>
            );
          })}
          {cart.map((l) => (
            <div key={l.id} className="line new">
              <div className="name-row">
                <strong>{l.product.name}</strong>
                <Money minor={unitPrice(l) * l.quantity} currency={menu.currency} />
              </div>
              {l.modifierIds.length ? (
                <div className="sub">
                  +{' '}
                  {l.product.modifierGroups
                    .flatMap((g) => g.modifiers)
                    .filter((m) => l.modifierIds.includes(m.id))
                    .map((m) => m.name)
                    .join(', ')}
                </div>
              ) : null}
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
                  <strong>{l.quantity}</strong>
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
                  placeholder="Note for the kitchen"
                  aria-label={`Note for ${l.product.name}`}
                  value={l.notes}
                  onChange={(e) =>
                    setCart((c) => c.map((x) => (x.id === l.id ? { ...x, notes: e.target.value } : x)))
                  }
                />
              </div>
            </div>
          ))}
          {!order && cart.length === 0 ? (
            <div className="cart-empty">Tap products to add them to the order.</div>
          ) : null}
        </div>

        <div className="cart-foot">
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
                <span className="muted">Paid</span>
                <Money minor={order.paidTotal - order.refundedTotal} currency={menu.currency} />
                <span className="grand">Total</span>
                <span className="grand">
                  <Money minor={order.grandTotal} currency={menu.currency} />
                </span>
                <strong>Balance due</strong>
                <strong>
                  <Money minor={order.balanceDue} currency={menu.currency} />
                </strong>
              </>
            ) : null}
          </div>

          <ErrorBox error={error} />
          {printed ? (
            <div className="cart-status" role="status">
              {printed}
            </div>
          ) : null}

          <div className="cart-actions">
            {cart.length > 0 ? (
              canPayFirst ? (
                <button
                  type="button"
                  className="btn primary xl wide"
                  disabled={!!busy}
                  onClick={() => void send(false)}
                >
                  {busy ? 'Saving…' : 'Save order, then take payment'}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn primary xl wide"
                  disabled={!!busy}
                  onClick={() => void send(true)}
                >
                  {busy === 'send' ? 'Sending…' : error ? 'Retry send' : 'Send to kitchen'}
                </button>
              )
            ) : null}
            {order && !closed && pendingOnServer > 0 && cart.length === 0 ? (
              <button
                type="button"
                className="btn primary xl wide"
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
            {order && !closed && order.balanceDue > 0 && hasPermission(me, 'payment.record') ? (
              <button
                type="button"
                className={`btn lg ${cart.length === 0 && pendingOnServer === 0 ? 'primary wide' : ''}`}
                onClick={() => setDialog('pay')}
              >
                Take payment
              </button>
            ) : null}
            {order && !closed && readyItems > 0 ? (
              <button
                type="button"
                className="btn go lg"
                disabled={!!busy}
                onClick={() => void run('fulfil', () => api.fulfilOrder(orderId))}
              >
                {area.channel === 'takeaway' ? 'Picked up' : 'Served'}
              </button>
            ) : null}
            {order &&
            !closed &&
            hasPermission(me, 'kitchen.operate') &&
            order.tickets.some((t) => !['ready', 'completed', 'cancelled'].includes(t.status)) ? (
              <button
                type="button"
                className="btn lg"
                disabled={!!busy}
                onClick={() => void run('ready', () => api.markReady(orderId))}
              >
                Mark ready
              </button>
            ) : null}
            {order && hasPermission(me, 'receipt.print') ? (
              <button type="button" className="btn lg" disabled={!!busy} onClick={() => void printReceipt()}>
                {order.receiptsPrinted > 0 ? 'Reprint receipt' : 'Print receipt'}
              </button>
            ) : null}
            {order ? (
              <button type="button" className="btn lg" onClick={() => setDialog('receipt')}>
                View receipt
              </button>
            ) : null}
            {closed ? (
              <button type="button" className="btn primary lg wide" onClick={onClose}>
                Done
              </button>
            ) : null}
          </div>
        </div>
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
      {dialog === 'pay' && order ? (
        <PaymentModal
          order={order}
          currency={menu.currency}
          onClose={() => setDialog(null)}
          onPaid={async (o) => {
            feed.refresh();
            if (o.balanceDue === 0) {
              setDialog(null);
              toast(`Order #${o.orderNumber} paid`);
            }
            if (canPayFirst && o.items.some((i) => i.status === 'pending') && o.balanceDue === 0) {
              await run('send', () => api.sendToKitchen(orderId, { submissionId }));
              setSubmissionId(uuid());
            }
          }}
        />
      ) : null}
      {dialog === 'correct' && order ? (
        <CorrectionModal
          me={me}
          order={order}
          onClose={() => setDialog(null)}
          onChanged={() => feed.refresh()}
        />
      ) : null}
      {dialog === 'receipt' ? <ReceiptModal orderId={orderId} onClose={() => setDialog(null)} /> : null}
      {dialog === 'move' && order ? (
        <MoveDialog
          menu={menu}
          order={order}
          onClose={() => setDialog(null)}
          onMoved={(o) => {
            setDialog(null);
            toast(`Order #${o.orderNumber} moved`);
            onOpenOrder({ id: o.id, areaId: o.areaId, tableId: o.table?.id ?? null });
          }}
        />
      ) : null}
      {dialog === 'merge' && order ? (
        <MergeDialog
          order={order}
          currency={menu.currency}
          onClose={() => setDialog(null)}
          onMerged={(o) => {
            setDialog(null);
            feed.refresh();
            toast(`Merged into order #${o.orderNumber}`);
          }}
        />
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
  const extra = product.modifierGroups
    .flatMap((g) => g.modifiers)
    .filter((m) => selected.includes(m.id))
    .reduce((a, m) => a + m.priceDelta, 0);
  return (
    <Modal
      title={product.name}
      onClose={onClose}
      footer={
        <>
          <span className="grow muted">
            <Money minor={product.price + extra} currency={currency} />
          </span>
          <button type="button" className="btn lg" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary lg"
            disabled={problems.length > 0}
            onClick={() => onAdd(selected, notes.trim())}
          >
            Add to order
          </button>
        </>
      }
    >
      {product.modifierGroups.map((g) => (
        <fieldset key={g.id}>
          <legend>
            {g.name}{' '}
            <span className="muted small">
              {g.minSelect > 0 ? `choose ${g.minSelect}` : 'optional'}
              {g.maxSelect ? ` · up to ${g.maxSelect}` : ''}
            </span>
          </legend>
          <div className="chips">
            {g.modifiers.map((m) => (
              <button
                key={m.id}
                type="button"
                className={`btn lg ${selected.includes(m.id) ? 'primary' : ''}`}
                aria-pressed={selected.includes(m.id)}
                onClick={() => toggle(g.id, m.id)}
              >
                {m.name}
                {m.priceDelta ? (
                  <>
                    {' '}
                    +<Money minor={m.priceDelta} currency={currency} />
                  </>
                ) : null}
              </button>
            ))}
          </div>
        </fieldset>
      ))}
      <Field label="Special instructions">
        <input placeholder="e.g. no pepper" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
    </Modal>
  );
}

/** Move the order to another table, or convert it to takeaway. History is kept. */
function MoveDialog({
  menu,
  order,
  onClose,
  onMoved,
}: {
  menu: MenuView;
  order: OrderView;
  onClose: () => void;
  onMoved: (o: OrderView) => void;
}) {
  const [areaId, setAreaId] = useState(order.areaId);
  const [customerName, setCustomerName] = useState(order.customerName ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const floor = useFeed(`floor:${menu.branchId}`, () => api.floor(menu.branchId), {
    topic: null,
    pollMs: 30_000,
  });
  const area = menu.areas.find((a) => a.id === areaId)!;
  const free = (floor.data?.tables ?? []).filter((t) => t.areaId === areaId && t.state === 'available');
  async function move(tableId: string | null) {
    setBusy(true);
    setError(null);
    try {
      onMoved(
        await api.transferOrder(order.id, { areaId, tableId, customerName: customerName.trim() || null }),
      );
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={`Move order #${order.orderNumber}`} onClose={onClose}>
      <div className="seg">
        {menu.areas.map((a) => (
          <button
            key={a.id}
            type="button"
            className={a.id === areaId ? 'on' : ''}
            onClick={() => setAreaId(a.id)}
          >
            {a.name}
          </button>
        ))}
      </div>
      {area.channel === 'dine_in' ? (
        <>
          <div className="muted small">Choose a free table. Kitchen screens update straight away.</div>
          <div className="chips">
            {free.map((t) => (
              <button
                key={t.id}
                type="button"
                className="btn lg"
                disabled={busy}
                onClick={() => void move(t.id)}
              >
                Table {t.label}
              </button>
            ))}
            {floor.data && free.length === 0 ? (
              <span className="muted">No free tables here. Use Merge instead.</span>
            ) : null}
          </div>
        </>
      ) : (
        <>
          <Field label="Customer name" required={area.requiresCustomerName}>
            <input value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
          </Field>
          <button type="button" className="btn primary lg" disabled={busy} onClick={() => void move(null)}>
            Convert to {area.name.toLowerCase()}
          </button>
        </>
      )}
      <ErrorBox error={error} />
    </Modal>
  );
}

/** Bring another open order's items and payments onto this bill (e.g. two tables joining). */
function MergeDialog({
  order,
  currency,
  onClose,
  onMerged,
}: {
  order: OrderView;
  currency: string;
  onClose: () => void;
  onMerged: (o: OrderView) => void;
}) {
  const [pick, setPick] = useState<OrderSummaryView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const active = useFeed(`orders:${order.branchId}`, () => api.activeOrders(order.branchId), {
    topic: null,
    pollMs: 30_000,
  });
  const others = (active.data ?? []).filter((o) => o.id !== order.id);
  async function merge() {
    if (!pick) return;
    setBusy(true);
    setError(null);
    try {
      onMerged(await api.mergeOrders(order.id, pick.id));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`Merge into order #${order.orderNumber}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={!pick || busy} onClick={() => void merge()}>
            {pick ? `Merge #${pick.orderNumber} into #${order.orderNumber}` : 'Choose an order'}
          </button>
        </>
      }
    >
      <div className="muted small">
        The chosen order’s items, kitchen tickets and payments move to this bill. It is closed as merged and
        keeps its history.
      </div>
      <div className="split-items">
        {others.map((o) => (
          <label key={o.id}>
            <span className="row">
              <input type="radio" name="merge" checked={pick?.id === o.id} onChange={() => setPick(o)} />#
              {o.orderNumber} · {o.tableLabel ? `Table ${o.tableLabel}` : (o.customerName ?? o.areaName)}
            </span>
            <Money minor={o.grandTotal} currency={currency} />
          </label>
        ))}
        {active.data && others.length === 0 ? <div className="empty">No other open orders</div> : null}
      </div>
      <ErrorBox error={error} />
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
  const toast = useToast();
  const active = order.items.filter((i) => i.status !== 'voided' && i.status !== 'cancelled');
  async function act(fn: () => Promise<unknown>, done: string) {
    setError(null);
    try {
      await fn();
      onChanged();
      toast(done);
      onClose();
    } catch (e) {
      setError(e);
    }
  }
  const ok = reason.trim().length >= 3;
  const payments = order.payments.filter((p) => p.status === 'recorded' && p.direction === 'charge');
  return (
    <Modal title={`Corrections — #${order.orderNumber}`} onClose={onClose}>
      <Field label="Reason" required hint="Recorded in the audit history with your name.">
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. customer changed their mind"
        />
      </Field>
      {hasPermission(me, 'order.void') ? (
        <fieldset>
          <legend>Void items (already sent: recorded as waste)</legend>
          <div className="split-items">
            {active.map((i) => (
              <label key={i.id}>
                <span className="row">
                  <input
                    type="checkbox"
                    checked={picked.includes(i.id)}
                    onChange={() =>
                      setPicked((p) => (p.includes(i.id) ? p.filter((x) => x !== i.id) : [...p, i.id]))
                    }
                  />
                  {i.quantity} × {i.name}
                </span>
                <Badge value={i.status} />
              </label>
            ))}
          </div>
          <button
            type="button"
            className="btn danger"
            disabled={!ok || picked.length === 0}
            onClick={() =>
              void act(
                () => api.voidItems(order.id, { requestId, itemIds: picked, reason: reason.trim() }),
                'Items voided',
              )
            }
          >
            Void selected items
          </button>
        </fieldset>
      ) : null}
      {hasPermission(me, 'order.cancel') ? (
        <fieldset>
          <legend>Cancel the whole order</legend>
          <div className="muted small">
            Only before cooking starts and before any payment. Stock is returned.
          </div>
          <button
            type="button"
            className="btn danger"
            disabled={!ok}
            onClick={() =>
              void act(() => api.cancelOrder(order.id, { reason: reason.trim() }), 'Order cancelled')
            }
          >
            Cancel whole order
          </button>
        </fieldset>
      ) : null}
      {hasPermission(me, 'payment.void') && payments.length > 0 ? (
        <fieldset>
          <legend>Void a payment recorded by mistake</legend>
          {payments.map((p) => (
            <button
              key={p.id}
              type="button"
              className="btn"
              disabled={!ok}
              onClick={() =>
                void act(() => api.voidPayment(p.id, { reason: reason.trim() }), 'Payment voided')
              }
            >
              Void payment: {p.method.toUpperCase()} {(p.amount / 100).toFixed(2)}
            </button>
          ))}
        </fieldset>
      ) : null}
      <ErrorBox error={error} />
    </Modal>
  );
}
