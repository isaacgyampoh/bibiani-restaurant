-- Owner onboarding: the platform operator invites the client's owner by email for a restaurant;
-- the owner proves the email (single-use link), sets their own password and becomes Owner.
-- Public sign-up stays disabled: only an open invitation can create an owner, and only for the
-- email it names. Nothing secret is stored here (no passwords, no tokens).
create table owner_invitations (
  id                 uuid primary key default gen_random_uuid(),
  restaurant_id      uuid not null references restaurants(id),
  email              text not null check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  note               text,
  created_at         timestamptz not null default now(),
  expires_at         timestamptz not null,
  accepted_at        timestamptz,
  accepted_staff_id  uuid,
  revoked_at         timestamptz,
  unique (restaurant_id, id),
  foreign key (restaurant_id, accepted_staff_id) references staff (restaurant_id, id)
);
select app.enable_tenant_rls('owner_invitations');
-- At most one open invitation per email (across restaurants).
create unique index owner_invitations_open_email_idx on owner_invitations (email)
  where accepted_at is null and revoked_at is null;

-- The owner is not yet a member of any restaurant when they start, so finding their invitation is
-- the one onboarding step that looks across tenants. It returns only what is needed to continue.
create function app.find_owner_invitation(p_email text, p_now timestamptz)
returns table (id uuid, restaurant_id uuid, restaurant_name text)
language sql stable security definer set search_path = ''
as $$
  select i.id, i.restaurant_id, r.name
  from public.owner_invitations i join public.restaurants r on r.id = i.restaurant_id
  where i.email = lower(trim(p_email)) and i.accepted_at is null and i.revoked_at is null and i.expires_at > p_now
$$;
revoke all on function app.find_owner_invitation(text, timestamptz) from public;
grant execute on function app.find_owner_invitation(text, timestamptz) to rp_api;
