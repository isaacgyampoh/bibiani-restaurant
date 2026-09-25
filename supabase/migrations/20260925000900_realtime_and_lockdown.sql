-- Realtime change signals + privilege lockdown.
--
-- Realtime is a NOTIFICATION mechanism only. Payloads carry ids/status/version;
-- clients refetch authoritative state from the API. Topics are private and
-- branch-scoped:
--   branch:<branch_id>:orders
--   branch:<branch_id>:station:<station_id>
--   branch:<branch_id>:print

create function app.notify(p_topic text, p_event text, p_payload jsonb) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if to_regprocedure('realtime.send(jsonb, text, text, boolean)') is null then
    return;  -- Realtime not installed (plain Postgres / test harness). Clients still reconcile by polling.
  end if;
  begin
    perform realtime.send(p_payload, p_event, p_topic, true);
  exception when others then
    -- A notification failure must never roll back an order. Clients reconcile by polling.
    raise warning 'realtime notify failed topic=% event=% error=%', p_topic, p_event, sqlerrm;
  end;
end $$;

create function app.on_order_changed() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform app.notify(
    'branch:' || new.branch_id || ':orders',
    'order_changed',
    jsonb_build_object('order_id', new.id, 'order_number', new.order_number, 'status', new.status,
                       'payment_status', new.payment_status, 'version', new.version)
  );
  return null;
end $$;

create trigger orders_notify after insert or update on orders
  for each row execute function app.on_order_changed();

create function app.on_ticket_changed() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform app.notify(
    'branch:' || new.branch_id || ':station:' || new.station_id,
    'ticket_changed',
    jsonb_build_object('ticket_id', new.id, 'order_id', new.order_id, 'status', new.status, 'version', new.version)
  );
  return null;
end $$;

create trigger production_tickets_notify after insert or update on production_tickets
  for each row execute function app.on_ticket_changed();

create function app.on_print_job_changed() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform app.notify(
    'branch:' || new.branch_id || ':print',
    'print_job_changed',
    jsonb_build_object('print_job_id', new.id, 'printer_id', new.printer_id, 'status', new.status)
  );
  return null;
end $$;

create trigger print_jobs_notify after insert or update of status on print_jobs
  for each row execute function app.on_print_job_changed();

-- Who may join a private branch topic: active staff with access to that branch,
-- or an active device paired to that branch. Identity comes from the verified JWT.
create function app.can_join_branch_topic(p_topic text) returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_branch uuid;
  v_uid uuid;
begin
  if p_topic !~ '^branch:[0-9a-f-]{36}:' then
    return false;
  end if;
  v_branch := split_part(p_topic, ':', 2)::uuid;
  v_uid := auth.uid();  -- identity from the verified Supabase JWT of the subscribing client
  if v_uid is null then
    return false;
  end if;
  return exists (
    select 1
    from public.staff s
    join public.staff_roles sr on sr.staff_id = s.id
    join public.branches b on b.id = v_branch and b.restaurant_id = s.restaurant_id
    where s.user_id = v_uid and s.is_active and (sr.branch_id is null or sr.branch_id = v_branch)
  ) or exists (
    select 1 from public.devices d
    where d.auth_user_id = v_uid and d.is_active and d.branch_id = v_branch
  );
end $$;

do $$
begin
  if to_regclass('realtime.messages') is not null then
    execute $p$
      create policy branch_topic_read on realtime.messages for select to authenticated
      using (realtime.messages.extension = 'broadcast' and app.can_join_branch_topic(realtime.topic()))
    $p$;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Lockdown: browser roles never touch public tables. All reads and writes go
-- through the API (application use cases). RLS stays enabled on every table
-- as a second wall.
-- ---------------------------------------------------------------------------
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema public from %I', r);
      execute format('revoke all on all sequences in schema public from %I', r);
      execute format('revoke all on all functions in schema public from %I', r);
      execute format('alter default privileges in schema public revoke all on tables from %I', r);
      execute format('alter default privileges in schema public revoke all on sequences from %I', r);
      execute format('alter default privileges in schema public revoke all on functions from %I', r);
    end if;
  end loop;
end $$;

grant usage, select on all sequences in schema public to app_api;

revoke all on all functions in schema app from public;
grant execute on function app.current_restaurant_id() to app_api;
grant execute on function app.notify(text, text, jsonb) to app_api;
grant execute on function app.on_order_changed() to app_api;
grant execute on function app.on_ticket_changed() to app_api;
grant execute on function app.on_print_job_changed() to app_api;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant usage on schema app to authenticated;
    grant execute on function app.can_join_branch_topic(text) to authenticated;
  end if;
end $$;
