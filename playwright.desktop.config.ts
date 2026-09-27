import { defineConfig, devices } from '@playwright/test'
export default defineConfig({
  testDir: './e2e/desktop',
  outputDir: 'test-results/desktop',
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  reporter: [['line']],
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1280, height: 900 },
    screenshot: 'only-on-failure',
  },
})
