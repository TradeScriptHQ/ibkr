import { defineConfig } from '@playwright/test'
import broker from './playwright.config.js'

// Fault injection exercises UI recovery; it does not qualify broker connectivity.
export default defineConfig({
  ...broker,
  testDir: './e2e/ui-regression',
  testIgnore: [],
  outputDir: 'test-results/ui-regression',
  reporter: [
    ['line'],
    ['html', { open: 'never', outputFolder: 'playwright-report/ui-regression' }],
  ],
})
