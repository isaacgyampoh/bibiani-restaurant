-- Order numbers are reserved in a short transaction of their own, keyed by the
-- client's order id, so the per-branch counter row is locked for two statements
-- instead of the whole order submission (peak-hour contention). Retrying the
-- same order reuses its reservation. An order abandoned after reserving leaves a
-- gap: numbers stay unique per branch and business day, not strictly gap-free.
create table order_number_reservations (
  order_id       uuid primary key,
  restaurant_id  uuid not null,
  branch_id      uuid not null,
  business_day   date not null,
  order_number   int not null,
  reserved_at    timestamptz not null default now(),
  unique (branch_id, business_day, order_number),
  foreign key (restaurant_id, branch_id) references branches (restaurant_id, id)
);
select app.enable_tenant_rls('order_number_reservations');
