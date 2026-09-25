-- Audit log (append-only) and device event trail.

create table audit_logs (
  id              bigint generated always as identity primary key,
  restaurant_id   uuid not null references restaurants(id),
  branch_id       uuid,
  actor_staff_id  uuid,
  actor_device_id uuid,
  action          text not null,           -- 'payment.void', 'print_job.retry', ...
  entity_type     text not null,
  entity_id       text not null,
  before_data     jsonb,
  after_data      jsonb,
  reason          text,
  correlation_id  text,
  created_at      timestamptz not null default now()
);
select app.enable_tenant_rls('audit_logs', p_append_only => true);
create index audit_logs_restaurant_idx on audit_logs (restaurant_id, created_at desc);
create index audit_logs_entity_idx on audit_logs (entity_type, entity_id);

create table device_events (
  id             bigint generated always as identity primary key,
  restaurant_id  uuid not null,
  device_id      uuid not null,
  event          text not null,            -- 'heartbeat_resumed', 'went_offline', 'printer_error'
  detail         jsonb,
  created_at     timestamptz not null default now(),
  foreign key (restaurant_id, device_id) references devices (restaurant_id, id)
);
select app.enable_tenant_rls('device_events', p_append_only => true);
create index device_events_device_idx on device_events (device_id, id desc);
