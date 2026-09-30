import { defineConfig, devices } from '@playwright/test'
import { selectedPlaywrightProjects } from './scripts/playwright-projects.mjs'

delete process.env.NO_COLOR

const host = '127.0.0.1'
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
const devPreviewParity = process.env.E2E_DEV_PREVIEW_PARITY === '1'
const devPort = parseE2ePort(process.env.E2E_DEV_PORT ?? '4175', 'E2E_DEV_PORT')
if (new Set([port, fakeProviderPort, devPort]).size !== 3) {
  throw new Error('E2E_PORT, E2E_FAKE_PROVIDER_PORT, and E2E_DEV_PORT must differ')
}
const devBaseURL = `http://${host}:${devPort}`
const reuseExistingServer = process.env.E2E_REUSE_EXISTING_SERVER === '1'
const packageManagerCommand = verificationPackageManagerCommand(process.env)
const skipBuild = process.env.E2E_SKIP_BUILD === '1'
const outputDir = process.env.E2E_PLAYWRIGHT_OUTPUT_DIR ?? 'test-results/playwright-results'
const applicationServerCommand = [
  ...(skipBuild ? [] : [`${packageManagerCommand} build`]),
  `${packageManagerCommand} exec vite preview --host ${host} --port ${port} --strictPort`,
].join(' && ')
const devServerCommand = `${packageManagerCommand} dev --host ${host} --port ${devPort} --strictPort`

export function parseE2ePort(raw: string, name: string): number {
  const parsed = Number(raw)
  if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`Invalid ${name}: ${raw}`)
  }
  return parsed
}

export function verificationPackageManagerCommand(environment: NodeJS.ProcessEnv): string {
  const node = environment.VERIFICATION_NODE_EXECUTABLE
  const pnpm = environment.VERIFICATION_PNPM_EXECUTABLE
  if ((node === undefined) !== (pnpm === undefined)) {
    throw new Error('Verification package-manager runtime is incomplete')
  }
  return node && pnpm ? `${shellArgument(node)} ${shellArgument(pnpm)}` : 'pnpm'
}

function shellArgument(value: string): string {
  if (
    value.length === 0 ||
    value.includes('\u0000') ||
    value.includes('\r') ||
    value.includes('\n')
  ) {
    throw new Error('Verification package-manager path is invalid')
  }
  return process.platform === 'win32'
    ? `"${value.replaceAll('"', '""')}"`
    : `'${value.replaceAll("'", `'"'"'`)}'`
}

export default defineConfig({
  testDir: './tests/e2e',
  outputDir,
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  workers: 2,
  reporter: [['list'], ['./scripts/playwright-proof-reporter.mjs']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: applicationServerCommand,
      url: baseURL,
      reuseExistingServer,
      timeout: 60_000,
    },
    {
      command: `${packageManagerCommand} fake-provider -- --host ${host} --port ${fakeProviderPort}`,
      url: `${fakeProviderURL}/healthz`,
      reuseExistingServer,
      timeout: 60_000,
    },
    ...(devPreviewParity
      ? [
          {
            command: devServerCommand,
            url: `${devBaseURL}/src/main.tsx`,
            reuseExistingServer,
            timeout: 60_000,
          },
        ]
      : []),
  ],
  projects: selectedPlaywrightProjects(process.env)
    .filter((project) => !project.activation || process.env[project.activation] === '1')
    .map(
      ({
        name,
        browser,
        testMatch,
        testIgnore,
        dependencies,
        fullyParallel,
        workers,
        development,
        headed,
      }) => ({
        name,
        testMatch,
        ...(testIgnore ? { testIgnore } : {}),
        ...(dependencies ? { dependencies } : {}),
        ...(fullyParallel === undefined ? {} : { fullyParallel }),
        ...(workers === undefined ? {} : { workers }),
        use: {
          ...devices[browser === 'firefox' ? 'Desktop Firefox' : 'Desktop Chrome'],
          baseURL: development ? devBaseURL : baseURL,
          ...(headed ? { headless: false } : {}),
        },
      }),
    ),
})
