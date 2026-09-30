-- Every member of staff can take orders (the restaurant owner's decision, 2026-09-30): each role,
-- in every restaurant, may take orders, send them to the kitchen, see orders and add customers to
-- orders. Additive only: nothing is taken away from any role. Payments, voids, refunds, discounts
-- and settings stay as they are.
insert into role_permissions (restaurant_id, role_id, permission_code)
select r.restaurant_id, r.id, p.code
from roles r
cross join (values ('order.create'), ('order.send'), ('order.view'), ('customer.attach')) as p(code)
on conflict do nothing;
