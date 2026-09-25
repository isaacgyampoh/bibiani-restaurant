/**
 * DEV ONLY: removes restaurants created by the hosted test suites (slug "test-*")
 * and their fixture logins. Refuses to run against any project but DEV.
 *   pnpm dev:cleanup-tests
 */
import { createPostgresDatabase, SupabaseAuthDirectory } from '@rp/infrastructure';

const url = process.env.TEST_DATABASE_URL ?? '';
const ref = process.env.TEST_ALLOWED_PROJECT_REF ?? 'nkijnjovztglmwxoemqg';
if (!url.includes(`.${ref}:`)) throw new Error('Refusing: TEST_DATABASE_URL is not the DEV project');

// Children before parents.
const TABLES = [
  'print_job_attempts',
  'print_jobs',
  'production_ticket_events',
  'production_ticket_items',
  'production_tickets',
  'order_item_taxes',
  'order_item_modifiers',
  'payments',
  'order_events',
  'order_items',
  'order_submissions',
  'orders',
  'order_number_reservations',
  'order_number_counters',
  'device_pairing_codes',
  'device_events',
  'audit_logs',
  'routing_rule_extra_outputs',
  'routing_rules',
  'station_outputs',
  'printers',
  'devices',
  'stations',
  'dining_tables',
  'operational_areas',
  'branch_products',
  'product_modifier_groups',
  'modifiers',
  'modifier_groups',
  'product_taxes',
  'products',
  'tax_rates',
  'categories',
  'staff_roles',
  'staff',
  'role_permissions',
  'roles',
  'branches',
];

const db = createPostgresDatabase(url, { max: 1 });
const auth = new SupabaseAuthDirectory(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!,
  process.env.SUPABASE_ANON_KEY!,
);
const targets = await db.query<{ id: string }>(`select id from restaurants where slug like 'test-%'`);
const ids = targets.map((t) => t.id);
const users = ids.length
  ? await db.query<{ user_id: string }>(
      `select user_id from staff where restaurant_id = any($1::uuid[]) and user_id is not null
       union select auth_user_id from devices where restaurant_id = any($1::uuid[]) and auth_user_id is not null`,
      [ids],
    )
  : [];
if (ids.length) {
  await db.transaction(async (sql) => {
    await sql.query('update printers set backup_printer_id = null where restaurant_id = any($1::uuid[])', [
      ids,
    ]);
    await sql.query('update devices set receipt_printer_id = null where restaurant_id = any($1::uuid[])', [
      ids,
    ]);
    await sql.query('update categories set parent_id = null where restaurant_id = any($1::uuid[])', [ids]);
    for (const table of TABLES)
      await sql.query(`delete from ${table} where restaurant_id = any($1::uuid[])`, [ids]);
    await sql.query('delete from restaurants where id = any($1::uuid[])', [ids]);
  });
}
let deleted = 0;
for (const u of users) {
  await auth.deleteUser(u.user_id).then(
    () => deleted++,
    () => undefined,
  );
}
await db.close();
console.log(JSON.stringify({ restaurantsRemoved: ids.length, loginsRemoved: deleted }));
