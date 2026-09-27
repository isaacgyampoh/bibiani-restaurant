/**
 * PLATFORM OPERATION: invite a restaurant's real owner by email (owner onboarding).
 * The owner then opens <APP_URL>/welcome, enters this email, verifies it from the emailed link,
 * chooses their own PIN and becomes Owner (their device is registered for PIN sign-in). Nothing is
 * emailed by this script and no password or PIN is created or printed. A previous open invitation
 * for the same email is revoked.
 *
 * --link (only while production email sending is not set up): also prints the single-use
 * verification link that the email would contain (valid 1 hour). Give it to the owner PRIVATELY
 * (in person or a direct message); whoever opens it can finish the owner sign-up. Needs
 * SUPABASE_URL, SUPABASE_SECRET_KEY and APP_URL.
 *
 *   PLATFORM_DATABASE_URL=... pnpm platform:invite-owner --restaurant-id <uuid> --email owner@example.com
 *     [--days 14] [--note "Handover to client"] [--link]
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
    link: { type: 'boolean', default: false },
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
    if (!values.link) {
      console.log('Next: the owner opens <APP_URL>/welcome and enters this email.');
    } else {
      const base = process.env.SUPABASE_URL?.replace(/\/$/, '');
      const key = process.env.SUPABASE_SECRET_KEY;
      const appUrl = process.env.APP_URL?.replace(/\/$/, '') ?? 'https://bibiani-restaurant.vercel.app';
      if (!base || !key) throw new Error('--link needs SUPABASE_URL and SUPABASE_SECRET_KEY');
      const headers = { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' };
      // The owner's login (random password nobody knows), as the welcome screen would create it.
      const created = await fetch(`${base}/auth/v1/admin/users`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          email,
          password: crypto.randomUUID() + crypto.randomUUID(),
          email_confirm: true,
        }),
      });
      if (!created.ok && created.status !== 422)
        throw new Error(`Could not create the login: ${created.status}`);
      const res = await fetch(`${base}/auth/v1/admin/generate_link`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ type: 'recovery', email, redirect_to: `${appUrl}/welcome/verify` }),
      });
      const body = (await res.json()) as { action_link?: string; properties?: { action_link?: string } };
      const link = body.properties?.action_link ?? body.action_link;
      if (!res.ok || !link) throw new Error(`Could not create the link: ${res.status}`);
      console.log(
        '\nSingle-use owner link (valid 1 hour). Give it to the owner privately, never in a group chat:',
      );
      console.log(link);
    }
  }
} finally {
  await sql.end();
}
