-- Catalog: categories, taxes, products, modifiers, per-branch availability.

create table categories (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references restaurants(id),
  parent_id      uuid,
  name           text not null,
  sort_order     int not null default 0,
  is_active      boolean not null default true,
  unique (restaurant_id, id),
  foreign key (restaurant_id, parent_id) references categories (restaurant_id, id),
  check (parent_id is distinct from id)
);
select app.enable_tenant_rls('categories');

-- Tax rates are configuration, never hard-coded. Inclusive taxes cannot be compound.
create table tax_rates (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references restaurants(id),
  name           text not null,
  rate_bp        int not null check (rate_bp between 0 and 10000),   -- basis points: 1500 = 15%
  is_inclusive   boolean not null default true,
  is_compound    boolean not null default false,
  apply_order    int not null default 0,
  is_active      boolean not null default true,
  unique (restaurant_id, id),
  check (not (is_inclusive and is_compound))
);
select app.enable_tenant_rls('tax_rates');

create table products (
  id                    uuid primary key default gen_random_uuid(),
  restaurant_id         uuid not null references restaurants(id),
  category_id           uuid not null,
  name                  text not null check (length(trim(name)) > 0),
  kitchen_name          text,
  base_price            bigint not null check (base_price >= 0),     -- minor units
  requires_preparation  boolean not null default true,
  is_active             boolean not null default true,
  created_at            timestamptz not null default now(),
  deleted_at            timestamptz,
  unique (restaurant_id, id),
  foreign key (restaurant_id, category_id) references categories (restaurant_id, id)
);
select app.enable_tenant_rls('products');
create index products_category_idx on products (restaurant_id, category_id) where deleted_at is null;

create table product_taxes (
  restaurant_id uuid not null,
  product_id    uuid not null,
  tax_rate_id   uuid not null,
  primary key (product_id, tax_rate_id),
  foreign key (restaurant_id, product_id) references products (restaurant_id, id) on delete cascade,
  foreign key (restaurant_id, tax_rate_id) references tax_rates (restaurant_id, id)
);
select app.enable_tenant_rls('product_taxes');

create table branch_products (
  restaurant_id   uuid not null,
  branch_id       uuid not null,
  product_id      uuid not null,
  price_override  bigint check (price_override >= 0),
  is_available    boolean not null default true,
  primary key (branch_id, product_id),
  foreign key (restaurant_id, branch_id) references branches (restaurant_id, id),
  foreign key (restaurant_id, product_id) references products (restaurant_id, id) on delete cascade
);
select app.enable_tenant_rls('branch_products');

create table modifier_groups (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references restaurants(id),
  name           text not null,
  min_select     int not null default 0 check (min_select >= 0),
  max_select     int check (max_select is null or max_select >= 1),
  unique (restaurant_id, id),
  check (max_select is null or max_select >= min_select)
);
select app.enable_tenant_rls('modifier_groups');

create table modifiers (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null,
  group_id       uuid not null,
  name           text not null,
  price_delta    bigint not null default 0,
  is_active      boolean not null default true,
  sort_order     int not null default 0,
  unique (restaurant_id, id),
  foreign key (restaurant_id, group_id) references modifier_groups (restaurant_id, id) on delete cascade
);
select app.enable_tenant_rls('modifiers');

create table product_modifier_groups (
  restaurant_id uuid not null,
  product_id    uuid not null,
  group_id      uuid not null,
  sort_order    int not null default 0,
  primary key (product_id, group_id),
  foreign key (restaurant_id, product_id) references products (restaurant_id, id) on delete cascade,
  foreign key (restaurant_id, group_id) references modifier_groups (restaurant_id, id) on delete cascade
);
select app.enable_tenant_rls('product_modifier_groups');
