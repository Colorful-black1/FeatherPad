import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: '.artifacts/playwright-results',
  forbidOnly: true,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:1420',
    channel: 'msedge',
    viewport: { width: 1200, height: 800 },
    trace: 'retain-on-failure',
  },
  webServer: {
    // Exercise the same built frontend embedded by Tauri, without a dev-module transformation waterfall.
    command: 'pnpm build:web && pnpm exec vite preview --host 127.0.0.1 --port 1420 --strictPort',
    url: 'http://127.0.0.1:1420',
    reuseExistingServer: !process.env.CI,
  },
});
