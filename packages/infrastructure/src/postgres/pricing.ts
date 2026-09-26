import type {
  DiscountRepository,
  ManualDiscountRecord,
  PromotionRecord,
  PromotionRepository,
} from '@rp/application';
import { DomainError } from '@rp/domain';
import { num, type Sql } from '../db/sql';
import { iso } from './util';

type Row = Record<string, unknown>;
const dateText = (v: unknown) => (v === null || v === undefined ? null : String(v).slice(0, 10));
const timeText = (v: unknown) => (v === null || v === undefined ? null : String(v).slice(0, 5));

const mapPromotion = (r: Row, targets: Row[]): PromotionRecord => ({
  id: r.id as string,
  name: r.name as string,
  kind: r.kind as PromotionRecord['kind'],
  percentBp: r.percent_bp === null ? null : num(r.percent_bp),
  amount: r.amount === null ? null : num(r.amount),
  bundleQuantity: r.bundle_quantity === null ? null : num(r.bundle_quantity),
  freeQuantity: r.free_quantity === null || r.free_quantity === undefined ? null : num(r.free_quantity),
  appliesToAll: Boolean(r.applies_to_all),
  productIds: targets
    .filter((t) => t.promotion_id === r.id && t.product_id)
    .map((t) => t.product_id as string),
  categoryIds: targets
    .filter((t) => t.promotion_id === r.id && t.category_id)
    .map((t) => t.category_id as string),
  branchId: (r.branch_id ?? null) as string | null,
  startsOn: dateText(r.starts_on_text),
  endsOn: dateText(r.ends_on_text),
  daysOfWeek: (r.days_of_week ?? null) as number[] | null,
  startTime: timeText(r.start_time),
  endTime: timeText(r.end_time),
  priority: num(r.priority),
  status: r.status as 'active' | 'paused',
  createdAt: iso(r.created_at as Date) ?? String(r.created_at),
  version: num(r.version),
  createdBy: (r.created_by ?? null) as string | null,
  updatedBy: (r.updated_by ?? null) as string | null,
  updatedAt: iso(r.updated_at as Date) ?? String(r.updated_at),
});

const SELECT = `select p.*, p.starts_on::text as starts_on_text, p.ends_on::text as ends_on_text,
                       c.display_name as created_by, u.display_name as updated_by
                from promotions p
                left join staff c on c.id = p.created_by_staff_id
                left join staff u on u.id = p.updated_by_staff_id`;

export function createPromotionRepository(sql: Sql): PromotionRepository {
  return {
    async list() {
      // One round trip (this runs on the order hot path): targets come along as JSON.
      const rows = await sql.query(
        `${SELECT.replace(
          'from promotions p',
          `, coalesce((select json_agg(json_build_object('promotion_id', t.promotion_id, 'product_id', t.product_id,
                                  'category_id', t.category_id)) from promotion_targets t where t.promotion_id = p.id), '[]') as targets
             from promotions p`,
        )} order by p.created_at`,
      );
      return rows.map((r) => mapPromotion(r, r.targets as Row[]));
    },
    async get(id) {
      const [r] = await sql.query(`${SELECT} where p.id = $1`, [id]);
      if (!r) return null;
      const targets = await sql.query(
        'select promotion_id, product_id, category_id from promotion_targets where promotion_id = $1',
        [id],
      );
      return mapPromotion(r, targets);
    },
    async save(p, staffId, expectedVersion) {
      const params = [
        p.id,
        p.branchId,
        p.name.trim(),
        p.kind,
        p.percentBp,
        p.amount,
        p.bundleQuantity,
        p.appliesToAll,
        p.startsOn,
        p.endsOn,
        p.daysOfWeek,
        p.startTime,
        p.endTime,
        p.priority,
        p.status,
        staffId,
        p.freeQuantity ?? null,
      ];
      let created = false;
      if (expectedVersion === null) {
        await sql.query(
          `insert into promotions (id, restaurant_id, branch_id, name, kind, percent_bp, amount, bundle_quantity, applies_to_all,
             starts_on, ends_on, days_of_week, start_time, end_time, priority, status, created_by_staff_id, updated_by_staff_id, free_quantity)
           values ($1, app.current_restaurant_id(), $2, $3, $4, $5, $6, $7, $8, $9::date, $10::date, $11::int[], $12::time, $13::time,
                   $14, $15, $16, $16, $17)`,
          params,
        );
        created = true;
      } else {
        const rows = await sql.query(
          `update promotions set branch_id = $2, name = $3, kind = $4, percent_bp = $5, amount = $6, bundle_quantity = $7,
             applies_to_all = $8, starts_on = $9::date, ends_on = $10::date, days_of_week = $11::int[], start_time = $12::time,
             end_time = $13::time, priority = $14, status = $15, updated_by_staff_id = $16, free_quantity = $17,
             updated_at = now(), version = version + 1
           where id = $1 and version = $18 returning id`,
          [...params, expectedVersion],
        );
        if (rows.length === 0)
          throw new DomainError(
            'VERSION_CONFLICT',
            'Someone else changed this promotion. Reload and try again.',
          );
      }
      await sql.query('delete from promotion_targets where promotion_id = $1', [p.id]);
      const targets = [
        ...p.productIds.map((id) => ({ product_id: id, category_id: null })),
        ...p.categoryIds.map((id) => ({ product_id: null, category_id: id })),
      ];
      if (targets.length)
        await sql.query(
          `insert into promotion_targets (restaurant_id, promotion_id, product_id, category_id)
           select app.current_restaurant_id(), $1, t.product_id, t.category_id
           from jsonb_to_recordset($2::text::jsonb) as t(product_id uuid, category_id uuid)`,
          [p.id, JSON.stringify(targets)],
        );
      return created ? 'created' : 'updated';
    },
    async setStatus(id, status, endsOn, staffId, expectedVersion) {
      const rows = await sql.query(
        `update promotions set status = $2, ends_on = case when $3::boolean then $4::date else ends_on end,
           starts_on = case when $3::boolean and starts_on > $4::date then $4::date else starts_on end,
           updated_by_staff_id = $5, updated_at = now(), version = version + 1
         where id = $1 and version = $6 returning id`,
        [id, status, endsOn !== undefined, endsOn ?? null, staffId, expectedVersion],
      );
      return rows.length > 0;
    },
    async context() {
      const [r] = await sql.query(
        `select r.currency, b.id as branch_id, b.timezone from restaurants r
           left join lateral (select id, timezone from branches where is_active order by created_at limit 1) b on true
          where r.id = app.current_restaurant_id()`,
      );
      return {
        currency: String(r?.currency ?? 'GHS').trim(),
        branchId: (r?.branch_id ?? null) as string | null,
        timeZone: (r?.timezone ?? 'UTC') as string,
      };
    },
    async productCategoryPaths() {
      const [products, categories] = await Promise.all([
        sql.query('select id, category_id from products where deleted_at is null'),
        sql.query('select id, parent_id from categories'),
      ]);
      const parent = new Map(categories.map((c) => [c.id as string, (c.parent_id ?? null) as string | null]));
      const out = new Map<string, string[]>();
      for (const p of products) {
        const path: string[] = [];
        let cur = p.category_id as string | null;
        while (cur && !path.includes(cur)) {
          path.push(cur);
          cur = parent.get(cur) ?? null;
        }
        out.set(p.id as string, path);
      }
      return out;
    },
  };
}

const mapDiscount = (r: Row): ManualDiscountRecord => ({
  id: r.id as string,
  orderId: r.order_id as string,
  kind: r.kind as 'amount' | 'percent',
  value: num(r.value),
  amount: num(r.amount),
  reason: r.reason as string,
  originalTotal: num(r.original_total),
  finalTotal: num(r.final_total),
  appliedByStaffId: (r.applied_by_staff_id ?? null) as string | null,
});

export function createDiscountRepository(sql: Sql): DiscountRepository {
  return {
    async find(id) {
      const [r] = await sql.query('select * from order_discounts where id = $1', [id]);
      return r ? mapDiscount(r) : null;
    },
    async active(orderId) {
      const [r] = await sql.query(
        'select * from order_discounts where order_id = $1 and removed_at is null',
        [orderId],
      );
      return r ? mapDiscount(r) : null;
    },
    async insert(d) {
      await sql.query(
        `insert into order_discounts (id, restaurant_id, order_id, kind, value, amount, reason, original_total, final_total, applied_by_staff_id)
         values ($1, app.current_restaurant_id(), $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          d.id,
          d.orderId,
          d.kind,
          d.value,
          d.amount,
          d.reason.trim(),
          d.originalTotal,
          d.finalTotal,
          d.appliedByStaffId,
        ],
      );
    },
    async remove(id, staffId, at) {
      await sql.query(
        'update order_discounts set removed_at = $2, removed_by_staff_id = $3 where id = $1 and removed_at is null',
        [id, at.toISOString(), staffId],
      );
    },
    async updateItemPricing(items) {
      if (items.length === 0) return;
      await sql.query(
        `update order_items i set manual_discount = r.manual_discount, line_total = r.line_total, tax_total = r.tax_total
         from jsonb_to_recordset($1::text::jsonb) as r(id uuid, manual_discount bigint, line_total bigint, tax_total bigint)
         where i.id = r.id`,
        [
          JSON.stringify(
            items.map((i) => ({
              id: i.id,
              manual_discount: i.manualDiscount,
              line_total: i.lineTotal,
              tax_total: i.taxTotal,
            })),
          ),
        ],
      );
      await sql.query(
        'delete from order_item_taxes where order_item_id in (select value::uuid from jsonb_array_elements_text($1::text::jsonb))',
        [JSON.stringify(items.map((i) => i.id))],
      );
      const taxes = items.flatMap((i) => i.taxLines.map((t) => ({ item_id: i.id, ...t })));
      if (taxes.length)
        await sql.query(
          `insert into order_item_taxes (restaurant_id, order_item_id, tax_rate_id, name, rate_bp, is_inclusive, amount)
           select app.current_restaurant_id(), r.item_id, r."taxRateId", r.name, r."rateBp", r."isInclusive", r.amount
           from jsonb_to_recordset($1::text::jsonb) as r(item_id uuid, "taxRateId" uuid, name text, "rateBp" int, "isInclusive" boolean, amount bigint)`,
          [JSON.stringify(taxes)],
        );
    },
  };
}
