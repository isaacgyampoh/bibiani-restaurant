/**
 * DEV smoke test of the REAL print agent process against the real API + Supabase DEV:
 * pairs PRINT-AGENT-01 with a one-time code, points the demo printers at local fake
 * ESC/POS printers (or real ones: set REAL_PRINTER=<name>=<ip:port>), runs the built agent
 * binary, and reports what printed. Requires the API running and a configured demo restaurant.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiClient } from '@rp/client-core';
import { FakePrinter } from '../../apps/print-agent/test/fake-printer';

const API_URL = process.env.API_URL ?? 'http://127.0.0.1:8787';
const dev = JSON.parse(readFileSync(process.env.ACCOUNTS_FILE ?? '.dev-accounts.json', 'utf8'));
const tokenRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { apikey: process.env.SUPABASE_ANON_KEY!, 'content-type': 'application/json' },
  body: JSON.stringify(dev.accounts.owner),
});
const owner = (await tokenRes.json()) as { access_token: string };
const api = new ApiClient({
  baseUrl: API_URL,
  getAccessToken: async () => owner.access_token,
  timeoutMs: 60_000,
});

const config = await api.configuration();
const agent = config.devices.find((d) => d.name === 'PRINT-AGENT-01')!;
const printers = config.devices.filter((d) => d.kind === 'printer');
const real = Object.fromEntries(
  (process.env.REAL_PRINTER ?? '')
    .split(',')
    .filter(Boolean)
    .map((p) => p.split('=')),
);
const fakes = new Map<string, FakePrinter>();
for (const p of printers) {
  let address = real[String(p.name)];
  if (!address) {
    const fake = new FakePrinter();
    await fake.start();
    fakes.set(String(p.name), fake);
    address = `127.0.0.1:${fake.port}`;
  }
  await api.saveConfig('device', {
    id: p.id,
    branchId: p.branchId,
    kind: 'printer',
    name: p.name,
    isActive: true,
    printer: {
      address,
      agentDeviceId: agent.id,
      paperWidthMm: 80,
      backupPrinterId: p.backupPrinterId ?? null,
    },
  });
}

const before = await api.printQueue(dev.branchId);
const { code } = await api.pairingCode(String(agent.id));
const pairRes = await fetch(`${API_URL}/v1/devices/pair`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code }),
});
const paired = (await pairRes.json()) as { session: { refreshToken: string } };

const dir = mkdtempSync(join(tmpdir(), 'agent-'));
const events: string[] = [];
const startAgent = () => {
  const c = spawn('node', ['apps/print-agent/dist/main.js'], {
    env: {
      ...process.env,
      API_URL,
      AGENT_REFRESH_TOKEN: paired.session.refreshToken, // the ORIGINAL pairing token, on every start
      JOURNAL_FILE: join(dir, 'journal.jsonl'),
      AGENT_SESSION_FILE: join(dir, 'agent-session.json'),
      POLL_INTERVAL_MS: '2000',
      AGENT_VERSION: 'smoke',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  c.stdout.on('data', (d: Buffer) => events.push(...d.toString().trim().split('\n')));
  c.stderr.on('data', (d: Buffer) => events.push(...d.toString().trim().split('\n')));
  return c;
};
let child = startAgent();

const deadline = Date.now() + 120_000;
let after = before;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 4000));
  after = await api.printQueue(dev.branchId);
  if (after.jobs.filter((j) => j.status === 'pending' || j.status === 'claimed').length === 0) break;
}
// Restart twice with the same original token: sign-in must use the persisted (rotated) token.
const restarts: string[] = [];
for (let i = 0; i < 2; i++) {
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 12_000)); // beyond Supabase's refresh-token reuse interval
  const before = events.filter((l) => l.includes('agent.config_loaded')).length;
  child = startAgent();
  const until = Date.now() + 30_000;
  while (Date.now() < until && events.filter((l) => l.includes('agent.config_loaded')).length === before)
    await new Promise((r) => setTimeout(r, 500));
  restarts.push(
    events.filter((l) => l.includes('agent.config_loaded')).length > before
      ? 'signed in'
      : 'FAILED to sign in',
  );
}
const ops = await api.operations(dev.branchId);
child.kill('SIGTERM');
for (const f of fakes.values()) await f.stop();

const printed = [...fakes].map(([name, f]) => ({
  name,
  jobs: f.jobs.length,
  firstLine: f.text(0).match(/ORDER #\d+|Receipt|TOTAL/)?.[0] ?? '',
}));
console.log(
  JSON.stringify(
    {
      queueBefore: before.jobs.length,
      queueAfter: after.jobs.map((j) => ({ printer: j.printerName, status: j.status, error: j.lastError })),
      printed,
      restartsWithOriginalToken: restarts,
      agentStatus: ops.devices.find((d) => d.name === 'PRINT-AGENT-01')?.status,
      printerHealth: ops.devices
        .filter((d) => d.kind === 'printer')
        .map((d) => `${d.name}:${d.printer?.healthy}`),
      agentEvents: events
        .map((l) => {
          try {
            return JSON.parse(l).event;
          } catch {
            return l.slice(0, 80);
          }
        })
        .filter(Boolean)
        .slice(0, 25),
    },
    null,
    1,
  ),
);
process.exit(0);
