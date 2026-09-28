-- Customers, cashier registers (open / close with counted cash) and reporting indexes. Additive only.

-- 1. Permissions. Existing roles get what matches what they already do.
insert into permissions (code, description) values
  ('customer.attach',  'Look up and add customers while taking orders'),
  ('customer.view',    'See the customer list, customer details and order history'),
  ('customer.manage',  'Edit and merge customer records'),
  ('register.operate', 'Open and close your own cash register'),
  ('register.manage',  'See every register and reopen a closed register');

insert into role_permissions (restaurant_id, role_id, permission_code)
select r.restaurant_id, r.id, p.code
from roles r
cross join (values ('customer.attach'), ('customer.view'), ('customer.manage'), ('register.operate'), ('register.manage')) as p(code)
where r.is_system and r.name in ('Owner', 'Manager')
on conflict do nothing;

insert into role_permissions (restaurant_id, role_id, permission_code)
select r.restaurant_id, r.id, 'customer.view'
from roles r where r.is_system and r.name = 'Supervisor'
on conflict do nothing;

-- Whoever takes orders may attach a customer; whoever takes payments runs a register.
insert into role_permissions (restaurant_id, role_id, permission_code)
select distinct rp.restaurant_id, rp.role_id, 'customer.attach'
from role_permissions rp where rp.permission_code = 'order.create'
on conflict do nothing;
insert into role_permissions (restaurant_id, role_id, permission_code)
select distinct rp.restaurant_id, rp.role_id, 'register.operate'
from role_permissions rp where rp.permission_code = 'payment.record'
on conflict do nothing;

-- 2. Customers. The telephone number (stored canonically, e.g. +233241234567) is required and is
--    the duplicate key. A merged record keeps its id (old orders still point at it) and names the
--    record it was merged into; only unmerged records must have a unique number.
create table customers (
  id                   uuid primary key,                 -- client-generated: retries are idempotent
  restaurant_id        uuid not null references restaurants(id),
  full_name            text check (full_name is null or length(trim(full_name)) > 0),
  phone                text not null check (phone ~ '^\+[0-9]{8,15}$'),
  email                text,
  notes                text,
  merged_into_id       uuid,
  created_by_staff_id  uuid,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  version              int not null default 1,
  unique (restaurant_id, id),
  foreign key (restaurant_id, merged_into_id) references customers (restaurant_id, id),
  foreign key (restaurant_id, created_by_staff_id) references staff (restaurant_id, id),
  check (merged_into_id is distinct from id)
);
select app.enable_tenant_rls('customers');
create unique index customers_phone_idx on customers (restaurant_id, phone) where merged_into_id is null;
create index customers_name_idx on customers (restaurant_id, lower(full_name));

alter table orders add column customer_id uuid;
alter table orders
  add constraint orders_customer_fk foreign key (restaurant_id, customer_id) references customers (restaurant_id, id);
create index orders_customer_idx on orders (customer_id, business_day) where customer_id is not null;

-- Canonical Ghanaian / international form, used here only to link orders placed before customers
-- existed (the application normalises with the same rules in packages/domain/src/customers.ts).
create function app.canonical_phone(p text) returns text
language sql immutable set search_path = ''
as $$
  select case
    when d ~ '^233[0-9]{9}$' then '+' || d
    when d ~ '^0[0-9]{9}$' then '+233' || substr(d, 2)
    when d ~ '^[2-5][0-9]{8}$' then '+233' || d
    when p ~ '^\s*(\+|00)' and length(regexp_replace(d, '^00', '')) between 8 and 15 then '+' || regexp_replace(d, '^00', '')
    else null
  end
  from (select regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g') as d) x
$$;

-- Customers from orders already taken with a telephone number (latest name wins), then link them.
insert into customers (id, restaurant_id, full_name, phone, created_at, updated_at)
select gen_random_uuid(), x.restaurant_id, x.full_name, x.phone, x.first_at, x.first_at
from (
  select o.restaurant_id, app.canonical_phone(o.customer_phone) as phone,
         (array_agg(nullif(trim(o.customer_name), '') order by o.created_at desc)
            filter (where nullif(trim(o.customer_name), '') is not null))[1] as full_name,
         min(o.created_at) as first_at
  from orders o
  where app.canonical_phone(o.customer_phone) is not null
  group by 1, 2
) x;
update orders o set customer_id = c.id
  from customers c
 where c.restaurant_id = o.restaurant_id and c.merged_into_id is null
   and c.phone = app.canonical_phone(o.customer_phone) and o.customer_id is null;

-- 3. Cash registers. A cashier opens a register on a terminal with an opening float; cash payments
--    they take are attached to it; closing records the counted cash. Expected cash and the variance
--    are computed from the payments and stored with the close: nothing is adjusted to match.
create table register_sessions (
  id                   uuid primary key,                 -- client-generated: retries are idempotent
  restaurant_id        uuid not null,
  branch_id            uuid not null,
  device_id            uuid,                             -- the terminal (null: opened from the back office)
  terminal_name        text not null,                    -- snapshots: history survives renames
  cashier_staff_id     uuid not null,
  cashier_name         text not null,
  status               text not null default 'open' check (status in ('open', 'closed')),
  opened_at            timestamptz not null default now(),
  opening_cash         bigint not null check (opening_cash >= 0),
  opening_note         text,
  closed_at            timestamptz,
  closed_by_staff_id   uuid,
  cash_sales           bigint,
  cash_refunds         bigint,
  expected_cash        bigint,
  counted_cash         bigint check (counted_cash is null or counted_cash >= 0),
  variance             bigint,
  closing_totals       jsonb,                            -- per-method totals at close
  closing_note         text,
  reopened_at          timestamptz,
  reopened_by_staff_id uuid,
  reopen_reason        text,
  reopen_count         int not null default 0,
  version              int not null default 1,
  unique (restaurant_id, id),
  foreign key (restaurant_id, branch_id) references branches (restaurant_id, id),
  foreign key (restaurant_id, device_id) references devices (restaurant_id, id),
  foreign key (restaurant_id, cashier_staff_id) references staff (restaurant_id, id),
  foreign key (restaurant_id, closed_by_staff_id) references staff (restaurant_id, id),
  foreign key (restaurant_id, reopened_by_staff_id) references staff (restaurant_id, id),
  check (status = 'open' or (closed_at is not null and counted_cash is not null and expected_cash is not null
                             and variance = counted_cash - expected_cash))
);
select app.enable_tenant_rls('register_sessions');
create unique index register_sessions_open_cashier_idx on register_sessions (branch_id, cashier_staff_id) where status = 'open';
create unique index register_sessions_open_device_idx on register_sessions (device_id) where status = 'open' and device_id is not null;
create index register_sessions_branch_idx on register_sessions (branch_id, opened_at desc);

-- A closed register cannot be edited; the only change allowed is reopening it (the application
-- requires register.manage and audits it). Re-applying the same row (hub sync replay) is allowed.
create function app.guard_closed_register() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if old.status = 'closed' and new.status = 'closed' and new is distinct from old then
    raise exception 'This register is closed' using errcode = 'RH002';
  end if;
  return new;
end $$;
create trigger register_sessions_closed_guard before update on register_sessions
  for each row execute function app.guard_closed_register();
create trigger register_sessions_hub_guard before insert or update on register_sessions
  for each row execute function app.guard_hub_branch();

alter table payments add column register_session_id uuid;
alter table payments
  add constraint payments_register_session_fk foreign key (restaurant_id, register_session_id)
  references register_sessions (restaurant_id, id);
create index payments_register_session_idx on payments (register_session_id) where register_session_id is not null;

-- 4. Reporting indexes (by staff, by terminal).
create index payments_device_idx on payments (device_id, created_at) where device_id is not null;
create index payments_staff_idx on payments (recorded_by_staff_id, created_at);
create index orders_created_by_idx on orders (created_by_staff_id, business_day);
