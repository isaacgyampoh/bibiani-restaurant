import { createHash } from 'node:crypto';
import type { MenuData, ReadModels } from '@rp/application';
import type {
  ConfigurationView,
  CustomerBoardView,
  FloorView,
  MenuView,
  OperationsView,
  OrderSummaryView,
  OrderView,
  PrintQueueView,
  StationBoardView,
  StationTicketView,
} from '@rp/contracts';
import { balanceDue } from '@rp/domain';
import { dateOrNull, num, numOrNull, type Sql } from '../db/sql';
import { createOpsReadModels } from './read-models-ops';
import { iso } from './util';

type Row = Record<string, unknown>;
const s = (v: unknown) => v as string;
const sn = (v: unknown) => (v ?? null) as string | null;
const isoOf = (v: unknown) => iso(dateOrNull(v));

const CLOSED = `('completed', 'cancelled', 'voided')`;

export function createReadModels(sql: Sql): ReadModels {
  return {
    ...createOpsReadModels(sql),
    async order(orderId): Promise<OrderView | null> {
      const [o] = await sql.query(
        `select o.*, o.business_day::text as business_day_text, a.name as area_name, t.label as table_label, r.currency,
                (select count(*) from print_jobs pj where pj.order_id = o.id and pj.kind = 'receipt')::int as receipts_printed,
                (select json_build_object('id', d.id, 'kind', d.kind, 'value', d.value, 'amount', d.amount,
                   'reason', d.reason, 'originalTotal', d.original_total, 'finalTotal', d.final_total,
                   'appliedBy', st.display_name, 'createdAt', d.created_at)
                 from order_discounts d left join staff st on st.id = d.applied_by_staff_id
                 where d.order_id = o.id and d.removed_at is null) as discount
         from orders o
         join operational_areas a on a.id = o.area_id
         join restaurants r on r.id = o.restaurant_id
         left join dining_tables t on t.id = o.table_id
         where o.id = $1`,
        [orderId],
      );
      if (!o) return null;
      const [items, tickets, jobs, payments] = await Promise.all([
        sql.query(
          `select i.*, pti.ticket_id,
             coalesce((select json_agg(json_build_object('modifierId', m.modifier_id, 'name', m.name, 'priceDelta', m.price_delta) order by m.name)
                       from order_item_modifiers m where m.order_item_id = i.id), '[]'::json) as modifiers
           from order_items i left join production_ticket_items pti on pti.order_item_id = i.id
           where i.order_id = $1 order by i.position`,
          [orderId],
        ),
        sql.query(
          `select t.*, st.name as station_name,
             coalesce((select json_agg(pti.order_item_id order by oi.position) from production_ticket_items pti
                       join order_items oi on oi.id = pti.order_item_id where pti.ticket_id = t.id), '[]'::json) as item_ids
           from production_tickets t join stations st on st.id = t.station_id
           where t.order_id = $1 order by st.sort_order, st.name, t.created_at`,
          [orderId],
        ),
        sql.query(
          `select id, printer_id, status, possible_duplicate, production_ticket_id from print_jobs
           where order_id = $1 order by created_at, copy_no`,
          [orderId],
        ),
        sql.query('select * from payments where order_id = $1 order by created_at, id', [orderId]),
      ]);
      const d = (o.discount ?? null) as Record<string, unknown> | null;
      const paid = num(o.paid_total);
      const refunded = num(o.refunded_total);
      return {
        id: s(o.id),
        branchId: s(o.branch_id),
        areaId: s(o.area_id),
        areaName: s(o.area_name),
        channel: o.channel as OrderView['channel'],
        orderNumber: num(o.order_number),
        businessDay: s(o.business_day_text),
        status: o.status as OrderView['status'],
        paymentStatus: o.payment_status as OrderView['paymentStatus'],
        table: o.table_id ? { id: s(o.table_id), label: s(o.table_label) } : null,
        customerName: sn(o.customer_name),
        customerPhone: sn(o.customer_phone),
        notes: sn(o.notes),
        currency: s(o.currency).trim(),
        subtotal: num(o.subtotal),
        taxTotal: num(o.tax_total),
        grandTotal: num(o.grand_total),
        paidTotal: paid,
        refundedTotal: refunded,
        balanceDue: balanceDue(num(o.grand_total), { paidTotal: paid, refundedTotal: refunded }),
        version: num(o.version),
        createdAt: isoOf(o.created_at)!,
        firstSubmittedAt: isoOf(o.first_submitted_at),
        readyAt: isoOf(o.ready_at),
        fulfilledAt: isoOf(o.fulfilled_at),
        completedAt: isoOf(o.completed_at),
        isRush: Boolean(o.is_rush),
        mergedIntoOrderId: sn(o.merged_into_order_id),
        receiptsPrinted: num(o.receipts_printed),
        discount: d
          ? {
              id: s(d.id),
              kind: d.kind as 'amount' | 'percent',
              value: num(d.value),
              amount: num(d.amount),
              reason: s(d.reason),
              originalTotal: num(d.originalTotal),
              finalTotal: num(d.finalTotal),
              appliedBy: sn(d.appliedBy),
              createdAt: isoOf(d.createdAt)!,
            }
          : null,
        items: items.map((i) => ({
          id: s(i.id),
          productId: s(i.product_id),
          name: s(i.name),
          quantity: num(i.quantity),
          unitPrice: num(i.unit_price),
          modifiers: (i.modifiers as { modifierId: string; name: string; priceDelta: unknown }[]).map(
            (m) => ({
              ...m,
              priceDelta: num(m.priceDelta),
            }),
          ),
          grossTotal: num(i.gross_total),
          promotion: i.promotion_name
            ? { id: sn(i.promotion_id), name: s(i.promotion_name), discount: num(i.promotion_discount) }
            : null,
          manualDiscount: num(i.manual_discount),
          lineTotal: num(i.line_total),
          taxTotal: num(i.tax_total),
          notes: sn(i.notes),
          status: i.status as OrderView['items'][number]['status'],
          stationId: sn(i.station_id),
          ticketId: sn(i.ticket_id),
        })),
        tickets: tickets.map((t) => ({
          id: s(t.id),
          stationId: s(t.station_id),
          stationName: s(t.station_name),
          submissionId: s(t.submission_id),
          status: t.status as OrderView['tickets'][number]['status'],
          version: num(t.version),
          itemIds: t.item_ids as string[],
          createdAt: isoOf(t.created_at)!,
          readyAt: isoOf(t.ready_at),
          printJobs: jobs
            .filter((j) => j.production_ticket_id === t.id)
            .map((j) => ({
              id: s(j.id),
              printerId: s(j.printer_id),
              status: j.status as OrderView['tickets'][number]['printJobs'][number]['status'],
              possibleDuplicate: Boolean(j.possible_duplicate),
            })),
        })),
        payments: payments.map((p) => ({
          id: s(p.id),
          direction: p.direction as OrderView['payments'][number]['direction'],
          refundOfPaymentId: sn(p.refund_of_payment_id),
          method: p.method as OrderView['payments'][number]['method'],
          amount: num(p.amount),
          tenderedAmount: numOrNull(p.tendered_amount),
          changeAmount: num(p.change_amount),
          reference: sn(p.reference),
          status: p.status as OrderView['payments'][number]['status'],
          createdAt: isoOf(p.created_at)!,
        })),
      };
    },

    async activeOrders(branchId): Promise<OrderSummaryView[]> {
      const rows = await sql.query(
        `select o.*, a.name as area_name, t.label as table_label
         from orders o join operational_areas a on a.id = o.area_id left join dining_tables t on t.id = o.table_id
         where o.branch_id = $1 and o.status not in ${CLOSED}
         order by o.created_at`,
        [branchId],
      );
      return rows.map((o) => ({
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
      }));
    },

    async recentClosedOrders(branchId): Promise<OrderSummaryView[]> {
      const rows = await sql.query(
        `select o.*, a.name as area_name, t.label as table_label
         from orders o join operational_areas a on a.id = o.area_id left join dining_tables t on t.id = o.table_id
         where o.branch_id = $1 and o.status in ${CLOSED}
           and o.business_day >= (select max(business_day) from orders where branch_id = $1) - 1
         order by coalesce(o.completed_at, o.cancelled_at, o.updated_at) desc
         limit 100`,
        [branchId],
      );
      return rows.map((o) => ({
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
      }));
    },

    async stationBoard(stationId): Promise<StationBoardView | null> {
      const [station] = await sql.query(
        `select s.id, s.name, s.branch_id, s.target_prep_seconds, s.show_prices, r.currency
         from stations s join restaurants r on r.id = s.restaurant_id where s.id = $1`,
        [stationId],
      );
      if (!station) return null;
      const [tickets, items, alerts] = await Promise.all([
        sql.query(
          `select t.*, o.channel, o.customer_name, o.notes as order_notes, o.is_rush, a.name as area_name, dt.label as table_label
           from production_tickets t
           join orders o on o.id = t.order_id
           join operational_areas a on a.id = o.area_id
           left join dining_tables dt on dt.id = o.table_id
           where t.station_id = $1 and t.status not in ('completed', 'cancelled')
           order by o.is_rush desc, t.created_at, t.id`,
          [stationId],
        ),
        sql.query(
          `select pti.ticket_id, i.id, i.quantity, coalesce(i.kitchen_name, i.name) as name, i.notes, i.status, i.line_total,
                  i.unit_price, i.gross_total, i.promotion_name, i.promotion_discount, i.manual_discount,
             coalesce((select json_agg(m.name order by m.name) from order_item_modifiers m where m.order_item_id = i.id), '[]'::json) as modifiers
           from production_ticket_items pti
           join production_tickets t on t.id = pti.ticket_id
           join order_items i on i.id = pti.order_item_id
           where t.station_id = $1 and t.status not in ('completed', 'cancelled')
           order by i.position`,
          [stationId],
        ),
        sql.query(
          `select p.device_id as printer_id, d.name as printer_name, p.last_error,
             count(j.id) filter (where j.status = 'failed') as failed_jobs,
             count(j.id) filter (where j.status = 'dead') as dead_jobs
           from station_outputs so
           join printers p on p.device_id = so.device_id
           join devices d on d.id = p.device_id
           left join print_jobs j on j.printer_id = p.device_id and j.status in ('failed', 'dead')
           where so.station_id = $1
           group by p.device_id, d.name, p.last_error`,
          [stationId],
        ),
      ]);
      return {
        station: {
          id: s(station.id),
          name: s(station.name),
          branchId: s(station.branch_id),
          targetPrepSeconds: numOrNull(station.target_prep_seconds),
          showPrices: Boolean(station.show_prices),
          currency: s(station.currency).trim(),
        },
        tickets: tickets.map(
          (t): StationTicketView => ({
            id: s(t.id),
            orderId: s(t.order_id),
            orderNumber: num(t.order_number),
            channel: t.channel as StationTicketView['channel'],
            areaName: s(t.area_name),
            tableLabel: sn(t.table_label),
            customerName: sn(t.customer_name),
            orderNotes: sn(t.order_notes),
            status: t.status as StationTicketView['status'],
            version: num(t.version),
            createdAt: isoOf(t.created_at)!,
            startedAt: isoOf(t.started_at),
            readyAt: isoOf(t.ready_at),
            isRush: Boolean(t.is_rush),
            items: items
              .filter((i) => i.ticket_id === t.id)
              .map((i) => ({
                id: s(i.id),
                quantity: num(i.quantity),
                name: s(i.name),
                modifiers: i.modifiers as string[],
                notes: sn(i.notes),
                status: i.status as StationTicketView['items'][number]['status'],
                ...(station.show_prices
                  ? {
                      unitPrice: num(i.unit_price),
                      grossTotal: num(i.gross_total),
                      promotionName: sn(i.promotion_name),
                      promotionDiscount: num(i.promotion_discount),
                      manualDiscount: num(i.manual_discount),
                      lineTotal: num(i.line_total),
                    }
                  : {
                      unitPrice: null,
                      grossTotal: null,
                      promotionName: null,
                      promotionDiscount: null,
                      manualDiscount: null,
                      lineTotal: null,
                    }),
              })),
          }),
        ),
        printerAlerts: alerts
          .filter((a) => num(a.failed_jobs) > 0 || num(a.dead_jobs) > 0 || a.last_error)
          .map((a) => ({
            printerId: s(a.printer_id),
            printerName: s(a.printer_name),
            failedJobs: num(a.failed_jobs),
            deadJobs: num(a.dead_jobs),
            lastError: sn(a.last_error),
          })),
        generatedAt: new Date().toISOString(),
      };
    },

    async customerBoard(branchId, now): Promise<CustomerBoardView> {
      const rows = await sql.query(
        `select o.order_number, o.channel, o.status
         from orders o join operational_areas a on a.id = o.area_id
         where o.branch_id = $1 and a.show_on_customer_display
           and o.status in ('submitted', 'in_preparation', 'partially_ready', 'ready')
           and o.created_at > $2::timestamptz - interval '12 hours'
         order by o.order_number`,
        [branchId, now.toISOString()],
      );
      const toEntry = (r: Row) => ({
        orderNumber: num(r.order_number),
        channel: r.channel as CustomerBoardView['ready'][number]['channel'],
      });
      return {
        preparing: rows.filter((r) => r.status !== 'ready').map(toEntry),
        ready: rows.filter((r) => r.status === 'ready').map(toEntry),
        generatedAt: now.toISOString(),
      };
    },

    async menu(branchId): Promise<MenuData> {
      const [areas, categories, products, groups, modifiers, currency] = await Promise.all([
        sql.query(
          `select * from operational_areas where branch_id = $1 and is_active order by sort_order, name`,
          [branchId],
        ),
        sql.query(
          `select id, name, parent_id, sort_order from categories where is_active order by sort_order, name`,
        ),
        sql.query(
          `select p.id, p.category_id, p.name, p.image_path, coalesce(bp.price_override, p.base_price) as price,
                  (p.is_active and p.deleted_at is null and coalesce(bp.is_available, true)) as is_available
           from products p left join branch_products bp on bp.product_id = p.id and bp.branch_id = $1
           where p.deleted_at is null and p.is_active order by p.name`,
          [branchId],
        ),
        sql.query(
          `select pmg.product_id, g.id, g.name, g.min_select, g.max_select from product_modifier_groups pmg
           join modifier_groups g on g.id = pmg.group_id order by pmg.sort_order`,
        ),
        sql.query(
          `select id, group_id, name, price_delta from modifiers where is_active order by sort_order, name`,
        ),
        sql.query(`select currency from restaurants where id = app.current_restaurant_id()`),
      ]);
      const body = {
        branchId,
        currency: s(currency[0]?.currency ?? 'GHS').trim(),
        areas: areas.map((a) => ({
          id: s(a.id),
          name: s(a.name),
          channel: a.channel as 'dine_in' | 'takeaway',
          requiresTable: Boolean(a.requires_table),
          requiresCustomerName: Boolean(a.requires_customer_name),
          paymentPolicy: a.payment_policy as 'pay_after_fulfillment',
          requirePaymentBeforeProduction: Boolean(a.require_payment_before_production),
        })),
        categories: categories.map((c) => ({
          id: s(c.id),
          name: s(c.name),
          parentId: sn(c.parent_id),
          sortOrder: num(c.sort_order),
        })),
        products: products.map((p) => ({
          id: s(p.id),
          categoryId: s(p.category_id),
          name: s(p.name),
          price: num(p.price),
          imagePath: sn(p.image_path),
          promotion: null,
          isAvailable: Boolean(p.is_available),
          modifierGroups: groups
            .filter((g) => g.product_id === p.id)
            .map((g) => ({
              id: s(g.id),
              name: s(g.name),
              minSelect: num(g.min_select),
              maxSelect: numOrNull(g.max_select),
              modifiers: modifiers
                .filter((m) => m.group_id === g.id)
                .map((m) => ({ id: s(m.id), name: s(m.name), priceDelta: num(m.price_delta) })),
            })),
        })),
      };
      // Content hash lets the POS cache the menu and refetch only when it changed.
      const version = createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16);
      return { ...body, version };
    },

    async floor(branchId, now): Promise<FloorView> {
      const [areas, tables] = await Promise.all([
        sql.query(
          `select id, name from operational_areas where branch_id = $1 and requires_table and is_active order by sort_order, name`,
          [branchId],
        ),
        sql.query(
          `select t.id, t.area_id, t.label, t.capacity, t.status as table_status,
                  o.id as order_id, o.order_number, o.status, o.payment_status, o.grand_total, o.paid_total, o.refunded_total, o.created_at
           from dining_tables t
           left join orders o on o.table_id = t.id and o.status not in ('completed', 'cancelled', 'voided')
           where t.branch_id = $1 and t.is_active
           order by length(t.label), t.label`,
          [branchId],
        ),
      ]);
      return {
        branchId,
        areas: areas.map((a) => ({ id: s(a.id), name: s(a.name) })),
        tables: tables.map((t) => {
          const order = t.order_id
            ? {
                id: s(t.order_id),
                orderNumber: num(t.order_number),
                status: s(t.status),
                paymentStatus: s(t.payment_status),
                grandTotal: num(t.grand_total),
                balanceDue: balanceDue(num(t.grand_total), {
                  paidTotal: num(t.paid_total),
                  refundedTotal: num(t.refunded_total),
                }),
                openedAt: isoOf(t.created_at)!,
              }
            : null;
          let state: FloorView['tables'][number]['state'];
          if (!order) {
            const ts = s(t.table_status);
            state = ts === 'cleaning' || ts === 'reserved' || ts === 'out_of_service' ? ts : 'available';
          } else if (order.status === 'ready' || order.status === 'partially_ready') state = 'ready_to_serve';
          else if (order.status === 'served') state = 'awaiting_payment';
          else state = 'occupied';
          return {
            id: s(t.id),
            areaId: s(t.area_id),
            label: s(t.label),
            capacity: num(t.capacity),
            state,
            order,
          };
        }),
        generatedAt: now.toISOString(),
      };
    },

    async operations(branchId, now): Promise<OperationsView> {
      const rows = await sql.query(
        `select d.id, d.name, d.kind, d.station_id, d.is_active, d.auth_user_id is not null as paired, d.last_heartbeat_at, d.app_version,
                pr.address, pr.agent_device_id, pr.last_error, pr.last_status_at,
                (select count(*) from print_jobs j where j.printer_id = d.id and j.status = 'failed')::int as failed_jobs,
                (select count(*) from print_jobs j where j.printer_id = d.id and j.status = 'dead')::int as dead_jobs,
                agent.last_heartbeat_at as agent_heartbeat_at
         from devices d
         left join printers pr on pr.device_id = d.id
         left join devices agent on agent.id = pr.agent_device_id
         where d.branch_id = $1
         order by d.kind, d.name`,
        [branchId],
      );
      const alive = (at: unknown) => {
        const d = dateOrNull(at);
        return d !== null && now.getTime() - d.getTime() <= 90_000;
      };
      return {
        branchId,
        devices: rows.map((d) => {
          const isPrinter = d.kind === 'printer';
          // A printer has no heartbeat of its own: it is "online" when its agent is alive and the last probe/print succeeded.
          const seenAt = isPrinter ? (dateOrNull(d.last_status_at) ?? null) : dateOrNull(d.last_heartbeat_at);
          const online = isPrinter
            ? alive(d.agent_heartbeat_at) && !d.last_error && d.last_status_at !== null
            : alive(d.last_heartbeat_at);
          return {
            id: s(d.id),
            name: s(d.name),
            kind: s(d.kind),
            stationId: sn(d.station_id),
            isActive: Boolean(d.is_active),
            paired: Boolean(d.paired),
            status: seenAt === null ? 'never_seen' : online ? 'online' : 'offline',
            lastSeenAt: iso(seenAt),
            appVersion: sn(d.app_version),
            printer: isPrinter
              ? {
                  address: sn(d.address),
                  agentDeviceId: sn(d.agent_device_id),
                  healthy: d.last_status_at === null ? null : !d.last_error,
                  lastError: sn(d.last_error),
                  lastStatusAt: isoOf(d.last_status_at),
                  failedJobs: num(d.failed_jobs),
                  deadJobs: num(d.dead_jobs),
                }
              : null,
          };
        }),
        generatedAt: now.toISOString(),
      };
    },

    async receiptData(orderId) {
      const [o] = await sql.query(
        `select o.*, r.name as restaurant_name, r.phone as restaurant_phone, r.currency, r.receipt_footer, b.name as branch_name, b.address as branch_address,
                b.timezone, t.label as table_label,
                coalesce(
                  (select s.display_name from payments p join staff s on s.id = p.recorded_by_staff_id
                   where p.order_id = o.id and p.status = 'recorded' order by p.created_at desc limit 1),
                  (select s.display_name from staff s where s.id = o.created_by_staff_id)) as cashier_name
         from orders o join restaurants r on r.id = o.restaurant_id join branches b on b.id = o.branch_id
         left join dining_tables t on t.id = o.table_id where o.id = $1`,
        [orderId],
      );
      if (!o) return null;
      const [items, taxes, payments] = await Promise.all([
        sql.query(
          `select i.quantity, i.name, i.unit_price, i.line_total, i.gross_total, i.promotion_name, i.promotion_discount,
             i.manual_discount, i.status,
             coalesce((select json_agg(json_build_object('name', m.name, 'priceDelta', m.price_delta) order by m.name)
                       from order_item_modifiers m where m.order_item_id = i.id), '[]'::json) as modifiers,
             (select d.reason from order_discounts d where d.order_id = i.order_id and d.removed_at is null) as discount_reason
           from order_items i where i.order_id = $1 order by i.position`,
          [orderId],
        ),
        sql.query(
          `select x.name, x.rate_bp, x.is_inclusive, sum(x.amount)::bigint as amount
           from order_item_taxes x join order_items i on i.id = x.order_item_id
           where i.order_id = $1 and i.status not in ('cancelled', 'voided')
           group by x.name, x.rate_bp, x.is_inclusive order by x.name`,
          [orderId],
        ),
        sql.query(`select * from payments where order_id = $1 and status = 'recorded' order by created_at`, [
          orderId,
        ]),
      ]);
      const grand = num(o.grand_total);
      const live = items.filter((i) => i.status !== 'voided' && i.status !== 'cancelled');
      const total = (k: string) => live.reduce((a, i) => a + num(i[k]), 0);
      return {
        restaurantName: s(o.restaurant_name),
        restaurantPhone: sn(o.restaurant_phone),
        branchName: s(o.branch_name),
        branchAddress: sn(o.branch_address),
        currency: s(o.currency).trim(),
        orderNumber: num(o.order_number),
        channel: o.channel as 'dine_in',
        tableLabel: sn(o.table_label),
        customerName: sn(o.customer_name),
        timeZone: s(o.timezone),
        cashierName: sn(o.cashier_name),
        items: items.map((i) => ({
          quantity: num(i.quantity),
          name: s(i.name),
          unitPrice: num(i.unit_price),
          grossTotal: num(i.gross_total),
          promotionName: sn(i.promotion_name),
          promotionDiscount: num(i.promotion_discount),
          lineTotal: num(i.line_total),
          modifiers: (i.modifiers as { name: string; priceDelta: unknown }[]).map((m) => ({
            name: m.name,
            priceDelta: num(m.priceDelta),
          })),
          voided: i.status === 'voided' || i.status === 'cancelled',
        })),
        subtotal: total('gross_total'),
        promotionTotal: total('promotion_discount'),
        discountTotal: total('manual_discount'),
        discountReason: sn(items[0]?.discount_reason),
        taxes: taxes.map((t) => ({
          name: s(t.name),
          rateBp: num(t.rate_bp),
          isInclusive: Boolean(t.is_inclusive),
          amount: num(t.amount),
        })),
        grandTotal: grand,
        payments: payments.map((p) => ({
          method: s(p.method),
          amount: num(p.amount),
          tendered: numOrNull(p.tendered_amount),
          change: num(p.change_amount),
          direction: p.direction as 'charge',
        })),
        balanceDue: balanceDue(grand, { paidTotal: num(o.paid_total), refundedTotal: num(o.refunded_total) }),
        footer: sn(o.receipt_footer),
      };
    },

    async configuration(): Promise<ConfigurationView> {
      const q = (text: string) => sql.query(text);
      const [
        restaurant,
        branches,
        areas,
        tables,
        categories,
        taxRates,
        products,
        stations,
        devices,
        outputs,
        rules,
        roles,
        staff,
        modifierGroups,
        modifiers,
      ] = await Promise.all([
        q(
          `select id, name, currency, timezone, phone, receipt_footer from restaurants where id = app.current_restaurant_id()`,
        ),
        q(
          `select id, name, code, address, timezone, to_char(business_day_cutoff, 'HH24:MI') as business_day_cutoff, order_number_start, is_active from branches order by name`,
        ),
        q(`select * from operational_areas order by sort_order, name`),
        q(`select * from dining_tables order by length(label), label`),
        q(`select * from categories order by sort_order, name`),
        q(`select * from tax_rates order by apply_order, name`),
        q(`select p.*, coalesce((select json_agg(tax_rate_id) from product_taxes pt where pt.product_id = p.id), '[]') as tax_rate_ids,
                  coalesce((select json_agg(group_id order by sort_order) from product_modifier_groups pm where pm.product_id = p.id), '[]') as modifier_group_ids
             from products p where p.deleted_at is null order by p.name`),
        q(`select * from stations order by sort_order, name`),
        q(`select d.id, d.branch_id, d.kind, d.name, d.station_id, d.receipt_printer_id, d.is_active, d.auth_user_id is not null as paired,
                    pr.address, pr.agent_device_id, pr.paper_width_mm, pr.backup_printer_id
             from devices d left join printers pr on pr.device_id = d.id order by d.kind, d.name`),
        q(`select * from station_outputs`),
        q(`select r.*, coalesce((select json_agg(device_id) from routing_rule_extra_outputs e where e.routing_rule_id = r.id), '[]') as extra_printer_ids
             from routing_rules r order by r.match, r.priority desc`),
        q(`select r.id, r.name, r.is_system, coalesce(array_agg(rp.permission_code) filter (where rp.permission_code is not null), '{}') as permissions
             from roles r left join role_permissions rp on rp.role_id = r.id group by r.id order by r.name`),
        q(`select s.id, s.display_name, s.email, s.is_active, s.pin_lookup is not null as has_pin, s.pin_must_change, s.activated_at,
                    coalesce(array_agg(sr.role_id) filter (where sr.role_id is not null), '{}') as role_ids, min(sr.branch_id::text) as branch_id
             from staff s left join staff_roles sr on sr.staff_id = s.id
             group by s.id order by s.is_active desc, s.display_name`),
        q(`select * from modifier_groups order by name`),
        q(`select * from modifiers order by sort_order, name`),
      ]);
      const camel = (rows: Record<string, unknown>[]) =>
        rows.map((r) =>
          Object.fromEntries(
            Object.entries(r)
              .filter(([k]) => k !== 'restaurant_id')
              .map(([k, v]) => [
                k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
                v instanceof Date ? v.toISOString() : typeof v === 'bigint' ? Number(v) : v,
              ]),
          ),
        );
      const r0 = restaurant[0]!;
      return {
        restaurant: {
          id: s(r0.id),
          name: s(r0.name),
          currency: s(r0.currency).trim(),
          timezone: s(r0.timezone),
          phone: sn(r0.phone),
          receiptFooter: sn(r0.receipt_footer),
        },
        branches: camel(branches),
        areas: camel(areas),
        tables: camel(tables),
        categories: camel(categories),
        taxRates: camel(taxRates),
        products: camel(products).map((p) => ({ ...p, basePrice: Number(p.basePrice) })),
        stations: camel(stations),
        devices: camel(devices),
        stationOutputs: camel(outputs),
        routingRules: camel(rules),
        modifierGroups: camel(modifierGroups),
        modifiers: camel(modifiers).map((m) => ({ ...m, priceDelta: Number(m.priceDelta) })),
        roles: roles.map((r) => ({
          id: s(r.id),
          name: s(r.name),
          isSystem: Boolean(r.is_system),
          permissions: r.permissions as string[],
        })),
        staff: staff.map((st) => ({
          id: s(st.id),
          displayName: s(st.display_name),
          email: sn(st.email),
          isActive: Boolean(st.is_active),
          roleIds: st.role_ids as string[],
          branchId: sn(st.branch_id),
          pin: st.has_pin ? (st.pin_must_change ? 'awaiting_activation' : 'active') : 'none',
          activatedAt: isoOf(st.activated_at),
        })),
      };
    },

    async me(p) {
      const [restaurant, branches, device] = await Promise.all([
        sql.query(`select id, name, currency from restaurants where id = app.current_restaurant_id()`),
        sql.query(
          p.staffId
            ? `select b.id, b.name from branches b where b.is_active and (
                 exists (select 1 from staff_roles sr where sr.staff_id = $1 and sr.branch_id is null)
                 or b.id in (select sr.branch_id from staff_roles sr where sr.staff_id = $1)) order by b.name`
            : `select b.id, b.name from branches b join devices d on d.branch_id = b.id where d.id = $1`,
          [p.staffId ?? p.deviceId],
        ),
        p.deviceId
          ? sql.query(`select id, kind, name, branch_id, station_id from devices where id = $1`, [p.deviceId])
          : Promise.resolve([] as Record<string, unknown>[]),
      ]);
      const r0 = restaurant[0]!;
      const d = device[0];
      return {
        restaurant: { id: s(r0.id), name: s(r0.name), currency: s(r0.currency).trim() },
        branches: branches.map((b) => ({ id: s(b.id), name: s(b.name) })),
        device: d
          ? {
              id: s(d.id),
              kind: s(d.kind),
              name: s(d.name),
              branchId: s(d.branch_id),
              stationId: sn(d.station_id),
            }
          : null,
      };
    },

    async printQueue(branchId): Promise<PrintQueueView> {
      const rows = await sql.query(
        `select j.id, j.printer_id, d.name as printer_name, j.kind, j.status, j.attempts, j.possible_duplicate,
                j.last_error, j.order_id, o.order_number, j.created_at
         from print_jobs j
         join devices d on d.id = j.printer_id
         left join orders o on o.id = j.order_id
         where j.branch_id = $1 and j.status in ('pending', 'claimed', 'failed', 'dead')
         order by j.created_at, j.copy_no
         limit 200`,
        [branchId],
      );
      return {
        jobs: rows.map((j) => ({
          id: s(j.id),
          printerId: s(j.printer_id),
          printerName: s(j.printer_name),
          kind: j.kind as PrintQueueView['jobs'][number]['kind'],
          status: j.status as PrintQueueView['jobs'][number]['status'],
          attempts: num(j.attempts),
          possibleDuplicate: Boolean(j.possible_duplicate),
          lastError: sn(j.last_error),
          orderId: sn(j.order_id),
          orderNumber: numOrNull(j.order_number),
          createdAt: isoOf(j.created_at)!,
        })),
      };
    },
  };
}
