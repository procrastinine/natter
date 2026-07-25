import { existsSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { LoadedWorkspaceSessionOwnerRegistry } from '../../src/store/workspace-session-owner'

const ROOT = resolve(__dirname, '../..')
const SRC = resolve(ROOT, 'src')
const SOURCE_PATTERN = /\.[cm]?[jt]sx?$/u

function sourcePath(path: string): string {
  return relative(ROOT, path).split(sep).join('/')
}

function resolveSourceImport(importer: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null
  const base = resolve(dirname(importer), specifier)
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    `${base}.cts`,
    resolve(base, 'index.ts'),
    resolve(base, 'index.tsx'),
  ]) {
    if (existsSync(candidate) && SOURCE_PATTERN.test(candidate)) return candidate
  }
  return null
}

function staticRuntimeImports(path: string): string[] {
  const relativePath = sourcePath(path)
  const source = ts.createSourceFile(
    relativePath,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    relativePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const imports: string[] = []
  const record = (specifier: ts.Expression | undefined): void => {
    if (!specifier || !ts.isStringLiteralLike(specifier)) return
    const target = resolveSourceImport(path, specifier.text)
    if (target) imports.push(target)
  }
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause
      if (clause?.isTypeOnly) continue
      const bindings = clause?.namedBindings
      const hasRuntimeBinding =
        !clause ||
        clause.name !== undefined ||
        (bindings !== undefined &&
          (ts.isNamespaceImport(bindings) ||
            bindings.elements.some((element) => !element.isTypeOnly)))
      if (hasRuntimeBinding) record(statement.moduleSpecifier)
      continue
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
      if (statement.isTypeOnly) continue
      const clause = statement.exportClause
      if (
        clause &&
        ts.isNamedExports(clause) &&
        clause.elements.every((element) => element.isTypeOnly)
      ) {
        continue
      }
      record(statement.moduleSpecifier)
      continue
    }
    if (
      ts.isImportEqualsDeclaration(statement) &&
      !statement.isTypeOnly &&
      ts.isExternalModuleReference(statement.moduleReference)
    ) {
      record(statement.moduleReference.expression)
    }
  }
  return imports
}

function staticRuntimeClosure(entry: string): Set<string> {
  const closure = new Set<string>([entry])
  const pending = [entry]
  for (let index = 0; index < pending.length; index += 1) {
    for (const dependency of staticRuntimeImports(pending[index] as string)) {
      if (closure.has(dependency)) continue
      closure.add(dependency)
      pending.push(dependency)
    }
  }
  return closure
}

describe('cold runtime boundary', () => {
  it('keeps feature implementations behind their owning lazy surface or event boundary', () => {
    const closure = new Set([...staticRuntimeClosure(resolve(SRC, 'main.tsx'))].map(sourcePath))

    expect(
      [
        'src/ui/storage/StorageView.tsx',
        'src/ui/storage/StorageChatsSurface.tsx',
        'src/hooks/useStorageCatalogApplication.ts',
        'src/store/storage-application.ts',
        'src/store/storage-catalog-session-workspace.ts',
        'src/store/attachment-detail-session.ts',
        'src/ui/chat/ImportModal.tsx',
        'src/ui/chat/BranchTreeView.tsx',
        'src/store/branch-tree-session-workspace.ts',
        'src/store/branch-tree-search-session.ts',
        'src/ui/chat/MessageList.tsx',
        'src/store/import-export.ts',
        'src/store/browser-import-export.ts',
        'src/store/browser-workspace-replacement.ts',
        'src/app/conversation-actions.ts',
        'src/store/generation-admission-controller.ts',
        'src/store/generation-engine.ts',
        'src/store/generated-output-localization-runtime.ts',
        'src/store/connection-probe-application.ts',
        'src/store/connection-probe-planning.ts',
        'src/store/request-planning.ts',
      ].filter((path) => closure.has(path)),
    ).toEqual([])

    for (const required of [
      'src/ui/settings/GlobalSettingsModal.tsx',
      'src/store/configuration-controller.ts',
      'src/store/stream-recovery-capability.ts',
      'src/store/generated-output-localization-capability.ts',
      'src/store/storage-maintenance-runtime.ts',
      'src/store/attachment-catalog-workspace.ts',
      'src/app/conversation-actions-capability.ts',
      'src/store/generation-capability-controller.ts',
      'src/store/connection-probe-capability.ts',
      'src/store/connection-probe-contract.ts',
    ]) {
      expect(closure.has(required), required).toBe(true)
    }
    expect(closure.has('src/store/stream-recovery.ts')).toBe(false)
  })

  it('keeps branch-tree search I/O behind the first non-empty query', () => {
    const closure = new Set(
      [...staticRuntimeClosure(resolve(SRC, 'ui/chat/BranchTreeView.tsx'))].map(sourcePath),
    )

    expect(closure.has('src/store/branch-tree-search-session.ts')).toBe(true)
    expect(closure.has('src/store/branch-tree-search-contract.ts')).toBe(false)
    expect(closure.has('src/store/branch-tree-search-runtime.ts')).toBe(false)
    expect(closure.has('src/store/message-search-service.ts')).toBe(false)
  })

  it('uses one generic loaded-owner registry and one interchange application boundary', () => {
    const lifecycle = readFileSync(resolve(SRC, 'store/browser-workspace-lifecycle.ts'), 'utf8')
    const sessionOwners = readFileSync(resolve(SRC, 'store/workspace-session-owner.ts'), 'utf8')
    const catalogWorkspace = readFileSync(
      resolve(SRC, 'store/catalog-session-workspace.ts'),
      'utf8',
    )
    const repository = readFileSync(resolve(SRC, 'store/browser-repo.ts'), 'utf8')
    const interchange = readFileSync(resolve(SRC, 'store/interchange-application.ts'), 'utf8')

    expect(lifecycle).toContain("from './workspace-session-owner'")
    expect(lifecycle).not.toMatch(/catalog-session-workspace|branch-tree-search-session/u)
    expect(sessionOwners).not.toMatch(/catalog-session-workspace|branch-tree-search-session/u)
    expect(catalogWorkspace).toContain(
      "registerLoadedWorkspaceSessionOwner('catalog-core', workspace)",
    )
    expect(repository).not.toMatch(
      /import\s+\{[^}]*BrowserImportExportHandler[^}]*\}\s+from\s+['"]\.\/browser-import-export['"]/u,
    )
    expect(repository).toContain("await import('./browser-import-export')")
    expect(repository).toContain("await import('./browser-workspace-replacement')")
    expect(interchange).toContain("await import('./import-export')")
    expect(interchange).not.toContain("await import('./chat-export')")
    expect(interchange).toContain("from './chat-export'")
  })

  it('keeps lazy delivery assertions out of the eager source closure', () => {
    const eagerPaths = [...staticRuntimeClosure(resolve(SRC, 'main.tsx'))].map(sourcePath)
    const baseline = JSON.parse(
      readFileSync(resolve(ROOT, 'scripts/performance-baseline.json'), 'utf8'),
    ) as {
      deliveryBudgets: {
        coldForbiddenPathFragments: readonly string[]
        namedAssets: Readonly<Record<string, { prefix: string }>>
      }
    }

    for (const fragment of baseline.deliveryBudgets.coldForbiddenPathFragments) {
      expect(
        eagerPaths.filter((path) => path.includes(fragment)),
        fragment,
      ).toEqual([])
    }
    for (const { prefix } of Object.values(baseline.deliveryBudgets.namedAssets)) {
      expect(
        eagerPaths.filter((path) => path.includes(prefix)),
        prefix,
      ).toEqual([])
    }
  })

  it('keeps search controllers app-owned across React remounts', () => {
    const hook = readFileSync(resolve(SRC, 'hooks/useCatalogApplication.ts'), 'utf8')
    const workspace = readFileSync(resolve(SRC, 'store/catalog-session-workspace.ts'), 'utf8')
    const creationOwners = [...staticRuntimeClosure(resolve(SRC, 'main.tsx'))]
      .filter((path) =>
        /import\s*\{[^}]*\bcreateSearchSessionController\b[^}]*\}/u.test(
          readFileSync(path, 'utf8'),
        ),
      )
      .map(sourcePath)

    expect(creationOwners).toEqual(['src/store/catalog-session-workspace.ts'])
    expect(workspace).toContain("registerLoadedWorkspaceSessionOwner('catalog-core', workspace)")
    expect(hook).not.toMatch(/createSearchSessionController|controller\.dispose\s*\(/u)
  })

  it('disposes only registered owners and replaces a reloaded owner without retaining it', async () => {
    const registry = new LoadedWorkspaceSessionOwnerRegistry()
    const events: string[] = []
    const owner = (label: string) => ({
      disposeTerminal: () => events.push(`${label}:dispose`),
      resetForTests: () => events.push(`${label}:reset`),
    })

    registry.register('catalog-core', owner('old-core'))
    registry.register('catalog-core', owner('new-core'))
    registry.disposeTerminal()
    registry.register('storage-catalog', owner('late-storage'))
    registry.resetForTests()

    expect(events).toEqual([
      'old-core:dispose',
      'new-core:dispose',
      'late-storage:dispose',
      'new-core:reset',
      'late-storage:reset',
    ])
  })
})
