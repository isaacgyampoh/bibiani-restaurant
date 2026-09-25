/**
 * PLATFORM OPERATION: renames a restaurant (shown in the app, on the customer display and printed on
 * receipts). Audited with the old and new name.
 *
 *   PLATFORM_DATABASE_URL=... tsx scripts/platform/rename-restaurant.ts --slug bibiani --name "Chefelisha Restaurant"
 */
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { createPostgresDatabase } from '@rp/infrastructure';

const { values } = parseArgs({ options: { slug: { type: 'string' }, name: { type: 'string' } } });
if (!values.slug || !values.name?.trim()) throw new Error('Usage: --slug <slug> --name <new name>');
const url = process.env.PLATFORM_DATABASE_URL;
if (!url) throw new Error('Missing PLATFORM_DATABASE_URL');
const db = createPostgresDatabase(url, { max: 1 });
try {
  const result = await db.transaction(async (sql) => {
    const [r] = await sql.query<{ id: string; name: string }>(
      'select id, name from restaurants where slug = $1 for update',
      [values.slug],
    );
    if (!r) throw new Error(`No restaurant with slug ${values.slug}`);
    await sql.query('update restaurants set name = $2 where id = $1', [r.id, values.name!.trim()]);
    await sql.query(
      `insert into audit_logs (restaurant_id, action, entity_type, entity_id, before_data, after_data, correlation_id)
       values ($1::uuid, 'platform.restaurant_renamed', 'restaurant', $1::text, $2::text::jsonb, $3::text::jsonb, $4)`,
      [r.id, JSON.stringify({ name: r.name }), JSON.stringify({ name: values.name!.trim() }), randomUUID()],
    );
    return { slug: values.slug, from: r.name, to: values.name!.trim() };
  });
  console.log(JSON.stringify({ renamed: true, ...result }));
} finally {
  await db.close();
}
