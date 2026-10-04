import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'test/browser', testMatch: '*.spec.ts', timeout: 30000,
  use: { headless: true, viewport: { width: 900, height: 700 } },
  webServer: { command: 'node test/browser/server.mjs', url: 'http://127.0.0.1:41731/test/browser/harness.html', reuseExistingServer: false },
});
