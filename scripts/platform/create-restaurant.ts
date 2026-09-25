/**
 * PLATFORM OPERATION: create a new restaurant tenant with its first branch,
 * standard roles and an owner login. Runs with a privileged database login
 * (PLATFORM_DATABASE_URL; in DEV the test admin login) and the server-side
 * auth key. Never exposed through the restaurant-facing API.
 *
 *   pnpm platform:create-restaurant --name "Bibiani Restaurant" --slug bibiani \
 *     --owner-email owner@example.com --owner-name "Owner" [--branch Main --code MAIN --start 5001] \
 *     [--send-password-email https://app.example.com]
 *
 * Production: leave OWNER_PASSWORD unset. The owner login then gets a random password that is never
 * printed or stored, and --send-password-email emails the owner a single-use link to /set-password,
 * so only the owner ever knows their password. (OWNER_PASSWORD is for disposable test tenants.)
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { ROLE_TEMPLATES } from '@rp/domain';
import { createPostgresDatabase, SupabaseAuthDirectory } from '@rp/infrastructure';

const { values } = parseArgs({
  options: {
    name: { type: 'string' },
    slug: { type: 'string' },
    'owner-email': { type: 'string' },
    'owner-name': { type: 'string', default: 'Owner' },
    branch: { type: 'string', default: 'Main' },
    code: { type: 'string', default: 'MAIN' },
    start: { type: 'string', default: '1' },
    currency: { type: 'string', default: 'GHS' },
    'send-password-email': { type: 'string' },
  },
});
const need = (v: string | undefined, what: string) => {
  if (!v) throw new Error(`Missing ${what}`);
  return v;
};
const name = need(values.name, '--name');
const slug = need(values.slug, '--slug');
const ownerEmail = need(values['owner-email'], '--owner-email').toLowerCase();
const ownerPassword = process.env.OWNER_PASSWORD || randomBytes(32).toString('base64url'); // unknown to anyone if unset
const dbUrl = need(
  process.env.PLATFORM_DATABASE_URL ?? process.env.TEST_DATABASE_URL,
  'PLATFORM_DATABASE_URL',
);

const auth = new SupabaseAuthDirectory(
  need(process.env.SUPABASE_URL, 'SUPABASE_URL'),
  need(process.env.SUPABASE_SECRET_KEY, 'SUPABASE_SECRET_KEY'),
  need(process.env.SUPABASE_ANON_KEY, 'SUPABASE_ANON_KEY'),
);
const db = createPostgresDatabase(dbUrl, { max: 1 });
const { id: userId } = await auth.createUser({
  email: ownerEmail,
  password: ownerPassword,
  metadata: { role: 'owner' },
});
try {
  const result = await db.transaction(async (sql) => {
    const restaurantId = randomUUID();
    const branchId = randomUUID();
    await sql.query('insert into restaurants (id, name, slug, currency) values ($1, $2, $3, $4)', [
      restaurantId,
      name,
      slug,
      values.currency,
    ]);
    await sql.query(
      'insert into branches (id, restaurant_id, name, code, order_number_start) values ($1, $2, $3, $4, $5)',
      [branchId, restaurantId, values.branch, values.code, Number(values.start)],
    );
    let ownerRoleId = '';
    for (const [roleName, perms] of Object.entries(ROLE_TEMPLATES)) {
      const roleId = randomUUID();
      if (roleName === 'Owner') ownerRoleId = roleId;
      await sql.query('insert into roles (id, restaurant_id, name, is_system) values ($1, $2, $3, true)', [
        roleId,
        restaurantId,
        roleName,
      ]);
      for (const p of perms) {
        await sql.query(
          'insert into role_permissions (restaurant_id, role_id, permission_code) values ($1, $2, $3)',
          [restaurantId, roleId, p],
        );
      }
    }
    const staffId = randomUUID();
    await sql.query(
      'insert into staff (id, restaurant_id, user_id, display_name, email) values ($1, $2, $3, $4, $5)',
      [staffId, restaurantId, userId, values['owner-name'], ownerEmail],
    );
    // Owner: every branch (null branch scope).
    await sql.query(
      'insert into staff_roles (restaurant_id, staff_id, role_id, branch_id) values ($1, $2, $3, null)',
      [restaurantId, staffId, ownerRoleId],
    );
    await sql.query(
      `insert into audit_logs (restaurant_id, action, entity_type, entity_id, after_data, correlation_id)
       values ($1, 'platform.restaurant_created', 'restaurant', $2, $3::text::jsonb, $4)`,
      [restaurantId, restaurantId, JSON.stringify({ name, slug, ownerEmail }), randomUUID()],
    );
    return { restaurantId, branchId, staffId };
  });
  let passwordEmail: string | undefined;
  const site = values['send-password-email'];
  if (site) {
    // Never throws: the restaurant is already committed; a failed email is resent from the sign-in screen.
    passwordEmail = await fetch(`${process.env.SUPABASE_URL}/auth/v1/recover`, {
      method: 'POST',
      headers: { apikey: process.env.SUPABASE_ANON_KEY!, 'content-type': 'application/json' },
      body: JSON.stringify({ email: ownerEmail, redirect_to: `${site.replace(/\/$/, '')}/set-password` }),
    })
      .then(async (res) => (res.ok ? 'sent' : `failed (${res.status}: ${await res.text()})`))
      .catch((e: unknown) => `failed (${String(e)})`);
  }
  console.log(JSON.stringify({ created: true, ...result, ownerEmail, passwordEmail }));
} catch (error) {
  await auth.deleteUser(userId).catch(() => undefined);
  throw error;
} finally {
  await db.close();
}
