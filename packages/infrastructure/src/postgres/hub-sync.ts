import type { HubIngestOutcome, HubSyncRepository } from '@rp/application';
import type { Sql } from '../db/sql';

type Row = Record<string, unknown>;

/**
 * Configuration the cloud owns and hands to a hub (cloud -> hub), in foreign-key order.
 * `branch`: the column that must equal the hub's branch. `exclude`: columns the hub owns
 * locally (or must never hold) and that a snapshot therefore never carries.
 */
export const SNAPSHOT_TABLES: readonly { table: string; branch?: string; exclude?: readonly string[] }[] = [
  { table: 'restaurants' },
  { table: 'branches', branch: 'id', exclude: ['hub_device_id'] },
  { table: 'roles' },
  { table: 'role_permissions' },
  // The environment-wide PIN digest never leaves the cloud; the hub keeps its own (OFFLINE-AUTHENTICATION.md).
  { table: 'staff', exclude: ['pin_lookup', 'email'] },
  { table: 'staff_roles' },
  { table: 'tax_rates' },
  { table: 'categories' },
  { table: 'products' },
  { table: 'product_taxes' },
  { table: 'branch_products', branch: 'branch_id' },
  { table: 'modifier_groups' },
  { table: 'modifiers' },
  { table: 'product_modifier_groups' },
  { table: 'operational_areas', branch: 'branch_id' },
  { table: 'dining_tables', branch: 'branch_id', exclude: ['status', 'status_changed_at', 'version'] },
  { table: 'stations', branch: 'branch_id' },
  {
    table: 'devices',
    branch: 'branch_id',
    exclude: ['auth_user_id', 'status', 'last_heartbeat_at', 'app_version', 'hub_health'],
  },
  { table: 'printers', exclude: ['last_error', 'last_status_at'] },
  { table: 'station_outputs' },
  { table: 'routing_rules', branch: 'branch_id' },
  { table: 'routing_rule_extra_outputs' },
  // Quantities converge through stock movements (applied once on each side), never by copying.
  { table: 'inventory_items', branch: 'branch_id', exclude: ['quantity', 'version'] },
  { table: 'product_recipe_components' },
  { table: 'promotions' },
  { table: 'promotion_targets' },
];

/**
 * Floor records a hub owns and uploads (hub -> cloud), in foreign-key order.
 * `upsert`: replace by primary key. `origin`: event rows keyed by origin_id, inserted once.
 * `movement`: inserted once, and the quantity change is applied when first seen.
 * `table_status`: only the table's status columns belong to the hub.
 * `customer`: customers are restaurant-wide. A customer made on the hub whose number the cloud
 *   already has (made meanwhile elsewhere) is kept, marked as merged into the cloud's record, so
 *   orders stay linked and no duplicate appears; a merge done in the cloud is never undone by a replay.
 */
export const UPLOAD_TABLES = {
  customers: 'customer',
  register_sessions: 'upsert',
  orders: 'upsert',
  order_submissions: 'upsert',
  order_items: 'upsert',
  order_item_modifiers: 'upsert',
  order_item_taxes: 'upsert',
  order_discounts: 'upsert',
  production_tickets: 'upsert',
  production_ticket_items: 'upsert',
  payments: 'upsert',
  dining_tables: 'table_status',
  stock_movements: 'movement',
  order_events: 'origin',
  production_ticket_events: 'origin',
  audit_logs: 'origin',
} as const;
export type UploadTable = keyof typeof UPLOAD_TABLES;
/** Uploaded tables whose rows legitimately disappear on the hub (tax lines are recomputed). */
const DELETABLE_UPLOADS = new Set(['order_item_taxes']);

interface TableMeta {
  columns: string[];
  primaryKey: string[];
  identity: Set<string>;
}
const metaCache = new Map<string, TableMeta>();

const IDENT = /^[a-z_][a-z0-9_]*$/;
const quote = (name: string) => {
  if (!IDENT.test(name)) throw new Error(`Invalid identifier ${name}`);
  return `"${name}"`;
};

export async function tableMeta(sql: Sql, table: string): Promise<TableMeta> {
  const cached = metaCache.get(table);
  if (cached) return cached;
  const columns = await sql.query<{ name: string; identity: boolean }>(
    `select a.attname as name, a.attidentity <> '' as identity
       from pg_attribute a
      where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped
      order by a.attnum`,
    [`public.${quote(table)}`],
  );
  const pk = await sql.query<{ name: string }>(
    `select a.attname as name
       from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
      where i.indrelid = $1::regclass and i.indisprimary
      order by array_position(i.indkey, a.attnum)`,
    [`public.${quote(table)}`],
  );
  const meta: TableMeta = {
    columns: columns.map((c) => c.name),
    primaryKey: pk.map((p) => p.name),
    identity: new Set(columns.filter((c) => c.identity).map((c) => c.name)),
  };
  metaCache.set(table, meta);
  return meta;
}

/**
 * Inserts or replaces one row by primary key, using only the columns present in `row` that the
 * table has (unknown keys are ignored, so an older peer's extra columns cannot break sync).
 * Returns true when the row was new.
 */
export async function upsertRow(
  sql: Sql,
  table: string,
  row: Row,
  options: { exclude?: readonly string[]; insertOnly?: boolean } = {},
): Promise<boolean> {
  const meta = await tableMeta(sql, table);
  const skip = new Set([...(options.exclude ?? []), ...meta.identity]);
  const cols = meta.columns.filter((c) => c in row && !skip.has(c));
  const list = cols.map(quote).join(', ');
  const keys = meta.primaryKey.map(quote).join(', ');
  const updatable = cols.filter((c) => !meta.primaryKey.includes(c));
  const onConflict =
    options.insertOnly || updatable.length === 0
      ? 'do nothing'
      : `do update set (${updatable.map(quote).join(', ')}) = row(${updatable
          .map((c) => `excluded.${quote(c)}`)
          .join(', ')})`;
  const inserted = await sql.query<{ inserted: boolean }>(
    `insert into ${quote(table)} (${list})
       select ${list} from jsonb_populate_record(null::${quote(table)}, $1::jsonb)
     on conflict (${keys}) ${onConflict}
     returning (xmax = 0) as inserted`,
    [JSON.stringify(row)],
  );
  return inserted[0]?.inserted ?? false;
}

/** Event rows made elsewhere: inserted once per origin id (their own sequence id is local). */
async function insertByOrigin(sql: Sql, table: string, row: Row): Promise<boolean> {
  if (typeof row.origin_id !== 'string') throw new HubRecordError('missing_origin_id');
  const meta = await tableMeta(sql, table);
  const cols = meta.columns.filter((c) => c in row && !meta.identity.has(c));
  const list = cols.map(quote).join(', ');
  const rows = await sql.query(
    `insert into ${quote(table)} (${list})
       select ${list} from jsonb_populate_record(null::${quote(table)}, $1::jsonb)
     on conflict (origin_id) where origin_id is not null do nothing
     returning 1`,
    [JSON.stringify(row)],
  );
  return rows.length > 0;
}

/**
 * A stock movement made elsewhere: stored once, and its quantity change applied to the item the
 * first time it is seen. Both sides therefore converge to the sum of all movements.
 */
export async function applyForeignMovement(sql: Sql, row: Row): Promise<boolean> {
  const inserted = await upsertRow(sql, 'stock_movements', row, { insertOnly: true });
  if (inserted) {
    await sql.query(
      `update inventory_items set quantity = quantity + $2::numeric, updated_at = now() where id = $1`,
      [row.item_id, String(row.quantity_delta)],
    );
  }
  return inserted;
}

export class HubRecordError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'HubRecordError';
  }
}

export function createHubSyncRepository(sql: Sql): HubSyncRepository {
  return {
    async branchHub(branchId) {
      const [r] = await sql.query<{ hub_device_id: string | null }>(
        'select hub_device_id from branches where id = $1',
        [branchId],
      );
      return r ? r.hub_device_id : null;
    },

    async setBranchHub(branchId, deviceId) {
      await sql.query('update branches set hub_device_id = $2 where id = $1', [branchId, deviceId]);
    },

    async snapshot(branchId) {
      const out: Record<string, Row[]> = {};
      for (const spec of SNAPSHOT_TABLES) {
        const minus = (spec.exclude ?? []).map((c) => ` - '${c}'`).join('');
        const where = spec.branch ? `where t.${quote(spec.branch)} = $1` : '';
        out[spec.table] = (
          await sql.query<{ r: Row }>(
            `select to_jsonb(t)${minus} as r from ${quote(spec.table)} t ${where}`,
            spec.branch ? [branchId] : [],
          )
        ).map((x) => x.r);
      }
      return out;
    },

    async orderCounters(branchId) {
      return (
        await sql.query<{ r: Row }>(
          `select to_jsonb(c) as r from order_number_counters c
            where c.branch_id = $1
            order by c.business_day desc
            limit 3`,
          [branchId],
        )
      ).map((x) => x.r);
    },

    async openOrders(branchId, hubDeviceId) {
      const [r] = await sql.query<{ n: number }>(
        `select count(*)::int as n from orders
          where branch_id = $1 and status not in ('completed', 'cancelled', 'voided')
            and hub_device_id is distinct from $2`,
        [branchId, hubDeviceId],
      );
      return r!.n;
    },

    async movementsSince(branchId, since) {
      return (
        await sql.query<{ r: Row }>(
          `select to_jsonb(m) as r from stock_movements m
            where m.branch_id = $1 and ($2::timestamptz is null or m.created_at >= $2::timestamptz)
            order by m.created_at, m.id`,
          [branchId, since],
        )
      ).map((x) => x.r);
    },

    async findBatch(batchId) {
      const [r] = await sql.query<{
        records: number;
        applied: number;
        conflicts: HubIngestOutcome['conflicts'];
      }>('select records, applied, conflicts from hub_sync_batches where id = $1', [batchId]);
      return r ? { batchId, records: r.records, applied: r.applied, conflicts: r.conflicts } : null;
    },

    async saveBatch(b) {
      await sql.query(
        `insert into hub_sync_batches (id, restaurant_id, branch_id, hub_device_id, records, applied, conflicts)
         values ($1, app.current_restaurant_id(), $2, $3, $4, $5, $6::jsonb)`,
        [b.batchId, b.branchId, b.hubDeviceId, b.records, b.applied, JSON.stringify(b.conflicts)],
      );
    },

    async applyUpload(branchId, restaurantId, table, row, deleted = false, hubDeviceId = null) {
      const kind = UPLOAD_TABLES[table as UploadTable];
      if (!kind) throw new HubRecordError('table_not_uploadable');
      if (deleted && !DELETABLE_UPLOADS.has(table)) throw new HubRecordError('delete_not_allowed');
      // The hub is authoritative for this branch: its uploads pass the branch guard (migration 0800).
      await sql.query(`select set_config('app.hub_sync', 'on', true)`);
      const record: Row = {
        ...row,
        restaurant_id: restaurantId,
        ...(table === 'orders' ? { hub_device_id: hubDeviceId } : {}),
      };
      // Restaurant-wide records (e.g. audit of PIN sign-ins and device pairing) have no branch.
      if ('branch_id' in record && record.branch_id !== null && record.branch_id !== branchId)
        throw new HubRecordError('other_branch');
      if (typeof record.order_id === 'string' && !('branch_id' in record)) {
        const [o] = await sql.query<{ branch_id: string }>('select branch_id from orders where id = $1', [
          record.order_id,
        ]);
        if (o && o.branch_id !== branchId) throw new HubRecordError('other_branch');
      }
      await sql.query('savepoint hub_record');
      try {
        let applied: boolean;
        if (deleted) {
          const meta = await tableMeta(sql, table);
          const match = meta.primaryKey.map((k, i) => `${quote(k)}::text = $${i + 1}`).join(' and ');
          const removed = await sql.query(
            `delete from ${quote(table)} where ${match} returning 1`,
            meta.primaryKey.map((k) => String(record[k])),
          );
          await sql.query('release savepoint hub_record');
          return removed.length > 0;
        }
        switch (kind) {
          case 'upsert':
            await upsertRow(sql, table, record);
            if (table === 'orders') {
              // Keep the cloud's counter ahead of the hub's numbers, so that if the hub is ever detached
              // the web POS continues the day's numbering without reusing a number.
              await sql.query(
                `insert into order_number_counters (restaurant_id, branch_id, business_day, next_number)
                 values ($1, $2, $3::date, $4::int + 1)
                 on conflict (branch_id, business_day)
                 do update set next_number = greatest(order_number_counters.next_number, excluded.next_number)`,
                [restaurantId, branchId, record.business_day, record.order_number],
              );
            }
            applied = true;
            break;
          case 'origin':
            applied = await insertByOrigin(sql, table, record);
            break;
          case 'customer': {
            const [clash] = await sql.query<{ id: string }>(
              `select id from customers where phone = $1 and merged_into_id is null and id <> $2`,
              [record.phone, record.id],
            );
            if (clash) await upsertRow(sql, table, { ...record, merged_into_id: clash.id });
            else await upsertRow(sql, table, record, { exclude: ['merged_into_id'] });
            applied = true;
            break;
          }
          case 'movement':
            applied = await applyForeignMovement(sql, record);
            break;
          case 'table_status': {
            const updated = await sql.query(
              `update dining_tables set status = $3::table_status, status_changed_at = $4::timestamptz,
                      version = version + 1
                where id = $1 and branch_id = $2
                  and (status is distinct from $3::table_status or status_changed_at < $4::timestamptz)
                returning 1`,
              [record.id, branchId, record.status, record.status_changed_at],
            );
            applied = updated.length > 0;
            break;
          }
        }
        await sql.query('release savepoint hub_record');
        return applied;
      } catch (error) {
        await sql.query('rollback to savepoint hub_record');
        const e = error as { code?: string; message?: string; constraint_name?: string; constraint?: string };
        throw new HubRecordError(
          e.code === '23503'
            ? `missing_reference:${e.constraint_name ?? e.constraint ?? ''}`
            : e.code === '23505'
              ? `duplicate:${e.constraint_name ?? e.constraint ?? ''}`
              : e.code === '23514'
                ? `check_failed:${e.constraint_name ?? e.constraint ?? ''}`
                : `database:${e.code ?? 'unknown'}`,
        );
      }
    },
  };
}
