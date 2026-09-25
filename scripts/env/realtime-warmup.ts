/**
 * New-environment Realtime warm-up: Supabase Realtime creates the daily partitions of
 * realtime.messages on the first private-channel join (until then joins fail with
 * MissingPartition and database broadcasts are dropped). Uses a temporary login that is
 * deleted afterwards; creates no restaurant data.
 *   tsx --env-file=.env.<env> scripts/env/realtime-warmup.ts
 */
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL!;
const anon = process.env.SUPABASE_ANON_KEY!;
const secret = process.env.SUPABASE_SECRET_KEY!;
const email = `warmup-${randomBytes(4).toString('hex')}@devices.example.com`;
const password = randomBytes(24).toString('base64url');
const admin = { apikey: secret, 'content-type': 'application/json' };
const created = (await (
  await fetch(`${url}/auth/v1/admin/users`, {
    method: 'POST',
    headers: admin,
    body: JSON.stringify({ email, password, email_confirm: true }),
  })
).json()) as { id: string };
try {
  const client = createClient(url, anon, { auth: { persistSession: false } });
  const { data } = await client.auth.signInWithPassword({ email, password });
  await client.realtime.setAuth(data.session!.access_token);
  const statuses: string[] = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const status = await new Promise<string>((resolve) => {
      const ch = client.channel(`warmup:${attempt}`, { config: { private: true } }).subscribe((s, err) => {
        if (s === 'SUBSCRIBED' || s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') {
          resolve(`${s}${err ? `: ${err.message}` : ''}`);
          void client.removeChannel(ch);
        }
      });
    });
    statuses.push(status);
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log(JSON.stringify({ joinAttempts: statuses }));
  // An unauthorized/unknown topic answering "Unauthorized" (rather than MissingPartition) means storage is ready.
} finally {
  await fetch(`${url}/auth/v1/admin/users/${created.id}`, { method: 'DELETE', headers: admin });
}
process.exit(0);
