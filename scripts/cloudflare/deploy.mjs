#!/usr/bin/env node
/**
 * Builds and deploys one environment to Cloudflare Workers.
 *   node scripts/cloudflare/deploy.mjs <production|staging> <env-file> [--secrets] [--dry-run]
 * --secrets uploads DATABASE_URL, SUPABASE_SECRET_KEY, PIN_PEPPER and MONITOR_TOKEN from the env file
 * as encrypted Worker secrets (through a temporary file that is deleted at once; nothing is printed).
 * Needs Cloudflare credentials: `wrangler login` locally, or CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID
 * in CI. Production deploys require green CI for the commit (scripts/deploy/require-ci-green.mjs) when
 * that script is present.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const [envName, envFile] = args.filter((a) => !a.startsWith('--'));
if (!envName || !envFile) throw new Error('usage: deploy.mjs <env> <env-file> [--secrets] [--dry-run]');
const run = (cmd, cmdArgs) => execFileSync(cmd, cmdArgs, { stdio: 'inherit' });

if (
  envName === 'production' &&
  existsSync('scripts/deploy/require-ci-green.mjs') &&
  !args.includes('--dry-run')
)
  run('node', ['scripts/deploy/require-ci-green.mjs']);

run('node', ['scripts/cloudflare/build.mjs', envName, envFile]);
const config = `.cloudflare/${envName}/wrangler.jsonc`;

if (args.includes('--secrets') && !args.includes('--dry-run')) {
  const env = Object.fromEntries(
    readFileSync(envFile, 'utf8')
      .split('\n')
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
  const names = ['DATABASE_URL', 'SUPABASE_SECRET_KEY', 'PIN_PEPPER', 'MONITOR_TOKEN'];
  const missing = names.filter((n) => !env[n]);
  if (missing.length) throw new Error(`${envFile} is missing ${missing.join(', ')}`);
  const dir = mkdtempSync(join(tmpdir(), 'cf-secrets-'));
  const file = join(dir, 'secrets.json');
  try {
    writeFileSync(file, JSON.stringify(Object.fromEntries(names.map((n) => [n, env[n]]))), { mode: 0o600 });
    run('npx', ['wrangler', 'secret', 'bulk', file, '--config', config]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

run('npx', ['wrangler', 'deploy', '--config', config, ...(args.includes('--dry-run') ? ['--dry-run'] : [])]);
