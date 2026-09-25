import type { MeView, OrderSummaryView, OrderView } from '@rp/contracts';
import { formatMinor } from '@rp/domain';
import { useEffect, useState } from 'react';
import { navigate } from '../../infra/router';
import { api, hasPermission, topics } from '../../infra/session';
import { useFeed } from '../../infra/use-feed';
import { Badge, ConnectionDot, ErrorBox, Modal } from '../../ui/components';
import { ReceiptModal } from '../../ui/Receipt';
import { Empty, Shell, Skeleton } from '../../ui/Shell';

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const METHOD: Record<string, string> = { cash: 'Cash', momo: 'MoMo', card: 'Card' };

export function OrdersPage({ me }: { me: MeView }) {
  const branchId = me.branches[0]?.id ?? '';
  const [tab, setTab] = useState<'open' | 'closed'>('open');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const active = useFeed(`orders:${branchId}`, () => api.activeOrders(branchId), {
    topic: topics.orders(branchId),
    pollMs: 30_000,
  });
  const closed = useFeed(
    tab === 'closed' ? `closed:${branchId}` : null,
    () => api.recentClosedOrders(branchId),
    {
      topic: topics.orders(branchId),
      pollMs: 60_000,
    },
  );
  const feed = tab === 'open' ? active : closed;
  const q = query.trim().toLowerCase();
  const rows = (feed.data ?? []).filter(
    (o) =>
      !q ||
      String(o.orderNumber).includes(q) ||
      (o.tableLabel ?? '').toLowerCase() === q ||
      (o.customerName ?? '').toLowerCase().includes(q),
  );
  const money = (m: number) => formatMinor(m, me.restaurant.currency);
  return (
    <Shell
      me={me}
      title="Orders"
      subtitle="Every order from every till, live."
      actions={<ConnectionDot state={feed.connection} />}
    >
      <ErrorBox error={feed.error} />
      <section className="card">
        <div className="toolbar">
          <div className="seg">
            <button type="button" className={tab === 'open' ? 'on' : ''} onClick={() => setTab('open')}>
              Open {active.data ? `(${active.data.length})` : ''}
            </button>
            <button type="button" className={tab === 'closed' ? 'on' : ''} onClick={() => setTab('closed')}>
              Completed & cancelled
            </button>
          </div>
          <input
            className="search"
            placeholder="Order number, table or customer"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {!feed.data ? (
          <Skeleton rows={6} />
        ) : rows.length === 0 ? (
          <Empty
            title={q ? 'No matching orders' : tab === 'open' ? 'No open orders' : 'No completed orders today'}
          >
            {tab === 'open'
              ? 'New orders from any POS appear here immediately.'
              : 'Completed orders of today and yesterday are listed here.'}
          </Empty>
        ) : (
          <table className="list clickable">
            <thead>
              <tr>
                <th>#</th>
                <th>Where</th>
                <th>Status</th>
                <th>Payment</th>
                <th className="num">Total</th>
                <th className="num">Due</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((o: OrderSummaryView) => (
                <tr
                  key={o.id}
                  onClick={() => setOpenId(o.id)}
                  tabIndex={0}
                  onKeyDown={(e) => e.key === 'Enter' && setOpenId(o.id)}
                >
                  <td>
                    <strong className="big-num">{o.orderNumber}</strong>
                  </td>
                  <td>
                    {o.tableLabel ? `${o.areaName} · Table ${o.tableLabel}` : o.areaName}
                    {o.customerName ? ` · ${o.customerName}` : ''}
                  </td>
                  <td>
                    <Badge value={o.status} />
                  </td>
                  <td>
                    <Badge value={o.paymentStatus} />
                  </td>
                  <td className="num">{money(o.grandTotal)}</td>
                  <td className="num">{o.balanceDue ? money(o.balanceDue) : '—'}</td>
                  <td className="muted">{time(o.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {openId ? <OrderDetail me={me} orderId={openId} onClose={() => setOpenId(null)} /> : null}
    </Shell>
  );
}

function OrderDetail({ me, orderId, onClose }: { me: MeView; orderId: string; onClose: () => void }) {
  const [order, setOrder] = useState<OrderView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showReceipt, setShowReceipt] = useState(false);
  useEffect(() => {
    api.getOrder(orderId).then(setOrder).catch(setError);
  }, [orderId]);
  const money = (m: number) => formatMinor(m, me.restaurant.currency);
  const closed = order ? ['completed', 'cancelled', 'voided'].includes(order.status) : false;
  return (
    <Modal title={order ? `Order #${order.orderNumber}` : 'Order'} onClose={onClose}>
      <ErrorBox error={error} />
      {!order ? (
        <Skeleton />
      ) : (
        <div className="order-detail">
          <div className="row wrap">
            <Badge value={order.status} />
            <Badge value={order.paymentStatus} />
            <span className="muted small">
              {order.table ? `${order.areaName} · Table ${order.table.label}` : order.areaName}
              {order.customerName ? ` · ${order.customerName}` : ''} · {time(order.createdAt)}
            </span>
          </div>
          <table className="list">
            <tbody>
              {order.items.map((i) => {
                const station = order.tickets.find((t) => t.itemIds.includes(i.id))?.stationName;
                return (
                  <tr
                    key={i.id}
                    className={i.status === 'voided' || i.status === 'cancelled' ? 'inactive' : ''}
                  >
                    <td>
                      {i.quantity} × {i.name}
                      {i.modifiers.length ? (
                        <div className="small muted">+ {i.modifiers.map((m) => m.name).join(', ')}</div>
                      ) : null}
                    </td>
                    <td className="small muted">{station ?? ''}</td>
                    <td>
                      <Badge value={i.status} />
                    </td>
                    <td className="num">{money(i.lineTotal)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="totals-box">
            <div className="row">
              <span className="grow">Total</span>
              <strong>{money(order.grandTotal)}</strong>
            </div>
            {order.payments.map((p) => (
              <div key={p.id} className="row small">
                <span className="grow">
                  {p.direction === 'refund' ? 'Refund' : METHOD[p.method]}{' '}
                  {p.reference ? `· ${p.reference}` : ''}
                  {p.status === 'voided' ? ' (voided)' : ''}
                </span>
                <span>{money(p.amount)}</span>
              </div>
            ))}
            <div className="row">
              <span className="grow">Balance due</span>
              <strong>{money(order.balanceDue)}</strong>
            </div>
          </div>
          {notice ? (
            <div className="info-box ok" role="status">
              {notice}
            </div>
          ) : null}
          <div className="row end wrap">
            {hasPermission(me, 'receipt.print') ? (
              <button
                type="button"
                className="btn"
                onClick={() =>
                  void api
                    .printReceipt(order.id, { requestId: crypto.randomUUID() })
                    .then((r) => {
                      setNotice(
                        r.isReprint
                          ? 'Receipt sent to the printer (marked REPRINT)'
                          : 'Receipt sent to the printer',
                      );
                      return api.getOrder(order.id).then(setOrder);
                    })
                    .catch((e) =>
                      e instanceof Error && /No receipt printer/.test(e.message)
                        ? setNotice(
                            'No receipt printer is connected yet. Use the POS “View receipt” to show it on screen.',
                          )
                        : setError(e),
                    )
                }
              >
                {order.receiptsPrinted > 0 ? 'Reprint receipt' : 'Print receipt'}
              </button>
            ) : null}
            <button type="button" className="btn" onClick={() => setShowReceipt(true)}>
              View receipt
            </button>
            {!closed && hasPermission(me, 'order.create') ? (
              <button
                type="button"
                className="btn primary"
                onClick={() =>
                  navigate(
                    `/pos?order=${order.id}&area=${order.areaId}${order.table ? `&table=${order.table.id}` : ''}`,
                  )
                }
              >
                Open in POS
              </button>
            ) : null}
          </div>
        </div>
      )}
      {showReceipt && order ? (
        <ReceiptModal orderId={order.id} onClose={() => setShowReceipt(false)} />
      ) : null}
    </Modal>
  );
}
