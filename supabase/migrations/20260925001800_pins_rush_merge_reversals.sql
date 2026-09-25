-- Product pass: staff PINs, rush orders, merged orders, kitchen price display,
-- restaurant contact details, and the stock reversal movement kind.

-- 1. Staff PINs. Only a keyed HMAC of the PIN is stored ("pin_lookup"): the key (pepper) lives in
--    the API's environment, never in the database, so a database copy cannot be brute-forced.
--    Deterministic per restaurant, so uniqueness is enforced by an index without revealing owners.
alter table staff
  add column pin_lookup text,
  add column pin_set_at timestamptz,
  add column pin_must_change boolean not null default false,
  add column activated_at timestamptz;
create unique index staff_restaurant_pin_idx on staff (restaurant_id, pin_lookup) where pin_lookup is not null;

-- Every PIN attempt, for lockout (per till and per restaurant) and the security log. Append-only.
create table pin_attempts (
  id             bigint generated always as identity primary key,
  restaurant_id  uuid not null references restaurants(id),
  device_id      uuid,
  staff_id       uuid,
  succeeded      boolean not null,
  created_at     timestamptz not null default now()
);
select app.enable_tenant_rls('pin_attempts', true);
create index pin_attempts_device_idx on pin_attempts (device_id, created_at desc);
create index pin_attempts_restaurant_idx on pin_attempts (restaurant_id, created_at desc);

-- 2. Orders: rush priority, and merge history (the merged order keeps its own history and points
--    at the order that now carries its items and payments).
alter table orders
  add column is_rush boolean not null default false,
  add column merged_into_order_id uuid;
alter table orders add constraint orders_merged_into_fk
  foreign key (restaurant_id, merged_into_order_id) references orders (restaurant_id, id);

-- 3. Stations can show authoritative line prices on their screen / ticket (presentation only).
alter table stations add column show_prices boolean not null default false;

-- 4. Restaurant contact details printed on receipts.
alter table restaurants add column phone text;

-- 5. Stock returned when a sent order is cancelled (compensating movement; the sale stays in the ledger).
alter type stock_movement_kind add value 'sale_reversal';

-- 6. The owner can edit the restaurant's own name and receipt details (Settings), nothing else.
grant update (name, phone, receipt_footer) on restaurants to app_api;
create policy tenant_update on restaurants for update to app_api
  using (id = app.current_restaurant_id()) with check (id = app.current_restaurant_id());
