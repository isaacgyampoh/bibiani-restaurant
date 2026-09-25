import type { InventoryItemRecord, InventoryRepository, StockCountRecord } from '@rp/application';
import { num, type Sql } from '../db/sql';
import { json } from './util';

type Row = Record<string, unknown>;
/** numeric(14,3) <-> thousandths (exact: the database value has at most 3 decimals). */
const milli = (v: unknown): number => Math.round(Number(v) * 1000);
const dec = (m: number): string => (m / 1000).toFixed(3);

const mapItem = (r: Row): InventoryItemRecord => ({
  id: r.id as string,
  branchId: r.branch_id as string,
  name: r.name as string,
  unit: r.unit as string,
  quantity: milli(r.quantity),
  minQuantity: milli(r.min_quantity),
  unitCost: num(r.unit_cost),
  isActive: Boolean(r.is_active),
  version: num(r.version),
});

export function createInventoryRepository(sql: Sql): InventoryRepository {
  return {
    async lockItem(itemId) {
      const [r] = await sql.query('select * from inventory_items where id = $1 for update', [itemId]);
      return r ? mapItem(r) : null;
    },

    async lockItems(itemIds) {
      if (itemIds.length === 0) return [];
      const rows = await sql.query(
        `select * from inventory_items where id in (select value::uuid from jsonb_array_elements_text($1::text::jsonb))
         order by id for update`,
        [json(itemIds)],
      );
      return rows.map(mapItem);
    },

    async saveItem(i) {
      const [r] = await sql.query<{ inserted: boolean }>(
        `insert into inventory_items (id, restaurant_id, branch_id, name, sku, category, unit, min_quantity, unit_cost, is_active)
         values ($1, app.current_restaurant_id(), $2, $3, $4, $5, $6, $7::numeric, $8, $9)
         on conflict (id) do update set name = excluded.name, sku = excluded.sku, category = excluded.category,
           unit = excluded.unit, min_quantity = excluded.min_quantity, unit_cost = excluded.unit_cost,
           is_active = excluded.is_active, version = inventory_items.version + 1, updated_at = now()
         returning (xmax = 0) as inserted`,
        [i.id, i.branchId, i.name, i.sku, i.category, i.unit, dec(i.minQuantity), i.unitCost, i.isActive],
      );
      return r?.inserted ? 'created' : 'updated';
    },

    async setQuantity(itemId, quantity) {
      await sql.query(
        `update inventory_items set quantity = $2::numeric, version = version + 1, updated_at = now() where id = $1`,
        [itemId, dec(quantity)],
      );
    },

    async movementExists(movementId) {
      const [r] = await sql.query<{ item_id: string }>('select item_id from stock_movements where id = $1', [
        movementId,
      ]);
      return r ? { itemId: r.item_id } : null;
    },

    async insertMovements(movements) {
      if (movements.length === 0) return;
      await sql.query(
        `insert into stock_movements (id, restaurant_id, branch_id, item_id, kind, quantity_delta, quantity_after,
                                      unit_cost, reason, reference, stock_count_id, order_id, staff_id)
         select m.id, app.current_restaurant_id(), m.branch_id, m.item_id, m.kind::stock_movement_kind,
                m.delta::numeric, m.after::numeric, m.unit_cost, m.reason, m.reference, m.stock_count_id, m.order_id, m.staff_id
         from jsonb_to_recordset($1::text::jsonb) as m(id uuid, branch_id uuid, item_id uuid, kind text, delta text,
              after text, unit_cost bigint, reason text, reference text, stock_count_id uuid, order_id uuid, staff_id uuid)`,
        [
          json(
            movements.map((m) => ({
              id: m.id,
              branch_id: m.branchId,
              item_id: m.itemId,
              kind: m.kind,
              delta: dec(m.delta),
              after: dec(m.after),
              unit_cost: m.unitCost,
              reason: m.reason,
              reference: m.reference,
              stock_count_id: m.stockCountId,
              order_id: m.orderId,
              staff_id: m.staffId,
            })),
          ),
        ],
      );
    },

    async insertCount(c) {
      await sql.query(
        `insert into stock_counts (id, restaurant_id, branch_id, note, started_by_staff_id)
         values ($1, app.current_restaurant_id(), $2, $3, $4)`,
        [c.id, c.branchId, c.note, c.staffId],
      );
      const rows = await sql.query(
        `insert into stock_count_lines (restaurant_id, count_id, item_id, system_quantity)
         select i.restaurant_id, $1, i.id, i.quantity
         from inventory_items i
         where i.branch_id = $2 and i.is_active
           and ($3::text is null or i.id in (select value::uuid from jsonb_array_elements_text($3::text::jsonb)))
         returning item_id`,
        [c.id, c.branchId, c.itemIds ? json(c.itemIds) : null],
      );
      return rows.length;
    },

    async lockCount(countId): Promise<StockCountRecord | null> {
      const [c] = await sql.query('select * from stock_counts where id = $1 for update', [countId]);
      if (!c) return null;
      const lines = await sql.query(
        'select item_id, system_quantity, counted_quantity, reason from stock_count_lines where count_id = $1',
        [countId],
      );
      return {
        id: c.id as string,
        branchId: c.branch_id as string,
        status: c.status as StockCountRecord['status'],
        version: num(c.version),
        lines: lines.map((l) => ({
          itemId: l.item_id as string,
          systemQuantity: milli(l.system_quantity),
          countedQuantity: l.counted_quantity === null ? null : milli(l.counted_quantity),
          reason: (l.reason ?? null) as string | null,
        })),
      };
    },

    async saveCountLine(countId, itemId, counted, reason, staffId) {
      const rows = await sql.query(
        `update stock_count_lines set counted_quantity = $3::numeric, reason = $4,
                counted_at = case when $3::numeric is null then null else now() end, counted_by_staff_id = $5
         where count_id = $1 and item_id = $2 returning item_id`,
        [countId, itemId, counted === null ? null : dec(counted), reason, staffId],
      );
      if (rows.length)
        await sql.query('update stock_counts set version = version + 1 where id = $1', [countId]);
      return rows.length > 0;
    },

    async setCountStatus(countId, status, staffId, expectedVersion) {
      const rows = await sql.query(
        `update stock_counts set status = $2::stock_count_status, version = version + 1,
                submitted_at = case when $2 = 'submitted' then now() else submitted_at end,
                submitted_by_staff_id = case when $2 = 'submitted' then $3::uuid else submitted_by_staff_id end,
                approved_at = case when $2 = 'approved' then now() else approved_at end,
                approved_by_staff_id = case when $2 = 'approved' then $3::uuid else approved_by_staff_id end,
                cancelled_at = case when $2 = 'cancelled' then now() else cancelled_at end
         where id = $1 and version = $4 returning id`,
        [countId, status, staffId, expectedVersion],
      );
      return rows.length > 0;
    },

    async setCountSystemQuantities(countId, quantities) {
      if (quantities.size === 0) return;
      await sql.query(
        `update stock_count_lines l set system_quantity = q.qty::numeric
         from jsonb_to_recordset($2::text::jsonb) as q(item_id uuid, qty text)
         where l.count_id = $1 and l.item_id = q.item_id`,
        [countId, json([...quantities].map(([item_id, qty]) => ({ item_id, qty: dec(qty) })))],
      );
    },

    async recipes(productIds) {
      const out = new Map<string, { itemId: string; quantity: number }[]>();
      if (productIds.length === 0) return out;
      const rows = await sql.query(
        `select product_id, item_id, quantity from product_recipe_components
         where product_id in (select value::uuid from jsonb_array_elements_text($1::text::jsonb))`,
        [json(productIds)],
      );
      for (const r of rows) {
        const list = out.get(r.product_id as string) ?? [];
        list.push({ itemId: r.item_id as string, quantity: milli(r.quantity) });
        out.set(r.product_id as string, list);
      }
      return out;
    },

    async setRecipe(productId, components) {
      await sql.query('delete from product_recipe_components where product_id = $1', [productId]);
      if (components.length === 0) return;
      await sql.query(
        `insert into product_recipe_components (restaurant_id, product_id, item_id, quantity)
         select app.current_restaurant_id(), $1, c.item_id, c.qty::numeric
         from jsonb_to_recordset($2::text::jsonb) as c(item_id uuid, qty text)`,
        [productId, json(components.map((c) => ({ item_id: c.itemId, qty: dec(c.quantity) })))],
      );
    },
  };
}
