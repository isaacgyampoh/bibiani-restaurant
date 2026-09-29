-- Owners and managers sign in on a new phone or laptop with their email + PIN (no emailed link).
-- The API login (rp_api) cannot read staff across restaurants, so this narrow function answers
-- "which active owner / manager has this email", for the server only.
create function app.managers_by_email(p_email text)
returns table (restaurant_id uuid, staff_id uuid)
language sql stable security definer set search_path = ''
as $$
  select s.restaurant_id, s.id
    from public.staff s
   where lower(s.email) = lower(trim(p_email)) and s.is_active and s.user_id is not null
     and exists (select 1 from public.staff_roles sr
                   join public.role_permissions rp on rp.role_id = sr.role_id
                  where sr.staff_id = s.id and rp.permission_code = 'device.manage')
$$;
revoke all on function app.managers_by_email(text) from public;
grant execute on function app.managers_by_email(text) to rp_api;

create index pin_attempts_staff_idx on pin_attempts (staff_id, created_at) where device_id is null;
