#!/usr/bin/env node
/**
 * Copies every product photo out of Supabase Storage (public bucket `product-images`) to a local
 * folder, verified by retrieval: each file's byte size must equal the size Storage recorded, and its
 * SHA-256 is written to a manifest so the R2 upload (upload-photos.mjs) can be verified file by file.
 * Also checks every photo a product references exists.
 *
 *   node migration-package/scripts/backup-photos.mjs <postgres-url-of-a-restored-backup> <out-dir>
 *
 * Reads the object list from a RESTORED BACKUP (not production) and the files over the public
 * URL (read-only GET; the bucket is public, as the app serves them). Exit 1 on any failure.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import postgres from 'postgres';

const [url, out] = process.argv.slice(2);
if (!url || !out) throw new Error('usage: backup-photos.mjs <postgres-url> <out-dir>');
const BASE = 'https://lgoirbfyspuflqekrcgp.supabase.co/storage/v1/object/public/product-images';
const sql = postgres(url, { max: 1 });
const objects = await sql`select name, (metadata->>'size')::bigint as size, metadata->>'mimetype' as type
                          from storage.objects where bucket_id = 'product-images' order by name`;
const refs = await sql`select image_path p from public.products where image_path is not null
                       union select image_thumb_path from public.products where image_thumb_path is not null`;
await sql.end();

const names = new Set(objects.map((o) => o.name));
const missingRefs = refs.map((r) => r.p).filter((p) => !names.has(p));
const manifest = [];
let failed = 0;
for (const o of objects) {
  const res = await fetch(`${BASE}/${o.name.split('/').map(encodeURIComponent).join('/')}`);
  if (!res.ok) {
    console.error(`FAIL ${o.name}: HTTP ${res.status}`);
    failed++;
    continue;
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (BigInt(bytes.length) !== BigInt(o.size)) {
    console.error(`FAIL ${o.name}: ${bytes.length} bytes, Storage recorded ${o.size}`);
    failed++;
    continue;
  }
  const file = join(out, 'product-images', o.name);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, bytes, { mode: 0o600 });
  manifest.push({
    name: o.name,
    size: bytes.length,
    type: o.type,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}
writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`, { mode: 0o600 });
console.log(
  `${manifest.length} of ${objects.length} photos copied and verified (size), ` +
    `${manifest.reduce((a, m) => a + m.size, 0)} bytes; manifest with SHA-256 written`,
);
console.log(`products referencing a photo: ${refs.length} paths, ${missingRefs.length} missing from Storage`);
if (missingRefs.length) for (const p of missingRefs) console.error(`  missing: ${p}`);
if (failed || missingRefs.length) process.exit(1);
