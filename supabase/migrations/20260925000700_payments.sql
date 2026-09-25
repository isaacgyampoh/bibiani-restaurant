-- Manual payment records (V1: no provider integrations).
-- Methods: cash, momo, card. "Split" is not a method: it is several records on one order.
-- Records are never edited. Corrections are voids (audited) or refunds (new rows).

create table payments (
  id                    uuid primary key,                 -- client-generated idempotency key
  restaurant_id         uuid not null,
  branch_id             uuid not null,
  order_id              uuid not null,
  direction             payment_direction not null default 'charge',
  refund_of_payment_id  uuid,
  method                payment_method not null,
  amount                bigint not null check (amount > 0),   -- amount applied to the order
  tendered_amount       bigint check (tendered_amount >= amount),
  change_amount         bigint not null default 0 check (change_amount >= 0),
  reference             text,                              -- e.g. MoMo transaction id read off the customer's phone
  note                  text,
  status                payment_record_status not null default 'recorded',
  request_hash          text not null,
  recorded_by_staff_id  uuid,
  device_id             uuid,
  created_at            timestamptz not null default now(),
  voided_at             timestamptz,
  voided_by_staff_id    uuid,
  void_reason           text,
  unique (restaurant_id, id),
  foreign key (restaurant_id, branch_id) references branches (restaurant_id, id),
  foreign key (restaurant_id, order_id) references orders (restaurant_id, id),
  foreign key (restaurant_id, refund_of_payment_id) references payments (restaurant_id, id),
  foreign key (restaurant_id, recorded_by_staff_id) references staff (restaurant_id, id),
  foreign key (restaurant_id, voided_by_staff_id) references staff (restaurant_id, id),
  foreign key (restaurant_id, device_id) references devices (restaurant_id, id),
  check ((direction = 'refund') = (refund_of_payment_id is not null)),
  check (method = 'cash' or tendered_amount is null),
  check ((status = 'voided') = (voided_at is not null and void_reason is not null))
);
select app.enable_tenant_rls('payments');
create index payments_order_idx on payments (order_id);
create index payments_branch_day_idx on payments (branch_id, created_at);
