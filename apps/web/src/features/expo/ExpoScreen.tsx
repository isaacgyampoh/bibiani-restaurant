import type { ExpoOrderView, ExpoView, MeView } from '@rp/contracts';
import { formatMinor } from '@rp/domain';
import { useEffect, useState } from 'react';
import { linkTo } from '../../infra/router';
import { api, hasPermission, topics } from '../../infra/session';
import { useFeed } from '../../infra/use-feed';
import { ConnectionDot, duration, ErrorBox } from '../../ui/components';
import { Icon } from '../../ui/icons';
import { type Notice, NoticeCenter, useNotices } from '../../ui/notifications';

const clock = duration;
const where = (o: ExpoOrderView) =>
  o.channel === 'dine_in'
    ? `${o.tableLabel ? `Table ${o.tableLabel}` : o.areaName}`
    : `Takeaway${o.customerName ? ` · ${o.customerName}` : ''}`;
const STATUS: Record<string, string> = {
  new: 'Waiting',
  accepted: 'Accepted',
  in_preparation: 'Cooking',
  on_hold: 'On hold',
  ready: 'Ready',
  completed: 'Done',
};

function diff(before: ExpoView, after: ExpoView): Omit<Notice, 'id' | 'at' | 'read'>[] {
  const out: Omit<Notice, 'id' | 'at' | 'read'>[] = [];
  const prev = new Map(before.orders.map((o) => [o.id, o]));
  for (const o of after.orders) {
    const p = prev.get(o.id);
    if (!p) {
      out.push({
        kind: 'new',
        title: `#${o.orderNumber} · ${where(o)}`,
        detail: `${o.stationsTotal} station(s)`,
      });
      continue;
    }
    for (const s of o.stations) {
      const was = p.stations.find((x) => x.ticketId === s.ticketId);
      if (!was)
        out.push({ kind: 'added', title: `#${o.orderNumber} · ${s.stationName}`, detail: 'More items sent' });
      else if (was.status !== 'ready' && s.status === 'ready')
        out.push({
          kind: 'station_ready',
          title: `#${o.orderNumber} · ${s.stationName} ready`,
          detail: `${o.stationsReady}/${o.stationsTotal} stations`,
        });
      else if (was.status === 'ready' && s.status !== 'ready' && s.status !== 'completed')
        out.push({
          kind: 'recalled',
          title: `#${o.orderNumber} · ${s.stationName}`,
          detail: 'Recalled to the kitchen',
        });
    }
    if (!p.canHandOver && o.canHandOver)
      out.push({ kind: 'order_ready', title: `#${o.orderNumber} READY`, detail: where(o) });
    if (!p.delayed && o.delayed)
      out.push({
        kind: 'delayed',
        title: `#${o.orderNumber} is late`,
        detail: `Waiting on ${o.holdingStation}`,
      });
  }
  return out;
}

/** The bridge between kitchen stations and the customer: what is ready, what is missing, who is late. */
export function ExpoScreen({ me }: { me: MeView }) {
  const branchId = me.branches[0]?.id ?? '';
  const feed = useFeed(`expo:${branchId}`, () => api.expo(branchId), {
    topic: topics.orders(branchId),
    pollMs: 10_000,
  });
  const notices = useNotices(feed.data, diff);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [filter, setFilter] = useState<'all' | 'ready' | 'late' | 'rush'>('all');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const drift = feed.lastLoadedAt ? Math.floor((Date.now() - feed.lastLoadedAt.getTime()) / 1000) : 0;
  void tick;

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
      feed.refresh();
    }
  }

  const orders = (feed.data?.orders ?? []).filter((o) =>
    filter === 'ready' ? o.canHandOver : filter === 'late' ? o.delayed : filter === 'rush' ? o.isRush : true,
  );
  const all = feed.data?.orders ?? [];
  const canKitchen = hasPermission(me, 'kitchen.operate');
  const canFulfil = hasPermission(me, 'order.fulfil');
  return (
    <div className="expo">
      <div className="bar">
        <a href="/dashboard" onClick={linkTo('/dashboard')} className="back">
          <Icon name="arrow-left" size={20} />
        </a>
        <img className="bar-logo" src="/logo-64.png" alt="" />
        <span className="title">Supervisor</span>
        <span className="count">{me.restaurant.name}</span>
        <span className="grow" />
        <NoticeCenter state={notices} />
        <ConnectionDot state={feed.connection} />
      </div>
      <div className="expo-summary" role="tablist" aria-label="Filter orders">
        {(
          [
            ['all', 'In the kitchen', all.length, ''],
            ['ready', 'Ready to hand over', all.filter((o) => o.canHandOver).length, 'ready'],
            ['late', 'Late', all.filter((o) => o.delayed).length, 'late'],
            ['rush', 'Rush', all.filter((o) => o.isRush).length, ''],
          ] as const
        ).map(([k, label, n, tone]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={filter === k}
            className={filter === k ? 'on' : ''}
            onClick={() => setFilter(k)}
          >
            <div className="k">{label}</div>
            <div className={`v ${n ? tone : ''}`}>{n}</div>
          </button>
        ))}
      </div>
      <ErrorBox error={error ?? feed.error} />
      {feed.connection === 'polling' ? (
        <div className="alert">Kitchen connection lost. Reconnecting…</div>
      ) : null}
      <div className="expo-grid">
        {orders.map((o) => {
          const elapsed = o.elapsedSeconds + drift;
          return (
            <article
              key={o.id}
              className={`expo-card ${o.canHandOver ? 'ready' : ''} ${o.delayed ? 'late' : ''}`}
              aria-label={`Order ${o.orderNumber}`}
            >
              <header>
                <span className="num">#{o.orderNumber}</span>
                <span className="where">{where(o)}</span>
                {o.isRush ? <span className="rush-tag">RUSH</span> : null}
                <span className="grow" />
                <span className={`timer ${o.delayed ? 'late' : ''}`}>{clock(elapsed)}</span>
              </header>
              <div
                className="progress"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={o.stationsTotal}
                aria-valuenow={o.stationsReady}
                aria-label={`${o.stationsReady} of ${o.stationsTotal} stations ready`}
              >
                <div
                  className="progress-fill"
                  style={{ width: `${(o.stationsReady / Math.max(1, o.stationsTotal)) * 100}%` }}
                />
                <span>
                  {o.stationsReady}/{o.stationsTotal} READY
                </span>
              </div>
              <ul className="stations">
                {o.stations.map((s) => {
                  const done = s.status === 'ready' || s.status === 'completed';
                  return (
                    <li key={s.ticketId} className={`${done ? 'done' : ''} ${s.delayed ? 'late' : ''}`}>
                      <div className="row">
                        <strong className="grow">{s.stationName}</strong>
                        <span className={`st ${done ? 'ok' : s.delayed ? 'late' : ''}`}>
                          {done
                            ? 'READY'
                            : `${STATUS[s.status] ?? s.status} · ${clock(s.elapsedSeconds + drift)}`}
                        </span>
                        {!done && canKitchen ? (
                          <button
                            type="button"
                            className="btn small-btn"
                            disabled={!!busy}
                            onClick={() =>
                              void run(s.ticketId, () => api.ticketAction(s.ticketId, { action: 'ready' }))
                            }
                          >
                            Ready
                          </button>
                        ) : null}
                      </div>
                      <div className="items">
                        {s.items.map((i, n) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: items have no id in this view
                          <span key={n}>
                            {i.quantity}× {i.name}
                            {i.modifiers.length ? <em> ({i.modifiers.join(', ')})</em> : null}
                            {i.notes ? <em className="note"> ! {i.notes}</em> : null}
                          </span>
                        ))}
                      </div>
                    </li>
                  );
                })}
              </ul>
              <footer>
                {o.delayed && o.holdingStation ? (
                  <span className="pill danger">Waiting on {o.holdingStation}</span>
                ) : null}
                <span className="expo-total">Total {formatMinor(o.grandTotal, me.restaurant.currency)}</span>
                {o.balanceDue > 0 && o.paymentStatus !== 'paid' ? (
                  <span className="pill warn">{formatMinor(o.balanceDue, me.restaurant.currency)} due</span>
                ) : (
                  <span className="pill ok">Paid</span>
                )}
                <span className="grow" />
                {o.canHandOver && canFulfil ? (
                  <button
                    type="button"
                    className="btn go lg"
                    disabled={!!busy}
                    onClick={() => void run(o.id, () => api.fulfilOrder(o.id))}
                  >
                    {o.channel === 'takeaway' ? 'Handed to customer' : 'Served'}
                  </button>
                ) : null}
              </footer>
            </article>
          );
        })}
      </div>
      {feed.data && orders.length === 0 ? (
        <div className="expo-empty">
          <img className="empty-logo" src="/logo-192.png" alt="" />
          {filter === 'all'
            ? 'No orders in the kitchen. New orders appear here the moment they are sent.'
            : 'Nothing here right now.'}
        </div>
      ) : null}
    </div>
  );
}
