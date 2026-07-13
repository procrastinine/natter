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
      expect(source).toContain('malformedJsonFrameReport({')
      expect(source).not.toMatch(/console\.warn\([\s\S]{0,200}data:\s*ev\.data/u)
    }
    expect(readText('src/api/sse.ts')).toContain('malformedStreamFrameDiagnostic(')
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
    expect(workspace).toContain("- '@typescript/native'")
    expect(workspace).toContain('- typescript')
    expect(packageJson.scripts['deps:peers']).toBe('pnpm peers check')
    expect(refresh).toContain("await run(['peers', 'check'])")
    expect(workflow).toContain('pnpm deps:peers')
    expect(rule?.matchDepNames).toEqual(['@typescript/native', 'typescript'])
    expect(rule?.rangeStrategy).toBe('in-range-only')
    expect(rule?.allowedVersions).toBeUndefined()
  })

  it('keeps Pages publication independent from the quality workflow', () => {
    const packageJson = readJson<{ scripts: Record<string, string> }>('package.json')
    const deploy = readText('.github/workflows/deploy.yml')

    expect(packageJson.scripts['build:pages']).toBe('vite build')
    expect(deploy).not.toContain('uses: ./.github/workflows/verify.yml')
    expect(deploy).toContain('needs: build_pages')
    expect(deploy).toContain('run: pnpm build:pages')
  })

  it('keeps delivery ratchets in one shared baseline', () => {
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
    const browserMeasurement = readText('scripts/measure-delivery.mjs')
    expect(browserMeasurement).toContain('coldForbiddenRequests')
    expect(browserMeasurement).toContain('diagnostics')
  })
})
