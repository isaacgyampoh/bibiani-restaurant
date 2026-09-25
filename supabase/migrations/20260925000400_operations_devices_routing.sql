-- Operational structure: areas, tables, stations, devices, printers, routing.
-- Hierarchy: restaurant -> branch -> operational area (where orders originate)
--            branch -> station (where items are produced; shared by all areas)
--            branch -> device (optionally bound to a station)

create table operational_areas (
  id                     uuid primary key default gen_random_uuid(),
  restaurant_id          uuid not null references restaurants(id),
  branch_id              uuid not null,
  name                   text not null,                       -- "Hall", "Takeaway counter"
  channel                order_channel not null,              -- behaviour key; name is free text
  requires_table         boolean not null default false,
  requires_customer_name boolean not null default false,
  require_payment_before_production boolean not null default false,
  show_on_customer_display boolean not null default true,
  is_active              boolean not null default true,
  sort_order             int not null default 0,
  unique (restaurant_id, id),
  unique (branch_id, name),
  foreign key (restaurant_id, branch_id) references branches (restaurant_id, id),
  check (not requires_table or channel = 'dine_in')
);
select app.enable_tenant_rls('operational_areas');

create table dining_tables (
  id                 uuid primary key default gen_random_uuid(),
  restaurant_id      uuid not null,
  branch_id          uuid not null,
  area_id            uuid not null,
  label              text not null,
  capacity           int not null default 4 check (capacity > 0),
  status             table_status not null default 'available',
  status_changed_at  timestamptz not null default now(),
  is_active          boolean not null default true,
  version            int not null default 1,
  unique (restaurant_id, id),
  unique (branch_id, label),
  foreign key (restaurant_id, branch_id) references branches (restaurant_id, id),
  foreign key (restaurant_id, area_id) references operational_areas (restaurant_id, id)
);
select app.enable_tenant_rls('dining_tables');

create table stations (
  id                   uuid primary key default gen_random_uuid(),
  restaurant_id        uuid not null,
  branch_id            uuid not null,
  name                 text not null,
  code                 text not null check (code ~ '^[A-Z0-9-]{1,12}$'),
  target_prep_seconds  int check (target_prep_seconds > 0),
  auto_ready           boolean not null default false,   -- e.g. bottled drinks: no preparation
  is_active            boolean not null default true,
  sort_order           int not null default 0,
  unique (restaurant_id, id),
  unique (branch_id, code),
  foreign key (restaurant_id, branch_id) references branches (restaurant_id, id)
);
select app.enable_tenant_rls('stations');

create table devices (
  id                 uuid primary key default gen_random_uuid(),
  restaurant_id      uuid not null,
  branch_id          uuid not null,
  kind               device_kind not null,
  name               text not null,                      -- "POS-01", "PASTRY-KDS-01"
  station_id         uuid,
  auth_user_id       uuid unique references auth.users(id) on delete set null,  -- device identity after pairing
  config             jsonb not null default '{}',
  status             device_status not null default 'unknown',
  last_heartbeat_at  timestamptz,
  app_version        text,
  is_active          boolean not null default true,
  created_at         timestamptz not null default now(),
  unique (restaurant_id, id),
  unique (branch_id, name),
  foreign key (restaurant_id, branch_id) references branches (restaurant_id, id),
  foreign key (restaurant_id, station_id) references stations (restaurant_id, id)
);
select app.enable_tenant_rls('devices');
create index devices_branch_kind_idx on devices (branch_id, kind);

-- Printer details for devices of kind 'printer'. Driven by a print agent on the LAN.
create table printers (
  device_id          uuid primary key,
  restaurant_id      uuid not null,
  connection         printer_connection not null,
  address            text,                         -- "192.168.1.50:9100"
  agent_device_id    uuid,
  paper_width_mm     int not null default 80 check (paper_width_mm in (58, 80)),
  backup_printer_id  uuid,
  last_error         text,
  last_status_at     timestamptz,
  unique (restaurant_id, device_id),
  foreign key (restaurant_id, device_id) references devices (restaurant_id, id) on delete cascade,
  foreign key (restaurant_id, agent_device_id) references devices (restaurant_id, id),
  foreign key (restaurant_id, backup_printer_id) references printers (restaurant_id, device_id),
  check (backup_printer_id is distinct from device_id)
);
select app.enable_tenant_rls('printers');

-- What a station feeds: printers (print jobs) and KDS screens (read their station).
create table station_outputs (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null,
  station_id     uuid not null,
  device_id      uuid not null,
  role           station_output_role not null default 'primary',
  copies         int not null default 1 check (copies between 1 and 5),
  unique (station_id, device_id),
  foreign key (restaurant_id, station_id) references stations (restaurant_id, id) on delete cascade,
  foreign key (restaurant_id, device_id) references devices (restaurant_id, id) on delete cascade
);
select app.enable_tenant_rls('station_outputs');

-- Routing: product rule > category rule (walking up the tree) > branch default.
-- Area-specific rules beat generic ones at the same level; then higher priority wins.
create table routing_rules (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null,
  branch_id      uuid not null,
  match          routing_match not null,
  product_id     uuid,
  category_id    uuid,
  area_id        uuid,                                 -- null = any operational area
  station_id     uuid not null,
  priority       int not null default 0,
  is_active      boolean not null default true,
  unique (restaurant_id, id),
  foreign key (restaurant_id, branch_id) references branches (restaurant_id, id),
  foreign key (restaurant_id, product_id) references products (restaurant_id, id) on delete cascade,
  foreign key (restaurant_id, category_id) references categories (restaurant_id, id) on delete cascade,
  foreign key (restaurant_id, area_id) references operational_areas (restaurant_id, id),
  foreign key (restaurant_id, station_id) references stations (restaurant_id, id),
  check (
    (match = 'product'  and product_id is not null and category_id is null) or
    (match = 'category' and category_id is not null and product_id is null) or
    (match = 'default'  and product_id is null and category_id is null)
  )
);
select app.enable_tenant_rls('routing_rules');
create unique index routing_rules_one_default_per_branch on routing_rules (branch_id)
  where match = 'default' and area_id is null and is_active;
create index routing_rules_branch_idx on routing_rules (branch_id) where is_active;

-- Extra outputs for a rule, e.g. "Birthday Cake" also prints on a second pastry printer.
create table routing_rule_extra_outputs (
  restaurant_id    uuid not null,
  routing_rule_id  uuid not null,
  device_id        uuid not null,
  primary key (routing_rule_id, device_id),
  foreign key (restaurant_id, routing_rule_id) references routing_rules (restaurant_id, id) on delete cascade,
  foreign key (restaurant_id, device_id) references devices (restaurant_id, id) on delete cascade
);
select app.enable_tenant_rls('routing_rule_extra_outputs');
