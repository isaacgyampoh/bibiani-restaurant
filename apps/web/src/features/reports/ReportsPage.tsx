import type { MeView, SalesReportView } from '@rp/contracts';
import { formatMinor } from '@rp/domain';
import { useEffect, useState } from 'react';
import { api } from '../../infra/session';
import { ErrorBox } from '../../ui/components';
import { Empty, Shell, Skeleton, Stat } from '../../ui/Shell';

const METHOD: Record<string, string> = { cash: 'Cash', momo: 'Mobile money', card: 'Card' };
const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => iso(new Date(Date.now() - n * 86_400_000));

export function ReportsPage({ me }: { me: MeView }) {
  const branchId = me.branches[0]?.id ?? '';
  const [range, setRange] = useState({ from: daysAgo(0), to: daysAgo(0) });
  const [report, setReport] = useState<SalesReportView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setLoading(true);
    setError(null);
    api
      .salesReport(branchId, range.from, range.to)
      .then(setReport)
      .catch(setError)
      .finally(() => setLoading(false));
  }, [branchId, range]);
  const money = (m: number) => formatMinor(m, report?.currency ?? me.restaurant.currency);
  const presets: [string, number, number][] = [
    ['Today', 0, 0],
    ['Yesterday', 1, 1],
    ['Last 7 days', 6, 0],
    ['Last 30 days', 29, 0],
  ];
  const maxHour = Math.max(1, ...(report?.byHour.map((h) => h.sales) ?? [1]));
  const maxDay = Math.max(1, ...(report?.byDay.map((d) => d.net) ?? [1]));
  return (
    <Shell
      me={me}
      title="Reports"
      subtitle="Sales, best sellers, busy hours and kitchen speed, from recorded orders and payments."
      actions={
        <div className="row wrap">
          <div className="seg light">
            {presets.map(([label, a, b]) => {
              const on = range.from === daysAgo(a) && range.to === daysAgo(b);
              return (
                <button
                  key={label}
                  type="button"
                  className={on ? 'on' : ''}
                  onClick={() => setRange({ from: daysAgo(a), to: daysAgo(b) })}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <input
            type="date"
            value={range.from}
            max={range.to}
            onChange={(e) => setRange({ ...range, from: e.target.value })}
            aria-label="From"
          />
          <input
            type="date"
            value={range.to}
            min={range.from}
            onChange={(e) => setRange({ ...range, to: e.target.value })}
            aria-label="To"
          />
        </div>
      }
    >
      <ErrorBox error={error} />
      {!report || loading ? (
        <Skeleton rows={8} />
      ) : report.totals.orders === 0 && report.byProduct.length === 0 ? (
        <section className="card">
          <Empty title="No sales in this period">Choose another date range, or take orders at the POS.</Empty>
        </section>
      ) : (
        <>
          <div className="metrics">
            <Stat
              label="Net sales"
              value={money(report.totals.net)}
              tone="ok"
              hint="payments minus refunds"
            />
            <Stat label="Paid orders" value={report.totals.orders} />
            <Stat label="Average order" value={money(report.totals.averageOrder)} />
            <Stat label="Items sold" value={report.totals.itemsSold} />
            <Stat
              label="Voids & cancellations"
              value={report.totals.voidedItems + report.totals.cancelledOrders}
              hint={`${report.totals.voidedItems} items (${money(report.totals.voidedValue)}), ${report.totals.cancelledOrders} orders`}
              tone={report.totals.voidedItems + report.totals.cancelledOrders ? 'warn' : undefined}
            />
          </div>
          <div className="grid-2">
            <section className="card">
              <div className="card-head">
                <h2>Best sellers</h2>
              </div>
              <table className="list">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th className="num">Qty</th>
                    <th className="num">Sales</th>
                  </tr>
                </thead>
                <tbody>
                  {report.byProduct.slice(0, 12).map((p) => (
                    <tr key={`${p.name}-${p.category}`}>
                      <td>
                        {p.name}
                        <div className="small muted">{p.category}</div>
                      </td>
                      <td className="num">{p.quantity}</td>
                      <td className="num">{money(p.sales)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
            <section className="card">
              <div className="card-head">
                <h2>Payment methods</h2>
              </div>
              <div className="methods">
                {report.byMethod.map((m) => {
                  const share = report.totals.net ? Math.round((m.amount / report.totals.net) * 100) : 0;
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
                        {m.count} payments · {share}%
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="card-head" style={{ marginTop: 18 }}>
                <h2>By category</h2>
              </div>
              <table className="list">
                <tbody>
                  {report.byCategory.map((c) => (
                    <tr key={c.name}>
                      <td>{c.name}</td>
                      <td className="num">{c.quantity} items</td>
                      <td className="num">{money(c.sales)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>
          <div className="grid-2">
            <section className="card">
              <div className="card-head">
                <h2>Busy hours</h2>
              </div>
              {report.byHour.length === 0 ? (
                <Empty title="No orders" />
              ) : (
                <div className="hbars">
                  {report.byHour.map((h) => (
                    <div key={h.hour} className="hbar-row">
                      <span className="hbar-label">{String(h.hour).padStart(2, '0')}:00</span>
                      <div className="bar-track">
                        <div className="bar-fill" style={{ width: `${(h.sales / maxHour) * 100}%` }} />
                      </div>
                      <span className="small">
                        {h.orders} · {money(h.sales)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>
            <section className="card">
              <div className="card-head">
                <h2>Areas and kitchen speed</h2>
              </div>
              <table className="list">
                <tbody>
                  {report.byArea.map((a) => (
                    <tr key={a.name}>
                      <td>{a.name}</td>
                      <td className="num">{a.orders} orders</td>
                      <td className="num">{money(a.sales)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <table className="list" style={{ marginTop: 12 }}>
                <thead>
                  <tr>
                    <th>Station</th>
                    <th className="num">Tickets</th>
                    <th className="num">Avg time to ready</th>
                  </tr>
                </thead>
                <tbody>
                  {report.stations.map((s) => (
                    <tr key={s.name}>
                      <td>{s.name}</td>
                      <td className="num">{s.tickets}</td>
                      <td className="num">
                        {s.averagePrepSeconds === null ? '—' : `${Math.round(s.averagePrepSeconds / 60)} min`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>
          {report.byDay.length > 1 ? (
            <section className="card">
              <div className="card-head">
                <h2>Sales by day</h2>
              </div>
              <div className="hbars">
                {report.byDay.map((d) => (
                  <div key={d.day} className="hbar-row">
                    <span className="hbar-label">
                      {new Date(`${d.day}T12:00:00`).toLocaleDateString([], {
                        weekday: 'short',
                        day: 'numeric',
                        month: 'short',
                      })}
                    </span>
                    <div className="bar-track">
                      <div className="bar-fill" style={{ width: `${(d.net / maxDay) * 100}%` }} />
                    </div>
                    <span className="small">{money(d.net)}</span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </>
      )}
    </Shell>
  );
}
