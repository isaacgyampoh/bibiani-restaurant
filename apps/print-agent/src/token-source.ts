import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createClient } from '@supabase/supabase-js';

/**
 * The agent authenticates as its own paired device (a Supabase Auth user linked
 * to devices.auth_user_id). It never holds a service key.
 *
 * Supabase rotates refresh tokens on use. The agent therefore persists the
 * LATEST refresh token to a private file (mode 0600) and prefers it on
 * restart; the configured AGENT_REFRESH_TOKEN is only the first-start token.
 * Without this, strict rotation settings would lock the agent out after a restart.
 */
export function supabaseDeviceTokenSource(
  supabaseUrl: string,
  anonKey: string,
  initialRefreshToken: string,
  sessionFile: string,
) {
  const client = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: true },
  });
  const persist = (refreshToken: string) => {
    mkdirSync(dirname(sessionFile), { recursive: true });
    writeFileSync(sessionFile, JSON.stringify({ refreshToken, savedAt: new Date().toISOString() }), {
      mode: 0o600,
    });
    chmodSync(sessionFile, 0o600);
  };
  client.auth.onAuthStateChange((event, session) => {
    if (session && (event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN')) persist(session.refresh_token);
  });

  const stored = (): string | null => {
    if (!existsSync(sessionFile)) return null;
    try {
      return (
        (JSON.parse(readFileSync(sessionFile, 'utf8')) as { refreshToken?: string }).refreshToken ?? null
      );
    } catch {
      return null;
    }
  };

  let ready: Promise<void> | null = null;
  const start = async () => {
    // Prefer the persisted (latest) token; fall back to the configured first-start token.
    for (const candidate of [stored(), initialRefreshToken].filter((t): t is string => Boolean(t))) {
      const { data, error } = await client.auth.refreshSession({ refresh_token: candidate });
      if (!error && data.session) {
        persist(data.session.refresh_token);
        return;
      }
    }
    throw new Error('Print agent sign-in failed: re-pair this agent (Admin → Devices → Pairing code)');
  };

  return async (): Promise<string> => {
    ready ??= start().catch((e) => {
      ready = null;
      throw e;
    });
    await ready;
    const { data } = await client.auth.getSession();
    if (!data.session) throw new Error('Print agent has no session');
    return data.session.access_token;
  };
}
