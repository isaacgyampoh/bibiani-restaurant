import { type FeedState, ReconcilingFeed } from '@rp/client-core';
import { useEffect, useRef, useState } from 'react';
import { branchSignal } from './session';

/**
 * Screen data that stays correct: realtime signal -> reload from the API; also
 * reload on reconnect, when the tab becomes visible, and on a safety poll.
 */
export function useFeed<T>(
  key: string | null,
  load: () => Promise<T>,
  options: { topic: string | null; pollMs: number },
): FeedState<T> & { refresh: () => void } {
  const [state, setState] = useState<FeedState<T>>({
    data: null,
    connection: 'connecting',
    lastLoadedAt: null,
    error: null,
  });
  const feedRef = useRef<ReconcilingFeed<T> | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (!key) return;
    const signal = options.topic
      ? branchSignal(options.topic)
      : {
          subscribe: (_c: () => void, s: (x: 'connected' | 'disconnected') => void) => {
            s('disconnected');
            return () => {};
          },
        };
    const feed = new ReconcilingFeed<T>({
      load: () => loadRef.current(),
      signal,
      pollIntervalMs: options.pollMs,
      onState: setState,
    });
    feedRef.current = feed;
    void feed.start();
    const onVisible = () => document.visibilityState === 'visible' && void feed.refresh();
    const onOnline = () => void feed.refresh();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    return () => {
      feed.stop();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
    };
  }, [key, options.topic, options.pollMs]);

  return { ...state, refresh: () => void feedRef.current?.refresh() };
}
