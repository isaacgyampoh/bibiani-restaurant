-- In-store hub: one always-on PC per branch runs MY FOOD locally (same migrations, same use cases)
-- and keeps working without internet. See docs/OFFLINE-ARCHITECTURE.md. Additive only.

-- 1. The hub is a device of its branch, paired like any other device, with one narrow permission.
alter type device_kind add value if not exists 'hub';
insert into permissions (code, description) values
  ('hub.sync', 'Act as an in-store hub: download configuration and upload floor records');

-- 2. A branch may be operated by a hub. While set, the cloud refuses floor writes for that branch
--    (the hub is authoritative for its orders); hub uploads are applied with app.hub_sync = 'on'.
alter table branches add column hub_device_id uuid;
alter table branches
  add constraint branches_hub_device_fk foreign key (restaurant_id, hub_device_id) references devices (restaurant_id, id);

create function app.guard_hub_branch() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if coalesce(current_setting('app.hub_sync', true), '') <> 'on'
     and exists (select 1 from public.branches b where b.id = new.branch_id and b.hub_device_id is not null) then
    raise exception 'This branch is run by its in-store hub' using errcode = 'RH001';
  end if;
  return new;
end $$;

create trigger orders_hub_guard before insert or update on orders
  for each row execute function app.guard_hub_branch();
create trigger payments_hub_guard before insert or update on payments
  for each row execute function app.guard_hub_branch();
create trigger production_tickets_hub_guard before insert or update on production_tickets
  for each row execute function app.guard_hub_branch();

-- What a hub last reported about itself and the devices on its restaurant network (health centre).
alter table devices add column hub_health jsonb;

-- Every PIN set or reset bumps the version, so a hub knows its copy of a PIN is stale.
alter table staff add column pin_version int not null default 0;

-- Orders uploaded by a hub remember which hub made them (null = made by the web POS).
alter table orders add column hub_device_id uuid;
alter table orders
  add constraint orders_hub_device_fk foreign key (restaurant_id, hub_device_id) references devices (restaurant_id, id);

-- 3. Event tables use sequence ids, which would collide between hub and cloud. Rows made on a hub
--    carry a stable origin id so an upload applied twice inserts them once.
alter table audit_logs add column origin_id uuid;
create unique index audit_logs_origin_idx on audit_logs (origin_id) where origin_id is not null;
alter table order_events add column origin_id uuid;
create unique index order_events_origin_idx on order_events (origin_id) where origin_id is not null;
alter table production_ticket_events add column origin_id uuid;
create unique index production_ticket_events_origin_idx on production_ticket_events (origin_id)
  where origin_id is not null;

-- 4. Upload batches received from hubs. A batch id is applied once; a repeat returns the same result.
create table hub_sync_batches (
  id              uuid primary key,
  restaurant_id   uuid not null references restaurants(id),
  branch_id       uuid not null,
  hub_device_id   uuid not null,
  received_at     timestamptz not null default now(),
  records         int not null check (records >= 0),
  applied         int not null check (applied >= 0),
  conflicts       jsonb not null default '[]',
  foreign key (restaurant_id, branch_id) references branches (restaurant_id, id),
  foreign key (restaurant_id, hub_device_id) references devices (restaurant_id, id)
);
select app.enable_tenant_rls('hub_sync_batches');
create index hub_sync_batches_hub_idx on hub_sync_batches (hub_device_id, received_at desc);
