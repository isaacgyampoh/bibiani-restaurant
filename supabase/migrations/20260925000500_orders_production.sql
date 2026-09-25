-- Orders, submissions (send-to-kitchen operations), items, production tickets, event trails.
-- Idempotency anchors (client-generated uuids): orders.id, order_items.id,
-- order_submissions.id. unique(submission_id, station_id) on production_tickets
-- is the database-level guarantee that a retried send never duplicates tickets.

create table order_number_counters (
  restaurant_id  uuid not null,
  branch_id      uuid not null,
  business_day   date not null,
  next_number    int not null check (next_number > 0),
  primary key (branch_id, business_day),
  foreign key (restaurant_id, branch_id) references branches (restaurant_id, id)
);
select app.enable_tenant_rls('order_number_counters');

create table orders (
  id                   uuid primary key,                      -- client-generated
  restaurant_id        uuid not null,
  branch_id            uuid not null,
  area_id              uuid not null,
  channel              order_channel not null,                -- snapshot of area.channel
  business_day         date not null,
  order_number         int not null check (order_number > 0),
  status               order_status not null default 'draft', -- derived by the domain
  payment_status       payment_status not null default 'unpaid',
  table_id             uuid,
  customer_name        text,
  customer_phone       text,
  notes                text,
  subtotal             bigint not null default 0 check (subtotal >= 0),
  tax_total            bigint not null default 0 check (tax_total >= 0),
  grand_total          bigint not null default 0 check (grand_total >= 0),
  paid_total           bigint not null default 0 check (paid_total >= 0),
  refunded_total       bigint not null default 0 check (refunded_total >= 0),
  held_at              timestamptz,
  created_by_staff_id  uuid,
  created_by_device_id uuid,
  request_hash         text not null,
  client_created_at    timestamptz,
  created_at           timestamptz not null default now(),
  first_submitted_at   timestamptz,
  ready_at             timestamptz,
  fulfilled_at         timestamptz,
  completed_at         timestamptz,
  cancelled_at         timestamptz,
  cancel_reason        text,
  updated_at           timestamptz not null default now(),
  version              int not null default 1,
  unique (restaurant_id, id),
  unique (branch_id, business_day, order_number),
  foreign key (restaurant_id, branch_id) references branches (restaurant_id, id),
  foreign key (restaurant_id, area_id) references operational_areas (restaurant_id, id),
  foreign key (restaurant_id, table_id) references dining_tables (restaurant_id, id),
  foreign key (restaurant_id, created_by_staff_id) references staff (restaurant_id, id),
  foreign key (restaurant_id, created_by_device_id) references devices (restaurant_id, id),
  check (refunded_total <= paid_total)
);
select app.enable_tenant_rls('orders');
create index orders_active_idx on orders (branch_id, status)
  where status not in ('completed', 'cancelled', 'voided');
-- At most one active order per table.
create unique index orders_one_active_per_table on orders (table_id)
  where table_id is not null and status not in ('completed', 'cancelled', 'voided');

create table order_submissions (
  id                     uuid primary key,                   -- client-generated
  restaurant_id          uuid not null,
  order_id               uuid not null,
  seq                    int not null check (seq > 0),
  request_hash           text not null,
  submitted_by_staff_id  uuid,
  device_id              uuid,
  submitted_at           timestamptz not null default now(),
  unique (restaurant_id, id),
  unique (order_id, seq),
  foreign key (restaurant_id, order_id) references orders (restaurant_id, id),
  foreign key (restaurant_id, submitted_by_staff_id) references staff (restaurant_id, id),
  foreign key (restaurant_id, device_id) references devices (restaurant_id, id)
);
select app.enable_tenant_rls('order_submissions');

create table order_items (
  id                 uuid primary key,                       -- client-generated
  restaurant_id      uuid not null,
  order_id           uuid not null,
  submission_id      uuid,                                   -- null while pending
  position           int not null check (position > 0),      -- line order as entered
  product_id         uuid not null,
  name               text not null,                          -- snapshots: history never changes with the menu
  kitchen_name       text,
  unit_price         bigint not null check (unit_price >= 0),
  quantity           int not null check (quantity > 0),
  modifiers_total    bigint not null default 0,
  line_total         bigint not null check (line_total >= 0), -- gross incl. modifiers, excl. exclusive tax
  tax_total          bigint not null default 0 check (tax_total >= 0),
  notes              text,
  station_id         uuid,                                   -- routing decision snapshot
  status             order_item_status not null default 'pending',
  status_changed_at  timestamptz not null default now(),
  void_reason        text,
  created_at         timestamptz not null default now(),
  unique (restaurant_id, id),
  foreign key (restaurant_id, order_id) references orders (restaurant_id, id),
  foreign key (restaurant_id, submission_id) references order_submissions (restaurant_id, id),
  foreign key (restaurant_id, product_id) references products (restaurant_id, id),
  foreign key (restaurant_id, station_id) references stations (restaurant_id, id),
  check ((status = 'pending') = (submission_id is null) or status in ('cancelled'))
);
select app.enable_tenant_rls('order_items');
create index order_items_order_idx on order_items (order_id, position);

create table order_item_modifiers (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null,
  order_item_id  uuid not null,
  modifier_id    uuid not null,
  name           text not null,
  price_delta    bigint not null,
  foreign key (restaurant_id, order_item_id) references order_items (restaurant_id, id) on delete cascade,
  foreign key (restaurant_id, modifier_id) references modifiers (restaurant_id, id)
);
select app.enable_tenant_rls('order_item_modifiers');
create index order_item_modifiers_item_idx on order_item_modifiers (order_item_id);

-- Per-line tax snapshot (reports aggregate these; rates may change later).
create table order_item_taxes (
  restaurant_id  uuid not null,
  order_item_id  uuid not null,
  tax_rate_id    uuid not null,
  name           text not null,
  rate_bp        int not null,
  is_inclusive   boolean not null,
  amount         bigint not null check (amount >= 0),
  primary key (order_item_id, tax_rate_id),
  foreign key (restaurant_id, order_item_id) references order_items (restaurant_id, id) on delete cascade,
  foreign key (restaurant_id, tax_rate_id) references tax_rates (restaurant_id, id)
);
select app.enable_tenant_rls('order_item_taxes');

create table production_tickets (
  id              uuid primary key,
  restaurant_id   uuid not null,
  branch_id       uuid not null,
  order_id        uuid not null,
  submission_id   uuid not null,
  station_id      uuid not null,
  order_number    int not null,
  status          ticket_status not null default 'new',
  created_at      timestamptz not null default now(),
  accepted_at     timestamptz,
  started_at      timestamptz,
  ready_at        timestamptz,
  completed_at    timestamptz,
  cancelled_at    timestamptz,
  updated_at      timestamptz not null default now(),
  version         int not null default 1,
  unique (restaurant_id, id),
  unique (submission_id, station_id),
  foreign key (restaurant_id, branch_id) references branches (restaurant_id, id),
  foreign key (restaurant_id, order_id) references orders (restaurant_id, id),
  foreign key (restaurant_id, submission_id) references order_submissions (restaurant_id, id),
  foreign key (restaurant_id, station_id) references stations (restaurant_id, id)
);
select app.enable_tenant_rls('production_tickets');
create index production_tickets_station_open_idx on production_tickets (station_id, created_at)
  where status not in ('completed', 'cancelled');
create index production_tickets_order_idx on production_tickets (order_id);

create table production_ticket_items (
  restaurant_id  uuid not null,
  ticket_id      uuid not null,
  order_item_id  uuid not null,
  primary key (ticket_id, order_item_id),
  unique (order_item_id),                                    -- an item is on exactly one ticket
  foreign key (restaurant_id, ticket_id) references production_tickets (restaurant_id, id) on delete cascade,
  foreign key (restaurant_id, order_item_id) references order_items (restaurant_id, id)
);
select app.enable_tenant_rls('production_ticket_items');

create table order_events (
  id              bigint generated always as identity primary key,
  restaurant_id   uuid not null,
  order_id        uuid not null,
  event           text not null,
  from_status     text,
  to_status       text,
  staff_id        uuid,
  device_id       uuid,
  correlation_id  text,
  payload         jsonb,
  created_at      timestamptz not null default now(),
  foreign key (restaurant_id, order_id) references orders (restaurant_id, id)
);
select app.enable_tenant_rls('order_events', p_append_only => true);
create index order_events_order_idx on order_events (order_id, id);

create table production_ticket_events (
  id              bigint generated always as identity primary key,
  restaurant_id   uuid not null,
  ticket_id       uuid not null,
  action          text not null,
  from_status     ticket_status,
  to_status       ticket_status not null,
  staff_id        uuid,
  device_id       uuid,
  correlation_id  text,
  created_at      timestamptz not null default now(),
  foreign key (restaurant_id, ticket_id) references production_tickets (restaurant_id, id)
);
select app.enable_tenant_rls('production_ticket_events', p_append_only => true);
create index production_ticket_events_ticket_idx on production_ticket_events (ticket_id, id);
