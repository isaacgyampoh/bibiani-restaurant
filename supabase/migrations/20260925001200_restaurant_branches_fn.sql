-- Branch ids of a restaurant, so a restaurant-wide ("all branches") grant can be
-- expanded to exactly this restaurant's branches and never match a foreign id.
create function app.restaurant_branch_ids(p_restaurant_id uuid)
returns table (branch_id uuid)
language sql stable security definer set search_path = ''
as $$
  select id from public.branches where restaurant_id = p_restaurant_id
$$;
revoke all on function app.restaurant_branch_ids(uuid) from public;
grant execute on function app.restaurant_branch_ids(uuid) to rp_api;
