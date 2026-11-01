import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/desktop',
  outputDir: '.artifacts/desktop-results',
  workers: 1,
  forbidOnly: true,
  retries: 0,
  timeout: 30_000,
});
