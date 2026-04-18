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
})
