#!/usr/bin/env node
/**
 * MY FOOD reconciliation: a fingerprint of one database, for comparing two restores of the same
 * backup (the restore path is what is under test; production keeps trading, so it is never the
 * comparison target).
 *
 *   node migration-package/scripts/reconcile.mjs <postgres-url>            -> JSON fingerprint
 *   node migration-package/scripts/reconcile.mjs --compare a.json b.json   -> exit 1 on any difference
 *
 * Money is bigint minor units (pesewas) everywhere in this schema; sums are done in SQL as numeric
 * and compared as strings: exact, never floating point. Counts only: no PIN digest, password hash or
 * token value is ever selected into the output (credential tables are fingerprinted by md5 inside the
 * database, and only the digest leaves it).
 *
 * Invariants are business rules that must hold in ANY correct copy. They are reported as counts of
 * violating rows. They are compared between copies like everything else; a non-zero count is also
 * listed under `attention` so it is investigated rather than silently carried over.
 */
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const SCHEMAS = ['public', 'app', 'auth', 'storage', 'supabase_migrations'];

async function fingerprint(url) {
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    await sql`set default_transaction_read_only = on`;
    const tables = await sql`
      select table_schema s, table_name t from information_schema.tables
      where table_type = 'BASE TABLE' and table_schema = any(${SCHEMAS})
      order by 1, 2`;
    const out = { tables: {}, totals: {}, invariants: {}, attention: [] };
    for (const { s, t } of tables) {
      const [r] = await sql.unsafe(
        `select count(*)::bigint as n, coalesce(md5(string_agg(md5(x::text), '' order by md5(x::text))), '') as h
         from "${s}"."${t}" x`,
      );
      out.tables[`${s}.${t}`] = { rows: String(r.n), md5: r.h };
    }
    const one = async (name, text) => {
      out.totals[name] = Object.fromEntries(
        Object.entries((await sql.unsafe(text))[0] ?? {}).map(([k, v]) => [k, v === null ? null : String(v)]),
      );
    };
    await one(
      'orders',
      `select count(*) n, sum(grand_total) grand, sum(subtotal) subtotal, sum(tax_total) tax,
              sum(paid_total) paid, sum(refunded_total) refunded,
              count(*) filter (where status = 'completed') completed,
              count(*) filter (where status in ('cancelled','voided')) cancelled
       from public.orders`,
    );
    await one(
      'payments_recorded',
      `select count(*) n,
              sum(amount) filter (where direction = 'charge') charges,
              sum(amount) filter (where direction = 'refund') refunds,
              sum(amount) filter (where direction = 'charge' and method = 'cash') cash,
              sum(amount) filter (where direction = 'charge' and method = 'momo') momo,
              sum(amount) filter (where direction = 'charge' and method = 'card') card,
              sum(change_amount) change
       from public.payments where status = 'recorded'`,
    );
    await one(
      'payments_voided',
      `select count(*) n, sum(amount) amount from public.payments where status = 'voided'`,
    );
    await one(
      'order_items',
      `select count(*) n, sum(line_total) lines, sum(tax_total) tax,
              count(*) filter (where status = 'voided') voided, count(*) filter (where status = 'cancelled') cancelled
       from public.order_items`,
    );
    await one(
      'registers',
      `select count(*) n, sum(opening_cash) opening, sum(cash_sales) cash_sales, sum(cash_refunds) cash_refunds,
              sum(expected_cash) expected, sum(counted_cash) counted, count(*) filter (where status = 'open') open
       from public.register_sessions`,
    );
    await one(
      'stock',
      `select (select count(*) from public.inventory_items) items,
              (select sum(quantity) from public.inventory_items) quantity,
              (select count(*) from public.stock_movements) movements,
              (select sum(quantity_delta) from public.stock_movements) moved`,
    );
    await one(
      'kitchen',
      `select count(*) n, count(*) filter (where status not in ('completed','cancelled')) open,
              count(*) filter (where accepted_at is not null) accepted
       from public.production_tickets`,
    );
    await one(
      'accounts',
      `select (select count(*) from public.staff) staff, (select count(*) from public.staff where is_active) active,
              (select count(*) from public.staff where pin_lookup is not null) with_pin,
              (select count(*) from auth.users) logins,
              (select count(*) from auth.users where encrypted_password is not null and encrypted_password <> '') with_password,
              (select md5(string_agg(id::text || coalesce(encrypted_password, ''), '' order by id)) from auth.users) login_digest,
              (select count(*) from public.devices where auth_user_id is not null) paired_devices`,
    );
    await one('photos', `select count(*) n, sum((metadata->>'size')::bigint) bytes from storage.objects`);

    const inv = async (name, text) => {
      const n = String((await sql.unsafe(text))[0].n);
      out.invariants[name] = n;
      if (n !== '0') out.attention.push(`${name}: ${n}`);
    };
    // An order's paid/refunded totals equal its recorded (not voided) payments.
    await inv(
      'order_paid_total_mismatch',
      `select count(*) n from public.orders o left join lateral (
         select coalesce(sum(amount) filter (where direction='charge'),0) c, coalesce(sum(amount) filter (where direction='refund'),0) r
         from public.payments p where p.order_id = o.id and p.status = 'recorded') p on true
       where o.paid_total <> p.c or o.refunded_total <> p.r`,
    );
    // Never "paid" with less received than the total.
    await inv(
      'paid_status_underpaid',
      `select count(*) n from public.orders where payment_status = 'paid' and paid_total - refunded_total < grand_total`,
    );
    // Nothing recorded beyond what the order was worth (no double settlement).
    await inv(
      'order_overpaid',
      `select count(*) n from public.orders where paid_total - refunded_total > grand_total`,
    );
    // A refund never exceeds the payment it refunds.
    await inv(
      'refund_exceeds_original',
      `select count(*) n from (select r.refund_of_payment_id, sum(r.amount) s from public.payments r
         where r.direction='refund' and r.status='recorded' group by 1) r join public.payments p on p.id = r.refund_of_payment_id
       where r.s > p.amount`,
    );
    // Each payment id is unique by construction; one request hash per payment.
    await inv(
      'duplicate_payment_requests',
      `select count(*) n from (select order_id, request_hash from public.payments group by 1,2 having count(*) > 1) d`,
    );
    // At most one stock reversal per order and item (no double return).
    await inv(
      'duplicate_stock_reversals',
      `select count(*) n from (select order_id, item_id from public.stock_movements where kind='sale_reversal' group by 1,2 having count(*)>1) d`,
    );
    // Each kitchen print job prints once (dedupe key).
    await inv(
      'duplicate_print_jobs',
      `select count(*) n from (select restaurant_id, dedupe_key from public.print_jobs group by 1,2 having count(*)>1) d`,
    );
    // Order numbers are unique per branch and business day.
    await inv(
      'duplicate_order_numbers',
      `select count(*) n from (select branch_id, business_day, order_number from public.orders group by 1,2,3 having count(*)>1) d`,
    );
    // Order items point at an existing order (referential integrity survived the restore).
    await inv(
      'orphan_order_items',
      `select count(*) n from public.order_items i where not exists (select 1 from public.orders o where o.id = i.order_id)`,
    );
    await inv(
      'orphan_payments',
      `select count(*) n from public.payments p where not exists (select 1 from public.orders o where o.id = p.order_id)`,
    );
    // Every paired device login exists in auth.users (devices can still sign in after the move).
    await inv(
      'device_login_missing',
      `select count(*) n from public.devices d where d.auth_user_id is not null and not exists (select 1 from auth.users u where u.id = d.auth_user_id)`,
    );
    await inv(
      'staff_login_missing',
      `select count(*) n from public.staff s where s.user_id is not null and not exists (select 1 from auth.users u where u.id = s.user_id)`,
    );
    return out;
  } finally {
    await sql.end();
  }
}

function compare(a, b) {
  const diffs = [];
  const keys = new Set([...Object.keys(a.tables), ...Object.keys(b.tables)]);
  for (const k of keys) {
    const x = a.tables[k];
    const y = b.tables[k];
    if (!x || !y) diffs.push(`${k}: present in only one copy`);
    else if (x.rows !== y.rows) diffs.push(`${k}: rows ${x.rows} vs ${y.rows}`);
    else if (x.md5 !== y.md5) diffs.push(`${k}: same row count, different content`);
  }
  for (const section of ['totals', 'invariants'])
    if (JSON.stringify(a[section]) !== JSON.stringify(b[section]))
      for (const k of new Set([...Object.keys(a[section]), ...Object.keys(b[section])]))
        if (JSON.stringify(a[section][k]) !== JSON.stringify(b[section][k]))
          diffs.push(`${section}.${k}: ${JSON.stringify(a[section][k])} vs ${JSON.stringify(b[section][k])}`);
  return diffs;
}

if (process.argv[2] === '--compare') {
  const [a, b] = process.argv.slice(3).map((f) => JSON.parse(readFileSync(f, 'utf8')));
  const diffs = compare(a, b);
  const tables = Object.keys(a.tables).length;
  if (diffs.length) {
    console.error(`RECONCILIATION FAILED: ${diffs.length} difference(s)`);
    for (const d of diffs) console.error(`  ${d}`);
    process.exit(1);
  }
  console.log(
    `RECONCILED: ${tables} tables, every row count and content fingerprint identical; totals and invariants identical.`,
  );
  if (a.attention.length)
    console.log(`Attention (present in the source data, carried over unchanged): ${a.attention.join('; ')}`);
} else {
  const url = process.argv[2];
  if (!url) throw new Error('usage: reconcile.mjs <postgres-url> | --compare a.json b.json');
  console.log(JSON.stringify(await fingerprint(url), null, 1));
}
