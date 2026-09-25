#!/usr/bin/env node
// Fails if anything that looks like a server credential is present in build output.
// Library code that merely mentions key prefixes (e.g. supabase-js checking "sb_secret_")
// does not match: we look for actual credential values.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const roots = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['apps/web/dist', 'apps/api/dist', 'apps/print-agent/dist'];
const exact = ['SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'DB_PASSWORD']
  .map((k) => process.env[k])
  .concat(
    ['DATABASE_URL', 'TEST_DATABASE_URL']
      .map((k) => process.env[k])
      .filter(Boolean)
      .map((url) => /:\/\/[^:]+:([^@]+)@/.exec(url)?.[1]),
  )
  .filter((v) => v && v.length >= 12);

const patterns = [
  [/sb_secret_[A-Za-z0-9_-]{20,}/, 'Supabase secret key'],
  [/postgres(?:ql)?:\/\/[^\s"'`:/]+:[^\s"'`@]{6,}@/, 'database URL with password'],
];

const files = [];
const walk = (p) => {
  let st;
  try {
    st = statSync(p);
  } catch {
    return;
  }
  if (st.isDirectory()) for (const f of readdirSync(p)) walk(join(p, f));
  else files.push(p);
};
roots.forEach(walk);

const findings = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const [re, label] of patterns) if (re.test(text)) findings.push(`${file}: ${label}`);
  for (const value of exact)
    if (text.includes(value)) findings.push(`${file}: exact secret value from environment`);
  for (const jwt of text.match(/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g) ?? []) {
    try {
      const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
      if (payload.role === 'service_role') findings.push(`${file}: service_role JWT`);
    } catch {}
  }
}
if (findings.length) {
  console.error(`Secret scan FAILED (${findings.length}):\n  ${[...new Set(findings)].join('\n  ')}`);
  process.exit(1);
}
console.log(`Secret scan passed: ${files.length} files in ${roots.join(', ')}`);
