-- Managers can add and edit staff (the restaurant owner's decision, 2026-09-30). Additive only.
-- Owners stay protected in the application: only an Owner may give the Owner role, change the
-- Owner role, or change, reset or deactivate an Owner. On a shared till (PIN sign-in) staff
-- management stays off for everyone, as before: it works on the person's own phone or laptop.
insert into role_permissions (restaurant_id, role_id, permission_code)
select r.restaurant_id, r.id, 'staff.manage'
from roles r
where r.is_system and r.name = 'Manager'
on conflict do nothing;
