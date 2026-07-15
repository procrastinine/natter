import { defineConfig, devices } from '@playwright/test'

const host = '127.0.0.1'
const requestedBuildKind = process.env.E2E_BUILD_KIND ?? 'app'
if (requestedBuildKind !== 'app' && requestedBuildKind !== 'pages') {
  throw new Error(`Unsupported E2E_BUILD_KIND: ${requestedBuildKind}`)
}
const buildKind: 'app' | 'pages' = requestedBuildKind

const port = parseE2ePort(process.env.E2E_PORT ?? '4173', 'E2E_PORT')
const baseURL = `http://${host}:${port}`
const fakeProviderPort = parseE2ePort(
  process.env.E2E_FAKE_PROVIDER_PORT ?? '4174',
  'E2E_FAKE_PROVIDER_PORT',
)
if (fakeProviderPort === port) {
  throw new Error('E2E_FAKE_PROVIDER_PORT must differ from E2E_PORT')
}
const fakeProviderURL = `http://${host}:${fakeProviderPort}`
process.env.E2E_FAKE_PROVIDER_ORIGIN = fakeProviderURL
const buildCommand = buildKind === 'pages' ? 'pnpm build:pages' : 'pnpm build'

export function parseE2ePort(raw: string, name: string): number {
  const parsed = Number(raw)
  if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`Invalid ${name}: ${raw}`)
  }
  return parsed
}

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
  webServer: [
    {
      command: `${buildCommand} && pnpm preview --host ${host} --port ${port} --strictPort`,
      url: baseURL,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `pnpm fake-provider -- --host ${host} --port ${fakeProviderPort}`,
      url: `${fakeProviderURL}/healthz`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
  ],
})
