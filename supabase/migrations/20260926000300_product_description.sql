-- A short customer-facing description per product (menu editor, POS details).
alter table products add column description text
  check (description is null or length(description) <= 300);
