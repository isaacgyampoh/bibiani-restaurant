import { defineConfig } from '@playwright/test';

// Browser end-to-end tests against the local API + web app, backed by hosted Supabase DEV.
// Prerequisite: a configured DEV restaurant (.dev-accounts.json from `pnpm dev:configure-demo`).
const remote = process.env.E2E_BASE_URL; // e.g. the deployed staging URL; no local servers then

export default defineConfig({
  testDir: 'e2e',
  timeout: 240_000,
  expect: { timeout: 30_000 },
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: remote ?? 'http://127.0.0.1:5173',
    viewport: { width: 1366, height: 900 },
    trace: 'retain-on-failure',
  },
  webServer: remote
    ? undefined
    : [
        {
          command: 'pnpm --filter @rp/api exec tsx --env-file=../../.env src/main.ts',
          url: 'http://127.0.0.1:8787/health',
          reuseExistingServer: true,
          timeout: 60_000,
        },
        {
          command: 'pnpm --filter @rp/web exec vite --host 127.0.0.1 --port 5173 --strictPort',
          url: 'http://127.0.0.1:5173',
          reuseExistingServer: true,
          timeout: 60_000,
        },
      ],
});
