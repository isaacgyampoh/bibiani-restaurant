import type { MenuView, MeView, OrderSummaryView } from '@rp/contracts';
import { useEffect, useState } from 'react';
import { linkTo } from '../../infra/router';
import { api, hasPermission, posDevice, signOut, topics } from '../../infra/session';
import { useFeed } from '../../infra/use-feed';
import { Badge, ConnectionDot, ErrorBox, Money } from '../../ui/components';
import { OrderScreen } from './OrderScreen';

type View =
  | { kind: 'area'; areaId: string }
  | { kind: 'completed'; areaId: string }
  | { kind: 'order'; areaId: string; tableId: string | null; orderId: string | null };

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
        setView((v) => v ?? (m.areas[0] ? { kind: 'area', areaId: m.areas[0].id } : null));
      })
      .catch(setMenuError);
  }, [branchId]);

  if (!branchId) return <div className="page error">This account has no branch assigned.</div>;
  if (menuError)
    return (
      <div className="page">
        <ErrorBox error={menuError} />
      </div>
    );
  if (!menu || !view) return <div className="page muted">Loading menu…</div>;
  const area = menu.areas.find((a) => a.id === view.areaId)!;

  return (
    <div className="app" style={{ height: '100vh' }}>
      <div className="topbar">
        <span className="title">{me.restaurant.name}</span>
        <div className="tabs">
          {menu.areas.map((a) => (
            <button
              key={a.id}
              type="button"
              className={`tab ${view.areaId === a.id && view.kind === 'area' ? 'active' : ''}`}
              onClick={() => setView({ kind: 'area', areaId: a.id })}
            >
              {a.name}
            </button>
          ))}
          <button
            type="button"
            className={`tab ${view.kind === 'completed' ? 'active' : ''}`}
            onClick={() => setView({ kind: 'completed', areaId: view.areaId })}
          >
            Completed
          </button>
        </div>
        <span className="spacer" />
        {till ? (
          <span className="small muted">{till.name}</span>
        ) : (
          <span className="small" style={{ color: '#ffb4a8' }}>
            Till not paired
          </span>
        )}
        <span className="small">{me.displayName}</span>
        {hasPermission(me, 'kitchen.operate') ? (
          <a href="/kds" onClick={linkTo('/kds')}>
            Kitchen
          </a>
        ) : null}
        {hasPermission(me, 'config.manage') ||
        hasPermission(me, 'device.manage') ||
        hasPermission(me, 'menu.manage') ? (
          <a href="/admin" onClick={linkTo('/admin')}>
            Admin
          </a>
        ) : null}
        <button type="button" className="link" onClick={() => void signOut()}>
          Sign out
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
    <div className="page">
      <div className="row wrap">
        <ConnectionDot state={feed.connection} />
        {Object.entries(counts).map(([state, n]) => (
          <span key={state} className="badge">
            {TABLE_LABEL[state]}: {n}
          </span>
        ))}
      </div>
      <ErrorBox error={feed.error} />
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
            <span className="small">
              {TABLE_LABEL[t.state]}
              {t.state === 'cleaning' ? ' — tap when clean' : ''}
            </span>
            {t.order ? (
              <span className="small">
                #{t.order.orderNumber} · <Money minor={t.order.balanceDue} currency={currency} /> due
              </span>
            ) : (
              <span className="small muted">{t.capacity} seats</span>
            )}
          </button>
        ))}
      </div>
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
    <div className="page">
      <div className="row">
        <button type="button" className="btn primary big" onClick={onNew}>
          + New takeaway order
        </button>
        <span className="grow" />
        <ConnectionDot state={feed.connection} />
      </div>
      <ErrorBox error={feed.error} />
      <table className="list panel">
        <thead>
          <tr>
            <th>#</th>
            <th>Customer</th>
            <th>Status</th>
            <th>Payment</th>
            <th>Due</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.id}>
              <td>
                <strong style={{ fontSize: 20 }}>{o.orderNumber}</strong>
              </td>
              <td>{o.customerName ?? <span className="muted">—</span>}</td>
              <td>
                <Badge value={o.status === 'ready' ? 'ready' : o.status} />
              </td>
              <td>
                <Badge value={o.paymentStatus} />
              </td>
              <td>
                <Money minor={o.balanceDue} currency={currency} />
              </td>
              <td>
                <button type="button" className="btn" onClick={() => onOpen(o.id)}>
                  Open
                </button>
              </td>
            </tr>
          ))}
          {orders.length === 0 ? (
            <tr>
              <td colSpan={6} className="muted">
                No open takeaway orders
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

/** Closed orders of today and yesterday. Opening one is read-only apart from viewing / reprinting the receipt. */
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
  const orders = feed.data ?? [];
  return (
    <div className="page">
      <div className="row">
        <h2 style={{ margin: 0 }}>Completed orders</h2>
        <span className="grow" />
        <ConnectionDot state={feed.connection} />
      </div>
      <ErrorBox error={feed.error} />
      <table className="list panel">
        <thead>
          <tr>
            <th>#</th>
            <th>Where</th>
            <th>Status</th>
            <th>Payment</th>
            <th>Total</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.id}>
              <td>
                <strong style={{ fontSize: 20 }}>{o.orderNumber}</strong>
              </td>
              <td>
                {o.tableLabel ? `Table ${o.tableLabel}` : o.areaName}
                {o.customerName ? ` · ${o.customerName}` : ''}
              </td>
              <td>
                <Badge value={o.status} />
              </td>
              <td>
                <Badge value={o.paymentStatus} />
              </td>
              <td>
                <Money minor={o.grandTotal} currency={currency} />
              </td>
              <td>
                <button type="button" className="btn" onClick={() => onOpen(o)}>
                  Open
                </button>
              </td>
            </tr>
          ))}
          {orders.length === 0 ? (
            <tr>
              <td colSpan={6} className="muted">
                No completed orders today
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
