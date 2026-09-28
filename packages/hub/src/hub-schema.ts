/**
 * Hub-only schema, applied on every start after the migrations (idempotent). Never part of
 * supabase/migrations: the cloud has no outbox. Change capture writes one outbox row per changed
 * floor record; the sync engine uploads the record's CURRENT state, so repeated changes collapse.
 *
 * Outbox states: pending -> syncing -> synced | conflict. A record changed while syncing is marked
 * dirty and goes back to pending after the acknowledgement. Nothing is ever dropped.
 */

/** Floor tables the hub uploads, with the columns that identify a row (matches UPLOAD_TABLES). */
export const CAPTURED_TABLES: readonly { table: string; key: readonly string[]; onlyStatus?: boolean }[] = [
  { table: 'customers', key: ['id'] },
  { table: 'register_sessions', key: ['id'] },
  { table: 'orders', key: ['id'] },
  { table: 'order_submissions', key: ['id'] },
  { table: 'order_items', key: ['id'] },
  { table: 'order_item_modifiers', key: ['id'] },
  { table: 'order_item_taxes', key: ['order_item_id', 'tax_rate_id'] },
  { table: 'order_discounts', key: ['id'] },
  { table: 'production_tickets', key: ['id'] },
  { table: 'production_ticket_items', key: ['ticket_id', 'order_item_id'] },
  { table: 'payments', key: ['id'] },
  { table: 'dining_tables', key: ['id'], onlyStatus: true },
  { table: 'stock_movements', key: ['id'] },
  { table: 'order_events', key: ['origin_id'] },
  { table: 'production_ticket_events', key: ['origin_id'] },
  { table: 'audit_logs', key: ['origin_id'] },
];

const ORIGIN_TABLES = ['audit_logs', 'order_events', 'production_ticket_events'];

export const HUB_SCHEMA_SQL = `
create schema if not exists hub;

create table if not exists hub.state (key text primary key, value jsonb not null);

create table if not exists hub.outbox (
  table_name       text not null,
  row_key          jsonb not null,
  seq              bigint not null,
  state            text not null default 'pending' check (state in ('pending', 'syncing', 'synced', 'conflict')),
  dirty            boolean not null default false,
  attempts         int not null default 0,
  last_error       text,
  conflict_reason  text,
  changed_at       timestamptz not null default now(),
  synced_at        timestamptz,
  primary key (table_name, row_key)
);
create sequence if not exists hub.outbox_seq;
create index if not exists hub_outbox_pending_idx on hub.outbox (seq) where state = 'pending';

-- Rows written while applying data FROM the cloud are not captured (hub.applying = on).
create or replace function hub.capture() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  r jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  k jsonb := '{}';
  col text;
begin
  if coalesce(current_setting('hub.applying', true), '') = 'on' then
    return null;
  end if;
  foreach col in array tg_argv loop
    k := k || jsonb_build_object(col, r -> col);
  end loop;
  insert into hub.outbox as o (table_name, row_key, seq)
  values (tg_table_name, k, nextval('hub.outbox_seq'))
  on conflict (table_name, row_key) do update set
    state = case when o.state in ('synced', 'conflict') then 'pending' else o.state end,
    seq = case when o.state in ('synced', 'conflict') then nextval('hub.outbox_seq') else o.seq end,
    dirty = o.dirty or o.state = 'syncing',
    attempts = case when o.state in ('synced', 'conflict') then 0 else o.attempts end,
    conflict_reason = null,
    changed_at = now();
  return null;
end $$;

${ORIGIN_TABLES.map((t) => `alter table public.${t} alter column origin_id set default gen_random_uuid();`).join('\n')}

${CAPTURED_TABLES.map(
  ({ table, key, onlyStatus }) => `
drop trigger if exists hub_capture on public.${table};
create trigger hub_capture after insert or ${onlyStatus ? 'update of status' : 'update or delete'} on public.${table}
  for each row execute function hub.capture(${key.map((k) => `'${k}'`).join(', ')});`,
).join('\n')}
`;
