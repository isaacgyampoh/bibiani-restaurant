// Applies every migration, in order, to an empty Postgres and reports the result.
// Used by CI ("pnpm db:check") as schema validation.
import { createPgliteDatabase, migrationFiles } from './pglite';

// Always migrate from empty here: this is the CI check that the migration history is reproducible.
const db = await createPgliteDatabase({ fresh: true });
const [tables] = await db.query<{ n: number }>(
  `select count(*)::int as n from pg_tables where schemaname = 'public'`,
);
const withoutRls = await db.query<{ tablename: string }>(
  `select tablename from pg_tables where schemaname = 'public' and not rowsecurity order by 1`,
);
await db.close();
console.log(`Applied ${migrationFiles().length} migrations; ${tables?.n} public tables.`);
if (withoutRls.length > 0) {
  console.error(`Tables without RLS: ${withoutRls.map((t) => t.tablename).join(', ')}`);
  process.exit(1);
}
console.log('Every public table has row level security enabled.');
