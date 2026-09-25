-- Restaurant operations product: dashboard/reports, inventory and stock taking permissions,
-- and the Supervisor / Inventory Manager roles. Existing restaurants get them too.

insert into permissions (code, description) values
  ('reports.view',     'View the dashboard, sales and kitchen reports'),
  ('inventory.manage', 'Manage inventory items, receive stock, record wastage and adjustments'),
  ('stock.count',      'Count stock and submit stock takes');

-- Owners and managers get everything new.
insert into role_permissions (restaurant_id, role_id, permission_code)
select r.restaurant_id, r.id, p.code
from roles r
cross join (values ('reports.view'), ('inventory.manage'), ('stock.count')) as p(code)
where r.is_system and r.name in ('Owner', 'Manager')
on conflict do nothing;

-- New standard roles for every existing restaurant (new restaurants get them from ROLE_TEMPLATES).
insert into roles (restaurant_id, name, is_system)
select r.id, x.name, true
from restaurants r
cross join (values ('Supervisor'), ('Inventory Manager')) as x(name)
on conflict (restaurant_id, name) do nothing;

insert into role_permissions (restaurant_id, role_id, permission_code)
select ro.restaurant_id, ro.id, p.code
from roles ro
join (values
  ('Supervisor', 'order.view'), ('Supervisor', 'order.fulfil'), ('Supervisor', 'kitchen.operate'),
  ('Supervisor', 'receipt.print'), ('Supervisor', 'reports.view'),
  ('Inventory Manager', 'inventory.manage'), ('Inventory Manager', 'stock.count'),
  ('Inventory Manager', 'reports.view'), ('Inventory Manager', 'order.view')
) as p(role_name, code) on p.role_name = ro.name
where ro.is_system
on conflict do nothing;
