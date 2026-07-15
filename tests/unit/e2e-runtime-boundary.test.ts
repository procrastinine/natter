import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { parseE2ePort } from '../../playwright.config'

const ROOT = resolve(__dirname, '../..')
const E2E_ROOT = resolve(ROOT, 'tests/e2e')
const SRC_ROOT = resolve(ROOT, 'src')
const TOOLS_ROOT = resolve(ROOT, 'tools')
const SCRIPTS_ROOT = resolve(ROOT, 'scripts')
const SOURCE_EXTENSION_PATTERN = /\.[cm]?[jt]sx?$/u
const BROWSER_INSTRUMENTATION_PATTERN =
  /(?:['"`]\/src\/|\b__debug[A-Za-z0-9_]*\b|\b__nuke\b|VITE_NATTER_DEBUG|instrumented-helpers|E2E_LANE)/u

function readText(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8')
}

function readJson<T>(path: string): T {
  return JSON.parse(readText(path)) as T
}

function filesBelow(root: string): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(root, entry.name)
    return entry.isDirectory() ? filesBelow(path) : [path]
  })
}

function relativePath(root: string, path: string): string {
  return relative(root, path).split(sep).join('/')
}

function targetsRuntimeExcludedTooling(importerPath: string, specifier: string): boolean {
  const withoutQuery = specifier.replace(/[?#].*$/u, '')
  const target = withoutQuery.startsWith('/')
    ? resolve(ROOT, `.${withoutQuery}`)
    : resolve(dirname(importerPath), withoutQuery)
  return [TOOLS_ROOT, SCRIPTS_ROOT].some(
    (root) => target === root || target.startsWith(`${root}${sep}`),
  )
}

function toolingImportOffenders(path: string, source = readFileSync(path, 'utf8')): string[] {
  const sourcePath = relativePath(SRC_ROOT, path)
  const sourceFile = ts.createSourceFile(
    sourcePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    sourcePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const offenders: string[] = []
  const record = (node: ts.Node, kind: string, expression: ts.Expression | undefined) => {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
    if (!expression || !ts.isStringLiteralLike(expression)) {
      offenders.push(`${sourcePath}:${line}:${kind}:<non-literal>`)
    } else if (targetsRuntimeExcludedTooling(path, expression.text)) {
      offenders.push(`${sourcePath}:${line}:${kind}:${expression.text}`)
    }
  }
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      record(node, 'import', node.moduleSpecifier)
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      record(node, 'export', node.moduleSpecifier)
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      record(node, 'import-equals', node.moduleReference.expression)
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      record(node, 'dynamic-import', node.arguments[0])
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require'
    ) {
      record(node, 'require', node.arguments[0])
    }
    node.forEachChild(visit)
  }
  visit(sourceFile)
  return offenders
}

function e2eInstrumentationSubject(path: string): string {
  const source = readFileSync(path, 'utf8')
  if (relativePath(E2E_ROOT, path) !== 'production-startup.spec.ts') return source
  return source
    .replaceAll('/src/main.tsx', '/')
    .replaceAll('__debugFakeStream', 'absentGlobalOne')
    .replaceAll('__debugRuntime', 'absentGlobalTwo')
    .replaceAll('__debugScroll', 'absentGlobalThree')
    .replaceAll('__debugStreams', 'absentGlobalFour')
    .replaceAll('__nuke', 'absentGlobalFive')
}

describe('built-app runtime boundary', () => {
  it('keeps runtime source imports pointed away from dev-only tools', () => {
    const offenders = filesBelow(SRC_ROOT)
      .filter((path) => SOURCE_EXTENSION_PATTERN.test(path))
      .flatMap((path) => toolingImportOffenders(path))
      .sort()
    expect(offenders).toEqual([])

    const cruiser = readText('.dependency-cruiser.cjs')
    expect(cruiser).toContain("name: 'runtime-must-not-import-devtools'")
    expect(cruiser).toContain("name: 'runtime-must-not-import-scripts'")
    expect(cruiser).toContain("from: { path: '^src/' }")
    expect(cruiser).toContain("to: { path: '^tools/' }")
    expect(cruiser).toContain("to: { path: '^scripts/' }")
    expect(cruiser).toContain("includeOnly: '^(src|tools|scripts)/'")
  })

  it('recognizes static, dynamic, and unanalyzable imports across the devtool boundary', () => {
    const importer = resolve(SRC_ROOT, 'nested/runtime.ts')
    const source = [
      "import type { One } from '../../tools/static'",
      "export { Two } from '/scripts/reexport?raw'",
      "import Three = require('../../tools/import-equals')",
      'void import(`../../tools/dynamic`)',
      "require('../../tools/commonjs')",
      'void import(runtimeModule)',
    ].join('\n')
    expect(toolingImportOffenders(importer, source)).toEqual([
      'nested/runtime.ts:1:import:../../tools/static',
      'nested/runtime.ts:2:export:/scripts/reexport?raw',
      'nested/runtime.ts:3:import-equals:../../tools/import-equals',
      'nested/runtime.ts:4:dynamic-import:../../tools/dynamic',
      'nested/runtime.ts:5:require:../../tools/commonjs',
      'nested/runtime.ts:6:dynamic-import:<non-literal>',
    ])
  })

  it('canonicalizes E2E ports before checking server separation', () => {
    expect(parseE2ePort('04174', 'TEST_PORT')).toBe(4174)
    expect(parseE2ePort('4174', 'TEST_PORT')).toBe(4174)
    for (const invalid of ['', '0', '-1', '1.5', '65536', 'not-a-port']) {
      expect(() => parseE2ePort(invalid, 'TEST_PORT')).toThrow(`Invalid TEST_PORT: ${invalid}`)
    }

    const config = readText('playwright.config.ts')
    expect(config).toContain('if (fakeProviderPort === port)')
  })

  it('keeps every browser spec independent of Vite source modules and debug globals', () => {
    const offenders = filesBelow(E2E_ROOT)
      .filter((path) => SOURCE_EXTENSION_PATTERN.test(path))
      .flatMap((path) => {
        const source = e2eInstrumentationSubject(path)
        return BROWSER_INSTRUMENTATION_PATTERN.test(source) ? [relativePath(E2E_ROOT, path)] : []
      })
    expect(offenders).toEqual([])
    expect(
      filesBelow(E2E_ROOT)
        .map((path) => relativePath(E2E_ROOT, path))
        .filter((path) => /\.instrumented\.(?:spec|test)\.[cm]?[jt]sx?$/u.test(path)),
    ).toEqual([])
  })

  it('runs one built artifact with the standalone fake API server', () => {
    const config = readText('playwright.config.ts')
    const packageJson = readJson<{ scripts: Record<string, string> }>('package.json')

    expect(config).toContain("buildKind === 'pages' ? 'pnpm build:pages' : 'pnpm build'")
    expect(config).toContain('pnpm preview --host')
    expect(config).toContain('pnpm fake-provider -- --host')
    expect(config).toContain('E2E_FAKE_PROVIDER_ORIGIN')
    expect(config).not.toContain('E2E_FAKE_PROVIDER_URL')
    expect(config).toMatch(/url: `\$\{fakeProviderURL\}\/healthz`/u)
    expect(config).toContain('reuseExistingServer: false')
    expect(config).toContain('--strictPort')
    expect(config).not.toContain('pnpm dev')
    expect(config).not.toContain('VITE_NATTER_DEBUG')
    expect(config).not.toContain('E2E_LANE')
    expect(config).not.toContain('testIgnore')
    expect(config).not.toContain('testMatch')

    expect(packageJson.scripts.e2e).toBe('playwright test --project=chromium')
    expect(packageJson.scripts['e2e:production']).toBe('playwright test --project=chromium')
    expect(packageJson.scripts['e2e:instrumented']).toBeUndefined()
    expect(packageJson.scripts['e2e:smoke']).toMatch(/^playwright test /u)
    expect(packageJson.scripts['e2e:production-startup']).toMatch(/^E2E_BUILD_KIND=pages /u)
    expect(packageJson.scripts['fake-provider']).toBe('node scripts/fake-stream-server.mjs')
  })

  it('starts the fake API explicitly in CI and tests before performance reporting', () => {
    const verify = readText('.github/workflows/verify.yml')
    const deploy = readText('.github/workflows/deploy.yml')
    const verifyE2eIndex = verify.indexOf('run: pnpm e2e')
    const verifyPerfIndex = verify.indexOf('run: pnpm perf:report')
    const deployStartupIndex = deploy.indexOf('run: pnpm e2e:production-startup')
    const deployUploadIndex = deploy.indexOf('uses: actions/upload-pages-artifact')

    expect(verify).toContain('Test the built app against the loopback fake provider')
    expect(verify).toContain('E2E_FAKE_PROVIDER_PORT: 4174')
    expect(verifyE2eIndex).toBeGreaterThanOrEqual(0)
    expect(verifyPerfIndex).toBeGreaterThan(verifyE2eIndex)
    expect(verify.slice(verifyE2eIndex, verifyPerfIndex)).not.toContain('pnpm build')
    expect(deployStartupIndex).toBeGreaterThanOrEqual(0)
    expect(deployUploadIndex).toBeGreaterThan(deployStartupIndex)
    expect(deploy.slice(deployStartupIndex, deployUploadIndex)).not.toContain('pnpm build')
  })

  it('limits build-mode behavior to the privacy proxy and keeps devtools outside the app entry', () => {
    const unsupportedRuntimeEnvFiles = filesBelow(SRC_ROOT)
      .filter((path) => SOURCE_EXTENSION_PATTERN.test(path))
      .filter((path) => {
        const sourcePath = relativePath(SRC_ROOT, path)
        let source = readFileSync(path, 'utf8').replaceAll(
          "import.meta.env.MODE === 'test'",
          'false',
        )
        if (
          sourcePath === 'core/global-settings.ts' ||
          sourcePath === 'ui/settings/GeneralSettings.tsx'
        ) {
          source = source.replaceAll('import.meta.env.DEV', 'false')
        }
        return /import\.meta\.env/u.test(source)
      })
      .map((path) => relativePath(SRC_ROOT, path))
      .sort()
    expect(unsupportedRuntimeEnvFiles).toEqual([])

    const envSwitchFiles = filesBelow(SRC_ROOT)
      .filter((path) => SOURCE_EXTENSION_PATTERN.test(path))
      .filter((path) => /import\.meta\.env\.(?:DEV|PROD)/u.test(readFileSync(path, 'utf8')))
      .map((path) => relativePath(SRC_ROOT, path))
      .sort()
    expect(envSwitchFiles).toEqual(['core/global-settings.ts', 'ui/settings/GeneralSettings.tsx'])
    expect(readText('src/core/global-settings.ts')).toContain('defaultCorsProxyUrlForRuntime')
    expect(readText('src/ui/settings/GeneralSettings.tsx')).toContain(
      'const isDev = import.meta.env.DEV',
    )

    const main = readText('src/main.tsx')
    const vite = readText('vite.config.ts')
    const devtools = readText('tools/browser-devtools.ts')
    expect(main).not.toMatch(/installDebug|browser-devtools|import\.meta\.env/u)
    expect(vite).toContain("apply: 'serve' as const")
    expect(vite).toContain("src: '/tools/browser-devtools.ts'")
    expect(devtools).toContain('installDebugScroll()')
    expect(devtools).toContain('installDebugStreams()')
    const streamDiagnostics = readText('src/lib/debug-streams.ts')
    const streamDevtool = readText('tools/debug-streams.ts')
    expect(streamDiagnostics).toContain('setStreamDebugSink')
    expect(streamDiagnostics).toContain('setRequestPlanDebugSink')
    expect(streamDiagnostics).not.toMatch(/entryBuffer|planBuffer|MAX_BUFFER_ENTRIES/u)
    expect(streamDevtool).toMatch(/entryBuffer|planBuffer|MAX_BUFFER_ENTRIES/u)
    expect(readText('src/lib/debug-scroll.ts')).not.toMatch(/localStorage|MAX_BUFFER_ENTRIES/u)
    expect(readText('tools/debug-scroll.ts')).toMatch(/localStorage|MAX_BUFFER_ENTRIES/u)
    expect(readText('src/ui/chat/ScrollRegion.tsx')).toContain('if (!hasScrollDebugSink()) return')
    expect(main).toContain("from './lib/storage-wipe'")
    expect(existsSync(resolve(SRC_ROOT, 'lib/debug-nuke.ts'))).toBe(false)
    expect(readText('src/app/Shell.tsx')).not.toContain('recycle-transcript')
    expect(existsSync(resolve(SRC_ROOT, 'lib/debug-fake-stream.ts'))).toBe(false)
  })

  it('keeps the production startup probe explicit about absent devtools', () => {
    const source = readText('tests/e2e/production-startup.spec.ts')
    expect(source).toContain("request.get('/src/main.tsx',")
    expect(source).toContain("Accept: 'application/javascript'")
    for (const global of [
      '__debugFakeStream',
      '__debugRuntime',
      '__debugScroll',
      '__debugStreams',
      '__nuke',
    ]) {
      expect(source).toContain(global)
    }
    expect(source).toContain('toEqual([])')
  })

  it('rejects standalone fake-provider fingerprints from distribution artifacts', () => {
    const verifier = readText('scripts/verify-dist.mjs')
    for (const marker of [
      'natter/fake-stream',
      '/__control/scenarios/',
      'E2E_FAKE_PROVIDER_ORIGIN',
      'fake-stream-server.mjs',
    ]) {
      expect(verifier).toContain(`'${marker}'`)
    }
  })
})
