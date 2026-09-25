-- Persistent print queue (transactional outbox). Jobs are inserted in the same
-- transaction as the production ticket they print, so a submitted ticket can
-- never exist without its print jobs. The database is authoritative; the print
-- agent only leases jobs and reports outcomes.

create table print_jobs (
  id                    uuid primary key,
  restaurant_id         uuid not null,
  branch_id             uuid not null,
  printer_id            uuid not null,                  -- current target (may be a backup)
  original_printer_id   uuid not null,                  -- target chosen at creation
  kind                  print_job_kind not null,
  order_id              uuid,                           -- correlation
  production_ticket_id  uuid,
  copy_no               int not null default 1 check (copy_no between 1 and 5),
  dedupe_key            text not null,
  document              jsonb not null,                 -- printer-agnostic document model
  status                print_job_status not null default 'pending',
  attempts              int not null default 0 check (attempts >= 0),
  max_attempts          int not null default 8 check (max_attempts > 0),
  possible_duplicate    boolean not null default false, -- set when a failure happened after bytes may have reached the printer
  is_reprint            boolean not null default false,
  next_attempt_at       timestamptz not null default now(),
  claim_id              uuid,                           -- changes on every lease; stale reports are rejected
  claimed_by_device_id  uuid,
  lease_expires_at      timestamptz,
  last_attempt_at       timestamptz,
  last_error            text,
  created_at            timestamptz not null default now(),
  printed_at            timestamptz,
  dead_at               timestamptz,
  version               int not null default 1,
  unique (restaurant_id, id),
  unique (restaurant_id, dedupe_key),
  foreign key (restaurant_id, branch_id) references branches (restaurant_id, id),
  foreign key (restaurant_id, printer_id) references printers (restaurant_id, device_id),
  foreign key (restaurant_id, original_printer_id) references printers (restaurant_id, device_id),
  foreign key (restaurant_id, order_id) references orders (restaurant_id, id),
  foreign key (restaurant_id, production_ticket_id) references production_tickets (restaurant_id, id),
  foreign key (restaurant_id, claimed_by_device_id) references devices (restaurant_id, id),
  check ((status = 'claimed') = (claim_id is not null and lease_expires_at is not null))
);
select app.enable_tenant_rls('print_jobs');
create index print_jobs_ready_idx on print_jobs (printer_id, next_attempt_at)
  where status in ('pending', 'failed');
create index print_jobs_claimed_idx on print_jobs (lease_expires_at) where status = 'claimed';
create index print_jobs_attention_idx on print_jobs (branch_id, status) where status = 'dead';
create index print_jobs_ticket_idx on print_jobs (production_ticket_id);

create table print_job_attempts (
  id              bigint generated always as identity primary key,
  restaurant_id   uuid not null,
  print_job_id    uuid not null,
  claim_id        uuid not null,
  agent_device_id uuid,
  printer_id      uuid not null,
  outcome         text not null check (outcome in ('printed', 'failed_before_send', 'failed_after_send', 'lease_expired')),
  error           text,
  created_at      timestamptz not null default now(),
  foreign key (restaurant_id, print_job_id) references print_jobs (restaurant_id, id)
);
select app.enable_tenant_rls('print_job_attempts', p_append_only => true);
create index print_job_attempts_job_idx on print_job_attempts (print_job_id, id);
