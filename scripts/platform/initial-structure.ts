/**
 * PLATFORM OPERATION: gives a newly created restaurant its starting STRUCTURE (no menu, prices or
 * taxes: the owner enters those). Everything is created through the restaurant-facing admin API, so
 * it is validated, permission-checked and audited exactly like the admin screen.
 *
 * It acts as a temporary "Platform setup" staff member (not as the owner), so the audit trail shows
 * who really made these entries. That login exists only while the script runs: afterwards the staff
 * record is deactivated and its auth user deleted. Nobody else's credentials are used or created.
 *
 *   PLATFORM_DATABASE_URL=... API_URL=https://... tsx --env-file=.env.production \
 *     scripts/platform/initial-structure.ts --slug bibiani [--tables 10]
 *
 * Refuses to run if the restaurant already has operational areas (safe to re-run after a failure
 * only once the partial structure has been reviewed in Admin).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { ApiClient } from '@rp/client-core';
import { createPostgresDatabase, SupabaseAuthDirectory } from '@rp/infrastructure';

const { values } = parseArgs({
  options: { slug: { type: 'string' }, tables: { type: 'string', default: '10' } },
});
const need = (v: string | undefined, what: string) => {
  if (!v) throw new Error(`Missing ${what}`);
  return v;
};
const slug = need(values.slug, '--slug');
const SUPABASE_URL = need(process.env.SUPABASE_URL, 'SUPABASE_URL');
const ANON = need(process.env.SUPABASE_ANON_KEY, 'SUPABASE_ANON_KEY');
const API_URL = need(process.env.API_URL, 'API_URL');
const auth = new SupabaseAuthDirectory(
  SUPABASE_URL,
  need(process.env.SUPABASE_SECRET_KEY, 'SUPABASE_SECRET_KEY'),
  ANON,
);
const db = createPostgresDatabase(need(process.env.PLATFORM_DATABASE_URL, 'PLATFORM_DATABASE_URL'), {
  max: 1,
});

const [restaurant] = await db.query<{ id: string; name: string; areas: number; owner_role: string | null }>(
  `select r.id, r.name,
          (select count(*) from operational_areas a where a.restaurant_id = r.id)::int as areas,
          (select id from roles o where o.restaurant_id = r.id and o.name = 'Owner') as owner_role
     from restaurants r where r.slug = $1`,
  [slug],
);
if (!restaurant) throw new Error(`No restaurant with slug ${slug}`);
if (restaurant.areas > 0) throw new Error(`${restaurant.name} already has areas: review it in Admin instead`);
if (!restaurant.owner_role) throw new Error('Owner role missing');

// Temporary setup identity.
const email = `platform-setup.${randomBytes(4).toString('hex')}@platform.example.com`;
const password = randomBytes(24).toString('base64url');
const { id: userId } = await auth.createUser({ email, password, metadata: { role: 'platform_setup' } });
const staffId = randomUUID();
const summary: Record<string, unknown> = {};
try {
  await db.transaction(async (sql) => {
    await sql.query(
      'insert into staff (id, restaurant_id, user_id, display_name, email) values ($1, $2, $3, $4, $5)',
      [staffId, restaurant.id, userId, 'Platform setup (temporary)', email],
    );
    await sql.query(
      'insert into staff_roles (restaurant_id, staff_id, role_id, branch_id) values ($1, $2, $3, null)',
      [restaurant.id, staffId, restaurant.owner_role],
    );
  });
  const tokenRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const { access_token } = (await tokenRes.json()) as { access_token?: string };
  if (!access_token) throw new Error(`Setup sign-in failed (${tokenRes.status})`);
  const api = new ApiClient({ baseUrl: API_URL, getAccessToken: async () => access_token });
  const me = await api.me();
  const branchId = me.branches[0]!.id;
  const save = async (entity: Parameters<ApiClient['saveConfig']>[0], record: Record<string, unknown>) =>
    (await api.saveConfig(entity, record)).id;

  // Areas: the hall pays after eating; takeaway pays before handover. Owner can change both.
  const hall = await save('area', {
    branchId,
    name: 'Hall',
    channel: 'dine_in',
    requiresTable: true,
    paymentPolicy: 'pay_after_fulfillment',
    sortOrder: 1,
  });
  await save('area', {
    branchId,
    name: 'Takeaway',
    channel: 'takeaway',
    paymentPolicy: 'pay_before_fulfillment',
    sortOrder: 2,
  });
  const tables = Number(values.tables);
  for (let n = 1; n <= tables; n++)
    await save('table', { branchId, areaId: hall, label: String(n), capacity: 4 });

  // Stations, each shown on its own kitchen screen. Printers are added once their LAN addresses are known.
  const kitchen = await save('station', {
    branchId,
    name: 'Kitchen',
    code: 'KIT',
    sortOrder: 1,
    targetPrepSeconds: 900,
  });
  const drinks = await save('station', {
    branchId,
    name: 'Drinks',
    code: 'DRK',
    sortOrder: 2,
    targetPrepSeconds: 300,
  });
  const kitchenKds = await save('device', { branchId, kind: 'kds', name: 'KITCHEN-01', stationId: kitchen });
  const drinksKds = await save('device', { branchId, kind: 'kds', name: 'DRINKS-01', stationId: drinks });
  await save('stationOutput', { stationId: kitchen, deviceId: kitchenKds, role: 'primary' });
  await save('stationOutput', { stationId: drinks, deviceId: drinksKds, role: 'primary' });
  await save('device', { branchId, kind: 'pos', name: 'POS-01' });
  await save('device', { branchId, kind: 'customer_display', name: 'CUSTOMER-DISPLAY-01' });
  await save('device', { branchId, kind: 'print_agent', name: 'PRINT-AGENT-01' });
  // Everything goes to the kitchen until the owner routes categories (e.g. Drinks) elsewhere.
  await save('routingRule', { branchId, match: 'default', stationId: kitchen });

  Object.assign(summary, {
    restaurant: restaurant.name,
    branchId,
    areas: ['Hall (pay after)', 'Takeaway (pay before)'],
    tables,
    stations: ['Kitchen', 'Drinks'],
    devices: ['POS-01', 'KITCHEN-01', 'DRINKS-01', 'CUSTOMER-DISPLAY-01', 'PRINT-AGENT-01'],
    routing: 'default -> Kitchen',
  });
} finally {
  // Remove the temporary identity whatever happened. The staff row stays (deactivated) for the audit trail.
  await db.query('update staff set is_active = false where id = $1', [staffId]).catch(() => undefined);
  await auth.deleteUser(userId).catch((e) => console.error('DELETE THE SETUP USER MANUALLY', userId, e));
  await db
    .query(
      `insert into audit_logs (restaurant_id, action, entity_type, entity_id, after_data, correlation_id)
       values ($1, 'platform.initial_structure', 'restaurant', $2, $3::text::jsonb, $4)`,
      [restaurant.id, restaurant.id, JSON.stringify({ ...summary, setupStaffId: staffId }), randomUUID()],
    )
    .catch(() => undefined);
  await db.close();
}
console.log(JSON.stringify({ configured: true, ...summary }));
