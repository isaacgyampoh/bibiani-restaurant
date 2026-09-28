import type { ReportFilter, ReportRepository, ReportRow } from '@rp/application';
import { displayPhone } from '@rp/domain';
import type { Sql } from '../db/sql';

/**
 * Report aggregates. Every figure comes from the same tables the POS, payments and inventory write
 * (orders, order_items with their price / discount / tax snapshots, payments, stock_movements), so
 * reports reconcile with the transactions. Definitions used throughout:
 *   - an order belongs to the business day it was opened on (orders.business_day, branch timezone);
 *   - SOLD order: not draft, cancelled or voided; SOLD line: sent to the kitchen and not cancelled /
 *     voided (pending lines of open orders are not sales yet);
 *   - gross = price x quantity incl. modifiers; net = gross - promotions - manager discounts (the
 *     line total); inclusive tax is inside net, exclusive tax is added on top;
 *   - money received = recorded charges - recorded refunds (voided payment records never count);
 *   - timestamps (stock movements, audit, registers) are placed on the branch's business day using
 *     its timezone and business-day cutoff, never UTC dates.
 */
type Row = Record<string, unknown>;

const SOLD_ORDER = `o.status not in ('cancelled', 'voided', 'draft')`;
const SOLD_LINE = `i.status not in ('pending', 'cancelled', 'voided')`;
const LOCAL_DAY = (col: string) =>
  `((${col} at time zone (select timezone from branches where id = $1)) - (select business_day_cutoff from branches where id = $1)::interval)::date`;
const ROLE = `(select r.name from staff_roles sr join roles r on r.id = sr.role_id where sr.staff_id = st.id
   order by array_position(array['Owner','Manager','Supervisor','Cashier','Waiter','Kitchen'], r.name) nulls last, r.name limit 1)`;
const TAX_LATERAL = `left join lateral (
    select coalesce(sum(t.amount) filter (where t.is_inclusive), 0) as incl,
           coalesce(sum(t.amount) filter (where not t.is_inclusive), 0) as excl,
           count(*) as n
      from order_item_taxes t where t.order_item_id = i.id) tx on true`;

/** Builds parameterised WHERE fragments; $1..$3 are always branch, from, to. */
class Where {
  readonly params: unknown[];
  constructor(readonly f: ReportFilter) {
    this.params = [f.branchId, f.from, f.to];
  }
  p(v: unknown): string {
    this.params.push(v);
    return `$${this.params.length}`;
  }
  /** Orders of the branch in the period, with the order-level filters. `staff`: who the staff filter means. */
  orders(opts: { staff?: 'creator' | 'none'; status?: 'sold' | 'filter' } = {}): string {
    const f = this.f;
    const parts = [`o.branch_id = $1`, `o.business_day between $2::date and $3::date`];
    if (opts.status !== 'filter') parts.push(SOLD_ORDER);
    else if (f.orderStatus === 'completed') parts.push(`o.status = 'completed'`);
    else if (f.orderStatus === 'cancelled') parts.push(`o.status in ('cancelled', 'voided')`);
    else if (f.orderStatus === 'open')
      parts.push(`o.status not in ('completed', 'cancelled', 'voided', 'draft')`);
    else parts.push(`o.status <> 'draft'`);
    if (f.channel) parts.push(`o.channel = ${this.p(f.channel)}::order_channel`);
    if (f.tableId) parts.push(`o.table_id = ${this.p(f.tableId)}::uuid`);
    if (f.staffId && (opts.staff ?? 'creator') === 'creator')
      parts.push(`o.created_by_staff_id = ${this.p(f.staffId)}::uuid`);
    if (f.method)
      parts.push(`exists (select 1 from payments px where px.order_id = o.id and px.status = 'recorded'
        and px.direction = 'charge' and px.method = ${this.p(f.method)}::payment_method)`);
    if (f.deviceId)
      parts.push(`exists (select 1 from payments px where px.order_id = o.id and px.status = 'recorded'
        and px.device_id = ${this.p(f.deviceId)}::uuid)`);
    return parts.join(' and ');
  }
  /** Sold lines, with the product / category filters. Needs `left join products pr on pr.id = i.product_id`. */
  lines(): string {
    const parts = [SOLD_LINE];
    if (this.f.productId) parts.push(`i.product_id = ${this.p(this.f.productId)}::uuid`);
    if (this.f.categoryId) parts.push(`pr.category_id = ${this.p(this.f.categoryId)}::uuid`);
    return parts.join(' and ');
  }
  /** Payment filters (the staff filter means the cashier who recorded the payment). */
  payments(): string {
    const parts = [`p.status = 'recorded'`];
    if (this.f.method) parts.push(`p.method = ${this.p(this.f.method)}::payment_method`);
    if (this.f.deviceId) parts.push(`p.device_id = ${this.p(this.f.deviceId)}::uuid`);
    if (this.f.staffId) parts.push(`p.recorded_by_staff_id = ${this.p(this.f.staffId)}::uuid`);
    return parts.join(' and ');
  }
  localDay(col: string): string {
    return `${LOCAL_DAY(col)} between $2::date and $3::date`;
  }
}

/** Columns that are numbers (drivers return int8 / numeric as strings). Everything else stays text. */
const NUMERIC = new Set(
  `orders items gross promo manual net inclusive_tax exclusive_tax taxed_lines_total untaxed rate_bp lines sales
   taxable tax quantity payments refunds_count refunds voided_count voided amount discounts total cash momo card
   collected orders_sent sends orders_created orders_cancelled bills voids cancellations payment_voids discount_amount
   registers_opened registers_closed voided_items voided_value cancelled_orders cancelled_value issued prints paid
   outstanding unpaid_amount unpaid_orders order_number customers new_customers visiting returning spend
   lifetime_orders opening_cash cash_sales cash_refunds expected_cash counted_cash variance total_net min_quantity
   unit_cost value quantity_delta quantity_before quantity_after movements expected counted variance_value used cost`.split(
    /\s+/,
  ),
);
const clean = (r: Row | undefined): ReportRow => {
  const out: ReportRow = {};
  for (const [k, v] of Object.entries(r ?? {})) {
    if (v === null || v === undefined) out[k] = null;
    else if (v instanceof Date) out[k] = v.toISOString();
    else if (NUMERIC.has(k)) out[k] = Number(v);
    else out[k] = String(v);
  }
  return out;
};

export function createReportRepository(sql: Sql): ReportRepository {
  const rows = async (text: string, params: unknown[]) => (await sql.query(text, params)).map(clean);
  const one = async (text: string, params: unknown[]) => clean((await sql.query(text, params))[0]);

  return {
    async context(branchId) {
      const [r] = await sql.query(
        `select rs.name as restaurant_name, b.name as branch_name, rs.currency, b.timezone,
                to_char(b.business_day_cutoff, 'HH24:MI') as cutoff
           from branches b join restaurants rs on rs.id = b.restaurant_id where b.id = $1`,
        [branchId],
      );
      return r
        ? {
            restaurantName: String(r.restaurant_name),
            branchName: String(r.branch_name),
            currency: String(r.currency).trim(),
            timezone: String(r.timezone),
            cutoff: String(r.cutoff),
          }
        : null;
    },

    async filterOptions(branchId) {
      const [staff, terminals, tables, categories, products] = await Promise.all([
        sql.query(
          `select st.id, st.display_name, ${ROLE} as role from staff st
            where st.is_active or exists (select 1 from orders o where o.created_by_staff_id = st.id)
            order by st.display_name`,
          [],
        ),
        sql.query(`select id, name from devices where branch_id = $1 and kind = 'pos' order by name`, [
          branchId,
        ]),
        sql.query(`select id, label from dining_tables where branch_id = $1 order by length(label), label`, [
          branchId,
        ]),
        sql.query(`select id, name from categories order by sort_order, name`, []),
        sql.query(`select id, name, category_id from products where deleted_at is null order by name`, []),
      ]);
      return {
        staff: staff.map((r) => ({
          id: String(r.id),
          name: String(r.display_name),
          role: (r.role ?? null) as string | null,
        })),
        terminals: terminals.map((r) => ({ id: String(r.id), name: String(r.name) })),
        tables: tables.map((r) => ({ id: String(r.id), label: String(r.label) })),
        categories: categories.map((r) => ({ id: String(r.id), name: String(r.name) })),
        products: products.map((r) => ({
          id: String(r.id),
          name: String(r.name),
          categoryId: String(r.category_id),
        })),
      };
    },

    async salesTotals(f) {
      const w = new Where(f);
      const ord = w.orders();
      const lines = w.lines();
      return one(
        `select count(distinct o.id)::int as orders,
                coalesce(sum(i.quantity), 0)::int as items,
                coalesce(sum(coalesce(i.gross_total, i.line_total)), 0)::bigint as gross,
                coalesce(sum(i.promotion_discount), 0)::bigint as promo,
                coalesce(sum(i.manual_discount), 0)::bigint as manual,
                coalesce(sum(i.line_total), 0)::bigint as net,
                coalesce(sum(tx.incl), 0)::bigint as inclusive_tax,
                coalesce(sum(tx.excl), 0)::bigint as exclusive_tax,
                coalesce(sum(i.line_total) filter (where tx.n > 0), 0)::bigint as taxed_lines_total,
                coalesce(sum(i.line_total) filter (where tx.n = 0), 0)::bigint as untaxed
           from orders o join order_items i on i.order_id = o.id
           left join products pr on pr.id = i.product_id
           ${TAX_LATERAL}
          where ${ord} and ${lines}`,
        w.params,
      );
    },

    async taxBreakdown(f) {
      const w = new Where(f);
      const ord = w.orders();
      const lines = w.lines();
      return rows(
        `select t.name, t.rate_bp, t.is_inclusive,
                count(*)::int as lines,
                coalesce(sum(i.line_total), 0)::bigint as sales,
                coalesce(sum(i.line_total - tx.incl), 0)::bigint as taxable,
                coalesce(sum(t.amount), 0)::bigint as tax
           from order_item_taxes t
           join order_items i on i.id = t.order_item_id
           join orders o on o.id = i.order_id
           left join products pr on pr.id = i.product_id
           ${TAX_LATERAL}
          where ${ord} and ${lines}
          group by t.name, t.rate_bp, t.is_inclusive
          order by t.is_inclusive desc, t.rate_bp desc, t.name`,
        w.params,
      );
    },

    async items(f) {
      const w = new Where(f);
      const ord = w.orders();
      const lines = w.lines();
      return rows(
        `select i.product_id, i.name as item, c.name as category,
                sum(i.quantity)::int as quantity,
                sum(coalesce(i.gross_total, i.line_total))::bigint as gross,
                sum(i.promotion_discount)::bigint as promo,
                sum(i.manual_discount)::bigint as manual,
                sum(i.line_total)::bigint as net,
                sum(tx.incl + tx.excl)::bigint as tax,
                count(distinct o.id)::int as orders
           from orders o join order_items i on i.order_id = o.id
           left join products pr on pr.id = i.product_id
           left join categories c on c.id = pr.category_id
           ${TAX_LATERAL}
          where ${ord} and ${lines}
          group by i.product_id, i.name, c.name
          order by net desc, item`,
        w.params,
      );
    },

    async categories(f) {
      const w = new Where(f);
      const ord = w.orders();
      const lines = w.lines();
      return rows(
        `select coalesce(c.name, 'No category') as category, sum(i.quantity)::int as quantity,
                sum(coalesce(i.gross_total, i.line_total))::bigint as gross,
                sum(i.promotion_discount + i.manual_discount)::bigint as discounts,
                sum(i.line_total)::bigint as net
           from orders o join order_items i on i.order_id = o.id
           left join products pr on pr.id = i.product_id
           left join categories c on c.id = pr.category_id
          where ${ord} and ${lines}
          group by c.name order by net desc`,
        w.params,
      );
    },

    async paymentMethods(f) {
      const w = new Where(f);
      const ord = w.orders({ staff: 'none', status: 'filter' });
      const pay = w.payments();
      return rows(
        `select p.method::text as method,
                count(*) filter (where p.direction = 'charge' and p.status = 'recorded')::int as payments,
                coalesce(sum(p.amount) filter (where p.direction = 'charge' and p.status = 'recorded'), 0)::bigint as gross,
                count(*) filter (where p.direction = 'refund' and p.status = 'recorded')::int as refunds_count,
                coalesce(sum(p.amount) filter (where p.direction = 'refund' and p.status = 'recorded'), 0)::bigint as refunds,
                count(*) filter (where p.status = 'voided')::int as voided_count,
                coalesce(sum(p.amount) filter (where p.status = 'voided'), 0)::bigint as voided,
                count(distinct p.order_id) filter (where p.status = 'recorded')::int as orders
           from payments p join orders o on o.id = p.order_id
          where ${ord} and ${pay.replace(`p.status = 'recorded'`, 'true')}
          group by p.method order by p.method`,
        w.params,
      );
    },

    async splitPayments(f) {
      const w = new Where(f);
      const ord = w.orders({ staff: 'none', status: 'filter' });
      const pay = w.payments();
      return one(
        `select count(*)::int as orders, coalesce(sum(total), 0)::bigint as amount, coalesce(sum(n), 0)::int as payments
           from (select p.order_id, count(*) as n, sum(p.amount) as total
                   from payments p join orders o on o.id = p.order_id
                  where ${ord} and ${pay} and p.direction = 'charge'
                  group by p.order_id having count(*) > 1) x`,
        w.params,
      );
    },

    async serviceTypes(f) {
      const w = new Where(f);
      const ord = w.orders();
      const lines = w.lines();
      return rows(
        `with sold as (
           select o.channel::text as channel, count(distinct o.id)::int as orders,
                  sum(coalesce(i.gross_total, i.line_total))::bigint as gross,
                  sum(i.promotion_discount + i.manual_discount)::bigint as discounts,
                  sum(i.line_total)::bigint as net,
                  sum(tx.incl + tx.excl)::bigint as tax,
                  sum(i.line_total + tx.excl)::bigint as total
             from orders o join order_items i on i.order_id = o.id
             left join products pr on pr.id = i.product_id
             ${TAX_LATERAL}
            where ${ord} and ${lines}
            group by o.channel)
         select c.channel, coalesce(s.orders, 0) as orders, coalesce(s.gross, 0) as gross,
                coalesce(s.discounts, 0) as discounts, coalesce(s.net, 0) as net, coalesce(s.tax, 0) as tax,
                coalesce(s.total, 0) as total
           from unnest(array['dine_in', 'takeaway']) as c(channel) left join sold s on s.channel = c.channel
          order by c.channel`,
        w.params,
      );
    },

    async terminals(f) {
      const w = new Where(f);
      const ord = w.orders({ staff: 'none', status: 'filter' });
      const pay = w.payments();
      return rows(
        `select p.device_id, coalesce(d.name, 'No terminal (signed in without a till)') as terminal,
                count(distinct p.order_id) filter (where p.direction = 'charge')::int as orders,
                count(*) filter (where p.direction = 'charge')::int as payments,
                coalesce(sum(p.amount) filter (where p.direction = 'charge' and p.method = 'cash'), 0)::bigint as cash,
                coalesce(sum(p.amount) filter (where p.direction = 'charge' and p.method = 'momo'), 0)::bigint as momo,
                coalesce(sum(p.amount) filter (where p.direction = 'charge' and p.method = 'card'), 0)::bigint as card,
                coalesce(sum(p.amount) filter (where p.direction = 'charge'), 0)::bigint as gross,
                coalesce(sum(p.amount) filter (where p.direction = 'refund'), 0)::bigint as refunds,
                coalesce(sum(case when p.direction = 'charge' then p.amount else -p.amount end), 0)::bigint as net
           from payments p join orders o on o.id = p.order_id
           left join devices d on d.id = p.device_id
          where ${ord} and ${pay}
          group by p.device_id, d.name
          order by net desc`,
        w.params,
      );
    },

    async staffSales(f) {
      const w = new Where(f);
      const ordSold = w.orders({ staff: 'none' });
      const lines = w.lines();
      const ordAny = w.orders({ staff: 'none', status: 'filter' });
      const pay = `p.status = 'recorded'${f.method ? ` and p.method = ${w.p(f.method)}::payment_method` : ''}`;
      const who = f.staffId ? `where st.id = ${w.p(f.staffId)}::uuid` : '';
      return rows(
        `with taken as (
           select o.created_by_staff_id as sid, count(distinct o.id)::int as orders,
                  sum(i.quantity)::int as items,
                  sum(i.line_total + tx.excl)::bigint as sales,
                  sum(i.promotion_discount + i.manual_discount)::bigint as discounts
             from orders o join order_items i on i.order_id = o.id
             left join products pr on pr.id = i.product_id
             ${TAX_LATERAL}
            where ${ordSold} and ${lines}
            group by 1),
         sent as (
           select s.submitted_by_staff_id as sid, count(distinct s.order_id)::int as orders_sent, count(*)::int as sends
             from order_submissions s join orders o on o.id = s.order_id
            where ${ordAny}
            group by 1),
         collected as (
           select p.recorded_by_staff_id as sid,
                  count(*) filter (where p.direction = 'charge')::int as payments,
                  coalesce(sum(p.amount) filter (where p.direction = 'charge'), 0)::bigint as collected,
                  coalesce(sum(p.amount) filter (where p.direction = 'charge' and p.method = 'cash'), 0)::bigint as cash,
                  coalesce(sum(p.amount) filter (where p.direction = 'refund'), 0)::bigint as refunds
             from payments p join orders o on o.id = p.order_id
            where ${ordAny} and ${pay}
            group by 1),
         ids as (select sid from taken union select sid from sent union select sid from collected)
         select st.id as staff_id, st.display_name as staff, ${ROLE} as role,
                coalesce(t.orders, 0) as orders, coalesce(t.items, 0) as items, coalesce(t.sales, 0) as sales,
                coalesce(t.discounts, 0) as discounts,
                coalesce(s.orders_sent, 0) as orders_sent, coalesce(s.sends, 0) as sends,
                coalesce(c.payments, 0) as payments, coalesce(c.collected, 0) as collected,
                coalesce(c.cash, 0) as cash, coalesce(c.refunds, 0) as refunds
           from ids join staff st on st.id = ids.sid
           left join taken t on t.sid = st.id left join sent s on s.sid = st.id left join collected c on c.sid = st.id
           ${who}
          order by st.display_name`,
        w.params,
      );
    },

    async staffActivity(f) {
      const w = new Where(f);
      const ordAny = w.orders({ staff: 'none', status: 'filter' });
      const auditDay = w.localDay('a.created_at');
      const regDay = w.localDay('r.opened_at');
      const who = f.staffId ? `where st.id = ${w.p(f.staffId)}::uuid` : '';
      return rows(
        `with created as (
           select o.created_by_staff_id as sid, count(*)::int as orders_created,
                  count(*) filter (where o.status in ('cancelled', 'voided'))::int as orders_cancelled
             from orders o where ${ordAny} group by 1),
         sent as (
           select s.submitted_by_staff_id as sid, count(distinct s.order_id)::int as orders_sent
             from order_submissions s join orders o on o.id = s.order_id where ${ordAny} group by 1),
         paid as (
           select p.recorded_by_staff_id as sid,
                  count(*) filter (where p.direction = 'charge' and p.status = 'recorded')::int as payments,
                  coalesce(sum(p.amount) filter (where p.direction = 'charge' and p.status = 'recorded'), 0)::bigint as collected,
                  count(*) filter (where p.direction = 'refund' and p.status = 'recorded')::int as refunds
             from payments p join orders o on o.id = p.order_id where ${ordAny} group by 1),
         audit as (
           select a.actor_staff_id as sid,
                  count(*) filter (where a.action in ('order.bill_issued', 'order.bill_copy'))::int as bills,
                  count(*) filter (where a.action = 'order.void_items')::int as voids,
                  count(*) filter (where a.action = 'order.cancel')::int as cancellations,
                  count(*) filter (where a.action = 'payment.void')::int as payment_voids
             from audit_logs a
            where (a.branch_id = $1 or a.branch_id is null) and ${auditDay} and a.actor_staff_id is not null
            group by 1),
         discounts as (
           select d.applied_by_staff_id as sid, count(*)::int as discounts, coalesce(sum(d.amount), 0)::bigint as discount_amount
             from order_discounts d join orders o on o.id = d.order_id
            where ${ordAny} and d.removed_at is null group by 1),
         registers as (
           select r.cashier_staff_id as sid, count(*)::int as registers_opened,
                  count(*) filter (where r.status = 'closed')::int as registers_closed
             from register_sessions r where r.branch_id = $1 and ${regDay} group by 1),
         ids as (select sid from created union select sid from sent union select sid from paid
                 union select sid from audit union select sid from discounts union select sid from registers)
         select st.id as staff_id, st.display_name as staff, ${ROLE} as role,
                coalesce(c.orders_created, 0) as orders_created, coalesce(s.orders_sent, 0) as orders_sent,
                coalesce(p.payments, 0) as payments, coalesce(p.collected, 0) as collected, coalesce(p.refunds, 0) as refunds,
                coalesce(a.bills, 0) as bills, coalesce(a.voids, 0) as voids,
                coalesce(a.cancellations, 0) as cancellations, coalesce(a.payment_voids, 0) as payment_voids,
                coalesce(d.discounts, 0) as discounts, coalesce(d.discount_amount, 0) as discount_amount,
                coalesce(r.registers_opened, 0) as registers_opened, coalesce(r.registers_closed, 0) as registers_closed
           from ids join staff st on st.id = ids.sid
           left join created c on c.sid = st.id left join sent s on s.sid = st.id left join paid p on p.sid = st.id
           left join audit a on a.sid = st.id left join discounts d on d.sid = st.id left join registers r on r.sid = st.id
           ${who}
          order by st.display_name`,
        w.params,
      );
    },

    async voids(f) {
      const w = new Where(f);
      const ord = w.orders({ status: 'filter' });
      return one(
        `select count(*) filter (where i.status = 'voided')::int as voided_items,
                coalesce(sum(i.line_total) filter (where i.status = 'voided'), 0)::bigint as voided_value,
                count(distinct o.id) filter (where o.status in ('cancelled', 'voided'))::int as cancelled_orders,
                coalesce(sum(i.line_total) filter (where o.status in ('cancelled', 'voided') and i.status in ('cancelled', 'voided')), 0)::bigint as cancelled_value
           from orders o left join order_items i on i.order_id = o.id
          where ${ord}`,
        w.params,
      );
    },

    async bills(f) {
      const w = new Where(f);
      const ord = w.orders({ status: 'filter' });
      return one(
        `select count(*) filter (where o.bill_issued_at is not null)::int as issued,
                coalesce(sum(o.bill_prints), 0)::int as prints,
                count(*) filter (where o.bill_issued_at is not null and o.payment_status <> 'unpaid'
                                   and o.paid_total >= o.grand_total)::int as paid,
                count(*) filter (where o.bill_issued_at is not null and o.status not in ('cancelled', 'voided')
                                   and o.paid_total - o.refunded_total < o.grand_total)::int as outstanding,
                coalesce(sum(o.grand_total - (o.paid_total - o.refunded_total))
                  filter (where o.status not in ('cancelled', 'voided') and o.paid_total - o.refunded_total < o.grand_total), 0)::bigint as unpaid_amount,
                count(*) filter (where o.status not in ('cancelled', 'voided') and o.paid_total - o.refunded_total < o.grand_total)::int as unpaid_orders
           from orders o where ${ord}`,
        w.params,
      );
    },

    async orders(f, limit) {
      const w = new Where(f);
      const ord = w.orders({ status: 'filter' });
      return rows(
        `select o.id, o.order_number, o.business_day::text as business_day_text, o.created_at,
                o.channel::text as channel, a.name as area, dt.label as table_label, o.customer_name,
                cs.display_name as order_staff,
                (select string_agg(distinct coalesce(s.submitted_by_name, ss.display_name), ', ')
                   from order_submissions s left join staff ss on ss.id = s.submitted_by_staff_id
                  where s.order_id = o.id) as sent_by,
                (select string_agg(distinct ps.display_name, ', ') from payments p join staff ps on ps.id = p.recorded_by_staff_id
                  where p.order_id = o.id and p.status = 'recorded' and p.direction = 'charge') as cashier,
                (select string_agg(distinct p.method::text, ', ') from payments p
                  where p.order_id = o.id and p.status = 'recorded' and p.direction = 'charge') as methods,
                o.status::text as status, o.payment_status::text as payment_status,
                o.grand_total as total, (o.paid_total - o.refunded_total) as paid,
                coalesce((select sum(i.promotion_discount + i.manual_discount) from order_items i
                   where i.order_id = o.id and i.status not in ('cancelled', 'voided')), 0)::bigint as discounts
           from orders o
           join operational_areas a on a.id = o.area_id
           left join dining_tables dt on dt.id = o.table_id
           left join staff cs on cs.id = o.created_by_staff_id
          where ${ord}
          order by o.business_day desc, o.order_number desc
          limit ${w.p(limit)}`,
        w.params,
      );
    },

    async customers(f) {
      const w = new Where(f);
      const ord = w.orders({ staff: 'none' });
      const created = w.localDay('c.created_at');
      const totals = await one(
        `select (select count(*) from customers c where c.merged_into_id is null
                   and ${LOCAL_DAY('c.created_at')} <= $3::date)::int as customers,
                (select count(*) from customers c where c.merged_into_id is null and ${created})::int as new_customers,
                count(distinct coalesce(cu.merged_into_id, cu.id))::int as visiting,
                count(distinct coalesce(cu.merged_into_id, cu.id)) filter (where exists (
                  select 1 from orders o2 join customers c2 on c2.id = o2.customer_id
                   where coalesce(c2.merged_into_id, c2.id) = coalesce(cu.merged_into_id, cu.id)
                     and o2.business_day < $2::date and o2.status not in ('cancelled', 'voided', 'draft')))::int as returning,
                count(distinct o.id)::int as orders,
                coalesce(sum(o.paid_total - o.refunded_total), 0)::bigint as spend
           from orders o join customers cu on cu.id = o.customer_id
          where ${ord}`,
        w.params,
      );
      const list = await sql.query(
        `with visits as (
           select coalesce(cu.merged_into_id, cu.id) as root, o.id, o.business_day, o.paid_total - o.refunded_total as paid
             from orders o join customers cu on cu.id = o.customer_id
            where ${ord}),
         lifetime as (
           select coalesce(c3.merged_into_id, c3.id) as root, min(o3.business_day)::text as first_visit_text,
                  count(*)::int as lifetime_orders
             from orders o3 join customers c3 on c3.id = o3.customer_id
            where o3.status not in ('cancelled', 'voided', 'draft')
            group by 1)
         select v.root as id, c.full_name as name, c.phone,
                count(distinct v.id)::int as orders, coalesce(sum(v.paid), 0)::bigint as spend,
                max(v.business_day)::text as last_visit_text, l.first_visit_text, l.lifetime_orders
           from visits v
           join customers c on c.id = v.root
           left join lifetime l on l.root = v.root
          group by v.root, c.full_name, c.phone, l.first_visit_text, l.lifetime_orders
          order by spend desc limit 2000`,
        w.params,
      );
      return {
        totals,
        rows: list.map((r) => clean({ ...r, phone: displayPhone(String(r.phone)) })),
      };
    },

    async registers(f) {
      const w = new Where(f);
      const day = w.localDay('r.opened_at');
      const staff = f.staffId ? ` and r.cashier_staff_id = ${w.p(f.staffId)}::uuid` : '';
      const device = f.deviceId ? ` and r.device_id = ${w.p(f.deviceId)}::uuid` : '';
      return rows(
        `select r.id, r.terminal_name, r.cashier_name, r.status, r.opened_at, r.closed_at, r.opening_cash,
                coalesce(r.cash_sales, live.cash) as cash_sales,
                coalesce(r.cash_refunds, live.cash_refunds) as cash_refunds,
                coalesce(r.expected_cash, r.opening_cash + live.cash - live.cash_refunds) as expected_cash,
                r.counted_cash, r.variance, live.momo, live.card, live.net as total_net
           from register_sessions r
           left join lateral (
             select coalesce(sum(p.amount) filter (where p.method = 'cash' and p.direction = 'charge'), 0)::bigint as cash,
                    coalesce(sum(p.amount) filter (where p.method = 'cash' and p.direction = 'refund'), 0)::bigint as cash_refunds,
                    coalesce(sum(case when p.direction = 'charge' then p.amount else -p.amount end) filter (where p.method = 'momo'), 0)::bigint as momo,
                    coalesce(sum(case when p.direction = 'charge' then p.amount else -p.amount end) filter (where p.method = 'card'), 0)::bigint as card,
                    coalesce(sum(case when p.direction = 'charge' then p.amount else -p.amount end), 0)::bigint as net
               from payments p where p.register_session_id = r.id and p.status = 'recorded') live on true
          where r.branch_id = $1 and ${day}${staff}${device}
          order by r.opened_at`,
        w.params,
      );
    },

    async inventoryValuation(branchId) {
      return rows(
        `select i.name as item, i.category, i.unit, i.quantity, i.min_quantity, i.unit_cost,
                round(greatest(i.quantity, 0) * i.unit_cost)::bigint as value,
                case when i.quantity <= 0 then 'Out of stock' when i.quantity <= i.min_quantity then 'Low' else 'OK' end as stock_status
           from inventory_items i where i.branch_id = $1 and i.is_active
          order by i.category nulls last, i.name`,
        [branchId],
      );
    },

    async movements(f, kinds, limit) {
      const w = new Where(f);
      const day = w.localDay('m.created_at');
      const kind = kinds
        ? ` and m.kind::text = any(${w.p(kinds)}::text[])`
        : f.movementKind
          ? ` and m.kind::text = ${w.p(f.movementKind)}`
          : '';
      const staff = f.staffId ? ` and m.staff_id = ${w.p(f.staffId)}::uuid` : '';
      return rows(
        `select m.created_at, i.name as item, i.unit, m.kind::text as kind, m.quantity_delta,
                (m.quantity_after - m.quantity_delta) as quantity_before, m.quantity_after,
                coalesce(m.unit_cost, i.unit_cost) as unit_cost,
                round(abs(m.quantity_delta) * coalesce(m.unit_cost, i.unit_cost))::bigint as value,
                m.reason, m.reference, st.display_name as staff, o.order_number,
                case when m.stock_count_id is not null then 'Approved stock take'
                     when m.kind = 'adjust' then 'Recorded (inventory manager)' else null end as approval
           from stock_movements m
           join inventory_items i on i.id = m.item_id
           left join staff st on st.id = m.staff_id
           left join orders o on o.id = m.order_id
          where m.branch_id = $1 and ${day}${kind}${staff}
          order by m.created_at desc
          limit ${w.p(limit)}`,
        w.params,
      );
    },

    async movementSummary(f) {
      const w = new Where(f);
      const day = w.localDay('m.created_at');
      return rows(
        `select m.kind::text as kind, count(*)::int as movements,
                coalesce(sum(round(m.quantity_delta * coalesce(m.unit_cost, i.unit_cost))), 0)::bigint as value
           from stock_movements m join inventory_items i on i.id = m.item_id
          where m.branch_id = $1 and ${day}
          group by m.kind order by m.kind`,
        w.params,
      );
    },

    async stockTakes(f) {
      const w = new Where(f);
      const day = w.localDay('coalesce(c.approved_at, c.submitted_at, c.started_at)');
      return rows(
        `select coalesce(c.approved_at, c.submitted_at, c.started_at) as counted_at, c.status::text as status,
                i.name as item, i.unit, l.system_quantity as expected, l.counted_quantity as counted,
                (l.counted_quantity - l.system_quantity) as variance,
                round((l.counted_quantity - l.system_quantity) * i.unit_cost)::bigint as variance_value,
                l.reason, cb.display_name as counted_by, sb.display_name as submitted_by, ab.display_name as approved_by
           from stock_counts c
           join stock_count_lines l on l.count_id = c.id
           join inventory_items i on i.id = l.item_id
           left join staff cb on cb.id = l.counted_by_staff_id
           left join staff sb on sb.id = c.submitted_by_staff_id
           left join staff ab on ab.id = c.approved_by_staff_id
          where c.branch_id = $1 and c.status in ('submitted', 'approved') and ${day} and l.counted_quantity is not null
          order by counted_at desc, i.name`,
        w.params,
      );
    },

    async recipeConsumption(f) {
      const w = new Where(f);
      const ord = w.orders({ staff: 'none', status: 'filter' });
      return rows(
        `select i.name as item, i.unit, -sum(m.quantity_delta) as used,
                round(-sum(m.quantity_delta * coalesce(m.unit_cost, i.unit_cost)))::bigint as cost,
                count(distinct m.order_id)::int as orders
           from stock_movements m
           join inventory_items i on i.id = m.item_id
           join orders o on o.id = m.order_id
          where m.kind::text in ('sale', 'sale_reversal') and ${ord}
          group by i.name, i.unit
          having sum(m.quantity_delta) <> 0
          order by cost desc, i.name`,
        w.params,
      );
    },

    async registerOrders(sessionId) {
      return one(
        `with paid as (select distinct p.order_id from payments p
                        where p.register_session_id = $1 and p.status = 'recorded' and p.direction = 'charge')
         select coalesce(sum(i.promotion_discount + i.manual_discount) filter (where ${SOLD_LINE}), 0)::bigint as discounts,
                coalesce(sum(tx.incl + tx.excl) filter (where ${SOLD_LINE}), 0)::bigint as tax,
                count(*) filter (where i.status = 'voided')::int as voided_items
           from paid join order_items i on i.order_id = paid.order_id
           ${TAX_LATERAL}`,
        [sessionId],
      );
    },
  };
}
