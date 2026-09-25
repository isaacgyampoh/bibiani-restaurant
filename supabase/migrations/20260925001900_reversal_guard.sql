-- At most ONE reversal per order and stock item: a retried or duplicated cancellation can never
-- return the same stock twice (the database refuses, whatever the application does).
create unique index stock_movements_one_reversal_idx on stock_movements (order_id, item_id)
  where kind = 'sale_reversal';
