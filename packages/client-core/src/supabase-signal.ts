import type { SupabaseClient } from '@supabase/supabase-js';
import type { ChangeSignal } from './reconciling-feed';

/**
 * ChangeSignal backed by Supabase Realtime private broadcast channels
 * (topics like `branch:<id>:station:<id>`, published by database triggers).
 *
 * NOT YET VERIFIED against a live Supabase project: the migrations have not
 * been applied to the hosted project. Tested only through the ChangeSignal
 * contract with a controllable signal.
 */
export class SupabaseBroadcastSignal implements ChangeSignal {
  constructor(
    private readonly client: SupabaseClient,
    private readonly topic: string,
  ) {}

  subscribe(onChange: () => void, onStatus: (status: 'connected' | 'disconnected') => void): () => void {
    const channel = this.client
      .channel(this.topic, { config: { private: true } })
      .on('broadcast', { event: '*' }, () => onChange())
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') onStatus('connected');
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED')
          onStatus('disconnected');
      });
    return () => {
      void this.client.removeChannel(channel);
    };
  }
}
