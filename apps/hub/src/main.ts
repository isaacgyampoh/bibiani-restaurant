import { resolve } from 'node:path';
import { fileSecretStore, runHub } from './run';

/**
 * Runs the MY FOOD Hub as a plain Node process (the desktop app runs the same thing).
 * Configuration comes from the environment; see apps/hub/.env.example.
 */
function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required environment variable ${name}. See apps/hub/.env.example.`);
    process.exit(1);
  }
  return v;
}

const log =
  (level: string) =>
  (event: string, fields: Record<string, unknown> = {}) =>
    (level === 'error' ? process.stderr : process.stdout).write(
      `${JSON.stringify({ ts: new Date().toISOString(), level, service: 'hub', event, ...fields })}\n`,
    );

const dataDir = resolve(process.env.HUB_DATA_DIR ?? '.hub-data');
const hub = await runHub({
  dataDir,
  port: Number(process.env.HUB_PORT ?? 8080),
  migrationsDir: resolve(process.env.HUB_MIGRATIONS_DIR ?? '../../supabase/migrations'),
  webDist: resolve(process.env.HUB_WEB_DIST ?? '../web/dist'),
  cloudApiUrl: required('CLOUD_API_URL'),
  supabaseUrl: required('SUPABASE_URL'),
  supabaseAnonKey: required('SUPABASE_ANON_KEY'),
  secrets: fileSecretStore(dataDir),
  logger: { info: log('info'), warn: log('warn'), error: log('error') },
  release: process.env.RELEASE ?? 'hub-local',
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    hub.stop();
    process.exit(0);
  });
}
