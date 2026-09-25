import type { MeView } from '@rp/contracts';
import { formatMinor } from '@rp/domain';
import { linkTo } from '../../infra/router';
import { api, hasPermission, topics } from '../../infra/session';
import { useFeed } from '../../infra/use-feed';
import { Badge, ConnectionDot, ErrorBox } from '../../ui/components';
import { Empty, Shell, Skeleton, Stat } from '../../ui/Shell';

const METHOD: Record<string, string> = { cash: 'Cash', momo: 'Mobile money', card: 'Card' };
const mins = (s: number | null) =>
  s === null
    ? '—'
    : s >= 3600
      ? `${Math.floor(s / 3600)}h ${String(Math.round((s % 3600) / 60)).padStart(2, '0')}m`
      : `${Math.round(s / 60)} min`;

/** "How is the restaurant doing right now?" Real figures for today's business day. */
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
      title="Dashboard"
      subtitle={d ? `Today · ${day}` : 'Today'}
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
          <div className="metrics">
            <Stat
              label="Sales today"
              value={money(d.sales.net)}
              hint={`${d.sales.orders} paid orders`}
              tone="ok"
            />
            <Stat label="Average order" value={money(d.sales.averageOrder)} />
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
            <Stat
              label="Low stock"
              value={d.inventory.lowStockItems}
              hint={
                d.inventory.openStockCounts
                  ? `${d.inventory.openStockCounts} stock count(s) in progress`
                  : 'items at or below minimum'
              }
              tone={d.inventory.lowStockItems ? 'danger' : undefined}
              href="/inventory"
            />
          </div>

          <div className="grid-2">
            <section className="card">
              <div className="card-head">
                <h2>Kitchen right now</h2>
                <a href="/expo" onClick={linkTo('/expo')}>
                  Supervisor view →
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

          <section className="card">
            <div className="card-head">
              <h2>Recent orders</h2>
              <a href="/orders" onClick={linkTo('/orders')}>
                All orders →
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
