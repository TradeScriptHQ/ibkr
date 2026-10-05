import { defineConfig, devices } from '@playwright/test'
import { TERMINAL_ORIGIN } from './e2e/support/terminal-origin.js'

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.spec.ts',
  testIgnore: ['**/mock/**', '**/desktop/**', '**/ui-regression/**'],
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  grepInvert: /@paper/u,
  reporter: [['line'], ['html', { open: 'never' }]],
  use: {
    baseURL: TERMINAL_ORIGIN,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  // Connect only to an explicitly started workstation. Never boot a saved live profile.
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1728, height: 1117 } },
    },
  ],
})
