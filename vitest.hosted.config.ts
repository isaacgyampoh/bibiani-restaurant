import { defineConfig } from 'vitest/config';

// Runs the database-backed suites against hosted Supabase DEV. Loads .env (gitignored).
export default defineConfig({
  test: {
    include: [
      'packages/testing/test/**/*.test.ts',
      'packages/testing/test-hosted/**/*.test.ts',
      'apps/*/test/**/*.test.ts',
      'apps/*/test-hosted/**/*.test.ts',
    ],
    env: { DB_STATEMENT_TIMEOUT_MS: '60000', DB_LOCK_TIMEOUT_MS: '60000', ...loadEnv() },
    testTimeout: 180_000,
    hookTimeout: 180_000,
    maxWorkers: 2,
  },
});

function loadEnv(): Record<string, string> {
  const { readFileSync, existsSync } = require('node:fs') as typeof import('node:fs');
  // TEST_ENV_FILE selects the environment: .env (DEV, default) or .env.staging.
  const file = process.env.TEST_ENV_FILE ?? '.env';
  if (!existsSync(file)) return {};
  return Object.fromEntries(
    readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
}
