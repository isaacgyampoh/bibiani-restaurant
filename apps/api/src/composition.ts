import { createApplication } from '@rp/application';
import {
  createJsonLogger,
  createPostgresDatabase,
  cryptoSecrets,
  JwksTokenVerifier,
  PgIdentityRegistry,
  PgPrincipalResolver,
  PgUnitOfWork,
  randomIds,
  SupabaseAuthDirectory,
  sha256Fingerprinter,
  systemClock,
} from '@rp/infrastructure';
import { createHttpApp } from './http/app';
import { createReadiness } from './http/health';

/** The single place concrete infrastructure is chosen. Used by the Node server and the serverless entry. */
export function compose(env: Record<string, string | undefined> = process.env) {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`Missing required environment variable ${name}. See .env.example.`);
    return value;
  };
  const supabaseUrl = required('SUPABASE_URL');
  const logger = createJsonLogger({
    service: 'api',
    env: env.APP_ENV ?? 'development',
    release: env.RELEASE ?? 'local',
  });
  const db = createPostgresDatabase(required('DATABASE_URL'), { max: Number(env.DB_POOL_MAX ?? 5) });
  const app = createApplication({
    // Secret key used ONLY here, server-side, for creating staff/device logins.
    auth: new SupabaseAuthDirectory(
      supabaseUrl,
      required('SUPABASE_SECRET_KEY'),
      required('SUPABASE_ANON_KEY'),
    ),
    identity: new PgIdentityRegistry(db),
    secrets: cryptoSecrets,
    deviceAccountDomain: env.DEVICE_ACCOUNT_DOMAIN ?? 'devices.example.com',
    uow: new PgUnitOfWork(db, {
      statementTimeoutMs: Number(env.DB_STATEMENT_TIMEOUT_MS ?? 8000),
      lockTimeoutMs: Number(env.DB_LOCK_TIMEOUT_MS ?? 4000),
    }),
    clock: systemClock,
    ids: randomIds,
    fingerprint: sha256Fingerprinter,
    logger,
  });
  const http = createHttpApp({
    app,
    verifier: new JwksTokenVerifier(supabaseUrl),
    resolver: new PgPrincipalResolver(db),
    logger,
    allowedOrigins: (env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    release: env.RELEASE ?? 'local',
    ops: {
      record: async (kind) => {
        await db.query('select app.ops_record($1)', [kind]);
      },
      health: async () => (await db.query<{ h: unknown }>('select app.ops_health() as h'))[0]?.h,
    },
    monitorToken: env.MONITOR_TOKEN,
    readiness: createReadiness({
      db,
      supabaseUrl,
      release: env.RELEASE ?? 'local',
      environment: env.APP_ENV ?? 'development',
    }),
  });
  return { http, db, logger };
}
