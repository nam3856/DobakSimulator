import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  workers: 2,
  timeout: 45000,
  expect: { timeout: 12000 },
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173/DobakSimulator/',
    viewport: { width: 1440, height: 1050 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node scripts/serve-test.mjs',
    url: 'http://127.0.0.1:4173/DobakSimulator/',
    reuseExistingServer: !process.env.CI,
  },
});
