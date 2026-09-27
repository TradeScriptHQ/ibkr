import { defineConfig, devices } from '@playwright/test'
import { unusedPort } from './scripts/isolated-mock.js'

process.env.MOCK_E2E_PORT ??= String(await unusedPort())
const origin = `http://localhost:${process.env.MOCK_E2E_PORT}`

export default defineConfig({
  testDir: './e2e/mock',
  outputDir: 'test-results/mock',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [['line'], ['html', { open: 'never', outputFolder: 'playwright-report/mock' }]],
  use: {
    baseURL: origin,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev -- --isolated-mock',
    url: origin,
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
    timeout: 120_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1728, height: 1117 } },
    },
  ],
})
