-- Order number slip for the customer (restaurant owner's request, 2026-09-30): when an order is sent
-- to the kitchen the first time, the till's receipt printer prints the order number for the
-- customer. On by default for every area; a manager can turn it off per area (Floor & tables).
alter type print_job_kind add value if not exists 'order_number';
alter table operational_areas add column print_order_number boolean not null default true;
