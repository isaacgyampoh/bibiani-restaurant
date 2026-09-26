-- "Buy X get Y free" promotions (e.g. buy 2 Cokes, get 1 free).
-- bundle_quantity = how many are bought, free_quantity = how many come free; the discount is the
-- price of the free items in every complete group of (bought + free).
alter table promotions add column free_quantity int check (free_quantity between 1 and 20);

-- Replace the kind checks (created unnamed in 20260925002100) with named ones that include the new kind.
do $$
declare r record;
begin
  for r in
    select conname from pg_constraint
    where conrelid = 'promotions'::regclass and contype = 'c'
      and (pg_get_constraintdef(oid) like '%bundle_price%' or pg_get_constraintdef(oid) like '%bundle_quantity >= 2%'
           or pg_get_constraintdef(oid) like '%bundle_quantity <= 99%')
  loop
    execute format('alter table promotions drop constraint %I', r.conname);
  end loop;
end $$;

alter table promotions add constraint promotions_kind_valid
  check (kind in ('percent_off', 'amount_off', 'fixed_price', 'bundle_price', 'buy_get_free'));
alter table promotions add constraint promotions_bundle_quantity_range
  check (bundle_quantity is null or bundle_quantity between 1 and 99);
alter table promotions add constraint promotions_kind_fields check (
  (kind = 'percent_off' and percent_bp is not null and amount is null and bundle_quantity is null and free_quantity is null) or
  (kind = 'amount_off' and amount > 0 and percent_bp is null and bundle_quantity is null and free_quantity is null) or
  (kind = 'fixed_price' and amount is not null and percent_bp is null and bundle_quantity is null and free_quantity is null) or
  (kind = 'bundle_price' and amount is not null and bundle_quantity >= 2 and percent_bp is null and free_quantity is null) or
  (kind = 'buy_get_free' and bundle_quantity between 1 and 20 and free_quantity is not null and amount is null and percent_bp is null)
);
