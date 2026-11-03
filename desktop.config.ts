import { defineConfig } from '@playwright/test';
import { nativeScenarios, testRunId } from './test-evidence';

export default defineConfig({
  testDir: './tests/desktop',
  outputDir: `.artifacts/desktop-results/${testRunId}`,
  metadata: { evidenceRunId: testRunId },
  projects: [
    ...nativeScenarios.map(name => ({ name, testMatch: 'shell.spec.ts', metadata: { scenario: name } })),
    { name: 'settings', testMatch: 'settings.spec.ts' },
    { name: 'recent', testMatch: 'recent.spec.ts' },
    { name: 'accessibility', testMatch: 'accessibility.spec.ts' },
    { name: 'text-preview', testMatch: 'text-preview.spec.ts' },
    { name: 'language', testMatch: 'language.spec.ts' },
    { name: 'encoding', testMatch: 'encoding.spec.ts' },
    { name: 'autosave', testMatch: 'autosave.spec.ts' },
    { name: 'recovery', testMatch: 'recovery.spec.ts' },
    { name: 'reliability', testMatch: 'reliability.spec.ts' },
    { name: 'g2-special', testMatch: 'g2-special.spec.ts' },
    { name: 'markdown', testMatch: 'markdown.spec.ts' },
  ],
  workers: 1,
  forbidOnly: true,
  retries: 0,
  timeout: 30_000,
});
