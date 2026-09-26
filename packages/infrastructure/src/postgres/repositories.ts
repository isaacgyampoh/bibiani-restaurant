import type {
  AgentPrinter,
  AuditLog,
  CatalogReader,
  ClaimedPrintJob,
  ConfigurationReader,
  DeviceRepository,
  OrderAggregate,
  OrderHeader,
  OrderRepository,
  PaymentRepository,
  PrintJobRecord,
  PrintJobRepository,
  ProductionRepository,
  Repositories,
  RoutingSnapshot,
  StoredPayment,
  TicketRecord,
} from '@rp/application';
import { DomainError, type OrderItem, type ProductForSale, type TaxRate } from '@rp/domain';
import { dateOrNull, num, numOrNull, type Sql } from '../db/sql';
import { createAdminRepository } from './admin';
import { createInventoryRepository } from './inventory';
import { createPinRepository } from './pins';
import { createDiscountRepository, createPromotionRepository } from './pricing';
import { createReadModels } from './read-models';
import { assignments, json } from './util';

type Row = Record<string, unknown>;
const s = (v: unknown) => v as string;
const sn = (v: unknown) => (v ?? null) as string | null;

export function createRepositories(sql: Sql): Repositories {
  return {
    orders: orderRepository(sql),
    config: memoized(configurationReader(sql)),
    catalog: catalogReader(sql),
    production: productionRepository(sql),
    printJobs: printJobRepository(sql),
    payments: paymentRepository(sql),
    devices: deviceRepository(sql),
    audit: auditLog(sql),
    read: createReadModels(sql),
    admin: createAdminRepository(sql),
    inventory: createInventoryRepository(sql),
    pins: createPinRepository(sql),
    promotions: createPromotionRepository(sql),
    discounts: createDiscountRepository(sql),
  };
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------
function mapHeader(r: Row): OrderHeader {
  return {
    id: s(r.id),
    branchId: s(r.branch_id),
    areaId: s(r.area_id),
    channel: r.channel as OrderHeader['channel'],
    businessDay: s(r.business_day_text),
    orderNumber: num(r.order_number),
    status: r.status as OrderHeader['status'],
    paymentStatus: r.payment_status as OrderHeader['paymentStatus'],
    tableId: sn(r.table_id),
    customerName: sn(r.customer_name),
    customerPhone: sn(r.customer_phone),
    notes: sn(r.notes),
    subtotal: num(r.subtotal),
    taxTotal: num(r.tax_total),
    grandTotal: num(r.grand_total),
    paidTotal: num(r.paid_total),
    refundedTotal: num(r.refunded_total),
    requestHash: s(r.request_hash),
    version: num(r.version),
    createdAt: dateOrNull(r.created_at)!,
    firstSubmittedAt: dateOrNull(r.first_submitted_at),
    readyAt: dateOrNull(r.ready_at),
    fulfilledAt: dateOrNull(r.fulfilled_at),
    completedAt: dateOrNull(r.completed_at),
    isRush: Boolean(r.is_rush),
    mergedIntoOrderId: sn(r.merged_into_order_id),
  };
}

export function mapPayment(r: Row): StoredPayment {
  return {
    id: s(r.id),
    orderId: s(r.order_id),
    direction: r.direction as StoredPayment['direction'],
    method: r.method as StoredPayment['method'],
    amount: num(r.amount),
    status: r.status as StoredPayment['status'],
    refundOfPaymentId: sn(r.refund_of_payment_id),
    requestHash: s(r.request_hash),
  };
}

function orderRepository(sql: Sql): OrderRepository {
  return {
    async lockOrderId(orderId) {
      await sql.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [orderId]);
    },

    async findForUpdate(orderId): Promise<OrderAggregate | null> {
      const [header] = await sql.query(
        'select o.*, o.business_day::text as business_day_text from orders o where o.id = $1 for update',
        [orderId],
      );
      if (!header) return null;
      const items = await sql.query(
        `select i.*, p.category_id, p.requires_preparation,
           coalesce((select json_agg(json_build_object('modifierId', m.modifier_id, 'name', m.name, 'priceDelta', m.price_delta) order by m.name)
                     from order_item_modifiers m where m.order_item_id = i.id), '[]'::json) as modifiers,
           coalesce((select json_agg(json_build_object('taxRateId', t.tax_rate_id, 'name', t.name, 'rateBp', t.rate_bp,
                                                        'isInclusive', t.is_inclusive, 'amount', t.amount))
                     from order_item_taxes t where t.order_item_id = i.id), '[]'::json) as tax_lines
         from order_items i join products p on p.id = i.product_id
         where i.order_id = $1 order by i.position`,
        [orderId],
      );
      const payments = await sql.query('select * from payments where order_id = $1 order by created_at, id', [
        orderId,
      ]);
      return {
        header: mapHeader(header),
        items: items.map(
          (r): OrderItem => ({
            id: s(r.id),
            productId: s(r.product_id),
            categoryId: s(r.category_id),
            name: s(r.name),
            kitchenName: sn(r.kitchen_name),
            unitPrice: num(r.unit_price),
            quantity: num(r.quantity),
            modifiers: (r.modifiers as { modifierId: string; name: string; priceDelta: unknown }[]).map(
              (m) => ({
                ...m,
                priceDelta: num(m.priceDelta),
              }),
            ),
            modifiersTotal: num(r.modifiers_total),
            grossTotal: num(r.gross_total),
            promotion: r.promotion_name
              ? {
                  id: s(r.promotion_id),
                  name: s(r.promotion_name),
                  discount: num(r.promotion_discount),
                }
              : null,
            manualDiscount: num(r.manual_discount),
            lineTotal: num(r.line_total),
            taxLines: (r.tax_lines as { amount: unknown; rateBp: unknown }[]).map((t) => ({
              ...(t as unknown as OrderItem['taxLines'][number]),
              amount: num(t.amount),
              rateBp: num(t.rateBp),
            })),
            taxTotal: num(r.tax_total),
            notes: sn(r.notes),
            requiresPreparation: Boolean(r.requires_preparation),
            stationId: sn(r.station_id),
            submissionId: sn(r.submission_id),
            status: r.status as OrderItem['status'],
          }),
        ),
        payments: payments.map(mapPayment),
      };
    },

    async allocateOrderNumber(branchId, businessDay, start) {
      const [row] = await sql.query(
        `insert into order_number_counters (restaurant_id, branch_id, business_day, next_number)
         values (app.current_restaurant_id(), $1, $2, $3 + 1)
         on conflict (branch_id, business_day) do update set next_number = order_number_counters.next_number + 1
         returning next_number - 1 as n`,
        [branchId, businessDay, start],
      );
      return num(row!.n);
    },

    async orderExists(orderId) {
      return (await sql.query('select 1 from orders where id = $1', [orderId])).length > 0;
    },

    async findReservation(orderId) {
      const [r] = await sql.query(
        'select branch_id, business_day::text as day, order_number from order_number_reservations where order_id = $1',
        [orderId],
      );
      return r ? { branchId: s(r.branch_id), businessDay: s(r.day), orderNumber: num(r.order_number) } : null;
    },

    async insertReservation(r) {
      await sql.query(
        `insert into order_number_reservations (order_id, restaurant_id, branch_id, business_day, order_number)
         values ($1, app.current_restaurant_id(), $2, $3, $4)`,
        [r.orderId, r.branchId, r.businessDay, r.orderNumber],
      );
    },

    async insertHeader(h) {
      await sql.query(
        `insert into orders (id, restaurant_id, branch_id, area_id, channel, business_day, order_number, status, payment_status,
           table_id, customer_name, customer_phone, notes, subtotal, tax_total, grand_total, paid_total, refunded_total,
           created_by_staff_id, created_by_device_id, request_hash, client_created_at, created_at)
         values ($1, app.current_restaurant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)`,
        [
          h.id,
          h.branchId,
          h.areaId,
          h.channel,
          h.businessDay,
          h.orderNumber,
          h.status,
          h.paymentStatus,
          h.tableId,
          h.customerName,
          h.customerPhone,
          h.notes,
          h.subtotal,
          h.taxTotal,
          h.grandTotal,
          h.paidTotal,
          h.refundedTotal,
          h.createdByStaffId,
          h.createdByDeviceId,
          h.requestHash,
          h.clientCreatedAt?.toISOString() ?? null,
          h.createdAt.toISOString(),
        ],
      );
    },

    async insertItems(orderId, items) {
      // Position continues after existing lines, computed in the same statement (no extra round trip).
      await sql.query(
        `insert into order_items (id, restaurant_id, order_id, position, product_id, name, kitchen_name, unit_price, quantity,
           modifiers_total, gross_total, promotion_id, promotion_name, promotion_discount, manual_discount,
           line_total, tax_total, notes, status)
         select r.id, app.current_restaurant_id(), $1,
                (select coalesce(max(position), 0) from order_items where order_id = $1) + r.idx,
                r.product_id, r.name, r.kitchen_name, r.unit_price, r.quantity,
                r.modifiers_total, r.gross_total, r.promotion_id, r.promotion_name, r.promotion_discount, 0,
                r.line_total, r.tax_total, r.notes, 'pending'
         from jsonb_to_recordset($2::text::jsonb) as r(id uuid, idx int, product_id uuid, name text, kitchen_name text,
           unit_price bigint, quantity int, modifiers_total bigint, gross_total bigint, promotion_id uuid,
           promotion_name text, promotion_discount bigint, line_total bigint, tax_total bigint, notes text)`,
        [
          orderId,
          json(
            items.map((i, idx) => ({
              id: i.id,
              idx: idx + 1,
              product_id: i.productId,
              name: i.name,
              kitchen_name: i.kitchenName,
              unit_price: i.unitPrice,
              quantity: i.quantity,
              modifiers_total: i.modifiersTotal,
              gross_total: i.grossTotal,
              promotion_id: i.promotion?.id ?? null,
              promotion_name: i.promotion?.name ?? null,
              promotion_discount: i.promotion?.discount ?? 0,
              line_total: i.lineTotal,
              tax_total: i.taxTotal,
              notes: i.notes,
            })),
          ),
        ],
      );
      const modifiers = items.flatMap((i) => i.modifiers.map((m) => ({ item_id: i.id, ...m })));
      if (modifiers.length > 0) {
        await sql.query(
          `insert into order_item_modifiers (restaurant_id, order_item_id, modifier_id, name, price_delta)
           select app.current_restaurant_id(), r.item_id, r."modifierId", r.name, r."priceDelta"
           from jsonb_to_recordset($1::text::jsonb) as r(item_id uuid, "modifierId" uuid, name text, "priceDelta" bigint)`,
          [json(modifiers)],
        );
      }
      const taxes = items.flatMap((i) => i.taxLines.map((t) => ({ item_id: i.id, ...t })));
      if (taxes.length > 0) {
        await sql.query(
          `insert into order_item_taxes (restaurant_id, order_item_id, tax_rate_id, name, rate_bp, is_inclusive, amount)
           select app.current_restaurant_id(), r.item_id, r."taxRateId", r.name, r."rateBp", r."isInclusive", r.amount
           from jsonb_to_recordset($1::text::jsonb) as r(item_id uuid, "taxRateId" uuid, name text, "rateBp" int, "isInclusive" boolean, amount bigint)`,
          [json(taxes)],
        );
      }
    },

    async updateItems(updates, at) {
      if (updates.length === 0) return;
      await sql.query(
        `update order_items i set status = r.status::order_item_status,
           station_id = coalesce(r.station_id, i.station_id),
           submission_id = coalesce(r.submission_id, i.submission_id),
           status_changed_at = $2,
           void_reason = coalesce(r.void_reason, i.void_reason),
           voided_by_staff_id = coalesce(r.voided_by_staff_id, i.voided_by_staff_id),
           voided_at = case when r.status = 'voided' then $2::timestamptz else i.voided_at end
         from jsonb_to_recordset($1::text::jsonb) as r(item_id uuid, status text, station_id uuid, submission_id uuid,
                                                        void_reason text, voided_by_staff_id uuid)
         where i.id = r.item_id`,
        [
          json(
            updates.map((u) => ({
              item_id: u.itemId,
              status: u.status,
              station_id: u.stationId ?? null,
              submission_id: u.submissionId ?? null,
              void_reason: u.voidReason ?? null,
              voided_by_staff_id: u.voidedByStaffId ?? null,
            })),
          ),
          at.toISOString(),
        ],
      );
    },

    async updateHeader(orderId, patch, expectedVersion) {
      const set = assignments(patch, 3);
      const rows = await sql.query(
        `update orders set ${set.sql ? `${set.sql}, ` : ''}version = version + 1, updated_at = now()
         where id = $1 and version = $2 returning version`,
        [orderId, expectedVersion, ...set.params],
      );
      if (rows.length === 0) {
        throw new DomainError('VERSION_CONFLICT', 'This order was just changed elsewhere', {
          orderId,
          expectedVersion,
        });
      }
      return num(rows[0]!.version);
    },

    async mergedFrom(orderId) {
      const rows = await sql.query('select id from orders where merged_into_order_id = $1', [orderId]);
      return rows.map((r) => s(r.id));
    },

    async moveContents(fromId, toId, toOrderNumber) {
      await sql.query(
        `update order_submissions set order_id = $2,
                seq = seq + (select coalesce(max(seq), 0) from order_submissions where order_id = $2)
         where order_id = $1`,
        [fromId, toId],
      );
      const items = await sql.query(
        `update order_items set order_id = $2,
                position = position + (select coalesce(max(position), 0) from order_items where order_id = $2)
         where order_id = $1 returning id`,
        [fromId, toId],
      );
      await sql.query('update production_tickets set order_id = $2, order_number = $3 where order_id = $1', [
        fromId,
        toId,
        toOrderNumber,
      ]);
      const payments = await sql.query('update payments set order_id = $2 where order_id = $1 returning id', [
        fromId,
        toId,
      ]);
      return { items: items.length, payments: payments.length };
    },

    async activeOrderIdForTable(tableId) {
      const [row] = await sql.query(
        `select id from orders where table_id = $1 and status not in ('completed', 'cancelled', 'voided') limit 1`,
        [tableId],
      );
      return row ? s(row.id) : null;
    },

    async findSubmission(submissionId) {
      const [row] = await sql.query(
        'select id, order_id, seq, request_hash from order_submissions where id = $1',
        [submissionId],
      );
      return row
        ? { id: s(row.id), orderId: s(row.order_id), seq: num(row.seq), requestHash: s(row.request_hash) }
        : null;
    },

    async insertSubmission(sub) {
      const [row] = await sql.query(
        `insert into order_submissions (id, restaurant_id, order_id, seq, request_hash, submitted_by_staff_id, device_id, submitted_at)
         values ($1, app.current_restaurant_id(), $2,
                 (select coalesce(max(seq), 0) + 1 from order_submissions where order_id = $2), $3, $4, $5, $6)
         returning seq`,
        [sub.id, sub.orderId, sub.requestHash, sub.staffId, sub.deviceId, sub.submittedAt.toISOString()],
      );
      return num(row!.seq);
    },

    async appendEvent(e) {
      await sql.query(
        `insert into order_events (restaurant_id, order_id, event, from_status, to_status, staff_id, device_id, correlation_id, payload)
         values (app.current_restaurant_id(), $1, $2, $3, $4, $5, $6, $7, $8::text::jsonb)`,
        [
          e.orderId,
          e.event,
          e.fromStatus ?? null,
          e.toStatus ?? null,
          e.staffId,
          e.deviceId,
          e.correlationId,
          e.payload ? json(e.payload) : null,
        ],
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Configuration & catalog
// ---------------------------------------------------------------------------
function configurationReader(sql: Sql): ConfigurationReader {
  return {
    async branch(branchId) {
      const [r] = await sql.query(
        `select id, name, timezone, to_char(business_day_cutoff, 'HH24:MI:SS') as cutoff, order_number_start, is_active
         from branches where id = $1`,
        [branchId],
      );
      return r
        ? {
            id: s(r.id),
            name: s(r.name),
            timezone: s(r.timezone),
            businessDayCutoff: s(r.cutoff),
            orderNumberStart: num(r.order_number_start),
            isActive: Boolean(r.is_active),
          }
        : null;
    },

    async area(areaId) {
      const [r] = await sql.query('select * from operational_areas where id = $1', [areaId]);
      return r
        ? {
            id: s(r.id),
            branchId: s(r.branch_id),
            name: s(r.name),
            channel: r.channel as 'dine_in' | 'takeaway',
            requiresTable: Boolean(r.requires_table),
            requiresCustomerName: Boolean(r.requires_customer_name),
            requirePaymentBeforeProduction: Boolean(r.require_payment_before_production),
            paymentPolicy: r.payment_policy as 'pay_after_fulfillment',
            isActive: Boolean(r.is_active),
          }
        : null;
    },

    async table(tableId) {
      const [r] = await sql.query('select * from dining_tables where id = $1', [tableId]);
      return r
        ? {
            id: s(r.id),
            branchId: s(r.branch_id),
            areaId: s(r.area_id),
            label: s(r.label),
            status: r.status as 'available',
            isActive: Boolean(r.is_active),
          }
        : null;
    },

    async setTableStatus(tableId, status, at) {
      await sql.query(
        `update dining_tables set status = $2, status_changed_at = $3, version = version + 1
         where id = $1 and status is distinct from $2::table_status`,
        [tableId, status, at.toISOString()],
      );
    },

    async routingSnapshot(branchId): Promise<RoutingSnapshot> {
      const [stations, outputs, rules, extras, categories] = await Promise.all([
        sql.query('select id, name, auto_ready, is_active from stations where branch_id = $1', [branchId]),
        sql.query(
          `select so.station_id, so.device_id, so.role, so.copies, d.kind as device_kind, d.is_active as device_active,
                  pr.backup_printer_id, coalesce(bd.is_active, false) as backup_active
           from station_outputs so
           join stations st on st.id = so.station_id
           join devices d on d.id = so.device_id
           left join printers pr on pr.device_id = d.id
           left join devices bd on bd.id = pr.backup_printer_id
           where st.branch_id = $1`,
          [branchId],
        ),
        sql.query('select * from routing_rules where branch_id = $1 and is_active', [branchId]),
        sql.query(
          `select e.routing_rule_id, e.device_id
           from routing_rule_extra_outputs e
           join routing_rules r on r.id = e.routing_rule_id
           join devices d on d.id = e.device_id
           where r.branch_id = $1 and d.is_active and d.kind = 'printer'`,
          [branchId],
        ),
        sql.query('select id, parent_id from categories'),
      ]);
      const ruleExtraPrinters = new Map<string, string[]>();
      for (const e of extras) {
        const list = ruleExtraPrinters.get(s(e.routing_rule_id)) ?? [];
        list.push(s(e.device_id));
        ruleExtraPrinters.set(s(e.routing_rule_id), list);
      }
      return {
        stations: stations.map((r) => ({
          id: s(r.id),
          name: s(r.name),
          autoReady: Boolean(r.auto_ready),
          isActive: Boolean(r.is_active),
        })),
        outputs: outputs.map((r) => ({
          stationId: s(r.station_id),
          deviceId: s(r.device_id),
          deviceKind: s(r.device_kind),
          role: r.role as 'primary',
          copies: num(r.copies),
          deviceActive: Boolean(r.device_active),
          backupPrinterId: sn(r.backup_printer_id),
          backupActive: Boolean(r.backup_active),
        })),
        rules: rules.map((r) => ({
          id: s(r.id),
          match: r.match as 'product',
          productId: sn(r.product_id),
          categoryId: sn(r.category_id),
          areaId: sn(r.area_id),
          stationId: s(r.station_id),
          priority: num(r.priority),
        })),
        ruleExtraPrinters,
        categoryParents: new Map(categories.map((c) => [s(c.id), sn(c.parent_id)])),
      };
    },
  };
}

function catalogReader(sql: Sql): CatalogReader {
  return {
    async productsForSale(branchId, productIds) {
      const ids = json(productIds);
      const [products, taxes, groups, modifiers] = await Promise.all([
        sql.query(
          `select p.id, p.category_id, p.name, p.kitchen_name, coalesce(bp.price_override, p.base_price) as price,
                  (p.is_active and p.deleted_at is null and coalesce(bp.is_available, true)) as is_available,
                  p.requires_preparation
           from products p
           left join branch_products bp on bp.product_id = p.id and bp.branch_id = $1
           where p.id in (select value::uuid from jsonb_array_elements_text($2::text::jsonb))`,
          [branchId, ids],
        ),
        sql.query(
          `select pt.product_id, t.id, t.name, t.rate_bp, t.is_inclusive, t.is_compound, t.apply_order
           from product_taxes pt join tax_rates t on t.id = pt.tax_rate_id
           where t.is_active and pt.product_id in (select value::uuid from jsonb_array_elements_text($1::text::jsonb))`,
          [ids],
        ),
        sql.query(
          `select pmg.product_id, g.id, g.name, g.min_select, g.max_select
           from product_modifier_groups pmg join modifier_groups g on g.id = pmg.group_id
           where pmg.product_id in (select value::uuid from jsonb_array_elements_text($1::text::jsonb))
           order by pmg.sort_order`,
          [ids],
        ),
        sql.query(
          `select m.id, m.group_id, m.name, m.price_delta from modifiers m
           where m.is_active and m.group_id in (
             select pmg.group_id from product_modifier_groups pmg
             where pmg.product_id in (select value::uuid from jsonb_array_elements_text($1::text::jsonb)))
           order by m.sort_order, m.name`,
          [ids],
        ),
      ]);
      const result = new Map<string, ProductForSale>();
      for (const p of products) {
        const id = s(p.id);
        result.set(id, {
          id,
          categoryId: s(p.category_id),
          name: s(p.name),
          kitchenName: sn(p.kitchen_name),
          price: num(p.price),
          isAvailable: Boolean(p.is_available),
          requiresPreparation: Boolean(p.requires_preparation),
          taxes: taxes
            .filter((t) => t.product_id === id)
            .map(
              (t): TaxRate => ({
                id: s(t.id),
                name: s(t.name),
                rateBp: num(t.rate_bp),
                isInclusive: Boolean(t.is_inclusive),
                isCompound: Boolean(t.is_compound),
                applyOrder: num(t.apply_order),
              }),
            ),
          modifierGroups: groups
            .filter((g) => g.product_id === id)
            .map((g) => ({
              id: s(g.id),
              name: s(g.name),
              minSelect: num(g.min_select),
              maxSelect: numOrNull(g.max_select),
              modifiers: modifiers
                .filter((m) => m.group_id === g.id)
                .map((m) => ({ id: s(m.id), name: s(m.name), priceDelta: num(m.price_delta) })),
            })),
        });
      }
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Production tickets
// ---------------------------------------------------------------------------
const TICKET_SELECT = `select t.*,
  coalesce((select json_agg(pti.order_item_id order by oi.position)
            from production_ticket_items pti join order_items oi on oi.id = pti.order_item_id
            where pti.ticket_id = t.id), '[]'::json) as item_ids
  from production_tickets t`;

function mapTicket(r: Row): TicketRecord {
  return {
    id: s(r.id),
    branchId: s(r.branch_id),
    orderId: s(r.order_id),
    stationId: s(r.station_id),
    submissionId: s(r.submission_id),
    status: r.status as TicketRecord['status'],
    version: num(r.version),
    itemIds: r.item_ids as string[],
  };
}

function productionRepository(sql: Sql): ProductionRepository {
  return {
    async insertTickets(tickets) {
      if (tickets.length === 0) return;
      await sql.query(
        `insert into production_tickets (id, restaurant_id, branch_id, order_id, submission_id, station_id, order_number, status,
           ready_at, created_at, updated_at)
         select r.id, app.current_restaurant_id(), r.branch_id, r.order_id, r.submission_id, r.station_id, r.order_number,
                r.status::ticket_status, r.ready_at, r.created_at, r.created_at
         from jsonb_to_recordset($1::text::jsonb) as r(id uuid, branch_id uuid, order_id uuid, submission_id uuid, station_id uuid,
                                                 order_number int, status text, ready_at timestamptz, created_at timestamptz)`,
        [
          json(
            tickets.map((t) => ({
              id: t.id,
              branch_id: t.branchId,
              order_id: t.orderId,
              submission_id: t.submissionId,
              station_id: t.stationId,
              order_number: t.orderNumber,
              status: t.status,
              ready_at: t.readyAt?.toISOString() ?? null,
              created_at: t.createdAt.toISOString(),
            })),
          ),
        ],
      );
      await sql.query(
        `insert into production_ticket_items (restaurant_id, ticket_id, order_item_id)
         select app.current_restaurant_id(), r.ticket_id, r.item_id
         from jsonb_to_recordset($1::text::jsonb) as r(ticket_id uuid, item_id uuid)`,
        [json(tickets.flatMap((t) => t.itemIds.map((item_id) => ({ ticket_id: t.id, item_id }))))],
      );
    },

    async find(ticketId) {
      const [r] = await sql.query(`${TICKET_SELECT} where t.id = $1`, [ticketId]);
      return r ? mapTicket(r) : null;
    },

    async printersForTicket(ticketId) {
      const rows = await sql.query(
        `select distinct printer_id from print_jobs where production_ticket_id = $1 and kind = 'kitchen_ticket'`,
        [ticketId],
      );
      return rows.map((r) => s(r.printer_id));
    },

    async findForUpdate(ticketId) {
      const [r] = await sql.query(`${TICKET_SELECT} where t.id = $1 for update of t`, [ticketId]);
      return r ? mapTicket(r) : null;
    },

    async ticketsForOrder(orderId) {
      return (
        await sql.query(`${TICKET_SELECT} where t.order_id = $1 order by t.created_at, t.id`, [orderId])
      ).map(mapTicket);
    },

    async update(ticketId, patch, expectedVersion, at) {
      const set = assignments(patch, 4);
      const rows = await sql.query(
        `update production_tickets set ${set.sql ? `${set.sql}, ` : ''}version = version + 1, updated_at = $3
         where id = $1 and version = $2 returning version`,
        [ticketId, expectedVersion, at.toISOString(), ...set.params],
      );
      if (rows.length === 0) {
        throw new DomainError('VERSION_CONFLICT', 'This ticket was just updated on another screen', {
          ticketId,
        });
      }
      return num(rows[0]!.version);
    },

    async appendEvents(events) {
      if (events.length === 0) return;
      await sql.query(
        `insert into production_ticket_events (restaurant_id, ticket_id, action, from_status, to_status, staff_id, device_id, correlation_id)
         select app.current_restaurant_id(), r.ticket_id, r.action, r.from_status::ticket_status, r.to_status::ticket_status,
                r.staff_id, r.device_id, r.correlation_id
         from jsonb_to_recordset($1::text::jsonb) as r(ticket_id uuid, action text, from_status text, to_status text,
                                                        staff_id uuid, device_id uuid, correlation_id text)`,
        [
          json(
            events.map((e) => ({
              ticket_id: e.ticketId,
              action: e.action,
              from_status: e.fromStatus,
              to_status: e.toStatus,
              staff_id: e.staffId,
              device_id: e.deviceId,
              correlation_id: e.correlationId,
            })),
          ),
        ],
      );
    },

    async appendEvent(e) {
      await sql.query(
        `insert into production_ticket_events (restaurant_id, ticket_id, action, from_status, to_status, staff_id, device_id, correlation_id)
         values (app.current_restaurant_id(), $1, $2, $3, $4, $5, $6, $7)`,
        [e.ticketId, e.action, e.fromStatus, e.toStatus, e.staffId, e.deviceId, e.correlationId],
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Print jobs
// ---------------------------------------------------------------------------
function mapJob(r: Row): PrintJobRecord {
  return {
    id: s(r.id),
    branchId: s(r.branch_id),
    printerId: s(r.printer_id),
    originalPrinterId: s(r.original_printer_id),
    kind: r.kind as PrintJobRecord['kind'],
    status: r.status as PrintJobRecord['status'],
    attempts: num(r.attempts),
    maxAttempts: num(r.max_attempts),
    possibleDuplicate: Boolean(r.possible_duplicate),
    claimId: sn(r.claim_id),
    claimedByDeviceId: sn(r.claimed_by_device_id),
    leaseExpiresAt: dateOrNull(r.lease_expires_at),
    orderId: sn(r.order_id),
    productionTicketId: sn(r.production_ticket_id),
  };
}

function printJobRepository(sql: Sql): PrintJobRepository {
  return {
    async insert(jobs) {
      if (jobs.length === 0) return;
      await sql.query(
        `insert into print_jobs (id, restaurant_id, branch_id, printer_id, original_printer_id, kind, order_id,
           production_ticket_id, copy_no, dedupe_key, document, created_at, next_attempt_at, is_reprint)
         select r.id, app.current_restaurant_id(), r.branch_id, r.printer_id, r.original_printer_id, r.kind::print_job_kind,
                r.order_id, r.production_ticket_id, r.copy_no, r.dedupe_key, r.document, r.created_at, r.created_at,
                coalesce(r.is_reprint, false)
         from jsonb_to_recordset($1::text::jsonb) as r(id uuid, branch_id uuid, printer_id uuid, original_printer_id uuid, kind text,
           order_id uuid, production_ticket_id uuid, copy_no int, dedupe_key text, document jsonb, created_at timestamptz,
           is_reprint boolean)`,
        [
          json(
            jobs.map((j) => ({
              id: j.id,
              branch_id: j.branchId,
              printer_id: j.printerId,
              original_printer_id: j.originalPrinterId,
              kind: j.kind,
              order_id: j.orderId,
              production_ticket_id: j.productionTicketId,
              copy_no: j.copyNo,
              dedupe_key: j.dedupeKey,
              document: j.document,
              created_at: j.createdAt.toISOString(),
              is_reprint: j.isReprint ?? false,
            })),
          ),
        ],
      );
    },

    async findByDedupeKey(key) {
      const [r] = await sql.query('select id, is_reprint from print_jobs where dedupe_key = $1', [key]);
      return r ? { id: s(r.id), isReprint: Boolean(r.is_reprint) } : null;
    },

    async countForOrder(orderId, kind) {
      const [r] = await sql.query(
        'select count(*)::int as n from print_jobs where order_id = $1 and kind = $2',
        [orderId, kind],
      );
      return num(r!.n);
    },

    async receiptPrinterForDevice(deviceId) {
      const [r] = await sql.query(
        `select d.receipt_printer_id from devices d join devices p on p.id = d.receipt_printer_id
         where d.id = $1 and p.is_active`,
        [deviceId],
      );
      return r ? s(r.receipt_printer_id) : null;
    },

    async printerInBranch(printerId, branchId) {
      const rows = await sql.query(
        `select 1 from printers pr join devices d on d.id = pr.device_id where pr.device_id = $1 and d.branch_id = $2 and d.is_active`,
        [printerId, branchId],
      );
      return rows.length > 0;
    },

    async idsForTickets(ticketIds) {
      const rows = await sql.query(
        `select id from print_jobs where production_ticket_id in (select value::uuid from jsonb_array_elements_text($1::text::jsonb))`,
        [json(ticketIds)],
      );
      return rows.map((r) => s(r.id));
    },

    async expiredLeases(agentDeviceId, now) {
      const rows = await sql.query(
        `select j.* from print_jobs j join printers p on p.device_id = j.printer_id
         where p.agent_device_id = $1 and j.status = 'claimed' and j.lease_expires_at < $2
         for update of j skip locked`,
        [agentDeviceId, now.toISOString()],
      );
      return rows.map(mapJob);
    },

    async lockReady(agentDeviceId, now, limit) {
      const rows = await sql.query(
        `select j.* from print_jobs j
         join printers p on p.device_id = j.printer_id
         join devices d on d.id = p.device_id
         where p.agent_device_id = $1 and d.is_active
           and j.status in ('pending', 'failed') and j.next_attempt_at <= $2
         order by j.created_at, j.copy_no
         limit $3
         for update of j skip locked`,
        [agentDeviceId, now.toISOString(), limit],
      );
      return rows.map(mapJob);
    },

    async findForUpdate(jobId) {
      const [r] = await sql.query('select * from print_jobs where id = $1 for update', [jobId]);
      return r ? mapJob(r) : null;
    },

    async update(jobId, patch) {
      const set = assignments(patch, 2);
      if (!set.sql) return;
      await sql.query(`update print_jobs set ${set.sql}, version = version + 1 where id = $1`, [
        jobId,
        ...set.params,
      ]);
    },

    async claimed(jobIds): Promise<ClaimedPrintJob[]> {
      if (jobIds.length === 0) return [];
      const rows = await sql.query(
        `select * from print_jobs where id in (select value::uuid from jsonb_array_elements_text($1::text::jsonb))
         order by created_at, copy_no`,
        [json(jobIds)],
      );
      return rows.map((r) => ({
        id: s(r.id),
        printerId: s(r.printer_id),
        claimId: s(r.claim_id),
        kind: r.kind as ClaimedPrintJob['kind'],
        document: r.document as ClaimedPrintJob['document'],
        possibleDuplicate: Boolean(r.possible_duplicate),
        isReprint: Boolean(r.is_reprint),
        attempts: num(r.attempts),
        orderId: sn(r.order_id),
        productionTicketId: sn(r.production_ticket_id),
        leaseExpiresAt: dateOrNull(r.lease_expires_at)!,
      }));
    },

    async appendAttempt(a) {
      await sql.query(
        `insert into print_job_attempts (restaurant_id, print_job_id, claim_id, agent_device_id, printer_id, outcome, error)
         values (app.current_restaurant_id(), $1, $2, $3, $4, $5, $6)`,
        [a.jobId, a.claimId, a.agentDeviceId, a.printerId, a.outcome, a.error],
      );
    },

    async backupPrinterFor(printerId) {
      const [r] = await sql.query(
        `select pr.backup_printer_id from printers pr join devices d on d.id = pr.backup_printer_id
         where pr.device_id = $1 and d.is_active`,
        [printerId],
      );
      return r ? s(r.backup_printer_id) : null;
    },

    async agentPrinters(agentDeviceId): Promise<AgentPrinter[]> {
      const rows = await sql.query(
        `select p.device_id, d.name, p.connection, p.address, p.paper_width_mm, d.is_active
         from printers p join devices d on d.id = p.device_id
         where p.agent_device_id = $1 order by d.name`,
        [agentDeviceId],
      );
      return rows.map((r) => ({
        printerId: s(r.device_id),
        name: s(r.name),
        connection: r.connection as AgentPrinter['connection'],
        address: sn(r.address),
        paperWidthMm: num(r.paper_width_mm),
        isActive: Boolean(r.is_active),
      }));
    },

    async recordPrinterStatus(printerId, error, at) {
      await sql.query('update printers set last_error = $2, last_status_at = $3 where device_id = $1', [
        printerId,
        error,
        at.toISOString(),
      ]);
    },
  };
}

// ---------------------------------------------------------------------------
// Payments, devices, audit
// ---------------------------------------------------------------------------
function paymentRepository(sql: Sql): PaymentRepository {
  return {
    async find(paymentId) {
      const [r] = await sql.query('select * from payments where id = $1', [paymentId]);
      return r ? mapPayment(r) : null;
    },

    async insert(p) {
      await sql.query(
        `insert into payments (id, restaurant_id, branch_id, order_id, direction, refund_of_payment_id, method, amount,
           tendered_amount, change_amount, reference, note, request_hash, recorded_by_staff_id, device_id)
         values ($1, app.current_restaurant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          p.id,
          p.branchId,
          p.orderId,
          p.direction,
          p.refundOfPaymentId,
          p.method,
          p.amount,
          p.tenderedAmount,
          p.changeAmount,
          p.reference,
          p.note,
          p.requestHash,
          p.recordedByStaffId,
          p.deviceId,
        ],
      );
    },

    async markVoided(paymentId, by, reason, at) {
      await sql.query(
        `update payments set status = 'voided', voided_at = $2, voided_by_staff_id = $3, void_reason = $4
         where id = $1 and status = 'recorded'`,
        [paymentId, at.toISOString(), by, reason],
      );
    },
  };
}

function deviceRepository(sql: Sql): DeviceRepository {
  return {
    async heartbeat(deviceId, appVersion, at) {
      const [prev] = await sql.query(
        'select last_heartbeat_at from devices where id = $1 and is_active for update',
        [deviceId],
      );
      if (!prev) throw new DomainError('NOT_FOUND', 'Device not found', { deviceId });
      await sql.query(
        `update devices set last_heartbeat_at = $2, status = 'online', app_version = coalesce($3, app_version) where id = $1`,
        [deviceId, at.toISOString(), appVersion],
      );
      return { previousHeartbeatAt: dateOrNull(prev.last_heartbeat_at) };
    },

    async appendEvent(deviceId, event, detail) {
      await sql.query(
        `insert into device_events (restaurant_id, device_id, event, detail)
         values (app.current_restaurant_id(), $1, $2, $3::text::jsonb)`,
        [deviceId, event, json(detail)],
      );
    },
  };
}

function auditLog(sql: Sql): AuditLog {
  return {
    async append(a) {
      await sql.query(
        `insert into audit_logs (restaurant_id, branch_id, actor_staff_id, actor_device_id, action, entity_type, entity_id,
           before_data, after_data, reason, correlation_id)
         values (app.current_restaurant_id(), $1, $2, $3, $4, $5, $6, $7::text::jsonb, $8::text::jsonb, $9, $10)`,
        [
          a.branchId,
          a.actorStaffId,
          a.actorDeviceId,
          a.action,
          a.entityType,
          a.entityId,
          a.before === undefined ? null : json(a.before),
          a.after === undefined ? null : json(a.after),
          a.reason ?? null,
          a.correlationId,
        ],
      );
    },
  };
}

/**
 * Caches branch/area/table lookups for the life of one transaction (one use
 * case), so a use case that needs them in several places reads each once.
 */
function memoized(reader: ConfigurationReader): ConfigurationReader {
  const cache = new Map<string, Promise<unknown>>();
  const once = <T>(key: string, load: () => Promise<T>): Promise<T> => {
    if (!cache.has(key)) cache.set(key, load());
    return cache.get(key) as Promise<T>;
  };
  return {
    ...reader,
    branch: (id) => once(`branch:${id}`, () => reader.branch(id)),
    area: (id) => once(`area:${id}`, () => reader.area(id)),
    table: (id) => once(`table:${id}`, () => reader.table(id)),
    routingSnapshot: (id) => once(`routing:${id}`, () => reader.routingSnapshot(id)),
    setTableStatus: async (id, status, at) => {
      cache.delete(`table:${id}`);
      await reader.setTableStatus(id, status, at);
    },
  };
}
