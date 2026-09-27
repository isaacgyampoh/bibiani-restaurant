-- A PIN session stays bound to its device even when that device is deactivated or unpaired, so the
-- API can refuse it (instead of mistaking it for an email-link session). Additive: replaces a function.
drop function app.pin_session_device(uuid);
create function app.pin_session_device(p_session_id uuid)
returns table (
  restaurant_id uuid,
  staff_id uuid,
  device_id uuid,
  personal_staff_id uuid,
  device_usable boolean
)
language sql stable security definer set search_path = ''
as $$
  select p.restaurant_id, p.staff_id, p.device_id, d.personal_staff_id,
         coalesce(d.is_active and d.auth_user_id is not null, false)
    from public.pin_sessions p
    left join public.devices d on d.id = p.device_id
   where p.session_id = p_session_id
$$;
revoke all on function app.pin_session_device(uuid) from public;
grant execute on function app.pin_session_device(uuid) to rp_api;
