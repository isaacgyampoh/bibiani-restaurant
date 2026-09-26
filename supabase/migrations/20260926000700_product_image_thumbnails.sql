-- Small version of each product photo for POS buttons and lists (the full photo is still used in
-- the editor). Stored next to the photo in the same bucket; cleared whenever the photo changes.
alter table products add column image_thumb_path text
  check (image_thumb_path is null or image_thumb_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}-[0-9a-f-]{36}-t\.(webp|jpg|png)$');
