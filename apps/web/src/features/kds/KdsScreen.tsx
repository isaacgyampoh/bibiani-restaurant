import { ApiError } from '@rp/client-core';
import type { MeView, StationBoardView, StationTicketView } from '@rp/contracts';
import { formatMinor, type TicketAction } from '@rp/domain';
import { useEffect, useState } from 'react';
import { navigate } from '../../infra/router';
import { api, signOut, topics } from '../../infra/session';
import { useFeed } from '../../infra/use-feed';
import { ConnectionDot, elapsed } from '../../ui/components';
import { type Notice, NoticeCenter, useNotices } from '../../ui/notifications';

const whereOf = (t: StationTicketView) =>
  t.channel === 'dine_in'
    ? t.tableLabel
      ? `Table ${t.tableLabel}`
      : t.areaName
    : `Takeaway${t.customerName ? ` · ${t.customerName}` : ''}`;
const STATE: Record<string, string> = {
  new: 'New',
  accepted: 'Accepted',
  in_preparation: 'Cooking',
  on_hold: 'Paused',
  ready: 'Ready',
};

/** What changed on this station since the last authoritative reload. */
function kitchenDiff(
  before: StationBoardView,
  after: StationBoardView,
): Omit<Notice, 'id' | 'at' | 'read'>[] {
  const out: Omit<Notice, 'id' | 'at' | 'read'>[] = [];
  const prev = new Map(before.tickets.map((t) => [t.id, t]));
  const knownOrders = new Set(before.tickets.map((t) => t.orderNumber));
  for (const t of after.tickets) {
    const p = prev.get(t.id);
    const items = t.items.map((i) => `${i.quantity}× ${i.name}`).join(', ');
    if (!p) {
      out.push({
        kind: knownOrders.has(t.orderNumber) ? 'added' : 'new',
        title: `#${t.orderNumber} · ${whereOf(t)}${t.isRush ? ' · RUSH' : ''}`,
        detail: items,
      });
      continue;
    }
    for (const i of t.items) {
      const was = p.items.find((x) => x.id === i.id);
      if (
        was &&
        was.status !== 'voided' &&
        was.status !== 'cancelled' &&
        (i.status === 'voided' || i.status === 'cancelled')
      )
        out.push({
          kind: 'voided',
          title: `#${t.orderNumber} · ${i.quantity}× ${i.name}`,
          detail: 'Do not prepare',
        });
    }
    if (p.status === 'ready' && t.status !== 'ready' && t.status !== 'completed')
      out.push({ kind: 'recalled', title: `#${t.orderNumber} recalled`, detail: whereOf(t) });
    if (!p.isRush && t.isRush)
      out.push({ kind: 'delayed', title: `#${t.orderNumber} is now RUSH`, detail: whereOf(t) });
  }
  return out;
}

/**
 * Station screen. Shows only this station's tickets (enforced by the server: a paired KDS cannot
 * read or act on another station). Actions go through the API; the screen never writes data itself.
 */
export function KdsScreen({ me, stationParam }: { me: MeView; stationParam: string | null }) {
  const stationId = me.device?.stationId ?? stationParam;
  const branchId = me.device?.branchId ?? me.branches[0]?.id ?? '';
  if (!stationId) return <StationPicker me={me} branchId={branchId} />;
  return <Board me={me} stationId={stationId} branchId={branchId} isDevice={me.kind === 'device'} />;
}

function useStations(branchId: string, enabled: boolean) {
  const [stations, setStations] = useState<{ id: string; name: string }[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    api
      .configuration()
      .then((c) =>
        setStations(
          (c.stations as { id: string; name: string; branchId: string; isActive: boolean }[]).filter(
            (s) => s.branchId === branchId && s.isActive,
          ),
        ),
      )
      .catch(() => setStations([]));
  }, [branchId, enabled]);
  return stations;
}

function StationPicker({ me, branchId }: { me: MeView; branchId: string }) {
  const stations = useStations(branchId, true);
  return (
    <div className="kds">
      <div className="bar">
        <button type="button" className="dark-btn" onClick={() => navigate('/dashboard')} aria-label="Back">
          ←
        </button>
        <span className="title">Kitchen</span>
        <span className="count">Choose your station</span>
        <span className="grow" />
        <button type="button" className="dark-btn" onClick={() => navigate('/expo')}>
          Supervisor view
        </button>
        <span className="count">{me.displayName}</span>
      </div>
      <div className="station-grid">
        {stations?.map((s) => (
          <button
            key={s.id}
            type="button"
            className="station-tile"
            onClick={() => navigate(`/kds?station=${s.id}`)}
          >
            {s.name}
            <span>Open the {s.name} screen</span>
          </button>
        ))}
      </div>
      {stations && stations.length === 0 ? (
        <div className="kds-empty">No kitchen stations yet. Create them in Stations &amp; routing.</div>
      ) : null}
    </div>
  );
}

function Board({
  me,
  stationId,
  branchId,
  isDevice,
}: {
  me: MeView;
  stationId: string;
  branchId: string;
  isDevice: boolean;
}) {
  const feed = useFeed(`kds:${stationId}`, () => api.stationBoard(stationId), {
    topic: topics.station(branchId, stationId),
    pollMs: 20_000, // safety poll: a silently dead socket cannot hide tickets for long
  });
  const notices = useNotices(feed.data, kitchenDiff);
  const stations = useStations(branchId, !isDevice);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Heartbeat for paired screens, so managers can see this KDS is alive.
  useEffect(() => {
    if (!isDevice) return;
    const beat = () => void api.heartbeat({ appVersion: 'web-kds', printers: [] }).catch(() => undefined);
    beat();
    const t = setInterval(beat, 30_000);
    return () => clearInterval(t);
  }, [isDevice]);

  // Latest known status/version per ticket from our own actions, so a quick START -> READY
  // uses the new version immediately instead of waiting for the board to reload.
  const [local, setLocal] = useState<
    Record<string, { status: StationTicketView['status']; version: number }>
  >({});

  async function act(ticket: StationTicketView, action: TicketAction) {
    setBusy(ticket.id);
    setError(null);
    try {
      const send = () => api.ticketAction(ticket.id, { action, expectedVersion: ticket.version });
      // "Busy, try again" means nothing was saved: one automatic retry saves the cook a tap.
      const order = await send().catch((e) =>
        e instanceof ApiError && e.retryable && e.code !== 'NETWORK' ? send() : Promise.reject(e),
      );
      const updated = order.tickets.find((x) => x.id === ticket.id);
      if (updated)
        setLocal((m) => ({ ...m, [ticket.id]: { status: updated.status, version: updated.version } }));
    } catch (e) {
      const conflict = e instanceof ApiError && e.code === 'VERSION_CONFLICT';
      setError(
        conflict
          ? 'Updated on another screen: refreshed, tap again if needed'
          : e instanceof Error
            ? e.message
            : String(e),
      );
    } finally {
      setBusy(null);
      feed.refresh();
    }
  }

  const board = feed.data
    ? {
        ...feed.data,
        tickets: feed.data.tickets
          .map((t) => {
            const mine = local[t.id];
            return mine && mine.version > t.version
              ? { ...t, status: mine.status, version: mine.version }
              : t;
          })
          .filter((t) => t.status !== 'completed' && t.status !== 'cancelled'),
      }
    : null;
  const target = board?.station.targetPrepSeconds ?? null;
  const money = (m: number) => formatMinor(m, board?.station.currency ?? 'GHS');
  return (
    <div className="kds">
      <div className="bar">
        {!isDevice ? (
          <button
            type="button"
            className="dark-btn"
            onClick={() => navigate('/kds')}
            aria-label="All stations"
          >
            ←
          </button>
        ) : null}
        <span className="title">{board?.station.name ?? 'Kitchen'}</span>
        <span className="count">{board ? `${board.tickets.length} open` : ''}</span>
        {!isDevice && stations && stations.length > 1 ? (
          <div className="seg dark">
            {stations.map((s) => (
              <button
                key={s.id}
                type="button"
                className={s.id === stationId ? 'on' : ''}
                onClick={() => navigate(`/kds?station=${s.id}`)}
              >
                {s.name}
              </button>
            ))}
          </div>
        ) : null}
        <span className="grow" />
        <NoticeCenter state={notices} />
        <ConnectionDot state={feed.connection} />
        {!isDevice ? (
          <button type="button" className="dark-btn" onClick={() => void signOut()}>
            Sign out
          </button>
        ) : (
          <span className="count">{me.device?.name}</span>
        )}
      </div>
      {board?.printerAlerts.map((a) => (
        <div key={a.printerId} className="alert">
          Printer problem: {a.printerName} — {a.deadJobs + a.failedJobs} ticket(s) not printed
          {a.lastError ? ` (${a.lastError})` : ''}. Tickets are still shown here.
        </div>
      ))}
      {error ? <div className="alert warn">{error}</div> : null}
      {feed.connection === 'polling' ? (
        <div className="alert warn">Kitchen connection lost. Reconnecting… (screen refreshes every 20 s)</div>
      ) : null}
      <div className="tickets">
        {board?.tickets.map((t) => {
          const since = t.startedAt ?? t.createdAt;
          const late =
            target !== null && t.status !== 'ready' && now - new Date(t.createdAt).getTime() > target * 1000;
          return (
            <article
              key={t.id}
              className={`ticket ${t.status} ${late ? 'late' : ''} ${t.isRush ? 'rush' : ''}`}
              aria-label={`Order ${t.orderNumber}`}
            >
              <header>
                <span className="num">#{t.orderNumber}</span>
                <span className="elapsed">{elapsed(since, now)}</span>
              </header>
              <div className="where">
                {t.channel === 'dine_in'
                  ? `${t.areaName}${t.tableLabel ? ` · Table ${t.tableLabel}` : ''}`
                  : `Takeaway${t.customerName ? ` · ${t.customerName}` : ''}`}
                <span className="t-status">
                  {late ? 'Late · ' : ''}
                  {STATE[t.status] ?? t.status} ·{' '}
                  {new Date(t.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
              <ul>
                {t.items.map((i) => (
                  <li
                    key={i.id}
                    className={i.status === 'voided' || i.status === 'cancelled' ? 'voided' : ''}
                  >
                    <span className="qtyx">{i.quantity} ×</span> {i.name}
                    {i.lineTotal !== null ? <span className="price">{money(i.lineTotal)}</span> : null}
                    {i.modifiers.map((m) => (
                      <span key={m} className="mod">
                        + {m}
                      </span>
                    ))}
                    {i.notes ? <span className="note">! {i.notes}</span> : null}
                  </li>
                ))}
              </ul>
              {t.orderNotes ? <div className="order-note">Note: {t.orderNotes}</div> : null}
              <div className="actions">
                {t.status === 'new' || t.status === 'accepted' ? (
                  <button
                    type="button"
                    className="kbtn-start"
                    disabled={busy === t.id}
                    onClick={() => void act(t, 'start')}
                  >
                    START
                  </button>
                ) : null}
                {t.status === 'on_hold' ? (
                  <button
                    type="button"
                    className="kbtn-start"
                    disabled={busy === t.id}
                    onClick={() => void act(t, 'resume')}
                  >
                    RESUME
                  </button>
                ) : null}
                {t.status === 'in_preparation' ? (
                  <button
                    type="button"
                    className="kbtn-minor"
                    disabled={busy === t.id}
                    onClick={() => void act(t, 'pause')}
                  >
                    PAUSE
                  </button>
                ) : null}
                {t.status !== 'ready' ? (
                  <button
                    type="button"
                    className="kbtn-ready"
                    disabled={busy === t.id}
                    onClick={() => void act(t, 'ready')}
                  >
                    READY
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      className="kbtn-minor"
                      disabled={busy === t.id}
                      onClick={() => void act(t, 'recall')}
                    >
                      RECALL
                    </button>
                    <button
                      type="button"
                      className="kbtn-bump"
                      disabled={busy === t.id}
                      onClick={() => void act(t, 'complete')}
                    >
                      BUMP
                    </button>
                  </>
                )}
              </div>
            </article>
          );
        })}
      </div>
      {board && board.tickets.length === 0 ? (
        <div className="kds-empty">No open tickets. New orders appear here the moment they are sent.</div>
      ) : null}
    </div>
  );
}
