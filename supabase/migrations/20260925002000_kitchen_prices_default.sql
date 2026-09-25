-- The restaurant wants kitchen screens and tickets to show prices: make it the default for new
-- stations and switch it on for existing ones (still a per-station setting in Stations & routing).
alter table stations alter column show_prices set default true;
update stations set show_prices = true;
