import type { MeView, StockCountView } from '@rp/contracts';
import { formatMinor } from '@rp/domain';
import { useCallback, useEffect, useState } from 'react';
import { linkTo, navigate } from '../../infra/router';
import { api, hasPermission } from '../../infra/session';
import { useFeed } from '../../infra/use-feed';
import { ErrorBox } from '../../ui/components';
import { Empty, Shell, Skeleton } from '../../ui/Shell';

const STATUS: Record<string, string> = {
  open: 'Counting',
  submitted: 'Waiting for approval',
  approved: 'Approved',
  cancelled: 'Cancelled',
};
const when = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : '—';
const fmt = (n: number | null, unit: string) =>
  n === null ? '—' : `${Number(n.toFixed(3)).toLocaleString()} ${unit}`;

export function StockTakePage({ me, countId }: { me: MeView; countId: string | null }) {
  return countId ? <CountDetail me={me} countId={countId} /> : <CountList me={me} />;
}

function CountList({ me }: { me: MeView }) {
  const branchId = me.branches[0]?.id ?? '';
  const feed = useFeed(`counts:${branchId}`, () => api.stockCounts(branchId), {
    topic: null,
    pollMs: 60_000,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const money = (m: number) => formatMinor(m, me.restaurant.currency);
  async function start() {
    setBusy(true);
    setError(null);
    try {
      const { countId } = await api.startStockCount({ countId: crypto.randomUUID(), branchId, note: null });
      navigate(`/stock-takes/${countId}`);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  const canCount = hasPermission(me, 'stock.count');
  return (
    <Shell
      me={me}
      title="Stock taking"
      subtitle="Count what is physically in store. Differences change stock only after a manager approves them."
      actions={
        canCount ? (
          <button type="button" className="btn primary" disabled={busy} onClick={() => void start()}>
            {busy ? 'Starting…' : '+ Start stock count'}
          </button>
        ) : null
      }
    >
      <ErrorBox error={error ?? feed.error} />
      {!feed.data ? (
        <Skeleton rows={5} />
      ) : feed.data.length === 0 ? (
        <section className="card">
          <Empty
            title="No stock counts yet"
            action={
              canCount ? (
                <button type="button" className="btn primary" onClick={() => void start()}>
                  Start the first count
                </button>
              ) : null
            }
          >
            A count lists every active stock item with the system quantity. Enter what you find; the
            difference is shown as a variance and needs a reason.
          </Empty>
        </section>
      ) : (
        <section className="card">
          <table className="list">
            <thead>
              <tr>
                <th>Started</th>
                <th>Status</th>
                <th className="num">Counted</th>
                <th className="num">Variances</th>
                <th className="num">Variance value</th>
                <th>By</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {feed.data.map((c) => (
                <tr key={c.id}>
                  <td>
                    <strong>{when(c.startedAt)}</strong>
                    {c.note ? <div className="small muted">{c.note}</div> : null}
                  </td>
                  <td>
                    <span className={`pill count-${c.status}`}>{STATUS[c.status]}</span>
                  </td>
                  <td className="num">
                    {c.counted} / {c.lines}
                  </td>
                  <td className="num">{c.variances}</td>
                  <td className={`num ${c.varianceValue < 0 ? 'neg' : ''}`}>{money(c.varianceValue)}</td>
                  <td className="small muted">
                    {c.startedBy ?? '—'}
                    {c.approvedBy ? ` · approved by ${c.approvedBy}` : ''}
                  </td>
                  <td>
                    <a className="btn" href={`/stock-takes/${c.id}`} onClick={linkTo(`/stock-takes/${c.id}`)}>
                      {c.status === 'open' ? 'Continue' : 'Open'}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </Shell>
  );
}

function CountDetail({ me, countId }: { me: MeView; countId: string }) {
  const [count, setCount] = useState<StockCountView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, { counted: string; reason: string }>>({});
  const [filter, setFilter] = useState<'all' | 'todo' | 'variance'>('all');
  const load = useCallback(() => {
    api
      .stockCount(countId)
      .then((c) => {
        setCount(c);
        setDraft((d) => {
          const next = { ...d };
          for (const i of c.items)
            next[i.itemId] ??= {
              counted: i.countedQuantity === null ? '' : String(i.countedQuantity),
              reason: i.reason ?? '',
            };
          return next;
        });
      })
      .catch(setError);
  }, [countId]);
  useEffect(load, [load]);

  const open = count?.status === 'open';
  const money = (m: number) => formatMinor(m, me.restaurant.currency);

  async function saveLine(itemId: string) {
    const d = draft[itemId];
    const line = count?.items.find((i) => i.itemId === itemId);
    if (!d || !line || !open) return;
    const counted = d.counted.trim() === '' ? null : Number(d.counted);
    if (counted === line.countedQuantity && (d.reason || null) === line.reason) return;
    setError(null);
    try {
      await api.recordCountLine(countId, { itemId, countedQuantity: counted, reason: d.reason || null });
      load();
    } catch (e) {
      setError(e);
    }
  }
  async function decide(action: 'submit' | 'approve' | 'cancel') {
    if (!count) return;
    if (action === 'cancel' && !window.confirm('Cancel this stock count? Nothing will change in stock.'))
      return;
    setBusy(action);
    setError(null);
    try {
      await api.decideStockCount(countId, action, count.version);
      load();
    } catch (e) {
      setError(e);
      load();
    } finally {
      setBusy(null);
    }
  }

  const items = (count?.items ?? []).filter((i) =>
    filter === 'todo' ? i.countedQuantity === null : filter === 'variance' ? (i.variance ?? 0) !== 0 : true,
  );
  const missingReasons = (count?.items ?? []).filter((i) => (i.variance ?? 0) !== 0 && !i.reason).length;

  return (
    <Shell
      me={me}
      title="Stock count"
      subtitle={
        count ? (
          <>
            <span className={`pill count-${count.status}`}>{STATUS[count.status]}</span> Started{' '}
            {when(count.startedAt)}
            {count.startedBy ? ` by ${count.startedBy}` : ''}
          </>
        ) : null
      }
      actions={
        <a className="btn" href="/stock-takes" onClick={linkTo('/stock-takes')}>
          ← All counts
        </a>
      }
    >
      <ErrorBox error={error} />
      {!count ? (
        <Skeleton rows={8} />
      ) : (
        <>
          <div className="metrics">
            <div className="metric">
              <div className="metric-label">Counted</div>
              <div className="metric-value">
                {count.counted} / {count.lines}
              </div>
            </div>
            <div className={`metric ${count.variances ? 'attention' : ''}`}>
              <div className="metric-label">Variances</div>
              <div className="metric-value">{count.variances}</div>
              <div className="metric-hint">
                {missingReasons ? `${missingReasons} without a reason` : 'all explained'}
              </div>
            </div>
            <div className={`metric ${count.varianceValue < 0 ? 'alert' : ''}`}>
              <div className="metric-label">Variance value</div>
              <div className="metric-value">{money(count.varianceValue)}</div>
            </div>
          </div>
          <section className="card">
            <div className="toolbar">
              <div className="seg light">
                {(
                  [
                    ['all', 'All items'],
                    ['todo', 'Not counted'],
                    ['variance', 'Variances'],
                  ] as const
                ).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    className={filter === k ? 'on' : ''}
                    onClick={() => setFilter(k)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <span className="grow" />
              {open && hasPermission(me, 'stock.count') ? (
                <button
                  type="button"
                  className="btn primary"
                  disabled={!!busy || count.counted === 0}
                  onClick={() => void decide('submit')}
                >
                  Submit count for approval
                </button>
              ) : null}
              {count.status === 'submitted' && hasPermission(me, 'inventory.manage') ? (
                <button
                  type="button"
                  className="btn primary"
                  disabled={!!busy || missingReasons > 0}
                  title={missingReasons ? 'Every variance needs a reason' : undefined}
                  onClick={() => void decide('approve')}
                >
                  Approve and adjust stock
                </button>
              ) : null}
              {(open || count.status === 'submitted') && hasPermission(me, 'inventory.manage') ? (
                <button
                  type="button"
                  className="btn danger"
                  disabled={!!busy}
                  onClick={() => void decide('cancel')}
                >
                  Cancel count
                </button>
              ) : null}
            </div>
            {count.status === 'submitted' && missingReasons > 0 ? (
              <div className="info-box warn">
                {missingReasons} variance(s) have no reason. Cancel this count and recount with reasons, so
                every stock change is explained.
              </div>
            ) : null}
            {count.status === 'approved' ? (
              <div className="info-box ok">
                Approved {when(count.approvedAt)}
                {count.approvedBy ? ` by ${count.approvedBy}` : ''}. Stock was set to the counted quantities.
              </div>
            ) : null}
            {items.length === 0 ? (
              <Empty title="Nothing to show">No items match this filter.</Empty>
            ) : (
              <table className="list count-table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="num">System</th>
                    <th className="num">Counted</th>
                    <th className="num">Variance</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((i) => {
                    const d = draft[i.itemId] ?? { counted: '', reason: '' };
                    const typed = d.counted.trim() === '' ? null : Number(d.counted);
                    const variance =
                      typed === null ? null : Math.round((typed - i.systemQuantity) * 1000) / 1000;
                    return (
                      <tr key={i.itemId} className={variance ? 'has-variance' : ''}>
                        <td>
                          <strong>{i.name}</strong>
                          <div className="small muted">
                            {i.category ?? ''}
                            {i.currentQuantity !== i.systemQuantity && open
                              ? ` · stock moved since count started (now ${fmt(i.currentQuantity, i.unit)})`
                              : ''}
                          </div>
                        </td>
                        <td className="num">{fmt(i.systemQuantity, i.unit)}</td>
                        <td className="num">
                          {open ? (
                            <input
                              className="qty-input"
                              type="number"
                              min="0"
                              step="0.001"
                              inputMode="decimal"
                              aria-label={`Counted ${i.name}`}
                              value={d.counted}
                              onChange={(e) =>
                                setDraft({ ...draft, [i.itemId]: { ...d, counted: e.target.value } })
                              }
                              onBlur={() => void saveLine(i.itemId)}
                            />
                          ) : (
                            fmt(i.countedQuantity, i.unit)
                          )}
                        </td>
                        <td className={`num ${variance && variance < 0 ? 'neg' : variance ? 'plus' : ''}`}>
                          {variance === null ? '—' : `${variance > 0 ? '+' : ''}${fmt(variance, i.unit)}`}
                        </td>
                        <td>
                          {open ? (
                            <input
                              aria-label={`Reason ${i.name}`}
                              placeholder={variance ? 'Required: wastage, usage, theft…' : ''}
                              className={variance && !d.reason ? 'needs' : ''}
                              value={d.reason}
                              onChange={(e) =>
                                setDraft({ ...draft, [i.itemId]: { ...d, reason: e.target.value } })
                              }
                              onBlur={() => void saveLine(i.itemId)}
                            />
                          ) : (
                            <span className="small">{i.reason ?? ''}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </Shell>
  );
}
