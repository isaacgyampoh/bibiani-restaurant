import type { ReadModels } from '@rp/application';
import type {
  DashboardView,
  ExpoOrderView,
  ExpoView,
  InventoryView,
  OrderSummaryView,
  SalesReportView,
  StockCountSummaryView,
  StockCountView,
  StockMovementView,
} from '@rp/contracts';
import { balanceDue, isLowStock, stockValue } from '@rp/domain';
import { dateOrNull, num, numOrNull, type Sql } from '../db/sql';
import { iso } from './util';

/** Operations read models: dashboard, expediter board, inventory and stock taking. */
type Row = Record<string, unknown>;
const s = (v: unknown) => v as string;
const sn = (v: unknown) => (v ?? null) as string | null;
const isoOf = (v: unknown) => iso(dateOrNull(v));
const milli = (v: unknown) => Math.round(Number(v) * 1000);
const qty = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const secondsSince = (at: unknown, now: Date) => {
  const d = dateOrNull(at);
  return d ? Math.max(0, Math.round((now.getTime() - d.getTime()) / 1000)) : 0;
};
const OPEN_TICKET = `('new', 'accepted', 'in_preparation', 'on_hold')`;

function summary(o: Row): OrderSummaryView {
  return {
    id: s(o.id),
    orderNumber: num(o.order_number),
    channel: o.channel as OrderSummaryView['channel'],
    isRush: Boolean(o.is_rush),
    areaId: s(o.area_id),
    tableId: sn(o.table_id),
    areaName: s(o.area_name),
    tableLabel: sn(o.table_label),
    customerName: sn(o.customer_name),
    status: o.status as OrderSummaryView['status'],
    paymentStatus: o.payment_status as OrderSummaryView['paymentStatus'],
    grandTotal: num(o.grand_total),
    balanceDue: balanceDue(num(o.grand_total), {
      paidTotal: num(o.paid_total),
      refundedTotal: num(o.refunded_total),
    }),
    version: num(o.version),
    createdAt: isoOf(o.created_at)!,
  };
}

type OpsModels = Pick<
  ReadModels,
  | 'dashboard'
  | 'expo'
  | 'salesReport'
  | 'inventory'
  | 'stockMovements'
  | 'stockCounts'
  | 'stockCount'
  | 'recipe'
>;

export function createOpsReadModels(sql: Sql): OpsModels {
  const countSummaries = async (
    where: string,
    params: unknown[],
  ): Promise<(StockCountSummaryView & { version: number })[]> => {
    const rows = await sql.query(
      `select c.*, sb.display_name as started_by, ab.display_name as approved_by,
              (select count(*) from stock_count_lines l where l.count_id = c.id)::int as lines,
              (select count(*) from stock_count_lines l where l.count_id = c.id and l.counted_quantity is not null)::int as counted,
              (select count(*) from stock_count_lines l where l.count_id = c.id and l.counted_quantity is not null
                 and l.counted_quantity <> l.system_quantity)::int as variances,
              coalesce((select sum(round((l.counted_quantity - l.system_quantity) * i.unit_cost))
                 from stock_count_lines l join inventory_items i on i.id = l.item_id
                 where l.count_id = c.id and l.counted_quantity is not null), 0)::bigint as variance_value
       from stock_counts c
       left join staff sb on sb.id = c.started_by_staff_id
       left join staff ab on ab.id = c.approved_by_staff_id
       where ${where}
       order by c.started_at desc limit 50`,
      params,
    );
    return rows.map((c) => ({
      id: s(c.id),
      status: c.status as StockCountSummaryView['status'],
      note: sn(c.note),
      startedAt: isoOf(c.started_at)!,
      startedBy: sn(c.started_by),
      submittedAt: isoOf(c.submitted_at),
      approvedAt: isoOf(c.approved_at),
      approvedBy: sn(c.approved_by),
      lines: num(c.lines),
      counted: num(c.counted),
      variances: num(c.variances),
      varianceValue: num(c.variance_value),
      version: num(c.version),
    }));
  };

  return {
    async dashboard(branchId, businessDay, now): Promise<DashboardView> {
      const [sales, methods, statuses, tables, stations, stock, recent, currency] = await Promise.all([
        sql.query(
          `select coalesce(sum(case when p.direction = 'charge' then p.amount else -p.amount end), 0)::bigint as net,
                  count(distinct p.order_id)::int as orders,
                  (select coalesce(sum(i.promotion_discount), 0)::bigint from order_items i join orders o2 on o2.id = i.order_id
                    where o2.branch_id = $1 and o2.business_day = $2::date and o2.status not in ('cancelled', 'voided', 'draft')
                      and i.status not in ('pending', 'cancelled', 'voided')) as promo,
                  (select coalesce(sum(i.manual_discount), 0)::bigint from order_items i join orders o2 on o2.id = i.order_id
                    where o2.branch_id = $1 and o2.business_day = $2::date and o2.status not in ('cancelled', 'voided', 'draft')
                      and i.status not in ('pending', 'cancelled', 'voided')) as manual
           from payments p join orders o on o.id = p.order_id
           where o.branch_id = $1 and o.business_day = $2::date and p.status = 'recorded'`,
          [branchId, businessDay],
        ),
        sql.query(
          `select p.method, coalesce(sum(case when p.direction = 'charge' then p.amount else -p.amount end), 0)::bigint as amount,
                  count(*) filter (where p.direction = 'charge')::int as count
           from payments p join orders o on o.id = p.order_id
           where o.branch_id = $1 and o.business_day = $2::date and p.status = 'recorded'
           group by p.method`,
          [branchId, businessDay],
        ),
        sql.query(
          `select status, channel, count(*)::int as n from orders
           where branch_id = $1 and (business_day = $2::date or status not in ('completed', 'cancelled', 'voided', 'draft'))
           group by status, channel`,
          [branchId, businessDay],
        ),
        sql.query(
          `select (select count(*) from dining_tables t where t.branch_id = $1 and t.is_active)::int as total,
                  (select count(distinct o.table_id) from orders o where o.branch_id = $1 and o.table_id is not null
                     and o.status not in ('completed', 'cancelled', 'voided'))::int as occupied`,
          [branchId],
        ),
        sql.query(
          `select st.id, st.name, st.target_prep_seconds,
                  count(t.id) filter (where t.status in ${OPEN_TICKET})::int as open_tickets,
                  count(t.id) filter (where t.status in ${OPEN_TICKET} and st.target_prep_seconds is not null
                    and t.created_at < $2::timestamptz - make_interval(secs => st.target_prep_seconds))::int as delayed,
                  min(t.created_at) filter (where t.status in ${OPEN_TICKET}) as oldest,
                  count(t.id) filter (where t.ready_at is not null and t.ready_at::date >= $3::date)::int as ready_today,
                  avg(extract(epoch from t.ready_at - t.created_at)) filter (where t.ready_at is not null and t.ready_at::date >= $3::date) as avg_prep
           from stations st
           left join production_tickets t on t.station_id = st.id and t.created_at > $2::timestamptz - interval '2 days'
           where st.branch_id = $1 and st.is_active
           group by st.id order by st.sort_order, st.name`,
          [branchId, now.toISOString(), businessDay],
        ),
        sql.query(
          `select (select count(*) from inventory_items i where i.branch_id = $1 and i.is_active and i.quantity > 0 and i.quantity <= i.min_quantity)::int as low,
                  (select count(*) from inventory_items i where i.branch_id = $1 and i.is_active and i.quantity <= 0)::int as out,
                  (select count(*) from stock_counts c where c.branch_id = $1 and c.status in ('open', 'submitted'))::int as counts`,
          [branchId],
        ),
        sql.query(
          `select o.*, a.name as area_name, t.label as table_label
           from orders o join operational_areas a on a.id = o.area_id left join dining_tables t on t.id = o.table_id
           where o.branch_id = $1 and o.status <> 'draft'
           order by o.created_at desc limit 8`,
          [branchId],
        ),
        sql.query(`select currency from restaurants where id = app.current_restaurant_id()`),
      ]);
      const count = (pred: (status: string, channel: string) => boolean) =>
        statuses.filter((r) => pred(s(r.status), s(r.channel))).reduce((n, r) => n + num(r.n), 0);
      const open = (st: string) => !['completed', 'cancelled', 'voided', 'draft'].includes(st);
      const net = num(sales[0]?.net);
      const paidOrders = num(sales[0]?.orders);
      return {
        branchId,
        businessDay,
        currency: s(currency[0]?.currency).trim(),
        sales: {
          net,
          orders: paidOrders,
          averageOrder: paidOrders ? Math.round(net / paidOrders) : 0,
          promotionDiscounts: num(sales[0]?.promo),
          manualDiscounts: num(sales[0]?.manual),
          byMethod: (['cash', 'momo', 'card'] as const).map((method) => {
            const r = methods.find((m) => m.method === method);
            return { method, amount: num(r?.amount ?? 0), count: num(r?.count ?? 0) };
          }),
        },
        orders: {
          open: count((st) => open(st)),
          preparing: count((st) => ['submitted', 'in_preparation', 'partially_ready'].includes(st)),
          ready: count((st) => st === 'ready'),
          awaitingPayment: count((st) => st === 'served' || st === 'picked_up'),
          completed: count((st) => st === 'completed'),
          cancelled: count((st) => st === 'cancelled' || st === 'voided'),
          takeawayOpen: count((st, ch) => open(st) && ch === 'takeaway'),
        },
        tables: { occupied: num(tables[0]?.occupied), total: num(tables[0]?.total) },
        stations: stations.map((st) => ({
          id: s(st.id),
          name: s(st.name),
          openTickets: num(st.open_tickets),
          delayedTickets: num(st.delayed),
          oldestTicketSeconds: st.oldest ? secondsSince(st.oldest, now) : null,
          targetPrepSeconds: numOrNull(st.target_prep_seconds),
          readyToday: num(st.ready_today),
          averagePrepSeconds: st.avg_prep === null ? null : Math.round(Number(st.avg_prep)),
        })),
        inventory: {
          lowStockItems: num(stock[0]?.low),
          outOfStockItems: num(stock[0]?.out),
          openStockCounts: num(stock[0]?.counts),
          recentMovements: [],
        },
        promotions: { live: [], upcoming: [] },
        recentOrders: recent.map(summary),
        generatedAt: now.toISOString(),
      };
    },

    async salesReport(branchId, from, to): Promise<SalesReportView> {
      const range = [branchId, from, to];
      const SOLD = `o.branch_id = $1 and o.business_day between $2::date and $3::date`;
      const LIVE_ITEM = `i.status not in ('pending', 'cancelled', 'voided')`;
      const [pay, methods, days, orders, hours, products, areas, stations, voids, currency] =
        await Promise.all([
          sql.query(
            `select coalesce(sum(case when p.direction = 'charge' then p.amount else -p.amount end), 0)::bigint as net,
                  count(distinct p.order_id)::int as orders
           from payments p join orders o on o.id = p.order_id where ${SOLD} and p.status = 'recorded'`,
            range,
          ),
          sql.query(
            `select p.method, coalesce(sum(case when p.direction = 'charge' then p.amount else -p.amount end), 0)::bigint as amount,
                  count(*) filter (where p.direction = 'charge')::int as count
           from payments p join orders o on o.id = p.order_id where ${SOLD} and p.status = 'recorded' group by p.method`,
            range,
          ),
          sql.query(
            `select o.business_day::text as day,
                  coalesce(sum(case when p.direction = 'charge' then p.amount else -p.amount end), 0)::bigint as net,
                  count(distinct p.order_id)::int as orders
           from payments p join orders o on o.id = p.order_id where ${SOLD} and p.status = 'recorded'
           group by o.business_day order by o.business_day`,
            range,
          ),
          sql.query(
            `select count(*) filter (where o.status in ('cancelled', 'voided'))::int as cancelled from orders o where ${SOLD}`,
            range,
          ),
          sql.query(
            `select extract(hour from coalesce(o.first_submitted_at, o.created_at) at time zone b.timezone)::int as hour,
                  count(*)::int as orders, coalesce(sum(o.grand_total), 0)::bigint as sales
           from orders o join branches b on b.id = o.branch_id
           where ${SOLD} and o.status not in ('cancelled', 'voided', 'draft')
           group by 1 order by 1`,
            range,
          ),
          sql.query(
            `select i.name, c.name as category, sum(i.quantity)::int as quantity, sum(i.line_total)::bigint as sales,
                  sum(i.gross_total)::bigint as gross, sum(i.promotion_discount)::bigint as promo, sum(i.manual_discount)::bigint as manual,
                  coalesce(json_agg(json_build_object('name', i.promotion_name, 'quantity', i.quantity, 'discount', i.promotion_discount))
                    filter (where i.promotion_name is not null), '[]') as promos
           from order_items i join orders o on o.id = i.order_id
           left join products p on p.id = i.product_id left join categories c on c.id = p.category_id
           where ${SOLD} and o.status not in ('cancelled', 'voided') and ${LIVE_ITEM}
           group by i.name, c.name order by sales desc`,
            range,
          ),
          sql.query(
            `select a.name, count(*)::int as orders, coalesce(sum(o.grand_total), 0)::bigint as sales
           from orders o join operational_areas a on a.id = o.area_id
           where ${SOLD} and o.status not in ('cancelled', 'voided', 'draft') group by a.name order by sales desc`,
            range,
          ),
          sql.query(
            `select st.name, count(t.id)::int as tickets,
                  avg(extract(epoch from t.ready_at - t.created_at)) filter (where t.ready_at is not null) as avg_prep
           from production_tickets t join orders o on o.id = t.order_id join stations st on st.id = t.station_id
           where ${SOLD} and t.status <> 'cancelled' group by st.name, st.sort_order order by st.sort_order`,
            range,
          ),
          sql.query(
            `select count(*)::int as n, coalesce(sum(i.line_total), 0)::bigint as value
           from order_items i join orders o on o.id = i.order_id where ${SOLD} and i.status = 'voided'`,
            range,
          ),
          sql.query(`select currency from restaurants where id = app.current_restaurant_id()`),
        ]);
      const net = num(pay[0]?.net);
      const paid = num(pay[0]?.orders);
      const byProduct = products.map((p) => ({
        name: s(p.name),
        category: sn(p.category),
        quantity: num(p.quantity),
        gross: num(p.gross),
        discounts: num(p.promo) + num(p.manual),
        sales: num(p.sales),
        /** Cost of goods is not recorded on order lines yet. */
        cost: null,
      }));
      const promos = new Map<string, { lines: number; quantity: number; discount: number }>();
      for (const p of products)
        for (const x of p.promos as { name: string; quantity: number; discount: unknown }[]) {
          const c = promos.get(x.name) ?? { lines: 0, quantity: 0, discount: 0 };
          promos.set(x.name, {
            lines: c.lines + 1,
            quantity: c.quantity + x.quantity,
            discount: c.discount + num(x.discount),
          });
        }
      const sum = (k: string) => products.reduce((a, p) => a + num(p[k]), 0);
      const cats = new Map<string, { quantity: number; sales: number }>();
      for (const p of byProduct) {
        const k = p.category ?? 'Uncategorised';
        const c = cats.get(k) ?? { quantity: 0, sales: 0 };
        cats.set(k, { quantity: c.quantity + p.quantity, sales: c.sales + p.sales });
      }
      return {
        branchId,
        from,
        to,
        currency: s(currency[0]?.currency).trim(),
        totals: {
          net,
          orders: paid,
          averageOrder: paid ? Math.round(net / paid) : 0,
          itemsSold: byProduct.reduce((n, p) => n + p.quantity, 0),
          cancelledOrders: num(orders[0]?.cancelled),
          voidedItems: num(voids[0]?.n),
          voidedValue: num(voids[0]?.value),
          gross: sum('gross'),
          promotionDiscounts: sum('promo'),
          manualDiscounts: sum('manual'),
          itemSales: sum('sales'),
          cost: null,
        },
        byPromotion: [...promos.entries()]
          .map(([name, v]) => ({ name, ...v }))
          .sort((a, b) => b.discount - a.discount),
        byDay: days.map((d) => ({ day: s(d.day), net: num(d.net), orders: num(d.orders) })),
        byMethod: (['cash', 'momo', 'card'] as const).map((method) => {
          const r = methods.find((m) => m.method === method);
          return { method, amount: num(r?.amount ?? 0), count: num(r?.count ?? 0) };
        }),
        byHour: hours.map((h) => ({ hour: num(h.hour), orders: num(h.orders), sales: num(h.sales) })),
        byProduct,
        byCategory: [...cats.entries()]
          .map(([name, c]) => ({ name, ...c }))
          .sort((a, b) => b.sales - a.sales),
        byArea: areas.map((a) => ({ name: s(a.name), orders: num(a.orders), sales: num(a.sales) })),
        stations: stations.map((st) => ({
          name: s(st.name),
          tickets: num(st.tickets),
          averagePrepSeconds: st.avg_prep === null ? null : Math.round(Number(st.avg_prep)),
        })),
      };
    },

    async expo(branchId, now): Promise<ExpoView> {
      const orders = await sql.query(
        `select o.*, a.name as area_name, t.label as table_label
         from orders o join operational_areas a on a.id = o.area_id left join dining_tables t on t.id = o.table_id
         where o.branch_id = $1 and o.status in ('submitted', 'in_preparation', 'partially_ready', 'ready')
         order by o.is_rush desc, coalesce(o.first_submitted_at, o.created_at)
         limit 60`,
        [branchId],
      );
      if (orders.length === 0) return { branchId, orders: [], generatedAt: now.toISOString() };
      const ids = orders.map((o) => s(o.id));
      const [tickets, items] = await Promise.all([
        sql.query(
          `select t.id, t.order_id, t.station_id, st.name as station_name, st.target_prep_seconds, t.status, t.created_at, t.ready_at
           from production_tickets t join stations st on st.id = t.station_id
           where t.order_id = any($1::uuid[]) and t.status <> 'cancelled'
           order by st.sort_order, st.name, t.created_at`,
          [ids],
        ),
        sql.query(
          `select pti.ticket_id, i.name, i.quantity, i.notes, i.status, i.position,
                  coalesce((select json_agg(m.name) from order_item_modifiers m where m.order_item_id = i.id), '[]') as modifiers
           from production_ticket_items pti join order_items i on i.id = pti.order_item_id
           join production_tickets t on t.id = pti.ticket_id
           where t.order_id = any($1::uuid[]) and i.status not in ('cancelled', 'voided')
           order by i.position`,
          [ids],
        ),
      ]);
      const view = orders.map((o): ExpoOrderView => {
        const own = tickets.filter((t) => t.order_id === o.id);
        const stations = own.map((t) => {
          const elapsed = secondsSince(t.created_at, now);
          const target = numOrNull(t.target_prep_seconds);
          const done = t.status === 'ready' || t.status === 'completed';
          return {
            ticketId: s(t.id),
            stationId: s(t.station_id),
            stationName: s(t.station_name),
            status: t.status as ExpoOrderView['stations'][number]['status'],
            createdAt: isoOf(t.created_at)!,
            readyAt: isoOf(t.ready_at),
            elapsedSeconds: done ? secondsSince(t.created_at, dateOrNull(t.ready_at) ?? now) : elapsed,
            targetPrepSeconds: target,
            delayed: !done && target !== null && elapsed > target,
            items: items
              .filter((i) => i.ticket_id === t.id)
              .map((i) => ({
                name: s(i.name),
                quantity: num(i.quantity),
                modifiers: i.modifiers as string[],
                notes: sn(i.notes),
                status: s(i.status),
              })),
          };
        });
        const ready = stations.filter((st) => st.status === 'ready' || st.status === 'completed').length;
        const late = stations
          .filter((st) => st.delayed)
          .sort(
            (a, b) =>
              b.elapsedSeconds - (b.targetPrepSeconds ?? 0) - (a.elapsedSeconds - (a.targetPrepSeconds ?? 0)),
          );
        const due = balanceDue(num(o.grand_total), {
          paidTotal: num(o.paid_total),
          refundedTotal: num(o.refunded_total),
        });
        return {
          id: s(o.id),
          orderNumber: num(o.order_number),
          channel: o.channel as ExpoOrderView['channel'],
          isRush: Boolean(o.is_rush),
          areaName: s(o.area_name),
          tableLabel: sn(o.table_label),
          customerName: sn(o.customer_name),
          status: o.status as ExpoOrderView['status'],
          paymentStatus: o.payment_status as ExpoOrderView['paymentStatus'],
          grandTotal: num(o.grand_total),
          balanceDue: due,
          firstSubmittedAt: isoOf(o.first_submitted_at),
          elapsedSeconds: secondsSince(o.first_submitted_at ?? o.created_at, now),
          stationsReady: ready,
          stationsTotal: stations.length,
          delayed: late.length > 0,
          holdingStation: late[0]?.stationName ?? null,
          canHandOver: stations.length > 0 && ready === stations.length,
          stations,
        };
      });
      return { branchId, orders: view, generatedAt: now.toISOString() };
    },

    async inventory(branchId): Promise<InventoryView> {
      const [rows, currency] = await Promise.all([
        sql.query(
          `select i.*,
                  (select max(m.created_at) from stock_movements m where m.item_id = i.id) as last_movement_at,
                  coalesce((select json_agg(distinct p.name) from product_recipe_components rc join products p on p.id = rc.product_id
                            where rc.item_id = i.id), '[]') as used_in
           from inventory_items i where i.branch_id = $1
           order by i.is_active desc, i.category nulls last, i.name`,
          [branchId],
        ),
        sql.query(`select currency from restaurants where id = app.current_restaurant_id()`),
      ]);
      const items = rows.map((i) => {
        const q = milli(i.quantity);
        const min = milli(i.min_quantity);
        const cost = num(i.unit_cost);
        return {
          id: s(i.id),
          name: s(i.name),
          sku: sn(i.sku),
          category: sn(i.category),
          unit: s(i.unit),
          quantity: q / 1000,
          minQuantity: min / 1000,
          unitCost: cost,
          value: stockValue(q, cost),
          isLow: Boolean(i.is_active) && isLowStock({ quantity: q, minQuantity: min }),
          isActive: Boolean(i.is_active),
          lastMovementAt: isoOf(i.last_movement_at),
          usedIn: i.used_in as string[],
        };
      });
      const active = items.filter((i) => i.isActive);
      return {
        branchId,
        currency: s(currency[0]?.currency).trim(),
        items,
        totals: {
          items: active.length,
          lowStock: active.filter((i) => i.isLow).length,
          value: active.reduce((n, i) => n + i.value, 0),
        },
      };
    },

    async stockMovements(branchId, itemId, limit): Promise<StockMovementView[]> {
      const rows = await sql.query(
        `select m.*, i.name as item_name, i.unit, st.display_name as staff_name
         from stock_movements m join inventory_items i on i.id = m.item_id left join staff st on st.id = m.staff_id
         where m.branch_id = $1 and ($2::uuid is null or m.item_id = $2)
         order by m.created_at desc limit $3`,
        [branchId, itemId, limit],
      );
      return rows.map((m) => ({
        id: s(m.id),
        itemId: s(m.item_id),
        itemName: s(m.item_name),
        unit: s(m.unit),
        kind: m.kind as StockMovementView['kind'],
        quantityDelta: Number(m.quantity_delta),
        quantityAfter: Number(m.quantity_after),
        unitCost: numOrNull(m.unit_cost),
        reason: sn(m.reason),
        reference: sn(m.reference),
        staffName: sn(m.staff_name),
        createdAt: isoOf(m.created_at)!,
      }));
    },

    async stockCounts(branchId) {
      return (await countSummaries('c.branch_id = $1', [branchId])).map(({ version: _v, ...c }) => c);
    },

    async stockCount(countId): Promise<StockCountView | null> {
      const [head] = await countSummaries('c.id = $1', [countId]);
      if (!head) return null;
      const lines = await sql.query(
        `select l.*, i.name, i.category, i.unit, i.quantity as current_quantity, i.unit_cost
         from stock_count_lines l join inventory_items i on i.id = l.item_id
         where l.count_id = $1 order by i.category nulls last, i.name`,
        [countId],
      );
      return {
        ...head,
        items: lines.map((l) => {
          const counted = qty(l.counted_quantity);
          const system = Number(l.system_quantity);
          const variance = counted === null ? null : Math.round((counted - system) * 1000) / 1000;
          return {
            itemId: s(l.item_id),
            name: s(l.name),
            category: sn(l.category),
            unit: s(l.unit),
            systemQuantity: system,
            currentQuantity: Number(l.current_quantity),
            countedQuantity: counted,
            variance,
            varianceValue: variance === null ? null : Math.round(variance * num(l.unit_cost)),
            reason: sn(l.reason),
          };
        }),
      };
    },

    async recipe(productId) {
      const rows = await sql.query(
        `select rc.item_id, i.name, i.unit, rc.quantity from product_recipe_components rc
         join inventory_items i on i.id = rc.item_id where rc.product_id = $1 order by i.name`,
        [productId],
      );
      return rows.map((r) => ({
        itemId: s(r.item_id),
        name: s(r.name),
        unit: s(r.unit),
        quantity: Number(r.quantity),
      }));
    },
  };
}
