#!/usr/bin/env node
/**
 * Builds one environment for Cloudflare Workers (Static Assets + the API Worker):
 *   .cloudflare/<env>/assets          web app (built with ONLY that environment's public VITE_* values),
 *                                     the manual PDFs (/manual/*) and a _headers file (security headers)
 *   .cloudflare/<env>/wrangler.jsonc  Worker config: apps/api/src/worker.ts, SPA fallback, /v1 + /health
 *                                     to the Worker, non-secret vars. Secrets are set separately (deploy.mjs).
 * Usage: node scripts/cloudflare/build.mjs <production|staging> <env-file>
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const [envName, envFile] = process.argv.slice(2);
if (!envName || !envFile) throw new Error('usage: build.mjs <env> <env-file>');
const env = Object.fromEntries(
  readFileSync(envFile, 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const SETTINGS = {
  production: { worker: 'my-food-production', appUrl: 'https://www.chefelisha.cc' },
  staging: { worker: 'my-food-staging', appUrl: 'https://my-food-staging.workers.dev' },
}[envName];
if (!SETTINGS) throw new Error(`unknown environment ${envName}`);
const release =
  process.env.RELEASE ??
  `${envName}-${execFileSync('git', ['rev-parse', '--short', 'HEAD']).toString().trim()}`;
const run = (cmd, args, extraEnv = {}) =>
  execFileSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...extraEnv } });

// 1. Schema version the API requires.
run('node', ['scripts/deploy/stamp-schema-version.mjs']);

// 2. Web app with a sealed env dir: only this environment's public values.
const envDir = mkdtempSync(join(tmpdir(), `web-env-${envName}-`));
const publicVars = Object.entries(env).filter(([k]) => k.startsWith('VITE_'));
if (!publicVars.some(([k]) => k === 'VITE_SUPABASE_URL'))
  throw new Error(`${envFile} has no VITE_SUPABASE_URL`);
writeFileSync(join(envDir, '.env'), `${publicVars.map(([k, v]) => `${k}=${v}`).join('\n')}\nVITE_API_URL=\n`);
run('pnpm', ['--filter', '@rp/web', 'exec', 'vite', 'build'], { VITE_ENV_DIR: envDir });

// 3. Static assets: the web app, the manual (no secrets), and security headers.
const out = `.cloudflare/${envName}`;
rmSync(out, { recursive: true, force: true });
mkdirSync(`${out}/assets/manual`, { recursive: true });
cpSync('apps/web/dist', `${out}/assets`, { recursive: true });
for (const f of readdirSync('docs/manual').filter((f) => /\.(pdf|xlsx)$/.test(f)))
  cpSync(`docs/manual/${f}`, `${out}/assets/manual/${f}`);
// Content-Security-Policy as on Vercel: this app, this environment's Supabase project (API,
// realtime, product photos) and Google Fonts. No inline scripts, no framing, no plugins.
const supabaseOrigin = new URL(env.VITE_SUPABASE_URL).origin;
const csp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  `img-src 'self' data: blob: ${supabaseOrigin}`,
  `connect-src 'self' ${supabaseOrigin} ${supabaseOrigin.replace('https://', 'wss://')}`,
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
writeFileSync(
  `${out}/assets/_headers`,
  `/*
  Content-Security-Policy: ${csp}
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  X-Frame-Options: DENY
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Strict-Transport-Security: max-age=31536000
/assets/*
  Cache-Control: public, max-age=31536000, immutable
`,
);

// 4. Worker config. Secrets (DATABASE_URL, SUPABASE_SECRET_KEY, PIN_PEPPER, MONITOR_TOKEN) are never
// written here: deploy.mjs uploads them as encrypted Worker secrets.
const config = {
  $schema: resolve('node_modules/wrangler/config-schema.json'),
  name: SETTINGS.worker,
  main: resolve('apps/api/src/worker.ts'),
  compatibility_date: '2026-10-01',
  compatibility_flags: ['nodejs_compat'],
  workers_dev: true,
  assets: {
    directory: './assets',
    not_found_handling: 'single-page-application',
    run_worker_first: ['/v1/*', '/health', '/health/*'],
  },
  // Run the API next to the database (Supabase, AWS eu-west-1), as on Vercel (dub1): every query is a
  // round trip, so running near the visitor instead would make each request seconds slower.
  placement: { region: 'aws:eu-west-1' },
  observability: { enabled: true },
  vars: {
    APP_ENV: envName,
    APP_URL: SETTINGS.appUrl,
    DEVICE_ACCOUNT_DOMAIN: 'devices.example.com',
    RELEASE: release,
    SUPABASE_URL: env.SUPABASE_URL,
    SUPABASE_ANON_KEY: env.SUPABASE_ANON_KEY,
  },
};
writeFileSync(`${out}/wrangler.jsonc`, `${JSON.stringify(config, null, 2)}\n`);

// 5. Guards: the web bundle must reference this environment only, and nothing may hold a secret.
const bundleText = execFileSync('grep', ['-rhoE', '[a-z]{20}\\.supabase\\.co', `${out}/assets`]).toString();
const refs = [...new Set(bundleText.split('\n').filter(Boolean))];
const expectedRef = new URL(env.VITE_SUPABASE_URL).host;
if (refs.length !== 1 || refs[0] !== expectedRef)
  throw new Error(`web bundle references ${refs.join(', ')}; expected only ${expectedRef}`);
run('node', ['scripts/check-bundle-secrets.mjs', out], {
  SUPABASE_SECRET_KEY: env.SUPABASE_SECRET_KEY,
  DATABASE_URL: env.DATABASE_URL,
});
writeFileSync(`${out}/release.txt`, `${release}\n`);
console.log(
  JSON.stringify({
    built: out,
    environment: envName,
    worker: SETTINGS.worker,
    release,
    supabase: expectedRef,
  }),
);
