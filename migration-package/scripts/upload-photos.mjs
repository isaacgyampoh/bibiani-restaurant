#!/usr/bin/env node
/**
 * Uploads a photo backup (backup-photos.mjs) into a Supabase-compatible Storage (the server's, with
 * Cloudflare R2 underneath) at the SAME paths, so products keep their image_path unchanged, then
 * verifies every file by downloading it back through the PUBLIC URL and comparing SHA-256.
 *
 *   STORAGE_URL=https://supabase.example/storage/v1 SERVICE_KEY=... \
 *     node migration-package/scripts/upload-photos.mjs <backup-dir>
 *
 * Idempotent (x-upsert). Exit 1 if any file is missing or differs after the round trip.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
const { STORAGE_URL, SERVICE_KEY } = process.env;
if (!dir || !STORAGE_URL || !SERVICE_KEY)
  throw new Error('usage: STORAGE_URL=.. SERVICE_KEY=.. upload-photos.mjs <dir>');
const BUCKET = 'product-images';
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
const enc = (name) => name.split('/').map(encodeURIComponent).join('/');
let uploaded = 0;
let verified = 0;
const failures = [];
for (const m of manifest) {
  const bytes = readFileSync(join(dir, BUCKET, m.name));
  const put = await fetch(`${STORAGE_URL}/object/${BUCKET}/${enc(m.name)}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${SERVICE_KEY}`,
      apikey: SERVICE_KEY,
      'content-type': m.type ?? 'application/octet-stream',
      'x-upsert': 'true',
      'cache-control': 'max-age=31536000',
    },
    body: bytes,
  });
  if (!put.ok) {
    failures.push(`${m.name}: upload HTTP ${put.status} ${(await put.text()).slice(0, 120)}`);
    continue;
  }
  uploaded++;
  const get = await fetch(`${STORAGE_URL}/object/public/${BUCKET}/${enc(m.name)}`);
  const back = Buffer.from(await get.arrayBuffer());
  const sha = createHash('sha256').update(back).digest('hex');
  if (get.ok && sha === m.sha256) verified++;
  else
    failures.push(
      `${m.name}: read back HTTP ${get.status}, sha256 ${sha === m.sha256 ? 'same' : 'DIFFERENT'}`,
    );
}
console.log(
  `${uploaded}/${manifest.length} uploaded, ${verified}/${manifest.length} verified by retrieval (SHA-256)`,
);
for (const f of failures.slice(0, 20)) console.error(`  FAIL ${f}`);
if (verified !== manifest.length) process.exit(1);
