import { ApiClient, type ChangeSignal, SupabaseBroadcastSignal } from '@rp/client-core';
import type { MeView, PairDeviceResult } from '@rp/contracts';
import { createClient, type Session } from '@supabase/supabase-js';

/**
 * Infrastructure for the browser: Supabase is used ONLY for sign-in sessions and
 * realtime change signals. All reads and writes go through the platform API.
 * Only public values (URL, anon key) exist in this bundle.
 */
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? '';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'rp.session' },
});

// Private realtime channels need the current access token.
supabase.auth.onAuthStateChange((_event, session) => {
  if (session) void supabase.realtime.setAuth(session.access_token);
});

const POS_DEVICE_KEY = 'rp.posDevice';

/** A paired POS till: identifies the terminal (x-device-id) while staff sign in on it. */
export function posDevice(): { id: string; name: string } | null {
  try {
    const raw = localStorage.getItem(POS_DEVICE_KEY);
    return raw ? (JSON.parse(raw) as { id: string; name: string }) : null;
  } catch {
    return null;
  }
}

export async function currentSession(): Promise<Session | null> {
  return (await supabase.auth.getSession()).data.session;
}

export async function signInStaff(email: string, password: string): Promise<void> {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error)
    throw new Error(
      error.message === 'Invalid login credentials' ? 'Wrong email or password' : error.message,
    );
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut();
}

export const api = new ApiClient({
  baseUrl: API_URL,
  getAccessToken: async () => {
    const session = await currentSession();
    if (!session) throw new Error('Not signed in');
    return session.access_token;
  },
  getDeviceId: () => posDevice()?.id ?? null,
});

/** Exchanges a one-time pairing code for this device's own login (no shared passwords). */
export async function pairDevice(code: string): Promise<PairDeviceResult> {
  const res = await fetch(`${API_URL}/v1/devices/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message ?? 'Pairing failed');
  const result = body as PairDeviceResult;
  if (result.device.kind === 'pos') {
    // A till only needs its identity; people sign in on it with their own accounts.
    localStorage.setItem(POS_DEVICE_KEY, JSON.stringify({ id: result.device.id, name: result.device.name }));
    await supabase.auth.signOut();
  } else {
    await supabase.auth.setSession({
      access_token: result.session.accessToken,
      refresh_token: result.session.refreshToken,
    });
  }
  return result;
}

export function branchSignal(topic: string): ChangeSignal {
  return new SupabaseBroadcastSignal(supabase, topic);
}

export const topics = {
  orders: (branchId: string) => `branch:${branchId}:orders`,
  station: (branchId: string, stationId: string) => `branch:${branchId}:station:${stationId}`,
  ops: (branchId: string) => `branch:${branchId}:ops`,
};

export function hasPermission(me: MeView | null, permission: string, branchId?: string): boolean {
  if (!me) return false;
  return Object.entries(me.permissions).some(
    ([branch, perms]) => (branch === '*' || !branchId || branch === branchId) && perms.includes(permission),
  );
}
