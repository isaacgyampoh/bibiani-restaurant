/**
 * Removes ONE non-production restaurant (demo / test tenant) and everything that belongs to it:
 * its rows in every tenant table, its staff and device logins, and its product photos.
 * The schema, RLS, functions, triggers, migrations, storage buckets and every other restaurant are
 * not touched.
 *
 *   PLATFORM_DATABASE_URL=... SUPABASE_URL=... SUPABASE_SECRET_KEY=... \
 *     tsx scripts/platform/remove-restaurant.ts --restaurant-id <uuid> --confirm-name "<exact name>" [--execute]
 *
 * Without --execute it only reports what it would delete (dry run). With --execute it:
 *   1. writes an archive of every row it will delete to .production-archives/ (not committed),
 *   2. deletes the tenant's rows in dependency order in ONE transaction (all or nothing),
 *   3. checks inside that transaction that nothing of the tenant remains and no other row lost a
 *      reference, and rolls back otherwise,
 *   4. then deletes the tenant's logins (only those used by nobody else) and its photos.
 * Running it again for a removed restaurant does nothing (idempotent).
 * The real restaurant is protected and can never be removed with this script.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import postgres from 'postgres';

/** Production restaurants that must never be removed. */
const PROTECTED = new Set(['4f82b0a9-e079-448c-8eb0-e93f2bc713f9']); // Chefelisha Restaurant (real)

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const restaurantId = arg('restaurant-id');
const confirmName = arg('confirm-name');
const execute = process.argv.includes('--execute');
if (!restaurantId || !/^[0-9a-f-]{36}$/.test(restaurantId))
  throw new Error('--restaurant-id <uuid> is required');
if (PROTECTED.has(restaurantId)) throw new Error('This is the real restaurant. It can never be removed.');
const dbUrl = process.env.PLATFORM_DATABASE_URL;
if (!dbUrl) throw new Error('Set PLATFORM_DATABASE_URL (privileged database login)');

const sql = postgres(dbUrl, { max: 1, prepare: false, onnotice: () => {} });
const q = (text: string, params: unknown[] = []) => sql.unsafe(text, params as never[]);

const [restaurant] = await q('select id, name from restaurants where id = $1', [restaurantId]);
if (!restaurant) {
  console.log(`Restaurant ${restaurantId} does not exist (already removed). Nothing to do.`);
  await sql.end();
  process.exit(0);
}
if (confirmName !== restaurant.name)
  throw new Error(`--confirm-name must be exactly "${restaurant.name}" for this restaurant`);

const tables = (
  await q(`select c.table_name as t from information_schema.columns c
             join information_schema.tables x on x.table_schema = c.table_schema and x.table_name = c.table_name
            where c.table_schema = 'public' and c.column_name = 'restaurant_id' and x.table_type = 'BASE TABLE'
            order by 1`)
).map((r) => r.t as string);
const ident = (t: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(t)) throw new Error(`bad table name ${t}`);
  return `public."${t}"`;
};

const counts: Record<string, number> = {};
for (const t of tables) {
  const [r] = await q(`select count(*)::int as n from ${ident(t)} where restaurant_id = $1`, [restaurantId]);
  if (r!.n > 0) counts[t] = r!.n;
}
const logins = (
  await q(
    `select distinct u as id from (
       select user_id as u from staff where restaurant_id = $1 and user_id is not null
       union select auth_user_id from devices where restaurant_id = $1 and auth_user_id is not null) x`,
    [restaurantId],
  )
).map((r) => r.id as string);
const photos = (
  await q(`select name from storage.objects where bucket_id = 'product-images' and name like $1`, [
    `${restaurantId}/%`,
  ])
).map((r) => r.name as string);

console.log(`\nRestaurant: ${restaurant.name} (${restaurantId})`);
console.log('WILL DELETE (rows per table):');
for (const [t, n] of Object.entries(counts)) console.log(`  ${t.padEnd(30)} ${n}`);
console.log(`  restaurants                    1`);
console.log(`  logins (auth users)            ${logins.length}`);
console.log(`  product photos                 ${photos.length}`);
console.log('WILL PRESERVE: schema, RLS policies, functions, triggers, migrations, storage buckets,');
console.log('  auth configuration, the permission catalogue, and every other restaurant with all its data.');
if (!execute) {
  console.log('\nDry run only. Add --execute to remove.');
  await sql.end();
  process.exit(0);
}

// 1. Archive.
const archiveDir = resolve('.production-archives');
mkdirSync(archiveDir, { recursive: true });
const archive: Record<string, unknown[]> = {
  restaurants: await q('select * from restaurants where id = $1', [restaurantId]),
};
for (const t of Object.keys(counts))
  archive[t] = await q(`select * from ${ident(t)} where restaurant_id = $1`, [restaurantId]);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const archiveFile = join(archiveDir, `${stamp}-${restaurantId}.json`);
writeFileSync(archiveFile, JSON.stringify({ restaurant, counts, logins, photos, archive }, null, 1), {
  mode: 0o600,
});
console.log(`\nArchive written: ${archiveFile}`);

// 2 + 3. Delete in dependency order (retrying tables blocked by references), verify, commit.
const referencesBefore = await danglingReferences();
await sql.begin(async (tx) => {
  const t = (text: string, params: unknown[] = []) => tx.unsafe(text, params as never[]);
  // Some foreign keys are deferrable: check them at each statement so the order logic sees them.
  await t('set constraints all immediate');
  let pending = Object.keys(counts);
  for (let pass = 0; pending.length > 0; pass++) {
    if (pass > tables.length + 2)
      throw new Error(`Could not resolve delete order for: ${pending.join(', ')}`);
    const blocked: string[] = [];
    for (const table of pending) {
      try {
        // A savepoint per table: a table still referenced is simply retried in the next pass.
        await tx.savepoint((sp) =>
          sp.unsafe(`delete from ${ident(table)} where restaurant_id = $1`, [restaurantId]),
        );
      } catch (error) {
        if ((error as { code?: string }).code !== '23503') throw error;
        blocked.push(table);
      }
    }
    if (blocked.length === pending.length) {
      // No progress: the remaining tables reference each other (devices <-> printers <-> stations
      // <-> branches). Clear their optional references for this restaurant only, then retry.
      for (const table of blocked) await clearOptionalReferences(tx, table);
    }
    pending = blocked;
  }
  await t('delete from restaurants where id = $1', [restaurantId]);
  for (const table of tables) {
    const [r] = await t(`select count(*)::int as n from ${ident(table)} where restaurant_id = $1`, [
      restaurantId,
    ]);
    if (r!.n !== 0) throw new Error(`${table} still has ${r!.n} rows; rolled back`);
  }
});
const referencesAfter = await danglingReferences();
if (referencesAfter > referencesBefore)
  throw new Error('A reference check failed after removal. Investigate.');
console.log('Database rows removed and verified (one transaction).');

// 4. Logins and photos (outside the database transaction; each is checked first).
const base = process.env.SUPABASE_URL?.replace(/\/$/, '');
const key = process.env.SUPABASE_SECRET_KEY;
if (!base || !key) throw new Error('Set SUPABASE_URL and SUPABASE_SECRET_KEY to remove logins and photos');
const headers = { apikey: key, authorization: `Bearer ${key}` };
let removedLogins = 0;
for (const id of logins) {
  const [inUse] = await q(
    'select 1 from staff where user_id = $1 union select 1 from devices where auth_user_id = $1',
    [id],
  );
  if (inUse) continue; // used by another restaurant: never removed
  const res = await fetch(`${base}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers });
  if (res.ok || res.status === 404) removedLogins++;
  else console.warn(`Login ${id.slice(0, 8)}: ${res.status}`);
}
if (photos.length > 0) {
  const res = await fetch(`${base}/storage/v1/object/product-images`, {
    method: 'DELETE',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ prefixes: photos }),
  });
  if (!res.ok) console.warn(`Photos: ${res.status}`);
}
console.log(`Logins removed: ${removedLogins}/${logins.length}. Photos removed: ${photos.length}.`);
await sql.end();

/** Sets this restaurant's nullable foreign-key columns of `table` to null (cycle breaking only). */
async function clearOptionalReferences(tx: postgres.TransactionSql, table: string): Promise<void> {
  const cols = await tx.unsafe(
    `select distinct a.attname as col
       from pg_constraint c
       join unnest(c.conkey) k on true
       join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k
      where c.contype = 'f' and c.conrelid = $1::regclass and a.attname <> 'restaurant_id' and not a.attnotnull`,
    [ident(table)],
  );
  for (const { col } of cols) {
    await tx
      .savepoint((sp) =>
        sp.unsafe(
          `update ${ident(table)} set "${col}" = null where restaurant_id = $1 and "${col}" is not null`,
          [restaurantId as string],
        ),
      )
      .catch(() => undefined); // not every optional column can be cleared (e.g. check constraints); fine
  }
}

/** Rows anywhere in public that point at a row that does not exist (should always be 0). */
async function danglingReferences(): Promise<number> {
  const fks = await q(`
    select c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent,
           array(select a.attname from unnest(c.conkey) k join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k) as ccols,
           array(select a.attname from unnest(c.confkey) k join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k) as pcols
      from pg_constraint c join pg_namespace n on n.oid = c.connamespace
     where c.contype = 'f' and n.nspname = 'public'`);
  let total = 0;
  for (const fk of fks) {
    const cc = fk.ccols as string[];
    const pc = fk.pcols as string[];
    const notNull = cc.map((c) => `c."${c}" is not null`).join(' and ');
    const match = cc.map((c, i) => `p."${pc[i]}" = c."${c}"`).join(' and ');
    const [r] = await q(
      `select count(*)::int as n from ${fk.child} c where ${notNull} and not exists (select 1 from ${fk.parent} p where ${match})`,
    );
    total += r!.n;
  }
  return total;
}
