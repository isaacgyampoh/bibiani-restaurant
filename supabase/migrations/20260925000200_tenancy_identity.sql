-- Tenancy (restaurant -> branch) and identity (staff, roles, permissions).

create table restaurants (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) > 0),
  slug        text not null unique check (slug ~ '^[a-z0-9-]+$'),
  currency    char(3) not null default 'GHS',
  timezone    text not null default 'Africa/Accra',
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

alter table restaurants enable row level security;
create policy tenant_isolation on restaurants for select to app_api
  using (id = app.current_restaurant_id());
grant select on restaurants to app_api;

create table branches (
  id                   uuid primary key default gen_random_uuid(),
  restaurant_id        uuid not null references restaurants(id),
  name                 text not null,
  code                 text not null check (code ~ '^[A-Z0-9-]{1,12}$'),
  timezone             text not null default 'Africa/Accra',
  business_day_cutoff  time not null default '04:00',
  order_number_start   int not null default 1 check (order_number_start > 0),
  is_active            boolean not null default true,
  created_at           timestamptz not null default now(),
  unique (restaurant_id, code),
  unique (restaurant_id, id)
);
select app.enable_tenant_rls('branches');

-- Static catalogue of permission codes. Global, read-only for the API.
create table permissions (
  code        text primary key,
  description text not null
);
alter table permissions enable row level security;
create policy read_all on permissions for select to app_api using (true);
grant select on permissions to app_api;

insert into permissions (code, description) values
  ('order.create',   'Create orders and add items'),
  ('order.send',     'Send orders to production'),
  ('order.fulfil',   'Mark orders served or picked up'),
  ('order.cancel',   'Cancel orders before production'),
  ('order.void',     'Void items after production started'),
  ('order.view',     'View orders'),
  ('kitchen.operate','Operate kitchen display tickets'),
  ('payment.record', 'Record manual payments'),
  ('payment.void',   'Void a recorded payment'),
  ('payment.refund', 'Refund a payment'),
  ('print.manage',   'Retry, cancel and reprint print jobs'),
  ('print.agent',    'Act as a print agent'),
  ('display.view',   'Read the customer order board'),
  ('device.manage',  'Register and manage devices'),
  ('menu.manage',    'Manage products, categories and routing'),
  ('config.manage',  'Manage branches, areas, stations and tables'),
  ('staff.manage',   'Manage staff and roles'),
  ('audit.view',     'View audit logs');

create table roles (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references restaurants(id),
  name           text not null,
  is_system      boolean not null default false,
  created_at     timestamptz not null default now(),
  unique (restaurant_id, name),
  unique (restaurant_id, id)
);
select app.enable_tenant_rls('roles');

create table role_permissions (
  restaurant_id    uuid not null,
  role_id          uuid not null,
  permission_code  text not null references permissions(code),
  primary key (role_id, permission_code),
  foreign key (restaurant_id, role_id) references roles (restaurant_id, id) on delete cascade
);
select app.enable_tenant_rls('role_permissions');

-- A person working for a restaurant. user_id links to Supabase Auth when the
-- person signs in; it is null for PIN-only staff (PIN support: later phase).
create table staff (
  id              uuid primary key default gen_random_uuid(),
  restaurant_id   uuid not null references restaurants(id),
  user_id         uuid references auth.users(id) on delete set null,
  display_name    text not null check (length(trim(display_name)) > 0),
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  unique (restaurant_id, user_id),
  unique (restaurant_id, id)
);
select app.enable_tenant_rls('staff');
create index staff_user_idx on staff (user_id) where user_id is not null;

create table staff_roles (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null,
  staff_id       uuid not null,
  role_id        uuid not null,
  branch_id      uuid,                          -- null = every branch
  unique nulls not distinct (staff_id, role_id, branch_id),
  foreign key (restaurant_id, staff_id) references staff (restaurant_id, id) on delete cascade,
  foreign key (restaurant_id, role_id) references roles (restaurant_id, id) on delete cascade,
  foreign key (restaurant_id, branch_id) references branches (restaurant_id, id)
);
select app.enable_tenant_rls('staff_roles');
create index staff_roles_staff_idx on staff_roles (staff_id);
