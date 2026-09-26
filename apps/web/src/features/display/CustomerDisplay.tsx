import type { MeView } from '@rp/contracts';
import { useEffect, useState } from 'react';
import { api, topics } from '../../infra/session';
import { useFeed } from '../../infra/use-feed';

/** Customer-facing board: order numbers and state only. It never invents state; it reloads from the server. */
export function CustomerDisplay({ me }: { me: MeView }) {
  const branchId = me.device?.branchId ?? me.branches[0]?.id ?? '';
  const feed = useFeed(`board:${branchId}`, () => api.customerBoard(branchId), {
    topic: topics.orders(branchId),
    pollMs: 15_000,
  });

  useEffect(() => {
    if (me.kind !== 'device') return;
    const beat = () => void api.heartbeat({ appVersion: 'web-display', printers: [] }).catch(() => undefined);
    beat();
    const t = setInterval(beat, 30_000);
    return () => clearInterval(t);
  }, [me.kind]);

  const board = feed.data;
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 15_000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="board">
      <header>
        <img className="logo-img" src="/logo-192.png" alt="" />
        <div className="names">
          <span className="brand-title">{me.restaurant.name}</span>
          <span className="slogan">Food is better than love</span>
        </div>
        <span className="clock">{clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        {!document.fullscreenElement ? (
          <button
            type="button"
            className="fullscreen"
            onClick={() => void document.documentElement.requestFullscreen?.()}
          >
            Full screen
          </button>
        ) : null}
      </header>
      <div className="cols">
        <Column name="Order received" className="received" orders={board?.received} empty="" />
        <Column name="Preparing" className="preparing" orders={board?.preparing} empty="" />
        <Column
          name="Ready"
          title="Ready — please collect"
          className="ready"
          orders={board?.ready}
          empty="Your number appears here when your order is ready"
        />
      </div>
      <footer>
        {feed.connection === 'live'
          ? 'Please collect your order when your number is under Ready'
          : 'Updating…'}
      </footer>
    </div>
  );
}

function Column({
  name,
  title,
  className,
  orders,
  empty,
}: {
  name: string;
  title?: string;
  className: string;
  orders: { orderNumber: number }[] | undefined;
  empty: string;
}) {
  return (
    <section className={`col ${className}`} aria-label={name}>
      <h2>{title ?? name}</h2>
      <div className="nums">
        {orders?.map((o) => (
          <span key={o.orderNumber} className="n">
            {o.orderNumber}
          </span>
        ))}
        {orders && orders.length === 0 && empty ? <span className="none">{empty}</span> : null}
      </div>
    </section>
  );
}
