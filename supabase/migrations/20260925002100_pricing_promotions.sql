-- Pricing and promotions.
--
-- Price flow: catalogue price -> live promotion (automatic) -> order line SNAPSHOT -> kitchen,
-- receipt, reports. Order lines keep the gross amount, the promotion that applied (id + name)
-- with its discount, and any manager discount, so historical orders never change when prices
-- or promotions do. Manual discounts are separate from promotions, permissioned and audited.

-- 1. Order line price snapshot
alter table order_items
  add column gross_total bigint,                                  -- (unit price + modifiers) x quantity, before discounts
  add column promotion_id uuid,
  add column promotion_name text,
  add column promotion_discount bigint not null default 0 check (promotion_discount >= 0),
  add column manual_discount bigint not null default 0 check (manual_discount >= 0);
-- Existing lines had no discounts: their gross is their total.
update order_items set gross_total = line_total where gross_total is null;
alter table order_items alter column gross_total set not null;
alter table order_items add constraint order_items_discount_bounds
  check (promotion_discount + manual_discount <= gross_total and line_total = gross_total - promotion_discount - manual_discount);

-- 2. Promotions (automatic pricing rules)
create table promotions (
  id                   uuid primary key default gen_random_uuid(),
  restaurant_id        uuid not null references restaurants(id),
  branch_id            uuid,                                    -- null = every branch
  name                 text not null check (length(trim(name)) between 1 and 60),
  kind                 text not null check (kind in ('percent_off', 'amount_off', 'fixed_price', 'bundle_price')),
  percent_bp           int check (percent_bp between 1 and 10000),   -- percent_off: 1000 = 10%
  amount               bigint check (amount >= 0),               -- amount_off (per unit) / fixed_price (per unit) / bundle_price (per bundle)
  bundle_quantity      int check (bundle_quantity between 2 and 99),
  applies_to_all       boolean not null default false,
  starts_on            date,
  ends_on              date,
  days_of_week         int[] check (days_of_week <@ array[0,1,2,3,4,5,6]),  -- 0 = Sunday; null = every day
  start_time           time,
  end_time             time,
  priority             int not null default 0 check (priority between 0 and 100),
  status               text not null default 'active' check (status in ('active', 'paused')),
  created_by_staff_id  uuid,
  updated_by_staff_id  uuid,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  version              int not null default 1,
  unique (restaurant_id, id),
  foreign key (restaurant_id, branch_id) references branches (restaurant_id, id),
  check (ends_on is null or starts_on is null or ends_on >= starts_on),
  check ((start_time is null) = (end_time is null)),
  check (
    (kind = 'percent_off' and percent_bp is not null and amount is null and bundle_quantity is null) or
    (kind = 'amount_off' and amount > 0 and percent_bp is null and bundle_quantity is null) or
    (kind = 'fixed_price' and amount is not null and percent_bp is null and bundle_quantity is null) or
    (kind = 'bundle_price' and amount is not null and bundle_quantity is not null and percent_bp is null)
  )
);
select app.enable_tenant_rls('promotions');

create table promotion_targets (
  restaurant_id  uuid not null,
  promotion_id   uuid not null,
  product_id     uuid,
  category_id    uuid,
  foreign key (restaurant_id, promotion_id) references promotions (restaurant_id, id) on delete cascade,
  foreign key (restaurant_id, product_id) references products (restaurant_id, id) on delete cascade,
  foreign key (restaurant_id, category_id) references categories (restaurant_id, id) on delete cascade,
  check ((product_id is null) <> (category_id is null))
);
select app.enable_tenant_rls('promotion_targets');
create unique index promotion_targets_product_idx on promotion_targets (promotion_id, product_id) where product_id is not null;
create unique index promotion_targets_category_idx on promotion_targets (promotion_id, category_id) where category_id is not null;

-- 3. Manager discounts on an order (append-only history; replacing one voids the previous)
create table order_discounts (
  id                   uuid primary key,                         -- client-generated: retries are idempotent
  restaurant_id        uuid not null,
  order_id             uuid not null,
  kind                 text not null check (kind in ('amount', 'percent')),
  value                bigint not null check (value > 0),        -- minor units, or basis points for percent
  amount               bigint not null check (amount > 0),       -- what was actually taken off
  reason               text not null check (length(trim(reason)) >= 3),
  original_total       bigint not null,
  final_total          bigint not null,
  applied_by_staff_id  uuid,
  created_at           timestamptz not null default now(),
  removed_at           timestamptz,
  removed_by_staff_id  uuid,
  foreign key (restaurant_id, order_id) references orders (restaurant_id, id)
);
select app.enable_tenant_rls('order_discounts');
create unique index order_discounts_one_active_idx on order_discounts (order_id) where removed_at is null;

-- 4. Permissions
insert into permissions (code, description) values
  ('promotions.manage', 'Create, schedule, pause and end promotions'),
  ('discount.apply',    'Apply a manager discount to an order');
insert into role_permissions (restaurant_id, role_id, permission_code)
select r.restaurant_id, r.id, p.code
from roles r cross join (values ('promotions.manage'), ('discount.apply')) as p(code)
where r.is_system and r.name in ('Owner', 'Manager')
on conflict do nothing;
insert into role_permissions (restaurant_id, role_id, permission_code)
select r.restaurant_id, r.id, 'discount.apply' from roles r where r.is_system and r.name = 'Supervisor'
on conflict do nothing;
