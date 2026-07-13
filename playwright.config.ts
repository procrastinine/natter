import { defineConfig, devices } from '@playwright/test'

const host = '127.0.0.1'
const port = process.env.E2E_PORT ?? '5173'
const baseURL = `http://${host}:${port}`
const serverMode = process.env.E2E_SERVER_MODE === 'preview' ? 'preview' : 'dev'
const e2eUserAgentSuffix = ' NatterE2E'
const reuseExistingServer =
  process.env.E2E_REUSE_EXISTING_SERVER === undefined
    ? !process.env.CI
    : process.env.E2E_REUSE_EXISTING_SERVER === '1'

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command:
      serverMode === 'preview'
        ? `pnpm preview --host ${host} --port ${port}`
        : `pnpm dev --host ${host} --port ${port}`,
    url: baseURL,
    reuseExistingServer,
    timeout: 60_000,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        userAgent: `${devices['Desktop Chrome'].userAgent}${e2eUserAgentSuffix}`,
      },
    },
    {
      name: 'firefox',
      use: {
        ...devices['Desktop Firefox'],
        userAgent: `${devices['Desktop Firefox'].userAgent}${e2eUserAgentSuffix}`,
      },
    },
  ],
})
