-- Inventory and stock taking.
--
-- Rules (enforced in packages/domain/src/inventory.ts and the application layer):
--  * an item's quantity only changes together with a stock movement, in the same transaction;
--  * stock movements are append-only (no update / delete for the API role): the ledger is the history;
--  * a stock count never changes stock by itself: it is counted, submitted, then approved by someone
--    with inventory.manage, and only approval writes the 'count' movements for the variances;
--  * sales deduct stock only for products that have recipe components.
-- Quantities are numeric(14,3) in the item's unit; money is integer minor units like everywhere else.

create type stock_movement_kind as enum ('receive', 'waste', 'adjust', 'count', 'sale');
create type stock_count_status as enum ('open', 'submitted', 'approved', 'cancelled');

create table inventory_items (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null,
  branch_id      uuid not null,
  name           text not null check (length(trim(name)) > 0),
  sku            text,
  category       text,
  unit           text not null check (unit in ('kg', 'g', 'l', 'ml', 'pcs', 'pack', 'bottle', 'crate', 'bag', 'tray')),
  quantity       numeric(14,3) not null default 0,
  min_quantity   numeric(14,3) not null default 0 check (min_quantity >= 0),
  unit_cost      bigint not null default 0 check (unit_cost >= 0),   -- per unit, minor units
  is_active      boolean not null default true,
  version        int not null default 1,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (restaurant_id, id),
  foreign key (restaurant_id, branch_id) references branches (restaurant_id, id)
);
select app.enable_tenant_rls('inventory_items');
create unique index inventory_items_branch_name_idx on inventory_items (branch_id, lower(name));
create unique index inventory_items_branch_sku_idx on inventory_items (branch_id, lower(sku)) where sku is not null;

create table stock_counts (
  id                    uuid primary key,                 -- client-generated
  restaurant_id         uuid not null,
  branch_id             uuid not null,
  status                stock_count_status not null default 'open',
  note                  text,
  started_by_staff_id   uuid,
  started_at            timestamptz not null default now(),
  submitted_by_staff_id uuid,
  submitted_at          timestamptz,
  approved_by_staff_id  uuid,
  approved_at           timestamptz,
  cancelled_at          timestamptz,
  version               int not null default 1,
  unique (restaurant_id, id),
  foreign key (restaurant_id, branch_id) references branches (restaurant_id, id)
);
select app.enable_tenant_rls('stock_counts');
create index stock_counts_branch_idx on stock_counts (branch_id, started_at desc);

create table stock_count_lines (
  restaurant_id     uuid not null,
  count_id          uuid not null,
  item_id           uuid not null,
  system_quantity   numeric(14,3) not null,            -- snapshot at count start, refreshed at approval
  counted_quantity  numeric(14,3) check (counted_quantity is null or counted_quantity >= 0),
  reason            text,
  counted_at        timestamptz,
  counted_by_staff_id uuid,
  primary key (count_id, item_id),
  foreign key (restaurant_id, count_id) references stock_counts (restaurant_id, id) on delete cascade,
  foreign key (restaurant_id, item_id) references inventory_items (restaurant_id, id)
);
select app.enable_tenant_rls('stock_count_lines');

create table stock_movements (
  id               uuid primary key,                    -- client-generated: retries are idempotent
  restaurant_id    uuid not null,
  branch_id        uuid not null,
  item_id          uuid not null,
  kind             stock_movement_kind not null,
  quantity_delta   numeric(14,3) not null check (quantity_delta <> 0),
  quantity_after   numeric(14,3) not null,
  unit_cost        bigint,
  reason           text,
  reference        text,                                -- supplier invoice, order number, ...
  stock_count_id   uuid,
  order_id         uuid,
  staff_id         uuid,
  created_at       timestamptz not null default now(),
  foreign key (restaurant_id, item_id) references inventory_items (restaurant_id, id),
  foreign key (restaurant_id, branch_id) references branches (restaurant_id, id)
);
select app.enable_tenant_rls('stock_movements', true);   -- append-only
create index stock_movements_item_idx on stock_movements (item_id, created_at desc);
create index stock_movements_branch_idx on stock_movements (branch_id, created_at desc);

-- What one unit of a product consumes (e.g. Jollof Rice: 0.25 kg rice, 0.05 l oil).
create table product_recipe_components (
  restaurant_id  uuid not null,
  product_id     uuid not null,
  item_id        uuid not null,
  quantity       numeric(14,3) not null check (quantity > 0),
  primary key (product_id, item_id),
  foreign key (restaurant_id, product_id) references products (restaurant_id, id) on delete cascade,
  foreign key (restaurant_id, item_id) references inventory_items (restaurant_id, id)
);
select app.enable_tenant_rls('product_recipe_components');
