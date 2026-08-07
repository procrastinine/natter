import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(__dirname, '../..')

function readText(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8')
}

function readJson<T>(path: string): T {
  return JSON.parse(readText(path)) as T
}

describe('tooling telemetry audit', () => {
  it('does not depend on known telemetry or analytics SDKs', () => {
    const packageJson = readJson<{
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }>('package.json')
    const allDeps = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    }
    const denied = [
      '@sentry/browser',
      '@sentry/node',
      '@vercel/analytics',
      'amplitude-js',
      'analytics-node',
      'bugsnag',
      'mixpanel',
      'posthog-js',
      'rollbar',
      'segment',
      'statsig-js',
    ]

    for (const pkg of denied) {
      expect(allDeps[pkg], `Unexpected telemetry dependency: ${pkg}`).toBeUndefined()
    }
  })

  it('keeps VS Code workspace telemetry off and disables tsserver ATA', () => {
    const settings = readJson<Record<string, unknown>>('.vscode/settings.json')

    expect(settings['telemetry.telemetryLevel']).toBe('off')
    expect(settings['typescript.disableAutomaticTypeAcquisition']).toBe(true)
  })

  it('disables package-manager update notifier and funding prompts', () => {
    const npmrc = readText('.npmrc')

    expect(npmrc).toContain('fund=false')
    expect(npmrc).toContain('update-notifier=false')
  })

  it('does not opt into Vitest OpenTelemetry tracing', () => {
    const viteConfig = readText('vite.config.ts')

    expect(viteConfig).not.toMatch(/openTelemetry/i)
  })

  it('keeps malformed stream warnings on the bounded redaction path', () => {
    const adapters = [
      'src/api/anthropic-messages.ts',
      'src/api/chat-completions.ts',
      'src/api/gemini-native.ts',
      'src/api/responses.ts',
      'src/api/text-completions.ts',
    ]

    for (const adapter of adapters) {
      const source = readText(adapter)
      expect(source).toContain('consumeProviderStream')
      expect(source).not.toContain('decodeProviderStreamFrame({')
      expect(source).not.toMatch(/console\.warn\([\s\S]{0,200}data:\s*ev\.data/u)
    }
    const runtime = readText('src/api/provider-stream-runtime.ts')
    expect(runtime).toContain('decodeProviderStreamFrame({')
    expect(runtime).not.toMatch(/console\.warn\([\s\S]{0,200}data:\s*event\.data/u)
    const boundary = readText('src/api/sse.ts')
    expect(boundary).toContain('malformedJsonFrameReport({')
    expect(boundary).toContain('malformedStreamFrameDiagnostic(')
  })

  it('keeps the native compiler and tooling API on bounded aliases', () => {
    const packageJson = readJson<{
      scripts: Record<string, string>
      devDependencies: Record<string, string>
    }>('package.json')
    const workspace = readText('pnpm-workspace.yaml')
    const refresh = readText('scripts/deps-refresh.mjs')
    const workflow = readText('.github/workflows/verify.yml')
    const renovate = readJson<{
      packageRules: Array<{
        matchDepNames?: string[]
        rangeStrategy?: string
        allowedVersions?: string
      }>
    }>('renovate.json')
    const rule = renovate.packageRules.find((candidate) =>
      candidate.matchDepNames?.includes('@typescript/native'),
    )

    expect(packageJson.devDependencies['@typescript/native']).toMatch(/^npm:typescript@\^7\./u)
    expect(packageJson.devDependencies.typescript).toMatch(/^npm:@typescript\/typescript6@\^6\./u)
    expect(workspace).toContain('minimumReleaseAge: 1440')
    expect(workspace).toContain('minimumReleaseAgeStrict: true')
    expect(workspace).toContain('minimumReleaseAgeIgnoreMissingTime: false')
    expect(workspace).toContain('trustPolicy: no-downgrade')
    expect(workspace).toContain('trustLockfile: false')
    expect(workspace).toContain('blockExoticSubdeps: true')
    expect(workspace).toContain('strictDepBuilds: true')
    expect(workspace).toContain('update:\n  ignoreDeps:')
    expect(workspace).not.toContain('updateConfig:')
    expect(workspace).toContain("- '@typescript/native'")
    expect(workspace).toContain('- typescript')
    expect(packageJson.scripts['deps:peers']).toBe('pnpm peers check')
    expect(refresh).toContain("await run(['peers', 'check'])")
    expect(refresh).toContain("await run(['install', '--frozen-lockfile'])")
    expect(refresh).toContain('DependencyNodeRuntimeMismatch')
    expect(refresh).toContain('DependencyPnpmRuntimeMismatch')
    expect(workflow).toContain('pnpm verify:ci')
    expect(workflow).not.toContain('pnpm deps:peers')
    expect(rule?.matchDepNames).toEqual(['@typescript/native', 'typescript'])
    expect(rule?.rangeStrategy).toBe('in-range-only')
    expect(rule?.allowedVersions).toBeUndefined()
  })

  it('keeps Pages publication independent from the quality workflow', () => {
    const packageJson = readJson<{ scripts: Record<string, string> }>('package.json')
    const deploy = readText('.github/workflows/deploy.yml')

    expect(packageJson.scripts['build:pages']).toBeUndefined()
    expect(packageJson.scripts.build).toBe('tsc -b && vite build && node scripts/verify-dist.mjs')
    expect(packageJson.scripts['e2e:production-startup']).toMatch(/^playwright test /u)
    expect(deploy).not.toContain('uses: ./.github/workflows/verify.yml')
    expect(deploy).toContain('needs: build_pages')
    expect(deploy).toContain('run: pnpm e2e:production-startup')
    expect(deploy).not.toContain('E2E_SERVER_MODE')
    expect(deploy.indexOf('run: pnpm e2e:production-startup')).toBeLessThan(
      deploy.indexOf('uses: actions/upload-pages-artifact'),
    )
  })

  it('keeps delivery ratchets advisory and artifact correctness blocking', () => {
    const baseline = readJson<{
      deliveryBudgets: {
        maximums: Record<string, number>
        coldStaticGraphMaximums: Record<string, number>
        namedAssets: Record<string, unknown>
        browserMeasurements: {
          preview: Record<string, number>
          dev: Record<string, number>
        }
        coldForbiddenPathFragments: string[]
      }
    }>('scripts/performance-baseline.json')

    expect(baseline.deliveryBudgets.maximums.totalBytes).toBeGreaterThan(0)
    expect(baseline.deliveryBudgets.coldStaticGraphMaximums.gzipBytes).toBeGreaterThan(0)
    expect(Object.keys(baseline.deliveryBudgets.namedAssets)).toContain('branch-tree')
    expect(Object.keys(baseline.deliveryBudgets.browserMeasurements)).toEqual(['preview', 'dev'])
    expect(
      Object.keys(baseline.deliveryBudgets.browserMeasurements.preview).length,
    ).toBeGreaterThan(0)
    expect(baseline.deliveryBudgets.browserMeasurements.dev).toEqual({})
    expect(baseline.deliveryBudgets.coldForbiddenPathFragments.length).toBeGreaterThan(0)
    for (const script of [
      'scripts/verify-dist.mjs',
      'scripts/report-performance-baseline.mjs',
      'scripts/measure-delivery.mjs',
    ]) {
      expect(readText(script)).toContain('baseline.deliveryBudgets')
    }
    const distributionVerifier = readText('scripts/verify-dist.mjs')
    expect(distributionVerifier).not.toContain('deliveryBudgetProblems')
    expect(distributionVerifier).toContain('expected one module entry script')
    const performanceReporter = readText('scripts/report-performance-baseline.mjs')
    expect(performanceReporter).toContain('deliveryBudgetProblems')
    expect(performanceReporter).toContain('if (hardProblems.length > 0) process.exitCode = 1')
    expect(performanceReporter).not.toContain('depcruise')
    expect(performanceReporter).not.toContain('jscpd')
    expect(performanceReporter).toContain('VERIFICATION_PERFORMANCE_INPUT')
    expect(performanceReporter).toContain('evaluateStreamProfile')
    expect(performanceReporter).toContain('evaluateConcurrentStreamProfile')
    expect(performanceReporter).toContain('targetDeviations: bundleBudgetProblems')
    expect(performanceReporter).not.toContain('...bundleBudgetProblems')
    expect(distributionVerifier).toContain('missing named distribution asset')
    const browserMeasurement = readText('scripts/measure-delivery.mjs')
    expect(browserMeasurement).toContain('coldForbiddenRequests')
    expect(browserMeasurement).toContain('diagnostics')
    expect(browserMeasurement).toContain('if (report.hardProblems.length > 0) process.exitCode = 1')
  })
})
