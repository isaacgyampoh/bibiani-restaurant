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
        <section className="col preparing" aria-label="Preparing">
          <h2>NOW PREPARING</h2>
          <div className="nums">
            {board?.preparing.map((o) => (
              <span key={o.orderNumber} className="n">
                {o.orderNumber}
              </span>
            ))}
            {board && board.preparing.length === 0 ? <span className="none">—</span> : null}
          </div>
        </section>
        <section className="col ready" aria-label="Ready">
          <h2>READY FOR COLLECTION</h2>
          <div className="nums">
            {board?.ready.map((o) => (
              <span key={o.orderNumber} className="n">
                {o.orderNumber}
              </span>
            ))}
            {board && board.ready.length === 0 ? (
              <span className="none">Your number appears here when it is ready</span>
            ) : null}
          </div>
        </section>
      </div>
      <footer>{feed.connection === 'live' ? 'Food is better than love' : 'Updating…'}</footer>
    </div>
  );
}
