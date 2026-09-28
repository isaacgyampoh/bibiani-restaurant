import type { CustomerRecord, CustomerRepository } from '@rp/application';
import type { CustomerOrderView, CustomerSummaryView } from '@rp/contracts';
import { displayPhone } from '@rp/domain';
import { num, type Sql } from '../db/sql';
import { isoDay, isoOf } from './report-util';

type Row = Record<string, unknown>;
const sn = (v: unknown) => (v ?? null) as string | null;

const mapRecord = (r: Row): CustomerRecord => ({
  id: String(r.id),
  fullName: sn(r.full_name),
  phone: String(r.phone),
  email: sn(r.email),
  notes: sn(r.notes),
  mergedIntoId: sn(r.merged_into_id),
  version: num(r.version),
});

/**
 * Visits and spend come from the orders themselves (never stored twice). A customer's orders are
 * those linked to it or to any record merged into it; cancelled and voided orders are not visits.
 */
const STATS = `
  left join lateral (
    select count(*)::int as orders,
           coalesce(sum(o.paid_total - o.refunded_total), 0)::bigint as spend,
           min(o.business_day)::text as first_visit,
           max(o.business_day)::text as last_visit
      from orders o
     where o.customer_id in (select m.id from customers m where m.id = c.id or m.merged_into_id = c.id)
       and o.status not in ('cancelled', 'voided', 'draft')
  ) st on true`;

const mapSummary = (r: Row): CustomerSummaryView => ({
  id: String(r.id),
  fullName: sn(r.full_name),
  phone: String(r.phone),
  phoneDisplay: displayPhone(String(r.phone)),
  email: sn(r.email),
  orders: num(r.orders),
  totalSpend: num(r.spend),
  firstVisit: sn(r.first_visit),
  lastVisit: sn(r.last_visit),
  createdAt: isoOf(r.created_at)!,
});

export function createCustomerRepository(sql: Sql): CustomerRepository {
  return {
    async currency() {
      const [r] = await sql.query('select currency from restaurants where id = app.current_restaurant_id()');
      return String(r?.currency ?? 'GHS').trim();
    },

    async findByPhone(phone) {
      const [r] = await sql.query('select * from customers where phone = $1 and merged_into_id is null', [
        phone,
      ]);
      return r ? mapRecord(r) : null;
    },

    async find(customerId) {
      const [r] = await sql.query('select * from customers where id = $1', [customerId]);
      return r ? mapRecord(r) : null;
    },

    async insert(c) {
      const rows = await sql.query(
        `insert into customers (id, restaurant_id, full_name, phone, email, notes, created_by_staff_id)
         values ($1, app.current_restaurant_id(), $2, $3, $4, $5, $6)
         on conflict (id) do nothing returning 1`,
        [c.id, c.fullName, c.phone, c.email, c.notes, c.staffId],
      );
      return rows.length > 0;
    },

    async update(customerId, p, expectedVersion) {
      const rows = await sql.query(
        `update customers set full_name = $2, phone = $3, email = $4, notes = $5, updated_at = now(), version = version + 1
          where id = $1 and version = $6 and merged_into_id is null returning 1`,
        [customerId, p.fullName, p.phone, p.email, p.notes, expectedVersion],
      );
      return rows.length > 0;
    },

    async merge(fromId, intoId) {
      await sql.query(
        `update customers set merged_into_id = $2, updated_at = now(), version = version + 1
          where id = $1 or merged_into_id = $1`,
        [fromId, intoId],
      );
    },

    async linkOrder(orderId, customerId, name, phone) {
      await sql.query(
        `update orders set customer_id = $2, customer_name = $3, customer_phone = $4, updated_at = now()
          where id = $1
            and (customer_id is distinct from $2 or customer_name is distinct from $3 or customer_phone is distinct from $4)`,
        [orderId, customerId, name, phone],
      );
    },

    async list({ search, limit, offset }) {
      const q = search?.trim() ?? '';
      const digits = q.replace(/\D/g, '');
      // A number is searched on its digits (so 024..., 24... and +233 24... all match); a name by words.
      const phoneLike = digits.length >= 3 ? `%${digits.replace(/^0/, '')}%` : null;
      const nameLike = q && !/^[\d\s+()-]+$/.test(q) ? `%${q.toLowerCase()}%` : null;
      const where = `c.merged_into_id is null and (
          ($1::text is null and $2::text is null)
          or ($1::text is not null and c.phone like $1)
          or ($2::text is not null and (lower(c.full_name) like $2 or lower(coalesce(c.email, '')) like $2)))`;
      const [rows, total] = await Promise.all([
        sql.query(
          `select c.*, st.* from customers c ${STATS}
            where ${where}
            order by st.last_visit desc nulls last, c.created_at desc
            limit $3 offset $4`,
          [phoneLike, nameLike, limit, offset],
        ),
        sql.query(`select count(*)::int as n from customers c where ${where}`, [phoneLike, nameLike]),
      ]);
      return { customers: rows.map(mapSummary), total: num(total[0]?.n) };
    },

    async detail(customerId) {
      const [c] = await sql.query(`select c.*, st.* from customers c ${STATS} where c.id = $1`, [customerId]);
      if (!c) return null;
      const [from, orders] = await Promise.all([
        sql.query(
          'select id, phone, full_name from customers where merged_into_id = $1 order by created_at',
          [customerId],
        ),
        sql.query(
          `select o.id, o.order_number, o.business_day::text as day, o.channel, o.status, o.grand_total,
                  o.paid_total - o.refunded_total as paid,
                  coalesce((select array_agg(distinct p.method::text) from payments p
                             where p.order_id = o.id and p.status = 'recorded' and p.direction = 'charge'), '{}') as methods,
                  coalesce((select string_agg(i.quantity || '× ' || i.name, ', ' order by i.position)
                              from order_items i where i.order_id = o.id and i.status not in ('cancelled', 'voided')), '') as items
             from orders o
            where o.customer_id in (select m.id from customers m where m.id = $1 or m.merged_into_id = $1)
              and o.status <> 'draft'
            order by o.created_at desc limit 50`,
          [customerId],
        ),
      ]);
      return {
        ...mapSummary(c),
        notes: sn(c.notes),
        updatedAt: isoOf(c.updated_at)!,
        version: num(c.version),
        mergedIntoId: sn(c.merged_into_id),
        mergedFrom: from.map((m) => ({
          id: String(m.id),
          phoneDisplay: displayPhone(String(m.phone)),
          fullName: sn(m.full_name),
        })),
        recentOrders: orders.map(
          (o): CustomerOrderView => ({
            id: String(o.id),
            orderNumber: num(o.order_number),
            businessDay: isoDay(o.day),
            channel: o.channel as CustomerOrderView['channel'],
            status: String(o.status),
            total: num(o.grand_total),
            paid: num(o.paid),
            methods: (o.methods as string[]) ?? [],
            items: String(o.items ?? ''),
          }),
        ),
      };
    },

    async lookup(phone, name, limit) {
      const rows = await sql.query(
        `select c.id, c.full_name, c.phone,
                (select count(*) from orders o where o.customer_id = c.id and o.status not in ('cancelled', 'voided', 'draft'))::int as orders
           from customers c
          where c.merged_into_id is null
            and (c.phone = $1 or ($2::text is not null and lower(c.full_name) like $2))
          order by (c.phone = $1) desc nulls last, c.full_name
          limit $3`,
        [phone, name ? `%${name.toLowerCase()}%` : null, limit],
      );
      return rows.map((r) => ({
        id: String(r.id),
        fullName: sn(r.full_name),
        phone: String(r.phone),
        orders: num(r.orders),
      }));
    },
  };
}
