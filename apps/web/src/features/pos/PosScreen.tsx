import type { MenuView, MeView, OrderSummaryView } from '@rp/contracts';
import { useEffect, useState } from 'react';
import { linkTo, navigate } from '../../infra/router';
import { api, hasPermission, posDevice, signOut, topics } from '../../infra/session';
import { useFeed } from '../../infra/use-feed';
import { Badge, ConnectionDot, ErrorBox, Money, statusLabel } from '../../ui/components';
import { Empty, Skeleton } from '../../ui/Shell';
import { BrandPanel } from '../auth/LoginScreen';
import { OrderScreen } from './OrderScreen';

type View =
  | { kind: 'area'; areaId: string }
  | { kind: 'completed'; areaId: string }
  | { kind: 'order'; areaId: string; tableId: string | null; orderId: string | null };

const IDLE_LOCK_MS = 5 * 60_000;
const minutesSince = (iso: string) =>
  Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));

export function PosScreen({ me }: { me: MeView }) {
  const branchId = me.branches[0]?.id ?? '';
  const [menu, setMenu] = useState<MenuView | null>(null);
  const [menuError, setMenuError] = useState<unknown>(null);
  const [view, setView] = useState<View | null>(null);
  const till = posDevice();

  useEffect(() => {
    if (!branchId) return;
    api
      .menu(branchId)
      .then((m) => {
        setMenu(m);
        setView((v) => {
          if (v) return v;
          // Deep link from Orders: /pos?order=<id>&area=<id>[&table=<id>]
          const q = new URLSearchParams(window.location.search);
          const area = m.areas.find((a) => a.id === q.get('area'));
          if (area && q.get('order'))
            return { kind: 'order', areaId: area.id, tableId: q.get('table'), orderId: q.get('order') };
          return m.areas[0] ? { kind: 'area', areaId: m.areas[0].id } : null;
        });
      })
      .catch(setMenuError);
  }, [branchId]);

  // A till unlocked with a PIN locks itself after a few idle minutes, back to the PIN pad.
  useEffect(() => {
    if (!till || me.signedInWith !== 'pin') return;
    let timer = setTimeout(() => void signOut(), IDLE_LOCK_MS);
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void signOut(), IDLE_LOCK_MS);
    };
    for (const e of ['pointerdown', 'keydown']) window.addEventListener(e, reset);
    return () => {
      clearTimeout(timer);
      for (const e of ['pointerdown', 'keydown']) window.removeEventListener(e, reset);
    };
  }, [till, me.signedInWith]);

  if (!branchId)
    return (
      <div className="auth">
        <BrandPanel />
        <div className="auth-card">
          <Empty title="No branch assigned">Ask a manager to give your account access to a branch.</Empty>
        </div>
      </div>
    );
  if (menuError)
    return (
      <div className="auth">
        <BrandPanel />
        <div className="auth-card">
          <ErrorBox error={menuError} />
        </div>
      </div>
    );
  if (!menu || !view)
    return (
      <div className="pos-app">
        <Skeleton rows={6} />
      </div>
    );
  const area = menu.areas.find((a) => a.id === view.areaId)!;

  return (
    <div className="pos-app">
      <div className="topbar">
        <img className="logo-img" src="/logo-64.png" alt="" />
        <span className="title">{me.restaurant.name}</span>
        <div className="tabs" role="tablist">
          {menu.areas.map((a) => (
            <button
              key={a.id}
              type="button"
              role="tab"
              aria-selected={view.areaId === a.id && view.kind === 'area'}
              className={`tab ${view.areaId === a.id && view.kind === 'area' ? 'active' : ''}`}
              onClick={() => setView({ kind: 'area', areaId: a.id })}
            >
              {a.name}
            </button>
          ))}
          <button
            type="button"
            role="tab"
            aria-selected={view.kind === 'completed'}
            className={`tab ${view.kind === 'completed' ? 'active' : ''}`}
            onClick={() => setView({ kind: 'completed', areaId: view.areaId })}
          >
            Completed
          </button>
        </div>
        <span className="spacer" />
        {hasPermission(me, 'order.view') ? (
          <a href="/orders" onClick={linkTo('/orders')}>
            Orders
          </a>
        ) : null}
        {hasPermission(me, 'reports.view') || hasPermission(me, 'menu.manage') ? (
          <a href="/dashboard" onClick={linkTo('/dashboard')}>
            Back office
          </a>
        ) : null}
        <span className="who">
          <strong>{me.displayName}</strong>
          {till ? till.name : 'Browser till'}
        </span>
        {me.pin?.hasPin ? (
          <button type="button" className="link" onClick={() => navigate('/my-pin')}>
            PIN
          </button>
        ) : null}
        <button type="button" className="link" onClick={() => void signOut()}>
          {till && me.signedInWith === 'pin' ? 'Lock' : 'Sign out'}
        </button>
      </div>
      {view.kind === 'order' ? (
        <OrderScreen
          key={view.orderId ?? `new-${view.tableId}`}
          me={me}
          menu={menu}
          area={area}
          tableId={view.tableId}
          existingOrderId={view.orderId}
          onClose={() => setView({ kind: 'area', areaId: view.areaId })}
          onOpenOrder={(o) => setView({ kind: 'order', areaId: o.areaId, tableId: o.tableId, orderId: o.id })}
        />
      ) : view.kind === 'completed' ? (
        <CompletedView
          branchId={branchId}
          currency={menu.currency}
          onOpen={(o) => setView({ kind: 'order', areaId: o.areaId, tableId: o.tableId, orderId: o.id })}
        />
      ) : area.channel === 'dine_in' ? (
        <HallView
          branchId={branchId}
          areaId={area.id}
          currency={menu.currency}
          onOpen={(tableId, orderId) => setView({ kind: 'order', areaId: area.id, tableId, orderId })}
        />
      ) : (
        <TakeawayView
          branchId={branchId}
          currency={menu.currency}
          onNew={() => setView({ kind: 'order', areaId: area.id, tableId: null, orderId: null })}
          onOpen={(orderId) => setView({ kind: 'order', areaId: area.id, tableId: null, orderId })}
        />
      )}
    </div>
  );
}

const TABLE_LABEL: Record<string, string> = {
  available: 'Available',
  occupied: 'Occupied',
  ready_to_serve: 'Ready to serve',
  awaiting_payment: 'Awaiting payment',
  cleaning: 'Needs cleaning',
  reserved: 'Reserved',
  out_of_service: 'Out of service',
};
const LEGEND: [string, string][] = [
  ['available', 'var(--line-strong)'],
  ['occupied', 'var(--info)'],
  ['ready_to_serve', 'var(--ok)'],
  ['awaiting_payment', 'var(--prep)'],
  ['cleaning', 'var(--faint)'],
];

function HallView({
  branchId,
  areaId,
  currency,
  onOpen,
}: {
  branchId: string;
  areaId: string;
  currency: string;
  onOpen: (tableId: string, orderId: string | null) => void;
}) {
  const feed = useFeed(`floor:${branchId}`, () => api.floor(branchId), {
    topic: topics.orders(branchId),
    pollMs: 30_000,
  });
  const tables = feed.data?.tables.filter((t) => t.areaId === areaId) ?? [];
  const counts: Record<string, number> = {};
  for (const t of tables) counts[t.state] = (counts[t.state] ?? 0) + 1;

  async function clean(tableId: string) {
    await api.setTableStatus(tableId, { status: 'available' });
    feed.refresh();
  }

  return (
    <>
      <div className="floor-bar">
        <ul className="legend" aria-label="Table states">
          {LEGEND.map(([state, colour]) => (
            <li key={state}>
              <i style={{ background: colour }} />
              {TABLE_LABEL[state]} <strong>{counts[state] ?? 0}</strong>
            </li>
          ))}
        </ul>
        <span className="grow" />
        <ConnectionDot state={feed.connection} />
      </div>
      <ErrorBox error={feed.error} />
      {!feed.data ? (
        <Skeleton rows={4} />
      ) : tables.length === 0 ? (
        <Empty title="No tables in this area">Add tables in Floor &amp; tables.</Empty>
      ) : (
        <div className="floor">
          {tables.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`table-card ${t.state}`}
              onClick={() => (t.state === 'cleaning' ? void clean(t.id) : onOpen(t.id, t.order?.id ?? null))}
              disabled={t.state === 'out_of_service'}
            >
              <span className="label">{t.label}</span>
              <span className="state">
                {t.order && t.state === 'occupied' ? statusLabel(t.order.status) : TABLE_LABEL[t.state]}
              </span>
              {t.order ? (
                <span className="meta">
                  #{t.order.orderNumber} · <Money minor={t.order.balanceDue} currency={currency} /> due ·{' '}
                  {minutesSince(t.order.openedAt)} min
                </span>
              ) : (
                <span className="meta">
                  {t.state === 'cleaning' ? 'Tap when clean' : `${t.capacity} seats`}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function OrderRows({
  orders,
  currency,
  onOpen,
  empty,
  showWhere,
}: {
  orders: OrderSummaryView[];
  currency: string;
  onOpen: (o: OrderSummaryView) => void;
  empty: string;
  showWhere?: boolean;
}) {
  return (
    <div className="card">
      <table className="list clickable">
        <thead>
          <tr>
            <th>Order</th>
            <th>{showWhere ? 'Where' : 'Customer'}</th>
            <th>Status</th>
            <th>Payment</th>
            <th className="num">{showWhere ? 'Total' : 'Due'}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.id} onClick={() => onOpen(o)}>
              <td>
                <strong className="big-num">{o.orderNumber}</strong>{' '}
                {o.isRush ? <span className="rush-tag">RUSH</span> : null}
              </td>
              <td>
                {showWhere ? (o.tableLabel ? `${o.areaName} · Table ${o.tableLabel}` : o.areaName) : null}
                {o.customerName ? `${showWhere ? ' · ' : ''}${o.customerName}` : null}
                {!showWhere && !o.customerName ? <span className="muted">—</span> : null}
              </td>
              <td>
                <Badge value={o.status} />
              </td>
              <td>
                <Badge value={o.paymentStatus} />
              </td>
              <td className="num">
                <Money minor={showWhere ? o.grandTotal : o.balanceDue} currency={currency} />
              </td>
              <td className="actions-cell">
                <button
                  type="button"
                  className="btn sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpen(o);
                  }}
                >
                  Open
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {orders.length === 0 ? <Empty title={empty} /> : null}
    </div>
  );
}

function TakeawayView({
  branchId,
  currency,
  onNew,
  onOpen,
}: {
  branchId: string;
  currency: string;
  onNew: () => void;
  onOpen: (orderId: string) => void;
}) {
  const feed = useFeed(`orders:${branchId}`, () => api.activeOrders(branchId), {
    topic: topics.orders(branchId),
    pollMs: 30_000,
  });
  const orders = (feed.data ?? [])
    .filter((o) => o.channel === 'takeaway')
    .sort((a, b) => b.orderNumber - a.orderNumber);
  return (
    <>
      <div className="floor-bar">
        <button type="button" className="btn primary lg" onClick={onNew}>
          + New takeaway order
        </button>
        <span className="grow" />
        <ConnectionDot state={feed.connection} />
      </div>
      <ErrorBox error={feed.error} />
      <div className="orders-list">
        {!feed.data ? (
          <Skeleton rows={4} />
        ) : (
          <OrderRows
            orders={orders}
            currency={currency}
            onOpen={(o) => onOpen(o.id)}
            empty="No open takeaway orders"
          />
        )}
      </div>
    </>
  );
}

/** Closed orders of today and yesterday. Opening one is read-only apart from the receipt. */
function CompletedView({
  branchId,
  currency,
  onOpen,
}: {
  branchId: string;
  currency: string;
  onOpen: (order: OrderSummaryView) => void;
}) {
  const feed = useFeed(`closed-orders:${branchId}`, () => api.recentClosedOrders(branchId), {
    topic: topics.orders(branchId),
    pollMs: 60_000,
  });
  return (
    <>
      <div className="floor-bar">
        <strong>Completed orders</strong>
        <span className="muted small">Today and yesterday · open one to view or reprint its receipt</span>
        <span className="grow" />
        <ConnectionDot state={feed.connection} />
      </div>
      <ErrorBox error={feed.error} />
      <div className="orders-list">
        {!feed.data ? (
          <Skeleton rows={4} />
        ) : (
          <OrderRows
            orders={feed.data}
            currency={currency}
            onOpen={onOpen}
            empty="No completed orders today"
            showWhere
          />
        )}
      </div>
    </>
  );
}
