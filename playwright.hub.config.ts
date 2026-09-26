import { defineConfig } from '@playwright/test';

// Browser tests of the in-store MY FOOD Hub: the real web build served by a real hub, with an
// in-process cloud. Build the web app first (pnpm --filter @rp/web build).
export default defineConfig({
  testDir: 'e2e-hub',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:8790',
    viewport: { width: 1366, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 20_000,
  },
  webServer: {
    command: 'npx tsx apps/hub/test/e2e-server.ts',
    url: 'http://127.0.0.1:8790/hub/status',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
