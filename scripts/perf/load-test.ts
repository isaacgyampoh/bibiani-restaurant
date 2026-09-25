/**
 * Load test against a DEPLOYED environment (default: staging).
 *   tsx --env-file=.env.staging scripts/perf/load-test.ts
 * Needs ACCOUNTS_FILE (from configure-demo) and API_URL. Writes perf-results/<env>-<time>.json.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import postgres from 'postgres';

const API = (process.env.API_URL ?? 'https://restaurant-management-staging.vercel.app').replace(/\/$/, '');
const accounts = JSON.parse(readFileSync(process.env.ACCOUNTS_FILE ?? '.staging-accounts.json', 'utf8'));
const SUPA = process.env.SUPABASE_URL!;
const ANON = process.env.SUPABASE_ANON_KEY!;

async function token(email: string, password: string) {
  const r = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return ((await r.json()) as { access_token: string }).access_token;
}
const cashierToken = await token(accounts.accounts.cashier.email, accounts.accounts.cashier.password);
const ownerToken = await token(accounts.accounts.owner.email, accounts.accounts.owner.password);

// biome-ignore lint/suspicious/noExplicitAny: loosely-typed JSON from the API in a measurement script
type Json = any;
interface Sample {
  ok: boolean;
  status: number;
  clientMs: number;
  serverMs: number;
  dbMs: number;
  statements: number;
  error?: string;
}
function parseTiming(h: string | null) {
  const total = /total;dur=([\d.]+)/.exec(h ?? '');
  const db = /db;dur=([\d.]+);desc="(\d+) statements/.exec(h ?? '');
  return {
    serverMs: total ? Number(total[1]) : Number.NaN,
    dbMs: db ? Number(db[1]) : Number.NaN,
    statements: db ? Number(db[2]) : 0,
  };
}
async function call(
  method: string,
  path: string,
  body: unknown,
  tok = cashierToken,
): Promise<{ sample: Sample; json: Json }> {
  const t = performance.now();
  try {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const json = await res.json().catch(() => null);
    const timing = parseTiming(res.headers.get('server-timing'));
    return {
      sample: {
        ok: res.ok,
        status: res.status,
        clientMs: performance.now() - t,
        ...timing,
        error: res.ok ? undefined : json?.error?.code,
      },
      json,
    };
  } catch (e) {
    return {
      sample: {
        ok: false,
        status: 0,
        clientMs: performance.now() - t,
        serverMs: Number.NaN,
        dbMs: Number.NaN,
        statements: 0,
        error: (e as Error).name,
      },
      json: null,
    };
  }
}

// Menu ids
const menu = (await call('GET', `/v1/branches/${accounts.branchId}/menu`, undefined)).json;
const pid = (name: string) => menu.products.find((p: { name: string }) => p.name === name).id as string;
const takeaway = menu.areas.find((a: { channel: string }) => a.channel === 'takeaway').id as string;
const orderCmd = () => ({
  orderId: randomUUID(),
  branchId: accounts.branchId,
  areaId: takeaway,
  items: [
    { id: randomUUID(), productId: pid('Jollof Rice'), quantity: 1, modifierIds: [] },
    { id: randomUUID(), productId: pid('Grilled Chicken'), quantity: 1, modifierIds: [] },
    { id: randomUUID(), productId: pid('Meat Pie'), quantity: 2, modifierIds: [] },
    { id: randomUUID(), productId: pid('Coke'), quantity: 2, modifierIds: [] },
  ],
  send: { submissionId: randomUUID() },
});

// Database pressure sampler (API connections), via the privileged staging test login.
const admin = postgres(process.env.TEST_DATABASE_URL!, { prepare: false, max: 1, onnotice: () => {} });
let maxApiConns = 0;
let sampling = true;
const sampler = (async () => {
  while (sampling) {
    const [r] =
      await admin`select count(*) filter (where usename = 'rp_api')::int as api, count(*) filter (where usename = 'rp_api' and state = 'active')::int as active from pg_stat_activity`.catch(
        () => [{ api: -1, active: -1 }],
      );
    maxApiConns = Math.max(maxApiConns, r!.api);
    await new Promise((res) => setTimeout(res, 250));
  }
})();

const pct = (xs: number[], p: number) => {
  const v = xs.filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
  return v.length ? Math.round(v[Math.min(v.length - 1, Math.ceil((p / 100) * v.length) - 1)]!) : null;
};
const summarize = (name: string, samples: Sample[], wallMs: number) => ({
  name,
  n: samples.length,
  errors: samples.filter((s) => !s.ok).length,
  errorRate: +(samples.filter((s) => !s.ok).length / samples.length).toFixed(3),
  errorCodes: [...new Set(samples.filter((s) => !s.ok).map((s) => `${s.status}:${s.error}`))],
  wallMs: Math.round(wallMs),
  client: {
    p50: pct(
      samples.map((s) => s.clientMs),
      50,
    ),
    p95: pct(
      samples.map((s) => s.clientMs),
      95,
    ),
    p99: pct(
      samples.map((s) => s.clientMs),
      99,
    ),
  },
  server: {
    p50: pct(
      samples.map((s) => s.serverMs),
      50,
    ),
    p95: pct(
      samples.map((s) => s.serverMs),
      95,
    ),
    p99: pct(
      samples.map((s) => s.serverMs),
      99,
    ),
  },
  db: {
    p50: pct(
      samples.map((s) => s.dbMs),
      50,
    ),
    p95: pct(
      samples.map((s) => s.dbMs),
      95,
    ),
    p99: pct(
      samples.map((s) => s.dbMs),
      99,
    ),
  },
  statements: samples[0]?.statements,
});

const results: unknown[] = [];
const orders: { id: string; total: number }[] = [];
async function submitBatch(name: string, count: number, concurrent: boolean) {
  const samples: Sample[] = [];
  const t = performance.now();
  const one = async () => {
    const r = await call('POST', '/v1/orders/submit', orderCmd());
    samples.push(r.sample);
    if (r.sample.ok) orders.push({ id: r.json.id, total: r.json.grandTotal });
  };
  if (concurrent) await Promise.all(Array.from({ length: count }, one));
  else for (let i = 0; i < count; i++) await one();
  const s = summarize(name, samples, performance.now() - t);
  results.push(s);
  console.log(JSON.stringify(s));
}

// Warm-up (cold start excluded from the statistics, reported separately)
const cold = await call('GET', '/health/ready', undefined);
results.push({
  name: 'first request after deploy/idle (cold path)',
  clientMs: Math.round(cold.sample.clientMs),
});
await submitBatch('order submit x1', 1, false);
await submitBatch('order submit x10 sequential', 10, false);
await submitBatch('order submit x10 concurrent', 10, true);
await submitBatch('order submit x50 concurrent', 50, true);
if (process.env.SKIP_100 !== '1') await submitBatch('order submit x100 concurrent', 100, true);

// Payment recording (sequential, card, full amount)
{
  const samples: Sample[] = [];
  const t = performance.now();
  for (const o of orders.slice(0, 10)) {
    samples.push(
      (
        await call('POST', `/v1/orders/${o.id}/payments`, {
          paymentId: randomUUID(),
          method: 'card',
          amount: o.total,
        })
      ).sample,
    );
  }
  const s = summarize('record payment x10 sequential', samples, performance.now() - t);
  results.push(s);
  console.log(JSON.stringify(s));
}

// Realtime propagation: KDS device session subscribed to the kitchen station topic.
{
  const kds = createClient(SUPA, ANON, { auth: { persistSession: false } });
  // A paired KDS login is not in the accounts file; the kitchen staff account can subscribe (staff of the branch).
  await kds.auth.signInWithPassword(accounts.accounts.kitchen);
  const { data } = await kds.auth.getSession();
  await kds.realtime.setAuth(data.session!.access_token);
  const stations = (await call('GET', '/v1/admin/configuration', undefined, ownerToken)).json.stations;
  const kit = stations.find((s: { code: string }) => s.code === 'KIT').id;
  const arrivals = new Map<string, number>();
  await new Promise<void>((resolve) =>
    kds
      .channel(`branch:${accounts.branchId}:station:${kit}`, { config: { private: true } })
      .on('broadcast', { event: '*' }, (m) => {
        const id = (m.payload as { order_id: string }).order_id;
        if (!arrivals.has(id)) arrivals.set(id, performance.now());
      })
      .subscribe((st) => st === 'SUBSCRIBED' && resolve()),
  );
  const lat: number[] = [];
  const afterCommit: number[] = [];
  for (let i = 0; i < 10; i++) {
    const t0 = performance.now();
    const r = await call('POST', '/v1/orders/submit', orderCmd());
    const tDone = performance.now();
    const until = performance.now() + 15_000;
    while (!arrivals.has(r.json.id) && performance.now() < until)
      await new Promise((res) => setTimeout(res, 20));
    if (arrivals.has(r.json.id)) {
      lat.push(arrivals.get(r.json.id)! - t0);
      afterCommit.push(arrivals.get(r.json.id)! - tDone);
    }
  }
  const s = {
    name: 'realtime: submit start -> KDS signal received (test machine)',
    received: `${lat.length}/10`,
    p50: pct(lat, 50),
    p95: pct(lat, 95),
    signalAfterApiResponse: { p50: pct(afterCommit, 50), p95: pct(afterCommit, 95) },
  };
  results.push(s);
  console.log(JSON.stringify(s));
  await kds.removeAllChannels();
}

// Print-agent claim latency: pair the agent, then claim repeatedly (jobs are queued from the orders above).
{
  const config = (await call('GET', '/v1/admin/configuration', undefined, ownerToken)).json;
  const agent = config.devices.find((d: { name: string }) => d.name === 'PRINT-AGENT-01');
  const code = (await call('POST', `/v1/admin/devices/${agent.id}/pairing-code`, {}, ownerToken)).json.code;
  const paired = await (
    await fetch(`${API}/v1/devices/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    })
  ).json();
  const agentToken = paired.session.accessToken as string;
  const samples: Sample[] = [];
  let claimed = 0;
  const t = performance.now();
  for (let i = 0; i < 10; i++) {
    const r = await call('POST', '/v1/print-agent/claim', { limit: 10 }, agentToken);
    samples.push(r.sample);
    claimed += Array.isArray(r.json) ? r.json.length : 0;
    // Report each as printed so the queue drains like a real agent would.
    for (const j of Array.isArray(r.json) ? r.json : [])
      await call(
        'POST',
        `/v1/print-jobs/${j.id}/result`,
        { claimId: j.claimId, outcome: 'printed' },
        agentToken,
      );
  }
  const s = {
    ...summarize('print agent claim (limit 10) x10', samples, performance.now() - t),
    jobsClaimed: claimed,
  };
  results.push(s);
  console.log(JSON.stringify(s));
}

sampling = false;
await sampler;
await admin.end();
results.push({
  name: 'database pressure',
  maxRpApiConnectionsObserved: maxApiConns,
  note: 'Supavisor transaction pooler; each warm function instance holds a pool of DB_POOL_MAX',
});
mkdirSync('perf-results', { recursive: true });
const file = `perf-results/${process.env.APP_ENV ?? 'env'}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
writeFileSync(file, JSON.stringify({ api: API, at: new Date().toISOString(), results }, null, 2));
console.log(`written ${file}`);
process.exit(0);
