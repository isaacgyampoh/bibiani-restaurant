/**
 * Keeps a screen's data in step with the database.
 *
 *   REALTIME EVENT != SOURCE OF TRUTH
 *
 * A change signal only means "something changed, go and look". The feed then
 * reloads authoritative state. It also reloads on (re)connection and on a
 * periodic safety poll, so a silently dead socket cannot leave a kitchen
 * screen showing stale tickets.
 */
export type ConnectionState = 'connecting' | 'live' | 'polling';

export interface ChangeSignal {
  /** Returns an unsubscribe function. `onStatus('connected')` must be emitted after every (re)subscribe. */
  subscribe(onChange: () => void, onStatus: (status: 'connected' | 'disconnected') => void): () => void;
}

export interface FeedState<T> {
  data: T | null;
  connection: ConnectionState;
  lastLoadedAt: Date | null;
  error: unknown;
}

export interface Timers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface ReconcilingFeedOptions<T> {
  load: () => Promise<T>;
  signal: ChangeSignal;
  /** Safety poll. KDS: ~20s. POS / displays: ~60s. Never every second. */
  pollIntervalMs: number;
  onState: (state: FeedState<T>) => void;
  timers?: Timers;
}

export class ReconcilingFeed<T> {
  private state: FeedState<T> = { data: null, connection: 'connecting', lastLoadedAt: null, error: null };
  private inFlight: Promise<void> | null = null;
  private again = false;
  private unsubscribe: (() => void) | null = null;
  private poll: unknown = null;
  private readonly timers: Timers;

  constructor(private readonly options: ReconcilingFeedOptions<T>) {
    this.timers = options.timers ?? {
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    };
  }

  async start(): Promise<void> {
    this.unsubscribe = this.options.signal.subscribe(
      () => void this.refresh(),
      (status) => {
        const wasLive = this.state.connection === 'live';
        this.update({ connection: status === 'connected' ? 'live' : 'polling' });
        // Reconnected: we may have missed events while away, so reload everything.
        if (status === 'connected' && !wasLive) void this.refresh();
      },
    );
    this.poll = this.timers.setInterval(() => void this.refresh(), this.options.pollIntervalMs);
    await this.refresh();
  }

  stop(): void {
    this.unsubscribe?.();
    if (this.poll !== null) this.timers.clearInterval(this.poll);
  }

  /** Coalesces bursts: at most one load in flight, plus one follow-up if changes arrived meanwhile. */
  refresh(): Promise<void> {
    if (this.inFlight) {
      this.again = true;
      return this.inFlight;
    }
    this.inFlight = (async () => {
      do {
        this.again = false;
        try {
          const data = await this.options.load();
          this.update({ data, lastLoadedAt: new Date(), error: null });
        } catch (error) {
          this.update({ error }); // keep showing last known data, flagged as stale by the UI
        }
      } while (this.again);
    })().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  get current(): FeedState<T> {
    return this.state;
  }

  private update(patch: Partial<FeedState<T>>): void {
    this.state = { ...this.state, ...patch };
    this.options.onState(this.state);
  }
}
