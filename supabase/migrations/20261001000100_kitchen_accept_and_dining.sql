-- Two changes requested by the restaurant (2026-10-01). Additive only; nothing is deleted.
--
-- 1. Kitchen workflow NEW -> ACCEPT -> START -> READY -> DONE. The ticket already has accepted_at;
--    who accepted it is now kept with it (staff, device, and the name and role at that moment), like
--    "Sent by". Earlier tickets keep these empty: no acceptance is invented for them.
alter table production_tickets add column accepted_by_staff_id uuid;
alter table production_tickets add column accepted_by_device_id uuid;
alter table production_tickets add column accepted_by_name text;
alter table production_tickets add column accepted_by_role text;
alter table production_tickets add constraint production_tickets_accepted_by_fk
  foreign key (restaurant_id, accepted_by_staff_id) references staff (restaurant_id, id);

-- 2. "Hall" is called "Dining". "Hall" was never a built-in value: it is the name a restaurant gave
--    its dine-in area. Areas named exactly "Hall" are renamed "Dining" (only where the branch has no
--    "Dining" area already, so the unique branch/name rule always holds). The area id, its tables,
--    orders and settings are unchanged; past orders simply show the new name.
with renamed as (
  update operational_areas a
     set name = 'Dining'
   where a.name = 'Hall'
     and not exists (select 1 from operational_areas b where b.branch_id = a.branch_id and b.name = 'Dining')
  returning a.restaurant_id, a.branch_id, a.id
)
insert into audit_logs (restaurant_id, branch_id, action, entity_type, entity_id, before_data, after_data, reason)
select restaurant_id, branch_id, 'config.area.update', 'area', id::text,
       '{"name": "Hall"}'::jsonb, '{"name": "Dining"}'::jsonb,
       'Hall is called Dining (restaurant request, 2026-10-01)'
from renamed;
