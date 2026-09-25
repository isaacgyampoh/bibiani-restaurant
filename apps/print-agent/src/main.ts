import { resolve } from 'node:path';
import { ApiClient } from '@rp/client-core';
import { PrintAgent } from './agent';
import { NetworkEscPosDriver } from './driver';
import { PrintJournal } from './journal';
import { supabaseDeviceTokenSource } from './token-source';

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required environment variable ${name}. See apps/print-agent/.env.example.`);
    process.exit(1);
  }
  return v;
}

const log =
  (level: string) =>
  (event: string, fields: Record<string, unknown> = {}) =>
    (level === 'error' ? process.stderr : process.stdout).write(
      `${JSON.stringify({ ts: new Date().toISOString(), level, service: 'print-agent', event, ...fields })}\n`,
    );
const logger = { info: log('info'), warn: log('warn'), error: log('error') };

const api = new ApiClient({
  baseUrl: required('API_URL'),
  getAccessToken: supabaseDeviceTokenSource(
    required('SUPABASE_URL'),
    required('SUPABASE_ANON_KEY'),
    required('AGENT_REFRESH_TOKEN'),
    resolve(process.env.AGENT_SESSION_FILE ?? '.journal/agent-session.json'),
  ),
});

const agent = new PrintAgent({
  api,
  driverFor: (printer) => {
    if (printer.connection !== 'network_escpos' || !printer.address) {
      throw new Error(
        `Printer ${printer.name}: connection ${printer.connection} is not supported by this agent yet`,
      );
    }
    return new NetworkEscPosDriver(printer.address);
  },
  journal: new PrintJournal(resolve(process.env.JOURNAL_FILE ?? '.journal/print-journal.jsonl')),
  logger,
  appVersion: process.env.AGENT_VERSION ?? '0.0.0',
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 3000),
});

agent.start();
logger.info('agent.started', {});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    agent.stop();
    logger.info('agent.stopped', { signal });
    process.exit(0);
  });
}
