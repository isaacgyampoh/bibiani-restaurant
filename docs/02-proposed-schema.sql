-- =============================================================================
-- SUPERSEDED (Phase 3, 2026-09-25): the implemented schema is supabase/migrations/.
-- This Phase 1 draft is kept for history. Corrections made during Phase 3:
--   * Tenant-scoped composite foreign keys ((restaurant_id, x_id)) so no row can
--     reference another restaurant's rows, even when RLS is bypassed by FK checks.
--   * Browser roles get no table privileges; the API runs as role app_api under
--     RLS with a transaction-local tenant (ADR 0001).
--   * order_types -> operational_areas (with channel, table/name requirements,
--     pay-before-production flag).
--   * Payments are manual records: no payment_methods/provider tables; method is an
--     enum (cash, momo, card); record status recorded|voided (ADR 0002).
--   * order_taxes -> order_item_taxes (per-line tax snapshot).
--   * order_items.position for stable line order; print_jobs.claim_id (lease
--     token), possible_duplicate flag; 'uncertain' status folded into failed +
--     possible_duplicate.
--   * Deferred to later migrations: shifts, cash movements, floors/sections,
--     inventory, displays/media, alerts, staff PIN sessions, order-number leases.
-- =============================================================================

-- =============================================================================
-- PROPOSED SCHEMA — Restaurant Operating Platform (Supabase / PostgreSQL 15+)
-- Status: DESIGN DRAFT for review. Not a migration. Will be split into ordered
-- migrations under supabase/migrations/ during Phase 3.
--
-- Conventions
--   * uuid PKs. Operational rows (orders, submissions, payments) use
--     CLIENT-GENERATED uuids so that retries are naturally idempotent.
--   * Money = bigint minor units (pesewas for GHS). Never float/numeric-in-JS.
--   * Every tenant row carries restaurant_id (denormalised) so RLS is a single
--     indexed predicate. Branch-scoped rows also carry branch_id.
--   * Operational tables (orders, tickets, payments, stock, audit) have NO
--     insert/update/delete RLS policies: all writes go through RPC functions
--     that validate permissions and run in one transaction.
--   * Status history is append-only in *_events tables (traceability).
--   * `version int` on hot rows for optimistic concurrency.
-- =============================================================================

create extension if not exists pgcrypto;
create extension if not exists pg_cron;      -- heartbeat sweeps, job retries
create schema if not exists app;             -- private helper functions (not exposed via PostgREST)

-- -----------------------------------------------------------------------------
-- ENUMS
-- -----------------------------------------------------------------------------
create type device_kind as enum (
  'pos', 'waiter_tablet', 'kiosk', 'kds', 'printer', 'print_agent',
  'customer_display', 'marketing_display', 'cash_drawer'
);
create type device_status as enum ('online', 'offline', 'degraded', 'unknown');

create type order_channel as enum ('dine_in', 'takeaway', 'delivery', 'online', 'kiosk', 'drive_through');

-- Lifecycle of the customer order (fulfilment dimension).
create type order_status as enum (
  'draft',            -- being built on a POS, nothing sent to production
  'open',             -- dine-in tab open, may have unsent items
  'submitted',        -- at least one submission sent; nothing started
  'in_preparation',   -- at least one item being prepared
  'partially_ready',  -- some active items ready, some not
  'ready',            -- every active item ready
  'served',           -- dine-in: delivered to table
  'picked_up',        -- takeaway/delivery handed over
  'completed',        -- fulfilled AND settled; closed
  'on_hold',          -- manually held (e.g. customer not arrived)
  'cancelled',        -- cancelled before production/fulfilment
  'voided'            -- voided after submission (manager, audited)
);
-- Money dimension, independent of fulfilment. REFUNDED lives here, not in order_status.
create type payment_state as enum ('unpaid', 'partially_paid', 'paid', 'partially_refunded', 'refunded');

create type order_item_status as enum (
  'pending',          -- in cart / on tab, not yet sent
  'sent',             -- on a production ticket
  'accepted',
  'in_preparation',
  'ready',
  'served',           -- dine-in delivered / takeaway handed over
  'cancelled',        -- removed before preparation
  'voided'            -- removed after preparation started (waste, audited)
);

create type ticket_status as enum (
  'new', 'accepted', 'in_preparation', 'on_hold', 'ready', 'completed', 'cancelled'
);

create type print_job_kind as enum ('production_ticket', 'receipt', 'bill', 'void_ticket', 'shift_report', 'test');
create type print_job_status as enum (
  'pending',     -- waiting for an agent
  'claimed',     -- leased by an agent (lease_expires_at)
  'printed',     -- agent confirmed bytes accepted by printer
  'failed',      -- attempt failed BEFORE bytes were sent; will retry
  'uncertain',   -- failure AFTER bytes may have been sent; retry marked "POSSIBLE DUPLICATE"
  'dead',        -- retries exhausted; surfaced as an alert, needs human action
  'cancelled'
);
create type printer_connection as enum ('network_escpos', 'usb_escpos', 'android_builtin', 'browser');

create type payment_direction as enum ('charge', 'refund');
create type payment_txn_status as enum ('pending', 'succeeded', 'failed', 'cancelled');
create type payment_method_kind as enum ('cash', 'mobile_money', 'card', 'bank_transfer', 'voucher', 'house_account', 'other');

create type table_status as enum ('available', 'occupied', 'reserved', 'cleaning', 'payment_pending', 'out_of_service');
create type shift_status as enum ('open', 'counting', 'closed', 'reviewed');
create type stock_movement_kind as enum ('purchase', 'sale', 'sale_reversal', 'wastage', 'adjustment', 'transfer_out', 'transfer_in', 'production_in', 'production_out', 'count');
create type routing_match as enum ('product', 'category', 'default');
create type station_output_role as enum ('primary', 'copy', 'backup');

-- -----------------------------------------------------------------------------
-- TENANCY
-- -----------------------------------------------------------------------------
create table restaurants (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  slug            text not null unique,
  currency        char(3) not null default 'GHS',
  timezone        text not null default 'Africa/Accra',
  branding        jsonb not null default '{}',   -- logo path, colours, receipt header/footer
  is_active       boolean not null default true,
  created_at      timestamptz not null default now()
);

create table branches (
  id                   uuid primary key default gen_random_uuid(),
  restaurant_id        uuid not null references restaurants(id),
  name                 text not null,
  code                 text not null,                  -- short code used in device names / numbers
  address              text,
  phone                text,
  business_day_cutoff  time not null default '04:00',  -- sales before this belong to previous business day
  settings             jsonb not null default '{}',
  is_active            boolean not null default true,
  created_at           timestamptz not null default now(),
  unique (restaurant_id, code)
);
create index on branches (restaurant_id);

-- -----------------------------------------------------------------------------
-- IDENTITY, ROLES, PERMISSIONS
-- -----------------------------------------------------------------------------
create table platform_admins (             -- SaaS operator staff. Not reachable via tenant RLS.
  user_id    uuid primary key references auth.users(id),
  created_at timestamptz not null default now()
);

create table permissions (                 -- static catalogue, seeded by migration
  code        text primary key,            -- e.g. 'order.void', 'payment.refund', 'menu.edit'
  description text not null
);

create table roles (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references restaurants(id),
  name           text not null,
  is_system      boolean not null default false,   -- seeded templates (Owner, Manager, Cashier...)
  created_at     timestamptz not null default now(),
  unique (restaurant_id, name)
);

create table role_permissions (
  role_id          uuid not null references roles(id) on delete cascade,
  permission_code  text not null references permissions(code),
  primary key (role_id, permission_code)
);

-- A person in a restaurant. May or may not have an auth.users login
-- (kitchen staff often only need a PIN on a shared device).
create table staff (
  id              uuid primary key default gen_random_uuid(),
  restaurant_id   uuid not null references restaurants(id),
  user_id         uuid references auth.users(id),     -- null = PIN-only staff
  display_name    text not null,
  phone           text,
  pin_hash        text,                                -- crypt(pin, gen_salt('bf'))
  pin_failed_count int not null default 0,
  pin_locked_until timestamptz,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  unique (restaurant_id, user_id)
);
create index on staff (restaurant_id);

create table staff_roles (
  id          uuid primary key default gen_random_uuid(),
  staff_id    uuid not null references staff(id) on delete cascade,
  role_id     uuid not null references roles(id) on delete cascade,
  branch_id   uuid references branches(id),     -- null = all branches
  unique nulls not distinct (staff_id, role_id, branch_id)
);

-- -----------------------------------------------------------------------------
-- OPERATIONAL STRUCTURE
-- -----------------------------------------------------------------------------
-- Order types are configurable ("Hall", "Takeaway", "Staff meal") but each maps
-- to a fixed channel so the engine knows the behaviour (tables? pickup?).
create table order_types (
  id               uuid primary key default gen_random_uuid(),
  restaurant_id    uuid not null references restaurants(id),
  branch_id        uuid references branches(id),        -- null = all branches
  name             text not null,
  channel          order_channel not null,
  requires_table   boolean not null default false,
  requires_customer_name boolean not null default false,
  show_on_customer_display boolean not null default true,
  service_charge_id uuid,                               -- fk added below
  is_active        boolean not null default true,
  sort_order       int not null default 0
);

create table floors (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references restaurants(id),
  branch_id      uuid not null references branches(id),
  name           text not null,
  sort_order     int not null default 0
);

create table sections (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references restaurants(id),
  branch_id      uuid not null references branches(id),
  floor_id       uuid not null references floors(id),
  name           text not null
);

create table dining_tables (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references restaurants(id),
  branch_id      uuid not null references branches(id),
  floor_id       uuid not null references floors(id),
  section_id     uuid references sections(id),
  label          text not null,                -- "12", "T12", "VIP-1"
  capacity       int not null default 4 check (capacity > 0),
  shape          text not null default 'square',
  pos_x          int, pos_y int, width int, height int, rotation int default 0,  -- floor map
  status         table_status not null default 'available',
  status_changed_at timestamptz not null default now(),
  is_active      boolean not null default true,
  version        int not null default 1,
  unique (branch_id, label)
);

create table stations (
  id                 uuid primary key default gen_random_uuid(),
  restaurant_id      uuid not null references restaurants(id),
  branch_id          uuid not null references branches(id),
  name               text not null,                 -- "Main Kitchen", "Pastry", "Grill", "Bar"...
  code               text not null,                 -- "KIT", "PAS", "GRL"
  color              text,
  target_prep_seconds int,                          -- for late highlighting / ETA
  auto_accept        boolean not null default false,
  auto_ready         boolean not null default false, -- e.g. bottled drinks: no prep needed
  is_active          boolean not null default true,
  sort_order         int not null default 0,
  unique (branch_id, code)
);

-- -----------------------------------------------------------------------------
-- DEVICES & PRINTERS
-- -----------------------------------------------------------------------------
create table devices (
  id              uuid primary key default gen_random_uuid(),
  restaurant_id   uuid not null references restaurants(id),
  branch_id       uuid not null references branches(id),
  auth_user_id    uuid unique references auth.users(id),   -- device identity after pairing
  kind            device_kind not null,
  name            text not null,                           -- "POS-01", "PASTRY-KDS-01"
  station_id      uuid references stations(id),            -- KDS / station printers
  config          jsonb not null default '{}',             -- per-kind settings (layout, sounds...)
  status          device_status not null default 'unknown',
  last_heartbeat_at timestamptz,
  last_ip         inet,
  app_version     text,
  pairing_code_hash text,
  pairing_expires_at timestamptz,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  unique (branch_id, name)
);
create index on devices (branch_id, kind);

create table printers (
  device_id        uuid primary key references devices(id) on delete cascade,  -- devices.kind = 'printer'
  restaurant_id    uuid not null references restaurants(id),
  branch_id        uuid not null references branches(id),
  connection       printer_connection not null,
  address          text,                         -- "192.168.1.50:9100"
  agent_device_id  uuid references devices(id),  -- which print agent drives it
  paper_width_mm   int not null default 80 check (paper_width_mm in (58, 80)),
  chars_per_line   int not null default 48,
  codepage         text not null default 'cp437',
  backup_printer_id uuid references printers(device_id),
  has_cash_drawer  boolean not null default false,
  last_error       text,
  last_error_at    timestamptz
);

-- Which outputs a station feeds: its KDS screens and printers.
create table station_outputs (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references restaurants(id),
  station_id     uuid not null references stations(id) on delete cascade,
  device_id      uuid not null references devices(id),
  role           station_output_role not null default 'primary',
  print_copies   int not null default 1 check (print_copies between 1 and 5),
  unique (station_id, device_id)
);

-- Which receipt printer / cash drawer a POS uses.
create table device_assignments (
  device_id         uuid primary key references devices(id) on delete cascade,
  restaurant_id     uuid not null references restaurants(id),
  receipt_printer_id uuid references printers(device_id),
  bill_printer_id    uuid references printers(device_id),
  default_order_type_id uuid references order_types(id)
);

create table device_events (                 -- connect/disconnect/heartbeat gaps, for observability
  id           bigint generated always as identity primary key,
  restaurant_id uuid not null,
  device_id    uuid not null references devices(id),
  event        text not null,                -- 'connected','disconnected','printer_offline','paper_out'...
  detail       jsonb,
  created_at   timestamptz not null default now()
);
create index on device_events (device_id, created_at desc);

-- -----------------------------------------------------------------------------
-- MENU
-- -----------------------------------------------------------------------------
create table categories (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references restaurants(id),
  parent_id      uuid references categories(id),
  name           text not null,
  color          text,
  image_path     text,
  sort_order     int not null default 0,
  is_active      boolean not null default true
);

create table tax_rates (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references restaurants(id),
  name           text not null,              -- configurable; Ghana levies are NOT hard-coded
  rate_bp        int not null check (rate_bp >= 0),   -- basis points: 1500 = 15.00%
  is_inclusive   boolean not null default true,       -- price already includes tax
  is_compound    boolean not null default false,      -- applied on top of previous taxes
  apply_order    int not null default 0,
  is_active      boolean not null default true
);

create table service_charges (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references restaurants(id),
  name           text not null,
  rate_bp        int,
  fixed_amount   bigint,
  is_taxable     boolean not null default false,
  check ((rate_bp is null) <> (fixed_amount is null))
);
alter table order_types add foreign key (service_charge_id) references service_charges(id);

create table products (
  id                  uuid primary key default gen_random_uuid(),
  restaurant_id       uuid not null references restaurants(id),
  category_id         uuid not null references categories(id),
  name                text not null,
  kitchen_name        text,                    -- short name on tickets ("JOLLOF")
  description         text,
  sku                 text,
  barcode             text,
  base_price          bigint not null check (base_price >= 0),
  image_path          text,
  requires_preparation boolean not null default true,  -- false => item goes straight to 'ready'
  track_stock         boolean not null default false,
  is_combo            boolean not null default false,
  is_active           boolean not null default true,
  version             int not null default 1,
  created_at          timestamptz not null default now(),
  deleted_at          timestamptz,             -- soft delete; history must keep resolving
  unique (restaurant_id, sku),
  unique (restaurant_id, barcode)
);
create index on products (restaurant_id, category_id) where deleted_at is null;

create table product_taxes (
  product_id  uuid not null references products(id) on delete cascade,
  tax_rate_id uuid not null references tax_rates(id),
  primary key (product_id, tax_rate_id)
);

-- Per-branch availability & price overrides (multi-location readiness).
create table branch_products (
  branch_id      uuid not null references branches(id),
  product_id     uuid not null references products(id),
  restaurant_id  uuid not null references restaurants(id),
  price_override bigint check (price_override >= 0),
  is_available   boolean not null default true,     -- "86'd" / sold out
  primary key (branch_id, product_id)
);

-- Combo components route individually (a combo can hit Grill + Drinks).
create table combo_components (
  combo_product_id     uuid not null references products(id) on delete cascade,
  component_product_id uuid not null references products(id),
  quantity             int not null default 1 check (quantity > 0),
  primary key (combo_product_id, component_product_id)
);

create table modifier_groups (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references restaurants(id),
  name           text not null,            -- "Spice level", "Extras"
  min_select     int not null default 0,
  max_select     int,                      -- null = unlimited
  check (max_select is null or max_select >= min_select)
);

create table modifiers (
  id                uuid primary key default gen_random_uuid(),
  restaurant_id     uuid not null references restaurants(id),
  group_id          uuid not null references modifier_groups(id) on delete cascade,
  name              text not null,          -- "No pepper", "Extra chicken"
  price_delta       bigint not null default 0,
  linked_product_id uuid references products(id),  -- for stock deduction of add-ons
  is_active         boolean not null default true,
  sort_order        int not null default 0
);

create table product_modifier_groups (
  product_id uuid not null references products(id) on delete cascade,
  group_id   uuid not null references modifier_groups(id) on delete cascade,
  sort_order int not null default 0,
  primary key (product_id, group_id)
);

-- -----------------------------------------------------------------------------
-- ROUTING
-- Resolution per order item (per branch, at submit time):
--   1. product rule (optionally scoped to an order type)
--   2. category rule, walking up the category tree
--   3. branch default rule
-- Highest priority wins at each level; order-type-specific beats generic.
-- The resolved station is SNAPSHOT onto order_items.station_id, so config
-- edits never re-route in-flight orders.
-- -----------------------------------------------------------------------------
create table routing_rules (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references restaurants(id),
  branch_id      uuid not null references branches(id),
  match          routing_match not null,
  product_id     uuid references products(id),
  category_id    uuid references categories(id),
  order_type_id  uuid references order_types(id),   -- null = any order type
  station_id     uuid not null references stations(id),
  priority       int not null default 0,
  is_active      boolean not null default true,
  check (
    (match = 'product'  and product_id is not null and category_id is null) or
    (match = 'category' and category_id is not null and product_id is null) or
    (match = 'default'  and product_id is null and category_id is null)
  )
);
create unique index routing_one_default_per_branch on routing_rules (branch_id)
  where match = 'default' and order_type_id is null and is_active;
create index on routing_rules (branch_id, match, product_id);
create index on routing_rules (branch_id, match, category_id);

-- Extra outputs beyond the station's own (e.g. "Birthday Cake" also → Pastry Display 2).
create table routing_rule_extra_outputs (
  routing_rule_id uuid not null references routing_rules(id) on delete cascade,
  device_id       uuid not null references devices(id),
  primary key (routing_rule_id, device_id)
);

-- -----------------------------------------------------------------------------
-- SHIFTS / CASH SESSIONS
-- -----------------------------------------------------------------------------
create table shifts (
  id              uuid primary key,                 -- client-generated
  restaurant_id   uuid not null references restaurants(id),
  branch_id       uuid not null references branches(id),
  device_id       uuid references devices(id),      -- the till / cash drawer
  staff_id        uuid not null references staff(id),
  business_day    date not null,
  status          shift_status not null default 'open',
  opening_cash    bigint not null check (opening_cash >= 0),
  counted_cash    bigint,
  expected_cash   bigint,                           -- computed server-side at close
  variance        bigint generated always as (counted_cash - expected_cash) stored,
  count_breakdown jsonb,                            -- denominations
  opened_at       timestamptz not null default now(),
  closed_at       timestamptz,
  reviewed_by     uuid references staff(id),
  reviewed_at     timestamptz,
  notes           text
);
create unique index one_open_shift_per_till on shifts (device_id) where status in ('open','counting');

create table cash_movements (                        -- pay-ins, payouts, expenses from the drawer
  id            uuid primary key,
  restaurant_id uuid not null references restaurants(id),
  shift_id      uuid not null references shifts(id),
  amount        bigint not null,                      -- +in / -out
  reason        text not null,
  staff_id      uuid not null references staff(id),
  created_at    timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- ORDERS
-- -----------------------------------------------------------------------------
-- Human order numbers: unique per branch per business day. Online POS gets the
-- next number from the counter; each POS also leases a small block so it can
-- keep numbering while offline (see 01-architecture.md §I).
create table order_number_counters (
  branch_id     uuid not null references branches(id),
  business_day  date not null,
  next_number   int not null,
  primary key (branch_id, business_day)
);
create table order_number_leases (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id),
  device_id     uuid not null references devices(id),
  business_day  date not null,
  range_start   int not null,
  range_end     int not null,
  next_number   int not null,
  check (range_start <= next_number and next_number <= range_end + 1)
);

create table orders (
  id               uuid primary key,                 -- CLIENT-GENERATED: idempotency anchor
  restaurant_id    uuid not null references restaurants(id),
  branch_id        uuid not null references branches(id),
  business_day     date not null,
  order_number     int not null,
  order_type_id    uuid not null references order_types(id),
  channel          order_channel not null,           -- snapshot of order_type.channel
  status           order_status not null default 'draft',
  payment_state    payment_state not null default 'unpaid',
  table_id         uuid references dining_tables(id),
  guest_count      int,
  customer_name    text,
  customer_phone   text,
  notes            text,
  priority         int not null default 0,
  held_at          timestamptz,                      -- 'on_hold' overlay; rollup never clears it
  held_reason      text,
  -- totals: always recomputed server-side from lines; never trusted from client
  subtotal         bigint not null default 0,
  discount_total   bigint not null default 0,
  service_charge_total bigint not null default 0,
  tax_total        bigint not null default 0,
  grand_total      bigint not null default 0,
  paid_total       bigint not null default 0,
  refunded_total   bigint not null default 0,
  created_by_staff uuid references staff(id),
  created_on_device uuid references devices(id),
  shift_id         uuid references shifts(id),
  opened_at        timestamptz not null default now(),
  first_submitted_at timestamptz,
  ready_at         timestamptz,
  fulfilled_at     timestamptz,
  closed_at        timestamptz,
  cancel_reason    text,
  merged_into_order_id uuid references orders(id),
  client_created_at timestamptz,                     -- device clock, for offline forensics
  synced_at        timestamptz not null default now(),-- when server first saw it
  version          int not null default 1,
  unique (branch_id, business_day, order_number)
);
create index on orders (branch_id, business_day, status);
create index on orders (branch_id, status) where status not in ('completed','cancelled','voided');
create index on orders (table_id) where status not in ('completed','cancelled','voided');
-- At most one active order per table (merges/transfers go through RPCs).
create unique index one_active_order_per_table on orders (table_id)
  where table_id is not null and status not in ('completed','cancelled','voided');

-- Each "send to kitchen" is a submission. It is the idempotency unit for
-- routing: re-sending the same submission id never creates duplicate tickets.
create table order_submissions (
  id              uuid primary key,                   -- CLIENT-GENERATED
  restaurant_id   uuid not null references restaurants(id),
  order_id        uuid not null references orders(id),
  seq             int not null,                       -- 1st round, 2nd round...
  submitted_by    uuid references staff(id),
  device_id       uuid references devices(id),
  submitted_at    timestamptz not null default now(),
  client_submitted_at timestamptz,
  unique (order_id, seq)
);

create table order_items (
  id               uuid primary key,                  -- CLIENT-GENERATED
  restaurant_id    uuid not null references restaurants(id),
  order_id         uuid not null references orders(id),
  submission_id    uuid references order_submissions(id),  -- null while 'pending'
  parent_item_id   uuid references order_items(id),   -- combo component
  product_id       uuid not null references products(id),
  -- snapshots (history must not change when the menu does)
  name             text not null,
  kitchen_name     text,
  unit_price       bigint not null,
  quantity         numeric(10,3) not null check (quantity > 0),
  modifiers_total  bigint not null default 0,
  discount_total   bigint not null default 0,
  tax_total        bigint not null default 0,
  line_total       bigint not null,
  notes            text,
  course           int,                               -- optional course firing
  seat             int,
  station_id       uuid references stations(id),      -- snapshot of routing decision
  status           order_item_status not null default 'pending',
  status_changed_at timestamptz not null default now(),
  void_reason      text,
  voided_by        uuid references staff(id),
  version          int not null default 1
);
create index on order_items (order_id);
create index on order_items (station_id, status) where status in ('sent','accepted','in_preparation');

create table order_item_modifiers (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references restaurants(id),
  order_item_id  uuid not null references order_items(id) on delete cascade,
  modifier_id    uuid references modifiers(id),
  name           text not null,                       -- snapshot
  price_delta    bigint not null default 0,
  quantity       int not null default 1
);

create table order_discounts (
  id             uuid primary key,
  restaurant_id  uuid not null references restaurants(id),
  order_id       uuid not null references orders(id),
  order_item_id  uuid references order_items(id),     -- null = order-level
  name           text not null,
  rate_bp        int,
  fixed_amount   bigint,
  amount         bigint not null,                     -- computed
  reason         text,
  approved_by    uuid references staff(id),
  created_at     timestamptz not null default now()
);

create table order_taxes (                            -- per-order tax breakdown for reporting
  order_id     uuid not null references orders(id),
  tax_rate_id  uuid not null references tax_rates(id),
  restaurant_id uuid not null,
  name         text not null,
  rate_bp      int not null,
  taxable_base bigint not null,
  amount       bigint not null,
  primary key (order_id, tax_rate_id)
);

create table order_events (                           -- append-only lifecycle trail
  id            bigint generated always as identity primary key,
  restaurant_id uuid not null,
  order_id      uuid not null references orders(id),
  event         text not null,                        -- 'created','submitted','item_voided','ready','transferred'...
  from_status   text,
  to_status     text,
  staff_id      uuid,
  device_id     uuid,
  payload       jsonb,
  created_at    timestamptz not null default now()
);
create index on order_events (order_id, id);

-- -----------------------------------------------------------------------------
-- PRODUCTION
-- -----------------------------------------------------------------------------
create table production_tickets (
  id              uuid primary key default gen_random_uuid(),
  restaurant_id   uuid not null references restaurants(id),
  branch_id       uuid not null references branches(id),
  order_id        uuid not null references orders(id),
  submission_id   uuid not null references order_submissions(id),
  station_id      uuid not null references stations(id),
  order_number    int not null,                       -- denormalised for KDS/print
  ticket_seq      int not null,                       -- per-station daily counter, optional display
  status          ticket_status not null default 'new',
  priority        int not null default 0,
  created_at      timestamptz not null default now(),
  accepted_at     timestamptz,
  started_at      timestamptz,
  ready_at        timestamptz,
  completed_at    timestamptz,
  paused_seconds  int not null default 0,
  version         int not null default 1,
  unique (submission_id, station_id)                  -- THE duplicate guard for routing
);
create index on production_tickets (station_id, status) where status not in ('completed','cancelled');
create index on production_tickets (order_id);

create table production_ticket_items (
  ticket_id      uuid not null references production_tickets(id) on delete cascade,
  order_item_id  uuid not null references order_items(id),
  restaurant_id  uuid not null,
  primary key (ticket_id, order_item_id)
);
create unique index one_ticket_per_item on production_ticket_items (order_item_id);

create table production_ticket_events (
  id            bigint generated always as identity primary key,
  restaurant_id uuid not null,
  ticket_id     uuid not null references production_tickets(id),
  from_status   ticket_status,
  to_status     ticket_status not null,
  action        text not null,                        -- 'accept','start','pause','ready','recall','bump','cancel'
  staff_id      uuid,
  device_id     uuid,
  created_at    timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- PRINTING (transactional outbox: jobs are inserted in the SAME transaction
-- that creates the ticket/receipt, so a ticket can never exist without a job)
-- -----------------------------------------------------------------------------
create table print_jobs (
  id               uuid primary key default gen_random_uuid(),
  restaurant_id    uuid not null references restaurants(id),
  branch_id        uuid not null references branches(id),
  printer_id       uuid not null references printers(device_id),
  original_printer_id uuid references printers(device_id),   -- set when rerouted to backup
  kind             print_job_kind not null,
  source_table     text not null,                   -- 'production_tickets','payments',...
  source_id        uuid not null,
  copy_no          int not null default 1,
  dedupe_key       text not null,                   -- e.g. 'ticket:<id>:copy:1'
  payload          jsonb not null,                  -- rendered document model (not raw bytes)
  status           print_job_status not null default 'pending',
  attempts         int not null default 0,
  max_attempts     int not null default 8,
  next_attempt_at  timestamptz not null default now(),
  claimed_by       uuid references devices(id),     -- print agent
  lease_expires_at timestamptz,
  is_reprint       boolean not null default false,
  requested_by     uuid references staff(id),
  last_error       text,
  created_at       timestamptz not null default now(),
  printed_at       timestamptz,
  unique (dedupe_key)
);
create index print_jobs_queue on print_jobs (printer_id, next_attempt_at)
  where status in ('pending','failed','uncertain');
create index on print_jobs (branch_id, status) where status in ('dead','uncertain');

create table print_job_attempts (
  id           bigint generated always as identity primary key,
  restaurant_id uuid not null,
  job_id       uuid not null references print_jobs(id),
  agent_id     uuid references devices(id),
  outcome      text not null,               -- 'printed','failed_before_send','failed_after_send','timeout'
  error        text,
  printer_status jsonb,                     -- DLE EOT result: paper, cover, error bits
  created_at   timestamptz not null default now()
);

create table print_templates (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references restaurants(id),
  kind           print_job_kind not null,
  name           text not null,
  definition     jsonb not null,            -- structured blocks, not free HTML
  is_default     boolean not null default false
);

-- -----------------------------------------------------------------------------
-- PAYMENTS (append-only; refunds are separate rows pointing at the charge)
-- -----------------------------------------------------------------------------
create table payment_methods (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references restaurants(id),
  name           text not null,              -- "Cash", "MTN MoMo", "Telecel Cash", "Visa"
  kind           payment_method_kind not null,
  opens_drawer   boolean not null default false,
  requires_reference boolean not null default false,
  provider       text,                       -- integration key, null = manual record
  is_active      boolean not null default true,
  sort_order     int not null default 0
);

create table payments (
  id               uuid primary key,                -- CLIENT-GENERATED idempotency key
  restaurant_id    uuid not null references restaurants(id),
  branch_id        uuid not null references branches(id),
  order_id         uuid not null references orders(id),
  shift_id         uuid references shifts(id),
  business_day     date not null,
  direction        payment_direction not null,
  refund_of        uuid references payments(id),
  method_id        uuid not null references payment_methods(id),
  method_kind      payment_method_kind not null,    -- snapshot for reporting
  amount           bigint not null check (amount > 0),
  tendered         bigint,                          -- cash given
  change_given     bigint,
  tip_amount       bigint not null default 0,
  status           payment_txn_status not null,
  provider_ref     text,                            -- MoMo transaction id / card auth code
  payer_phone      text,
  reason           text,                            -- refunds
  staff_id         uuid references staff(id),
  approved_by      uuid references staff(id),       -- refund approval
  device_id        uuid references devices(id),
  created_at       timestamptz not null default now(),
  settled_at       timestamptz,
  check ((direction = 'refund') = (refund_of is not null))
);
create index on payments (order_id);
create index on payments (branch_id, business_day);
create index on payments (shift_id);
create unique index payments_provider_ref on payments (method_id, provider_ref) where provider_ref is not null;

-- -----------------------------------------------------------------------------
-- INVENTORY (optional module; ledger is the source of truth)
-- -----------------------------------------------------------------------------
create table units (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references restaurants(id),
  name           text not null,   -- kg, g, L, ml, piece, bag
  base_unit_id   uuid references units(id),
  factor_to_base numeric(18,6) not null default 1
);

create table stock_items (                   -- ingredients AND stocked finished goods
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references restaurants(id),
  name           text not null,
  unit_id        uuid not null references units(id),
  product_id     uuid references products(id),   -- set for finished goods sold as-is (Coke)
  cost_per_unit  bigint,                          -- latest/avg cost in minor units
  is_active      boolean not null default true
);

create table stock_locations (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references restaurants(id),
  branch_id      uuid not null references branches(id),
  name           text not null                     -- "Main store", "Bar fridge"
);

create table recipes (
  product_id     uuid primary key references products(id) on delete cascade,
  restaurant_id  uuid not null references restaurants(id),
  yield_qty      numeric(12,4) not null default 1,
  deduct_on      text not null default 'submit' check (deduct_on in ('submit','ready','paid'))
);
create table recipe_lines (
  product_id     uuid not null references recipes(product_id) on delete cascade,
  stock_item_id  uuid not null references stock_items(id),
  quantity       numeric(12,4) not null check (quantity > 0),
  unit_id        uuid not null references units(id),
  primary key (product_id, stock_item_id)
);

create table stock_movements (               -- append-only ledger
  id              uuid primary key default gen_random_uuid(),
  restaurant_id   uuid not null references restaurants(id),
  branch_id       uuid not null references branches(id),
  location_id     uuid not null references stock_locations(id),
  stock_item_id   uuid not null references stock_items(id),
  kind            stock_movement_kind not null,
  quantity        numeric(14,4) not null,       -- signed, in stock_item unit
  unit_cost       bigint,
  source_table    text,                          -- 'order_items','purchases','transfers'
  source_id       uuid,
  dedupe_key      text unique,                   -- 'sale:<order_item_id>' prevents double deduction
  reason          text,
  staff_id        uuid references staff(id),
  created_at      timestamptz not null default now()
);
create index on stock_movements (location_id, stock_item_id, created_at);

create table stock_levels (                    -- maintained by trigger from the ledger
  location_id    uuid not null references stock_locations(id),
  stock_item_id  uuid not null references stock_items(id),
  restaurant_id  uuid not null,
  on_hand        numeric(14,4) not null default 0,
  reorder_level  numeric(14,4),
  updated_at     timestamptz not null default now(),
  primary key (location_id, stock_item_id)
);

create table purchases (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references restaurants(id),
  branch_id      uuid not null references branches(id),
  supplier_name  text,
  reference      text,
  total_cost     bigint,
  received_at    timestamptz not null default now(),
  staff_id       uuid references staff(id)
);

-- -----------------------------------------------------------------------------
-- DISPLAYS & MARKETING
-- -----------------------------------------------------------------------------
create table media_assets (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references restaurants(id),
  storage_path   text not null,               -- Supabase Storage: media/<restaurant_id>/...
  kind           text not null check (kind in ('image','video')),
  width int, height int, duration_ms int, bytes bigint,
  created_at     timestamptz not null default now()
);

create table playlists (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references restaurants(id),
  name           text not null
);
create table playlist_slides (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references restaurants(id),
  playlist_id    uuid not null references playlists(id) on delete cascade,
  kind           text not null check (kind in ('media','product','announcement','order_status')),
  media_id       uuid references media_assets(id),
  product_id     uuid references products(id),
  body           jsonb,                        -- text/announcement config
  duration_ms    int not null default 10000,
  sort_order     int not null default 0,
  active_from    timestamptz, active_until timestamptz,
  days_of_week   int[],                        -- schedule
  start_time     time, end_time time
);
-- device.config for display devices references playlist_id, layout, which order types to show.

-- -----------------------------------------------------------------------------
-- AUDIT, ALERTS, IDEMPOTENCY, SYNC
-- -----------------------------------------------------------------------------
create table audit_logs (                        -- append-only; no update/delete grants
  id             bigint generated always as identity primary key,
  restaurant_id  uuid,
  branch_id      uuid,
  actor_user_id  uuid,
  actor_staff_id uuid,
  device_id      uuid,
  action         text not null,                 -- 'order.void','price.change','payment.refund'...
  entity_table   text not null,
  entity_id      text not null,
  before_data    jsonb,
  after_data     jsonb,
  reason         text,
  created_at     timestamptz not null default now()
);
create index on audit_logs (restaurant_id, created_at desc);
create index on audit_logs (entity_table, entity_id);

create table alerts (                            -- what the owner sees without a developer
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references restaurants(id),
  branch_id      uuid references branches(id),
  severity       text not null check (severity in ('info','warning','critical')),
  kind           text not null,                 -- 'printer_offline','print_job_dead','device_offline','low_stock','sync_failed'
  subject_table  text, subject_id uuid,
  message        text not null,
  dedupe_key     text,                          -- one open alert per subject+kind
  created_at     timestamptz not null default now(),
  resolved_at    timestamptz,
  acknowledged_by uuid references staff(id)
);
create unique index alerts_open_dedupe on alerts (dedupe_key) where resolved_at is null;

create table idempotency_keys (                  -- for RPCs whose natural key is not a client uuid
  restaurant_id uuid not null,
  key           text not null,
  operation     text not null,
  request_hash  text not null,
  response      jsonb,
  created_at    timestamptz not null default now(),
  primary key (restaurant_id, key)
);

create table client_errors (                     -- observability: errors reported by devices
  id            bigint generated always as identity primary key,
  restaurant_id uuid,
  device_id     uuid,
  kind          text not null,                   -- 'sync_failed','realtime_disconnect','rpc_error'
  message       text,
  context       jsonb,
  created_at    timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- RLS HELPERS (security definer, fixed search_path, in private schema)
-- -----------------------------------------------------------------------------
-- The caller is either a human (auth.uid() -> staff.user_id) or a paired device
-- (auth.uid() -> devices.auth_user_id). Both resolve to a restaurant + branch set.

create function app.current_restaurant_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select s.restaurant_id from public.staff s where s.user_id = auth.uid() and s.is_active
  union
  select d.restaurant_id from public.devices d where d.auth_user_id = auth.uid() and d.is_active
$$;

create function app.has_branch_access(p_branch uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.staff s
    join public.staff_roles sr on sr.staff_id = s.id
    join public.branches b on b.id = p_branch and b.restaurant_id = s.restaurant_id
    where s.user_id = auth.uid() and s.is_active and (sr.branch_id is null or sr.branch_id = p_branch)
  ) or exists (
    select 1 from public.devices d where d.auth_user_id = auth.uid() and d.is_active and d.branch_id = p_branch
  )
$$;

create function app.has_permission(p_restaurant uuid, p_perm text, p_branch uuid default null) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.staff s
    join public.staff_roles sr on sr.staff_id = s.id
    join public.role_permissions rp on rp.role_id = sr.role_id
    where s.user_id = auth.uid() and s.is_active and s.restaurant_id = p_restaurant
      and rp.permission_code = p_perm
      and (sr.branch_id is null or p_branch is null or sr.branch_id = p_branch)
  )
$$;
-- PIN-switched staff on a shared device: RPCs receive p_staff_session and call
-- app.assert_staff_permission(session, perm), which checks a short-lived
-- staff_sessions row bound to the calling device (see below).

create table staff_sessions (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null,
  staff_id      uuid not null references staff(id),
  device_id     uuid not null references devices(id),
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  ended_at      timestamptz
);

-- -----------------------------------------------------------------------------
-- RLS POLICY PATTERN (applied to every tenant table; examples shown)
-- -----------------------------------------------------------------------------
alter table orders enable row level security;
create policy orders_select on orders for select to authenticated
  using (restaurant_id in (select app.current_restaurant_ids()) and app.has_branch_access(branch_id));
-- no insert/update/delete policies: writes only via RPC (submit_order, void_item, ...)

alter table products enable row level security;
create policy products_select on products for select to authenticated
  using (restaurant_id in (select app.current_restaurant_ids()));
create policy products_write on products for all to authenticated
  using (app.has_permission(restaurant_id, 'menu.edit'))
  with check (app.has_permission(restaurant_id, 'menu.edit'));

alter table audit_logs enable row level security;
create policy audit_select on audit_logs for select to authenticated
  using (app.has_permission(restaurant_id, 'audit.view'));
revoke update, delete, truncate on audit_logs from authenticated, anon;

-- Customer displays read through a narrow view (order number + public state
-- only; no names, phones or totals).
create view public_order_board with (security_invoker = true) as
  select o.id, o.branch_id, o.order_number, o.channel, o.status, o.ready_at, o.first_submitted_at
  from orders o
  join order_types ot on ot.id = o.order_type_id and ot.show_on_customer_display
  where o.status in ('submitted','in_preparation','partially_ready','ready')
     or (o.status in ('picked_up','served','completed') and o.fulfilled_at > now() - interval '3 minutes');

-- -----------------------------------------------------------------------------
-- KEY RPCs (signatures; bodies written in Phase 8–16 with pgTAP tests)
-- -----------------------------------------------------------------------------
-- upsert_draft_order(p_order jsonb, p_staff_session uuid) -> orders
-- submit_order(p_order_id uuid, p_submission_id uuid, p_items jsonb, p_staff_session uuid) -> jsonb
--     one transaction: lock order row, validate products/prices server-side,
--     insert items, resolve routing per item, create production_tickets
--     (unique(submission_id, station_id)), create print_jobs (outbox),
--     recompute totals, roll up status, write order_events, broadcast.
--     Re-calling with the same p_submission_id returns the original result.
-- ticket_transition(p_ticket_id, p_action, p_expected_version, p_staff_session)
-- item_transition(p_item_id, p_action, ...)            -- per-item bump / serve
-- void_items(p_order_id, p_item_ids[], p_reason, p_approver_session)
-- cancel_order(p_order_id, p_reason, ...)
-- transfer_table / merge_orders / split_order / move_items
-- record_payment(p_payment jsonb, p_staff_session) -> payments   (idempotent on id)
-- refund_payment(p_refund jsonb, p_approver_session)
-- open_shift / close_shift / review_shift
-- claim_print_jobs(p_agent_id, p_limit) -> setof print_jobs    (FOR UPDATE SKIP LOCKED + lease)
-- complete_print_job(p_job_id, p_outcome, p_error, p_printer_status)
-- reprint(p_source_table, p_source_id, p_printer_id, p_staff_session)
-- device_heartbeat(p_status jsonb)
-- lease_order_numbers(p_business_day, p_count)
-- report_* functions (sales_by_product, sales_by_payment_method, prep_times, shift_summary, ...)

-- -----------------------------------------------------------------------------
-- STATUS ROLLUP (implemented in app.recompute_order_status(order_id), called by
-- every RPC that changes item/ticket state, inside the same transaction)
-- -----------------------------------------------------------------------------
--   active_items := items where status not in ('cancelled','voided')
--   if no active items and order was submitted       -> 'cancelled' (or keep for void audit)
--   if all active items 'pending'                    -> 'draft' / 'open' (dine-in)
--   if all active sent items 'served'                -> 'served' | 'picked_up' (by channel)
--   if all active sent items in ('ready','served')   -> 'ready'
--   if any in ('ready','served') and others not      -> 'partially_ready'
--   if any in ('accepted','in_preparation')          -> 'in_preparation'
--   else                                             -> 'submitted'
--   'completed' only when fulfilled AND payment_state = 'paid'.
--   'on_hold' is a manual overlay stored separately (orders.held_at) so the
--   rollup never silently clears it.
--
-- Ticket -> item: ticket 'ready' sets its non-void items 'ready'; KDS may also
-- bump individual items. Ticket status is itself recomputed from its items when
-- items are bumped individually.

-- -----------------------------------------------------------------------------
-- REALTIME
-- Postgres triggers call realtime.send() (Broadcast from Database) on PRIVATE
-- topics. Payload = ids + version + status only; clients refetch the row.
--   branch:<id>:orders          POS, waiter tablets, customer displays
--   branch:<id>:station:<id>    KDS for that station
--   branch:<id>:print           print agents
--   branch:<id>:devices         admin / manager dashboard
-- Authorization via RLS on realtime.messages using the helpers above.
-- -----------------------------------------------------------------------------
