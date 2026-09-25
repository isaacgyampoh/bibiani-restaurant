import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Kitchen notifications, derived by comparing successive authoritative snapshots from the server
 * (never from realtime payloads). The first snapshot only sets the baseline: opening a screen does
 * not replay history.
 */
export type NoticeKind =
  | 'new'
  | 'added'
  | 'voided'
  | 'recalled'
  | 'station_ready'
  | 'order_ready'
  | 'delayed';
export interface Notice {
  id: string;
  kind: NoticeKind;
  title: string;
  detail?: string;
  at: number;
  read: boolean;
}

const LABEL: Record<NoticeKind, string> = {
  new: 'New order',
  added: 'Item added',
  voided: 'Item voided',
  recalled: 'Recalled',
  station_ready: 'Station ready',
  order_ready: 'Order ready',
  delayed: 'Delayed',
};
const LOUD: ReadonlySet<NoticeKind> = new Set(['new', 'voided', 'order_ready', 'delayed']);

let audio: AudioContext | null = null;
function chime(kind: NoticeKind) {
  if (!audio) return;
  const tones =
    kind === 'voided' || kind === 'delayed' ? [440, 330] : kind === 'order_ready' ? [660, 880] : [880];
  tones.forEach((f, i) => {
    const o = audio!.createOscillator();
    const g = audio!.createGain();
    o.frequency.value = f;
    o.type = 'sine';
    const t = audio!.currentTime + i * 0.18;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    o.connect(g).connect(audio!.destination);
    o.start(t);
    o.stop(t + 0.18);
  });
}

export function useNotices<S>(
  snapshot: S | null,
  diff: (previous: S, next: S) => Omit<Notice, 'id' | 'at' | 'read'>[],
) {
  const [notices, setNotices] = useState<Notice[]>([]);
  const [sound, setSound] = useState(() => {
    try {
      return localStorage.getItem('rp.sound') === 'on';
    } catch {
      return false;
    }
  });
  const previous = useRef<S | null>(null);
  const diffRef = useRef(diff);
  diffRef.current = diff;

  useEffect(() => {
    if (!snapshot) return;
    const before = previous.current;
    previous.current = snapshot;
    if (!before) return;
    const fresh = diffRef.current(before, snapshot);
    if (fresh.length === 0) return;
    const now = Date.now();
    setNotices((list) =>
      [...fresh.map((n, i) => ({ ...n, id: `${now}-${i}`, at: now, read: false })), ...list].slice(0, 50),
    );
    if (sound) {
      const loud = fresh.find((n) => LOUD.has(n.kind));
      if (loud) chime(loud.kind);
    }
  }, [snapshot, sound]);

  const toggleSound = useCallback(() => {
    const next = !sound;
    if (next && !audio) {
      const Ctx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      audio = Ctx ? new Ctx() : null;
    }
    void audio?.resume();
    if (next) chime('new');
    setSound(next);
    try {
      localStorage.setItem('rp.sound', next ? 'on' : 'off');
    } catch {
      /* per-device preference only */
    }
  }, [sound]);

  return {
    notices,
    unread: notices.filter((n) => !n.read).length,
    markAllRead: () => setNotices((l) => l.map((n) => ({ ...n, read: true }))),
    sound,
    toggleSound,
  };
}

/** Bell with unread count + dropdown list. The newest unread notice is also shown as a banner for 6 s. */
export function NoticeCenter({ state }: { state: ReturnType<typeof useNotices> }) {
  const [open, setOpen] = useState(false);
  const [banner, setBanner] = useState<Notice | null>(null);
  const newest = state.notices[0];
  useEffect(() => {
    if (!newest || newest.read) return;
    setBanner(newest);
    const t = setTimeout(() => setBanner(null), 6000);
    return () => clearTimeout(t);
  }, [newest]);
  // Audio needs a user gesture before first use: sound starts after "Sound on" is tapped (or on reload).
  useEffect(() => {
    if (!state.sound || audio) return;
    const unlock = () => {
      const Ctx = window.AudioContext;
      audio = Ctx ? new Ctx() : null;
      window.removeEventListener('pointerdown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    return () => window.removeEventListener('pointerdown', unlock);
  }, [state.sound]);
  return (
    <>
      <button type="button" className="dark-btn" onClick={state.toggleSound} aria-pressed={state.sound}>
        {state.sound ? 'Sound on' : 'Sound off'}
      </button>
      <div className="notice-center">
        <button
          type="button"
          className="dark-btn"
          onClick={() => {
            setOpen(!open);
            if (!open) state.markAllRead();
          }}
          aria-label={`Notifications, ${state.unread} unread`}
        >
          Alerts {state.unread ? <span className="count">{state.unread}</span> : null}
        </button>
        {open ? (
          <div className="notice-list" role="dialog" aria-label="Notifications">
            {state.notices.length === 0 ? <div className="muted small">No notifications yet</div> : null}
            {state.notices.map((n) => (
              <div key={n.id} className={`nitem ${n.kind}`}>
                <div className="row">
                  <strong className="grow">{n.title}</strong>
                  <span className="small muted">
                    {new Date(n.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                <div className="small">
                  <span className="tag">{LABEL[n.kind]}</span> {n.detail}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      {banner ? (
        <div className={`notice-banner ${banner.kind}`} role="status">
          <span className="tag">{LABEL[banner.kind]}</span> {banner.title}
          {banner.detail ? <span className="detail"> — {banner.detail}</span> : null}
        </div>
      ) : null}
    </>
  );
}
