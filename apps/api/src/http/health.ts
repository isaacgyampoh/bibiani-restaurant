import type { Database } from '@rp/infrastructure';
import { EXPECTED_SCHEMA_VERSION } from '../schema-version';

export interface ReadinessReport {
  status: 'ready' | 'not_ready';
  environment: string;
  release: string;
  checks: Record<string, { ok: boolean; detail?: unknown; ms: number }>;
}

/**
 * Readiness = can this instance serve restaurant traffic correctly?
 *  - database reachable (as the API login)
 *  - database schema at least the version this build was made for
 *  - Supabase Auth signing keys reachable (token verification)
 *  - Realtime storage ready (reported; NOT a readiness failure, because realtime is only a hint)
 */
export function createReadiness(o: {
  db: Database;
  supabaseUrl: string;
  release: string;
  environment: string;
}) {
  const timed = async <T>(fn: () => Promise<T>) => {
    const t = performance.now();
    try {
      return { value: await fn(), ms: Math.round(performance.now() - t) };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        ms: Math.round(performance.now() - t),
      };
    }
  };
  return async (): Promise<ReadinessReport> => {
    const [db, schema, jwks, realtime] = await Promise.all([
      timed(() => o.db.query('select 1')),
      timed(
        async () =>
          (await o.db.query<{ v: string | null }>('select app.schema_version() as v'))[0]?.v ?? null,
      ),
      timed(async () => {
        const res = await fetch(`${o.supabaseUrl}/auth/v1/.well-known/jwks.json`, {
          signal: AbortSignal.timeout(5000),
        });
        const body = (await res.json()) as { keys?: unknown[] };
        return body.keys?.length ?? 0;
      }),
      timed(
        async () =>
          (await o.db.query<{ ok: boolean | null }>('select app.realtime_storage_ready() as ok'))[0]?.ok ??
          null,
      ),
    ]);
    const checks: ReadinessReport['checks'] = {
      database: { ok: !('error' in db), detail: 'error' in db ? db.error : undefined, ms: db.ms },
      schema: {
        ok:
          'value' in schema &&
          schema.value !== undefined &&
          (schema.value === null || schema.value >= EXPECTED_SCHEMA_VERSION),
        detail:
          'value' in schema ? { database: schema.value, required: EXPECTED_SCHEMA_VERSION } : schema.error,
        ms: schema.ms,
      },
      auth: {
        ok: 'value' in jwks && (jwks.value ?? 0) > 0,
        detail: 'value' in jwks ? { signingKeys: jwks.value } : jwks.error,
        ms: jwks.ms,
      },
      realtime: {
        ok: 'value' in realtime && realtime.value !== false,
        detail:
          'value' in realtime
            ? { storageReadyToday: realtime.value, affectsReadiness: false }
            : realtime.error,
        ms: realtime.ms,
      },
    };
    const ready = checks.database!.ok && checks.schema!.ok && checks.auth!.ok;
    return { status: ready ? 'ready' : 'not_ready', environment: o.environment, release: o.release, checks };
  };
}
