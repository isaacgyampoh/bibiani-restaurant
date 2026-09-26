import type { MeView } from '@rp/contracts';
import { formatMinor } from '@rp/domain';
import { linkTo } from '../../infra/router';
import { api, hasPermission, topics } from '../../infra/session';
import { useFeed } from '../../infra/use-feed';
import { Badge, ConnectionDot, ErrorBox } from '../../ui/components';
import { Icon } from '../../ui/icons';
import { Empty, Shell, Skeleton, Stat } from '../../ui/Shell';

const METHOD: Record<string, string> = { cash: 'Cash', momo: 'Mobile money', card: 'Card' };
const mins = (s: number | null) =>
  s === null
    ? '—'
    : s >= 3600
      ? `${Math.floor(s / 3600)}h ${String(Math.round((s % 3600) / 60)).padStart(2, '0')}m`
      : `${Math.round(s / 60)} min`;

/** "How is the restaurant doing right now?" Real figures for today's business day. */
const MOVEMENT: Record<string, string> = {
  receive: 'Delivery',
  waste: 'Wastage',
  adjust: 'Adjustment',
  count: 'Stock count',
  sale: 'Sold',
  sale_reversal: 'Returned (order cancelled)',
};

export function DashboardPage({ me }: { me: MeView }) {
  const branchId = me.branches[0]?.id ?? '';
  const feed = useFeed(`dashboard:${branchId}`, () => api.dashboard(branchId), {
    topic: topics.orders(branchId),
    pollMs: 30_000,
  });
  const d = feed.data;
  const money = (m: number) => (d ? formatMinor(m, d.currency) : '');
  const day = d
    ? new Date(`${d.businessDay}T12:00:00`).toLocaleDateString(undefined, {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
      })
    : '';
  return (
    <Shell
      me={me}
      title={`Welcome back, ${me.displayName.replace(/\s*\(.*\)$/, '')}`}
      subtitle={`Here is what is happening at ${me.restaurant.name} today${d ? ` · ${day}` : ''}.`}
      actions={
        <>
          <ConnectionDot state={feed.connection} />
          {hasPermission(me, 'order.create') ? (
            <a className="btn primary" href="/pos" onClick={linkTo('/pos')}>
              Open POS
            </a>
          ) : null}
        </>
      }
    >
      <ErrorBox error={feed.error} />
      {!d ? (
        <Skeleton rows={6} />
      ) : (
        <>
          <h2 className="section-title">Today</h2>
          <div className="metrics">
            <Stat
              label="Sales today"
              value={money(d.sales.net)}
              hint={`${d.sales.orders} paid orders`}
              tone="ok"
            />
            <Stat label="Average order" value={money(d.sales.averageOrder)} />
            <Stat
              label="Promotions given"
              value={money(d.sales.promotionDiscounts)}
              hint="automatic, on items sold"
            />
            <Stat
              label="Manager discounts"
              value={money(d.sales.manualDiscounts)}
              hint="with reasons, audited"
              tone={d.sales.manualDiscounts ? 'warn' : undefined}
            />
          </div>

          <h2 className="section-title">Operations</h2>
          <div className="metrics">
            <Stat
              label="Open orders"
              value={d.orders.open}
              hint={`${d.orders.takeawayOpen} takeaway`}
              href="/orders"
            />
            <Stat
              label="Preparing"
              value={d.orders.preparing}
              tone={d.stations.some((s) => s.delayedTickets > 0) ? 'warn' : undefined}
              href="/expo"
            />
            <Stat
              label="Ready"
              value={d.orders.ready}
              hint="to serve or collect"
              tone={d.orders.ready ? 'info' : undefined}
              href="/expo"
            />
            <Stat
              label="Awaiting payment"
              value={d.orders.awaitingPayment}
              tone={d.orders.awaitingPayment ? 'warn' : undefined}
            />
            <Stat label="Tables occupied" value={`${d.tables.occupied} / ${d.tables.total}`} />
          </div>

          <div className="grid-2">
            <section className="card">
              <div className="card-head">
                <h2>Kitchen right now</h2>
                <a href="/expo" onClick={linkTo('/expo')}>
                  Supervisor view <Icon name="arrow-right" size={16} />
                </a>
              </div>
              {d.stations.length === 0 ? (
                <Empty title="No kitchen stations yet">Create stations to route orders to the kitchen.</Empty>
              ) : (
                <table className="list">
                  <thead>
                    <tr>
                      <th>Station</th>
                      <th>Open</th>
                      <th>Oldest</th>
                      <th>Late</th>
                      <th>Done today</th>
                      <th>Avg prep</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.stations.map((s) => (
                      <tr key={s.id}>
                        <td>
                          <strong>{s.name}</strong>
                        </td>
                        <td>{s.openTickets}</td>
                        <td>{mins(s.oldestTicketSeconds)}</td>
                        <td>
                          {s.delayedTickets ? (
                            <span className="pill danger">{s.delayedTickets} late</span>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td>{s.readyToday}</td>
                        <td>{mins(s.averagePrepSeconds)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <section className="card">
              <div className="card-head">
                <h2>Payments today</h2>
              </div>
              {d.sales.byMethod.every((m) => m.count === 0) ? (
                <Empty title="No payments yet today">Payments recorded at the POS appear here.</Empty>
              ) : (
                <div className="methods">
                  {d.sales.byMethod.map((m) => {
                    const share = d.sales.net ? Math.round((m.amount / d.sales.net) * 100) : 0;
                    return (
                      <div key={m.method} className="method">
                        <div className="row">
                          <strong className="grow">{METHOD[m.method]}</strong>
                          <span>{money(m.amount)}</span>
                        </div>
                        <div className="bar-track">
                          <div className={`bar-fill ${m.method}`} style={{ width: `${share}%` }} />
                        </div>
                        <div className="small muted">
                          {m.count} payment{m.count === 1 ? '' : 's'} · {share}%
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </div>

          <div className="grid-2">
            <section>
              <h2 className="section-title">Inventory</h2>
              <div className="metrics">
                <Stat
                  label="Low stock"
                  value={d.inventory.lowStockItems}
                  hint="at or below minimum"
                  tone={d.inventory.lowStockItems ? 'warn' : undefined}
                  href="/inventory"
                />
                <Stat
                  label="Out of stock"
                  value={d.inventory.outOfStockItems}
                  hint="none left"
                  tone={d.inventory.outOfStockItems ? 'danger' : undefined}
                  href="/inventory"
                />
                <Stat
                  label="Stock counts"
                  value={d.inventory.openStockCounts}
                  hint="in progress"
                  href="/stock-takes"
                />
              </div>
              <section className="card">
                <div className="card-head">
                  <h2>Recent stock changes</h2>
                  <a href="/inventory" onClick={linkTo('/inventory')}>
                    Stock <Icon name="arrow-right" size={16} />
                  </a>
                </div>
                {d.inventory.recentMovements.length === 0 ? (
                  <Empty title="No stock changes yet">
                    Deliveries, sales with a recipe, wastage and counts appear here.
                  </Empty>
                ) : (
                  <ul className="plain-list">
                    {d.inventory.recentMovements.map((m) => (
                      <li key={m.id} className="movement">
                        <span className="grow">
                          <strong>{m.itemName}</strong>{' '}
                          <span className="small muted">
                            {MOVEMENT[m.kind] ?? m.kind}
                            {m.reference ? ` · ${m.reference}` : ''}
                          </span>
                        </span>
                        <span className={`tabular ${m.quantityDelta < 0 ? 'neg' : 'plus'}`}>
                          {m.quantityDelta > 0 ? '+' : ''}
                          {m.quantityDelta} {m.unit}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </section>
            <section>
              <h2 className="section-title">Promotions</h2>
              <section className="card">
                {d.promotions.live.length + d.promotions.upcoming.length === 0 ? (
                  <Empty title="No promotions running">
                    {hasPermission(me, 'promotions.manage') ? (
                      <a href="/promotions" onClick={linkTo('/promotions')}>
                        Create one <Icon name="arrow-right" size={16} />
                      </a>
                    ) : null}
                  </Empty>
                ) : (
                  <ul className="plain-list">
                    {d.promotions.live.map((p) => (
                      <li key={p.id}>
                        <Badge value="promo_live" /> <strong>{p.name}</strong>
                        <div className="small muted">{p.summary}</div>
                      </li>
                    ))}
                    {d.promotions.upcoming.map((p) => (
                      <li key={p.id}>
                        <Badge value={p.startsOn ? 'promo_upcoming' : 'promo_scheduled'} />{' '}
                        <strong>{p.name}</strong>
                        <div className="small muted">{p.summary}</div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </section>
          </div>

          <section className="card">
            <div className="card-head">
              <h2>Recent orders</h2>
              <a href="/orders" onClick={linkTo('/orders')}>
                All orders <Icon name="arrow-right" size={16} />
              </a>
            </div>
            {d.recentOrders.length === 0 ? (
              <Empty
                title="No orders yet today"
                action={
                  hasPermission(me, 'order.create') ? (
                    <a className="btn primary" href="/pos" onClick={linkTo('/pos')}>
                      Take the first order
                    </a>
                  ) : null
                }
              >
                Orders taken at any POS show up here immediately.
              </Empty>
            ) : (
              <table className="list">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Where</th>
                    <th>Status</th>
                    <th>Payment</th>
                    <th className="num">Total</th>
                    <th>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {d.recentOrders.map((o) => (
                    <tr key={o.id}>
                      <td>
                        <strong>{o.orderNumber}</strong>
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
                      <td className="muted">
                        {new Date(o.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </Shell>
  );
}
