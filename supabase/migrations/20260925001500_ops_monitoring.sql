-- Minimum production monitoring. The API counts 5xx responses and authentication failures in
-- five-minute buckets; app.ops_health() summarises them together with printing health across all
-- restaurants. Counts only: no tenant data leaves these functions. Callable by rp_api alone, and
-- exposed only through the token-protected GET /v1/ops/health (see docs/13).

create table app.ops_counters (
  bucket_start  timestamptz not null,
  kind          text not null check (kind in ('http_5xx', 'auth_failure')),
  count         int not null default 0,
  primary key (bucket_start, kind)
);
alter table app.ops_counters enable row level security; -- no policies: reachable only through the functions below
revoke all on app.ops_counters from public;

create function app.ops_record(p_kind text) returns void
language sql volatile security definer set search_path = ''
as $$
  insert into app.ops_counters as c (bucket_start, kind, count)
  values (date_bin('5 minutes', now(), timestamptz '2000-01-01'), p_kind, 1)
  on conflict (bucket_start, kind) do update set count = c.count + 1;
  delete from app.ops_counters where bucket_start < now() - interval '7 days';
$$;

create function app.ops_health() returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'checkedAt', now(),
    -- last 15 minutes
    'http5xx', coalesce((select sum(count) from app.ops_counters
                          where kind = 'http_5xx' and bucket_start >= now() - interval '15 minutes'), 0),
    'authFailures', coalesce((select sum(count) from app.ops_counters
                               where kind = 'auth_failure' and bucket_start >= now() - interval '15 minutes'), 0),
    -- printing (paired agents and configured printers only; unpaired hardware is not an alert)
    'printJobsFailedLastHour', (select count(*) from public.print_jobs
                                 where status in ('failed', 'dead')
                                   and coalesce(last_attempt_at, created_at) >= now() - interval '1 hour'),
    'printJobsDeadLastDay', (select count(*) from public.print_jobs
                              where status = 'dead' and coalesce(last_attempt_at, created_at) >= now() - interval '1 day'),
    'printJobsRetrying', (select count(*) from public.print_jobs
                           where status in ('pending', 'claimed', 'failed') and attempts >= 3),
    'printJobsWaitingOver5Min', (select count(*) from public.print_jobs
                                  where status = 'pending' and created_at < now() - interval '5 minutes'
                                    and created_at >= now() - interval '1 day'),
    'agentsOffline', (select count(*) from public.devices
                       where kind = 'print_agent' and is_active and auth_user_id is not null and status = 'offline'),
    -- printers report health through their agent: an error means offline / out of paper / cover open
    'printersUnhealthy', (select count(*) from public.printers p join public.devices d on d.id = p.device_id
                           where d.is_active and p.last_error is not null)
  );
$$;

revoke all on function app.ops_record(text) from public;
revoke all on function app.ops_health() from public;
grant execute on function app.ops_record(text) to rp_api;
grant execute on function app.ops_health() to rp_api;
