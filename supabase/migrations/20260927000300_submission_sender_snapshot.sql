-- Who sent each round of an order to the kitchen, as it was at that moment. The staff id already
-- exists (submitted_by_staff_id); the name and role are now kept too, so history stays correct when
-- the person is renamed, changes role, is deactivated, or someone else later uses the same till.
-- Additive only.
alter table order_submissions add column submitted_by_name text;
alter table order_submissions add column submitted_by_role text;

-- Earlier rounds: best-effort snapshot from today's staff records.
update order_submissions s
   set submitted_by_name = st.display_name,
       submitted_by_role = (
         select r.name from staff_roles sr join roles r on r.id = sr.role_id
          where sr.staff_id = st.id
          order by array_position(array['Owner','Manager','Supervisor','Cashier','Waiter','Kitchen'], r.name) nulls last, r.name
          limit 1)
  from staff st
 where st.id = s.submitted_by_staff_id and s.submitted_by_name is null;

-- "Orders sent to the kitchen by staff" reports.
create index order_submissions_staff_idx on order_submissions (submitted_by_staff_id, submitted_at);
