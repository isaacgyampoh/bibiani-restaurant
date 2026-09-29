/**
 * The till's own customer-facing screen (the second monitor of a dual-screen POS). The POS window
 * and the customer window are two windows of the same browser on the same machine: they talk over
 * a BroadcastChannel, so the customer screen updates instantly, needs no sign-in and no server,
 * and keeps working offline. Nothing leaves the till. No phone numbers are ever sent to it.
 */
export interface TillScreenLine {
  name: string;
  quantity: number;
  amount: number;
  detail: string | null;
}

export type TillScreenState =
  | { kind: 'idle' }
  | {
      kind: 'order';
      title: string;
      lines: TillScreenLine[];
      discount: number;
      total: number;
      paid: number;
      due: number;
      currency: string;
      /** Items not yet sent: prices are the menu estimate. */
      estimate: boolean;
    }
  | { kind: 'paid'; title: string; total: number; change: number; currency: string };

type Message = { type: 'state'; state: TillScreenState } | { type: 'hello' };

const CHANNEL = 'myfood-till-screen';
let channel: BroadcastChannel | null = null;
let last: TillScreenState = { kind: 'idle' };

function open(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  if (!channel) {
    channel = new BroadcastChannel(CHANNEL);
    // A customer window that opens (or reloads) later asks for the current state.
    channel.addEventListener('message', (e: MessageEvent<Message>) => {
      if (e.data?.type === 'hello') channel?.postMessage({ type: 'state', state: last } satisfies Message);
    });
  }
  return channel;
}

/** POS side: what the customer should see now. */
export function showOnTillScreen(state: TillScreenState): void {
  last = state;
  open()?.postMessage({ type: 'state', state } satisfies Message);
}

/** Customer side: follow the POS. Returns an unsubscribe function. */
export function followTillScreen(onState: (s: TillScreenState) => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => undefined;
  const ch = new BroadcastChannel(CHANNEL);
  const listener = (e: MessageEvent<Message>) => {
    if (e.data?.type === 'state') onState(e.data.state);
  };
  ch.addEventListener('message', listener);
  ch.postMessage({ type: 'hello' } satisfies Message);
  return () => {
    ch.removeEventListener('message', listener);
    ch.close();
  };
}

/**
 * Opens the customer screen. On Chrome / Edge with two monitors it asks once for permission to
 * place windows and opens on the second screen; otherwise it opens a window to drag there.
 */
export async function openTillScreen(): Promise<void> {
  let features = 'popup=yes,width=1024,height=768';
  try {
    const w = window as Window & {
      getScreenDetails?: () => Promise<{
        screens: {
          isPrimary: boolean;
          availLeft: number;
          availTop: number;
          availWidth: number;
          availHeight: number;
        }[];
        currentScreen: { availLeft: number };
      }>;
    };
    if (w.getScreenDetails) {
      const details = await w.getScreenDetails();
      const other =
        details.screens.find((s) => s.availLeft !== details.currentScreen.availLeft) ??
        details.screens.find((s) => !s.isPrimary);
      if (other)
        features = `popup=yes,left=${other.availLeft},top=${other.availTop},width=${other.availWidth},height=${other.availHeight}`;
    }
  } catch {
    // Permission refused or not supported: a normal window, dragged to the second screen.
  }
  window.open('/till-screen', 'myfood-till-screen', features);
}

/** The order was closed on the till: back to welcome, but a "paid" screen stays until it times out. */
export function clearTillScreen(): void {
  if (last.kind !== 'paid') showOnTillScreen({ kind: 'idle' });
}
