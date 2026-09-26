/**
 * PLATFORM OPERATION: invite a restaurant's real owner by email (owner onboarding).
 * The owner then opens <APP_URL>/welcome, enters this email, verifies it from the emailed link,
 * sets their own password and becomes Owner. Nothing is emailed by this script and no password is
 * created or printed. A previous open invitation for the same email is revoked.
 *
 *   PLATFORM_DATABASE_URL=... pnpm platform:invite-owner --restaurant-id <uuid> --email owner@example.com
 *     [--days 14] [--note "Handover to client"]
 *   pnpm platform:invite-owner --list           (open invitations; emails masked)
 *   pnpm platform:invite-owner --revoke <email>
 */
import { parseArgs } from 'node:util';
import postgres from 'postgres';

const { values } = parseArgs({
  options: {
    'restaurant-id': { type: 'string' },
    email: { type: 'string' },
    days: { type: 'string', default: '14' },
    note: { type: 'string' },
    list: { type: 'boolean', default: false },
    revoke: { type: 'string' },
  },
});
const dbUrl = process.env.PLATFORM_DATABASE_URL;
if (!dbUrl)
  throw new Error('Set PLATFORM_DATABASE_URL (privileged database login for the target environment)');
const sql = postgres(dbUrl, { max: 1, prepare: false });
const mask = (e: string) => e.replace(/^(.).*(@.*)$/, '$1***$2');

try {
  if (values.list) {
    const rows = await sql`select i.email, r.name as restaurant, i.expires_at, i.accepted_at, i.revoked_at
      from owner_invitations i join restaurants r on r.id = i.restaurant_id order by i.created_at desc limit 20`;
    for (const r of rows)
      console.log(
        `${mask(r.email)}  ${r.restaurant}  ${r.accepted_at ? 'ACCEPTED' : r.revoked_at ? 'revoked' : new Date(r.expires_at) < new Date() ? 'expired' : `open until ${new Date(r.expires_at).toISOString().slice(0, 10)}`}`,
      );
  } else if (values.revoke) {
    const n = await sql`update owner_invitations set revoked_at = now()
      where email = ${values.revoke.toLowerCase()} and accepted_at is null and revoked_at is null`;
    console.log(`revoked ${n.count} open invitation(s)`);
  } else {
    const restaurantId = values['restaurant-id'];
    const email = values.email?.trim().toLowerCase();
    if (!restaurantId || !email) throw new Error('Need --restaurant-id and --email (or --list / --revoke)');
    const days = Number(values.days);
    if (!Number.isInteger(days) || days < 1 || days > 60) throw new Error('--days must be 1 to 60');
    const [r] = await sql`select name from restaurants where id = ${restaurantId}`;
    if (!r) throw new Error('No restaurant with that id');
    await sql.begin(async (tx) => {
      await tx`update owner_invitations set revoked_at = now()
        where email = ${email} and accepted_at is null and revoked_at is null`;
      await tx`insert into owner_invitations (restaurant_id, email, note, expires_at)
        values (${restaurantId}, ${email}, ${values.note ?? null}, now() + ${`${days} days`}::interval)`;
      await tx`insert into audit_logs (restaurant_id, action, entity_type, entity_id, after_data)
        values (${restaurantId}, 'owner.invited', 'owner_invitation', ${email}, ${sql.json({ email: mask(email), days })})`;
    });
    console.log(`Invited ${mask(email)} as Owner of "${r.name}" for ${days} days.`);
    console.log('Next: the owner opens <APP_URL>/welcome and enters this email.');
  }
} finally {
  await sql.end();
}
