import type { MeView } from '@rp/contracts';
import { useEffect } from 'react';
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
  return (
    <div className="board">
      <header>
        <span>{me.restaurant.name}</span>
        <button
          type="button"
          className="fullscreen"
          onClick={() => void document.documentElement.requestFullscreen?.()}
        >
          Full screen
        </button>
        <span style={{ fontSize: 18, opacity: 0.6 }}>{feed.connection === 'live' ? '' : 'Updating…'}</span>
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
          </div>
        </section>
      </div>
    </div>
  );
}
