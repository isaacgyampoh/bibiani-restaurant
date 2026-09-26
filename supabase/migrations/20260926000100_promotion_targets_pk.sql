-- Every table has a primary key (verified by scripts/env/verify-environment.ts).
-- promotion_targets was created without one in 20260925002100; add a surrogate key.
alter table promotion_targets add column id uuid not null default gen_random_uuid();
alter table promotion_targets add primary key (id);
