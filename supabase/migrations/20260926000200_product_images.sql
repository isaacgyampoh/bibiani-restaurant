-- Product photos for the POS and menu.
--
-- The picture itself lives in Supabase Storage (bucket `product-images`, public read: menu photos
-- are not sensitive and paths contain random ids). Only the API writes to it, with the server-side
-- secret key: there are no storage policies for browser roles, so browsers can never upload or delete.
-- The product row keeps the object path; the API turns it into a public URL.
alter table products add column image_path text
  check (image_path is null or image_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}-[0-9a-f-]{36}\.(webp|jpg|png)$');

do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('product-images', 'product-images', true, 2097152, array['image/webp', 'image/jpeg', 'image/png'])
    on conflict (id) do nothing;
  end if;
end $$;
