import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { Database, Sql } from '@rp/infrastructure';
import { HUB_SCHEMA_SQL } from './hub-schema';
import { LOCAL_AUTH_SQL } from './local-auth';

/**
 * Stand-ins for the Supabase-managed schemas the migrations reference, so the real migrations
 * and repository SQL run unmodified on an embedded Postgres (PGlite). NOT a Supabase emulator.
 * `captureRealtime`: tests record broadcasts; a hub drops them (local screens poll the hub).
 */
export function supabaseStubs(options: { captureRealtime: boolean }): string {
  return `
  create schema if not exists auth;
  create table if not exists auth.users (id uuid primary key, email text);
  create or replace function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  end $$;
  -- Default privileges like a Supabase project, so the lockdown migration is exercised.
  alter default privileges in schema public grant all on tables to anon, authenticated;
  create schema if not exists realtime;
  create table if not exists realtime.captured_messages (
    id bigint generated always as identity primary key,
    topic text not null, event text not null, payload jsonb not null, private boolean not null,
    created_at timestamptz not null default now()
  );
  create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true)
  returns void language sql as
    ${
      options.captureRealtime
        ? `$$ insert into realtime.captured_messages (topic, event, payload, private) values (topic, event, payload, private) $$`
        : `$$ select $$`
    };
`;
}

export function migrationFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => /^\d{14}_[a-z0-9_]+\.sql$/.test(f))
    .sort();
}

export function wrapPglite(runner: Pick<PGlite, 'query'>): Sql {
  return {
    query: async <T>(text: string, params: readonly unknown[] = []) =>
      (await runner.query<T>(text, params as unknown[])).rows,
  };
}

export function pgliteDatabase(pglite: PGlite): Database {
  const root = wrapPglite(pglite);
  return {
    query: root.query,
    transaction: (fn) => pglite.transaction((tx) => fn(wrapPglite(tx))),
    close: () => pglite.close(),
  };
}

/**
 * Opens (or creates) the hub's local database. Migrations are applied incrementally and recorded,
 * so an app update adds only the new ones and never touches existing data. `dataDir` null = in memory.
 */
export async function openLocalDatabase(options: {
  dataDir: string | null;
  migrationsDir: string;
  /** An already-migrated database to start from (tests). */
  pglite?: PGlite;
}): Promise<{ db: Database; pglite: PGlite; applied: string[] }> {
  const pglite = options.pglite ?? (await PGlite.create(options.dataDir ?? undefined));
  await pglite.exec(`
    create schema if not exists hub;
    create table if not exists hub.schema_migrations (name text primary key, applied_at timestamptz not null default now());
  `);
  const done = new Set(
    (await pglite.query<{ name: string }>('select name from hub.schema_migrations')).rows.map((r) => r.name),
  );
  const applied: string[] = [];
  if (done.size === 0) {
    // A fresh database, or one migrated elsewhere (tests): detect by the foundation table.
    const exists = (
      await pglite.query<{ n: number }>(
        `select count(*)::int as n from pg_tables where tablename = 'restaurants'`,
      )
    ).rows[0]!.n;
    if (exists === 0) await pglite.exec(supabaseStubs({ captureRealtime: false }));
    else for (const file of migrationFiles(options.migrationsDir)) done.add(file);
    if (exists > 0)
      for (const name of done)
        await pglite.query('insert into hub.schema_migrations (name) values ($1) on conflict do nothing', [
          name,
        ]);
  }
  for (const file of migrationFiles(options.migrationsDir)) {
    if (done.has(file)) continue;
    try {
      await pglite.transaction(async (tx) => {
        await tx.exec(readFileSync(join(options.migrationsDir, file), 'utf8'));
        await tx.query('insert into hub.schema_migrations (name) values ($1)', [file]);
      });
    } catch (error) {
      throw new Error(`Migration ${file} failed: ${(error as Error).message}`);
    }
    applied.push(file);
  }
  await pglite.exec(HUB_SCHEMA_SQL);
  await pglite.exec(LOCAL_AUTH_SQL);
  return { db: pgliteDatabase(pglite), pglite, applied };
}
