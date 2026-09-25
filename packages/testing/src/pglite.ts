import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import type { Database, Sql } from '@rp/infrastructure';

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = resolve(here, '../../../supabase/migrations');

/**
 * Stand-ins for the Supabase-managed schemas the migrations reference. They are
 * NOT a Supabase emulator: they exist so the real migrations and real SQL run
 * unmodified on a real Postgres engine in tests.
 */
const SUPABASE_STUBS = `
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
    $$ insert into realtime.captured_messages (topic, event, payload, private) values (topic, event, payload, private) $$;
`;

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{14}_[a-z0-9_]+\.sql$/.test(f))
    .sort();
}

function wrap(runner: Pick<PGlite, 'query'>): Sql {
  return {
    query: async <T>(text: string, params: readonly unknown[] = []) =>
      (await runner.query<T>(text, params as unknown[])).rows,
  };
}

export interface TestDatabase extends Database {
  target: 'pglite' | 'hosted';
}

/** Hash of stubs + every migration: the template is rebuilt whenever any of them changes. */
function schemaHash(): string {
  const h = createHash('sha256').update(SUPABASE_STUBS);
  for (const file of migrationFiles()) h.update(file).update(readFileSync(join(MIGRATIONS_DIR, file)));
  return h.digest('hex').slice(0, 16);
}

export const TEMPLATE_DIR = resolve(here, '../../../node_modules/.cache/rp-pglite');
const templatePath = () => join(TEMPLATE_DIR, `schema-${schemaHash()}.tar.gz`);

async function migrateFresh(): Promise<PGlite> {
  const pglite = await PGlite.create();
  await pglite.exec(SUPABASE_STUBS);
  for (const file of migrationFiles()) {
    try {
      await pglite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    } catch (error) {
      throw new Error(`Migration ${file} failed: ${(error as Error).message}`);
    }
  }
  return pglite;
}

/**
 * Builds the migrated schema once and stores a snapshot. Every test database is
 * a fresh, independent copy of it (applying 9 migrations per test file is slow).
 */
export async function buildTemplate(): Promise<string> {
  const path = templatePath();
  if (existsSync(path)) return path;
  const pglite = await migrateFresh();
  const dump = await pglite.dumpDataDir('gzip');
  await pglite.close();
  mkdirSync(TEMPLATE_DIR, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, Buffer.from(await dump.arrayBuffer()));
  renameSync(tmp, path);
  return path;
}

export async function createPgliteDatabase(options: { fresh?: boolean } = {}): Promise<TestDatabase> {
  const path = templatePath();
  const pglite =
    !options.fresh && existsSync(path)
      ? await PGlite.create({ loadDataDir: new Blob([readFileSync(path)]) })
      : await migrateFresh();
  const root = wrap(pglite);
  return {
    target: 'pglite',
    query: root.query,
    transaction: (fn) => pglite.transaction((tx) => fn(wrap(tx))),
    close: () => pglite.close(),
  };
}
