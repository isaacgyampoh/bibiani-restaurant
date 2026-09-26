import type { HubBatchCommand, HubBatchResultView, HubSnapshotView } from '@rp/contracts';
import {
  applyForeignMovement,
  type Database,
  SNAPSHOT_TABLES,
  type Sql,
  tableMeta,
  upsertRow,
} from '@rp/infrastructure';
import { CAPTURED_TABLES } from './hub-schema';

type Row = Record<string, unknown>;
const TABLE_ORDER = new Map(CAPTURED_TABLES.map((t, i) => [t.table, i]));
/** Re-read stock movements this far back on every pull: late commits are caught, ids dedupe. */
const MOVEMENT_OVERLAP_MS = 10 * 60 * 1000;

const quote = (name: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Invalid identifier ${name}`);
  return `"${name}"`;
};

async function applying(sql: Sql) {
  await sql.query(`select set_config('hub.applying', 'on', true)`);
}

export async function getState<T>(db: Sql, key: string): Promise<T | null> {
  const [r] = await db.query<{ value: T }>('select value from hub.state where key = $1', [key]);
  return r ? r.value : null;
}

export async function setState(db: Sql, key: string, value: unknown): Promise<void> {
  await db.query(
    'insert into hub.state (key, value) values ($1, $2::jsonb) on conflict (key) do update set value = excluded.value',
    [key, JSON.stringify(value)],
  );
}

export interface HubIdentity {
  restaurantId: string;
  branchId: string;
  hubDeviceId: string;
  attached: boolean;
  snapshotAt: string;
}

/**
 * Replaces the hub's copy of the branch configuration with the cloud's. Columns the hub owns
 * (PIN digests, device pairings and health, table status, stock quantities) are never in a
 * snapshot and are left untouched. A PIN changed in the cloud invalidates the hub's copy of it.
 */
export async function applySnapshot(db: Database, snapshot: HubSnapshotView): Promise<void> {
  await db.transaction(async (sql) => {
    await applying(sql);
    const staff = snapshot.tables.staff ?? [];
    for (const s of staff) {
      if (typeof s.user_id === 'string')
        await sql.query('insert into auth.users (id) values ($1) on conflict do nothing', [s.user_id]);
      await sql.query(
        `update staff set pin_lookup = null
          where id = $1 and pin_lookup is not null and pin_version is distinct from $2::int`,
        [s.id, s.pin_version ?? 0],
      );
    }
    // The snapshot is consistent as a whole but has reference cycles (devices <-> printers), so rows
    // are written with foreign-key triggers suspended, then checks are restored before deletions.
    await sql.query(`set local session_replication_role = replica`);
    for (const spec of SNAPSHOT_TABLES) {
      for (const row of snapshot.tables[spec.table] ?? []) await upsertRow(sql, spec.table, row);
    }
    await sql.query(`set local session_replication_role = origin`);
    for (const c of snapshot.orderCounters ?? [])
      await sql.query(
        `insert into order_number_counters (restaurant_id, branch_id, business_day, next_number)
         values ($1, $2, $3::date, $4::int)
         on conflict (branch_id, business_day)
         do update set next_number = greatest(order_number_counters.next_number, excluded.next_number)`,
        [c.restaurant_id, c.branch_id, c.business_day, c.next_number],
      );
    for (const spec of [...SNAPSHOT_TABLES].reverse()) {
      if (spec.table === 'restaurants') continue;
      await removeMissing(sql, spec, snapshot);
    }
    const identity: HubIdentity = {
      restaurantId: snapshot.restaurantId,
      branchId: snapshot.branchId,
      hubDeviceId: snapshot.hubDeviceId,
      attached: snapshot.attached,
      snapshotAt: snapshot.generatedAt,
    };
    await setState(sql, 'identity', identity);
  });
}

/** Deletes local config rows the cloud no longer has; rows still referenced locally are switched off. */
async function removeMissing(
  sql: Sql,
  spec: (typeof SNAPSHOT_TABLES)[number],
  snapshot: HubSnapshotView,
): Promise<void> {
  const meta = await tableMeta(sql, spec.table);
  const keyOf = (r: Row) => JSON.stringify(meta.primaryKey.map((k) => String(r[k])));
  const keep = new Set((snapshot.tables[spec.table] ?? []).map(keyOf));
  const cols = meta.primaryKey.map(quote).join(', ');
  const where = spec.branch ? `where ${quote(spec.branch)} = $1` : '';
  const local = await sql.query<Row>(
    `select ${cols} from ${quote(spec.table)} ${where}`,
    spec.branch ? [snapshot.branchId] : [],
  );
  for (const row of local) {
    if (keep.has(keyOf(row))) continue;
    const match = meta.primaryKey.map((k, i) => `${quote(k)}::text = $${i + 1}`).join(' and ');
    const params = meta.primaryKey.map((k) => String(row[k]));
    await sql.query('savepoint hub_remove');
    try {
      await sql.query(`delete from ${quote(spec.table)} where ${match}`, params);
      await sql.query('release savepoint hub_remove');
    } catch {
      await sql.query('rollback to savepoint hub_remove');
      if (meta.columns.includes('is_active'))
        await sql.query(`update ${quote(spec.table)} set is_active = false where ${match}`, params);
    }
  }
}

/** Stock movements made in the back office (or echoed back): each applied once, as a quantity change. */
export async function applyMovements(db: Database, movements: Row[], pulledAt: string): Promise<number> {
  let applied = 0;
  await db.transaction(async (sql) => {
    await applying(sql);
    for (const m of movements) if (await applyForeignMovement(sql, m)) applied++;
    await setState(
      sql,
      'movements_since',
      new Date(Date.parse(pulledAt) - MOVEMENT_OVERLAP_MS).toISOString(),
    );
  });
  return applied;
}

export interface TakenBatch {
  command: HubBatchCommand;
  keys: { table: string; key: Row }[];
}

/**
 * Takes the oldest pending changes (at most `limit`) and marks them syncing. Each record carries the
 * row's CURRENT state; parents are placed before children. Returns null when nothing is pending.
 */
export async function takeBatch(db: Database, batchId: string, limit: number): Promise<TakenBatch | null> {
  return db.transaction(async (sql) => {
    const pending = await sql.query<{ table_name: string; row_key: Row; seq: string }>(
      `update hub.outbox set state = 'syncing', dirty = false
        where (table_name, row_key) in (
          select table_name, row_key from hub.outbox where state = 'pending' order by seq limit $1 for update)
        returning table_name, row_key, seq`,
      [limit],
    );
    if (pending.length === 0) return null;
    pending.sort(
      (a, b) =>
        (TABLE_ORDER.get(a.table_name) ?? 99) - (TABLE_ORDER.get(b.table_name) ?? 99) ||
        Number(a.seq) - Number(b.seq),
    );
    const records: HubBatchCommand['records'] = [];
    const keys: TakenBatch['keys'] = [];
    for (const p of pending) {
      const cols = Object.keys(p.row_key);
      const [current] = await sql.query<{ r: Row }>(
        `select to_jsonb(t) as r from ${quote(p.table_name)} t
          where (${cols.map((c) => `t.${quote(c)}`).join(', ')}) =
                (select ${cols.map(quote).join(', ')} from jsonb_populate_record(null::${quote(p.table_name)}, $1::jsonb))`,
        [JSON.stringify(p.row_key)],
      );
      keys.push({ table: p.table_name, key: p.row_key });
      // A row gone locally is sent as a deletion; the cloud accepts that only where it is legitimate
      // (recomputed tax lines) and reports anything else as a conflict.
      records.push(
        current
          ? { table: p.table_name, row: current.r }
          : { table: p.table_name, row: p.row_key, deleted: true },
      );
    }
    return { command: { batchId, records }, keys };
  });
}

/** Acknowledged by the cloud: synced (or pending again if changed meanwhile); refused records -> conflict. */
export async function completeBatch(
  db: Database,
  taken: TakenBatch,
  result: HubBatchResultView,
): Promise<void> {
  const conflicts = new Map(result.conflicts.map((c) => [c.index, c.reason]));
  await db.transaction(async (sql) => {
    for (const [index, k] of taken.keys.entries()) {
      const reason = conflicts.get(index);
      await sql.query(
        `update hub.outbox set
            state = case when $3::text is not null then 'conflict' when dirty then 'pending' else 'synced' end,
            conflict_reason = $3, last_error = null, dirty = false,
            synced_at = case when $3::text is null then now() else synced_at end
          where table_name = $1 and row_key = $2::jsonb`,
        [k.table, JSON.stringify(k.key), reason ?? null],
      );
    }
    await setState(sql, 'last_upload', { at: new Date().toISOString(), batchId: result.batchId });
  });
}

/** The upload did not reach the cloud (or was refused as a whole): everything goes back to pending. */
export async function failBatch(db: Database, taken: TakenBatch, error: string): Promise<void> {
  await db.transaction(async (sql) => {
    for (const k of taken.keys)
      await sql.query(
        `update hub.outbox set state = 'pending', dirty = false, attempts = attempts + 1, last_error = $3
          where table_name = $1 and row_key = $2::jsonb and state = 'syncing'`,
        [k.table, JSON.stringify(k.key), error.slice(0, 300)],
      );
  });
}

/** After a crash, uploads that were in flight are simply sent again (the cloud applies them idempotently). */
export async function recoverInFlight(db: Sql): Promise<void> {
  await db.query(`update hub.outbox set state = 'pending' where state = 'syncing'`);
}

export interface OutboxStats {
  pending: number;
  retrying: number;
  conflicts: number;
  synced: number;
  oldestPendingAt: string | null;
  conflictList: { table: string; key: Row; reason: string | null }[];
}

export async function outboxStats(db: Sql): Promise<OutboxStats> {
  const [c] = await db.query<{
    pending: number;
    retrying: number;
    conflicts: number;
    synced: number;
    oldest: string | null;
  }>(
    `select count(*) filter (where state in ('pending', 'syncing'))::int as pending,
            count(*) filter (where state in ('pending', 'syncing') and attempts > 0)::int as retrying,
            count(*) filter (where state = 'conflict')::int as conflicts,
            count(*) filter (where state = 'synced')::int as synced,
            min(changed_at) filter (where state in ('pending', 'syncing')) as oldest
       from hub.outbox`,
  );
  const conflictList = await db.query<{ table: string; key: Row; reason: string | null }>(
    `select table_name as table, row_key as key, conflict_reason as reason
       from hub.outbox where state = 'conflict' order by changed_at limit 50`,
  );
  return {
    pending: c!.pending,
    retrying: c!.retrying,
    conflicts: c!.conflicts,
    synced: c!.synced,
    oldestPendingAt: c!.oldest ? new Date(c!.oldest).toISOString() : null,
    conflictList,
  };
}
