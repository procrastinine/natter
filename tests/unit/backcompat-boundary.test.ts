import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import Dexie from 'dexie'
import { describe, expect, it, vi } from 'vitest'
import {
  discoverLocalModulePaths,
  scanReachableLocalModuleGraph,
} from '../../scripts/local-module-graph.mjs'
import type * as WaveAStorageEpochV94 from '../../src/backcompat/wave-a-storage-epoch-v94'
import { waveACompletionSettingsV94 } from '../../src/store/browser-workspace-schema-v94'
import { WAVE_B_STORAGE_VERSION } from '../../src/store/browser-workspace-schema-v97'
import type { NatterDb } from '../../src/store/db'

const SRC_ROOT = join(process.cwd(), 'src')
const ALLOWED_BACKCOMPAT_IMPORTERS = new Set(['store/db.ts', 'store/import-export.ts'])
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx'])

describe('backcompat boundary', () => {
  it('keeps compatibility imports behind the DB migration entry point', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file).split(sep).join('/')
      if (rel.startsWith('backcompat/')) continue
      if (ALLOWED_BACKCOMPAT_IMPORTERS.has(rel)) continue
      const source = readFileSync(file, 'utf8')
      if (importsBackcompat(source)) offenders.push(rel)
    }
    expect(offenders).toEqual([])
  })

  it('keeps backcompat runners independent from the runtime DB module', () => {
    const offenders = sourceFiles(join(SRC_ROOT, 'backcompat'))
      .map((file) => relative(SRC_ROOT, file).split(sep).join('/'))
      .filter((rel) => importsRuntimeDb(readFileSync(join(SRC_ROOT, rel), 'utf8')))
    expect(offenders).toEqual([])
  })

  it('does not keep removed schema branches in live source', () => {
    const forbidden = [
      'usePreferredOrdering',
      'privacy.ignoreProviders',
      'privacy.onlyProviders',
      'providerPrefs.dataCollection',
      'providerPrefs.zdr',
      'carryForward',
      'AttachmentRef = AttachmentId',
      "typeof ref === 'string'",
      '"global:auto-scroll"',
      "'global:auto-scroll'",
      'natter:active-profile-id',
      'attachmentHeaderFromStoredRow',
      'migrateAttachmentRefRows',
      'legacyHiddenDraft',
      'temporary === undefined',
    ]
    const offenders: string[] = []
    for (const file of sourceFiles(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file).split(sep).join('/')
      if (rel.startsWith('backcompat/')) continue
      const source = readFileSync(file, 'utf8')
      for (const needle of forbidden) {
        if (source.includes(needle)) offenders.push(`${rel}: ${needle}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('keeps sidebar projection repair behind current repair or the final epoch', () => {
    const allowed = new Set([
      'store/browser-workspace-derived-repair.ts',
      'store/chat-sidebar-projection.ts',
    ])
    const rebuildCallers = sourceFiles(SRC_ROOT)
      .map((file) => relative(SRC_ROOT, file).split(sep).join('/'))
      .filter((rel) => !rel.startsWith('backcompat/') && !allowed.has(rel))
      .filter((rel) =>
        readFileSync(join(SRC_ROOT, rel), 'utf8').includes('rebuildChatSidebarProjection'),
      )
    expect(rebuildCallers).toEqual([])

    const catalogQueries = readFileSync(join(SRC_ROOT, 'store/browser-catalog-queries.ts'), 'utf8')
    expect(catalogQueries).not.toMatch(
      /table\s*<\s*Chat\s*,\s*ChatId\s*>\s*\(\s*['"]chats['"]\s*\)/u,
    )

    const db = readFileSync(join(SRC_ROOT, 'store/db.ts'), 'utf8')
    expect(db).not.toContain('ensureChatSidebarProjection')
    expect(db).not.toContain('backfillOrganizationFields')

    const finalEpoch = readFileSync(
      join(SRC_ROOT, 'backcompat/wave-a-derived-storage-v94.ts'),
      'utf8',
    )
    expect(finalEpoch).toContain('rebuildOrganizationAndChatSidebarV94')
  })

  it('keeps recent-model legacy reconstruction out of generation-time source', () => {
    const repository = readFileSync(join(SRC_ROOT, 'store/browser-repo.ts'), 'utf8')
    expect(repository).not.toContain('legacyRecentModelRecency')
    expect(repository).not.toContain('normalizedPublicRecentModels')
    expect(repository).not.toContain('advanceRecentModelState')

    const currentSettings = readFileSync(join(SRC_ROOT, 'core/global-settings.ts'), 'utf8')
    expect(currentSettings).toContain('export function advanceRecentModelState')
    for (const consumer of [
      'store/browser-configuration-domain.ts',
      'store/browser-generation-command-runtime.ts',
    ]) {
      expect(readFileSync(join(SRC_ROOT, consumer), 'utf8')).toContain('advanceRecentModelState')
    }

    const db = readFileSync(join(SRC_ROOT, 'store/db.ts'), 'utf8')
    expect(db).not.toContain('migrateRecentModelRecencyRows')

    const finalEpoch = readFileSync(
      join(SRC_ROOT, 'backcompat/wave-a-storage-epoch-v94.ts'),
      'utf8',
    )
    expect(finalEpoch).toContain('canonicalizeRecentModelSettingsRows')
    expect(finalEpoch).toContain('recentModelRecencyBackfillMarker()')

    const interchange = readFileSync(join(SRC_ROOT, 'backcompat/import-export.ts'), 'utf8')
    expect(interchange).toContain('canonicalizeRecentModelSettingsRows')
  })

  it('pins the v89 journal migration to explicit V1 event semantics', () => {
    const migration = readFileSync(
      join(SRC_ROOT, 'backcompat/stream-journal-semantics-v89.ts'),
      'utf8',
    )
    expect(migration).toContain('canonicalStreamEventV1FromUnknown')
    expect(migration).toContain('CanonicalStreamEventV1')
    expect(migration).not.toMatch(/\bcanonicalStreamEventFromUnknown\b/u)
    expect(migration).not.toMatch(/\bCanonicalStreamEvent\b/u)

    const eventValidator = readFileSync(
      join(SRC_ROOT, 'backcompat/canonical-stream-event-v1.ts'),
      'utf8',
    )
    expect(eventValidator).toContain('CanonicalStreamEventV1')
    expect(eventValidator).not.toMatch(/from\s+['"]\.\/(?:types|reasoning-envelope)['"]/u)

    const eventTypes = readFileSync(
      join(SRC_ROOT, 'backcompat/generation-stream-events-v1.ts'),
      'utf8',
    )
    expect(eventTypes).toContain('export type CanonicalStreamEventV1')
    expect(eventTypes).not.toMatch(/\bexport type CanonicalStreamEvent\b/u)
    expect(eventTypes).not.toMatch(/^import\s/mu)
  })

  it('keeps the current V2 journal graph independent from frozen V1 and backcompat', () => {
    const entry = 'src/store/persisted-stream-event.ts'
    const scan = scanReachableLocalModuleGraph({
      entryPaths: [entry],
      availablePaths: discoverLocalModulePaths({
        root: process.cwd(),
        directories: ['src'],
        files: [],
      }),
      root: process.cwd(),
      directories: ['src'],
      files: [],
      projectFile: () => null,
    })

    expect(scan.graph.diagnostics).toEqual([])
    expect(
      scan.graph.paths.filter(
        (path) =>
          path.includes('/backcompat/') || /(?:^|\/)generation-stream-events-v1\.ts$/u.test(path),
      ),
    ).toEqual([])

    const events = readFileSync(join(SRC_ROOT, 'core/generation-stream-events.ts'), 'utf8')
    const validator = readFileSync(join(SRC_ROOT, 'core/canonical-stream-event.ts'), 'utf8')
    expect(events).not.toContain('generation-stream-events-v1')
    expect(validator).not.toContain('canonical-stream-event-v1')
    expect(validator).not.toContain('generation-stream-events-v1')
  })

  it('keeps the current schema owner cold and the final migrator behind the upgrade callback', () => {
    const entry = 'src/store/browser-workspace-schema-v94.ts'
    const scan = scanReachableLocalModuleGraph({
      entryPaths: [entry],
      availablePaths: discoverLocalModulePaths({
        root: process.cwd(),
        directories: ['src'],
        files: [],
      }),
      root: process.cwd(),
      directories: ['src'],
      files: [],
      projectFile: () => null,
    })

    expect(scan.graph.diagnostics).toEqual([])
    expect(scan.graph.paths).toEqual([
      'src/store/browser-workspace-schema-v94.ts',
      'src/store/db-rows.ts',
    ])

    const db = readFileSync(join(SRC_ROOT, 'store/db.ts'), 'utf8')
    expect(db).not.toMatch(/from\s+['"][^'"]*backcompat\/wave-a-storage-epoch-v94(?:\.ts)?['"]/u)
    expect(db).toContain("import('../backcompat/wave-a-storage-epoch-v94')")
  })

  it('opens fresh and current databases without loading the final migrator or frozen V1 graph', async () => {
    const databaseName = `backcompat-cold-v94-${crypto.randomUUID()}`
    const forbiddenModules = [
      '../../src/backcompat/wave-a-storage-epoch-v94',
      '../../src/backcompat/generation-stream-events-v1',
      '../../src/backcompat/reasoning-envelope-v1',
      '../../src/backcompat/canonical-stream-event-v1',
      '../../src/backcompat/persisted-stream-event-v1',
    ] as const
    let fresh: NatterDb | undefined
    let currentA: NatterDb | undefined
    let currentB: NatterDb | undefined

    vi.resetModules()
    for (const modulePath of forbiddenModules) {
      vi.doMock(modulePath, () => {
        throw new Error(`ColdMigrationModuleLoaded:${modulePath}`)
      })
    }
    try {
      const { createDbForTests, prepareBrowserWorkspaceSchema } = await import('../../src/store/db')
      fresh = createDbForTests(databaseName)
      await prepareBrowserWorkspaceSchema(fresh)
      await fresh.open()
      expect(fresh.verno).toBe(WAVE_B_STORAGE_VERSION)
      expect(
        await fresh.table('settings').bulkGet(waveACompletionSettingsV94().map((row) => row.key)),
      ).not.toContain(undefined)
      fresh.close()

      currentA = createDbForTests(databaseName)
      currentB = createDbForTests(databaseName)
      await Promise.all([
        prepareBrowserWorkspaceSchema(currentA),
        prepareBrowserWorkspaceSchema(currentB),
      ])
      await Promise.all([currentA.open(), currentB.open()])
      expect([currentA.verno, currentB.verno]).toEqual([
        WAVE_B_STORAGE_VERSION,
        WAVE_B_STORAGE_VERSION,
      ])
    } finally {
      fresh?.close()
      currentA?.close()
      currentB?.close()
      await Dexie.delete(databaseName)
      for (const modulePath of forbiddenModules) vi.doUnmock(modulePath)
      vi.resetModules()
    }
  })

  it('runs one production cutover for concurrent legacy openers and zero work on reopen', async () => {
    const databaseName = `backcompat-concurrent-v94-${crypto.randomUUID()}`
    const migrationPath = '../../src/backcompat/wave-a-storage-epoch-v94'
    let moduleLoads = 0
    let migrations = 0
    let finalizations = 0
    let first: NatterDb | undefined
    let second: NatterDb | undefined
    let current: NatterDb | undefined

    vi.resetModules()
    vi.doMock(migrationPath, async () => {
      moduleLoads += 1
      const actual = await vi.importActual<typeof WaveAStorageEpochV94>(migrationPath)
      return {
        ...actual,
        async migrateWaveAStorageEpochRowsV94(
          ...args: Parameters<typeof actual.migrateWaveAStorageEpochRowsV94>
        ) {
          migrations += 1
          return actual.migrateWaveAStorageEpochRowsV94(...args)
        },
        async finalizeWaveAStorageEpochRowsV94(
          ...args: Parameters<typeof actual.finalizeWaveAStorageEpochRowsV94>
        ) {
          finalizations += 1
          return actual.finalizeWaveAStorageEpochRowsV94(...args)
        },
      }
    })
    try {
      const legacy = new Dexie(databaseName)
      legacy.version(25).stores({ settings: '&key' })
      await legacy.open()
      legacy.close()

      const { createDbForTests, prepareBrowserWorkspaceSchema } = await import('../../src/store/db')
      first = createDbForTests(databaseName)
      second = createDbForTests(databaseName)
      await Promise.all([
        prepareBrowserWorkspaceSchema(first),
        prepareBrowserWorkspaceSchema(second),
      ])
      await Promise.all([first.open(), second.open()])
      expect([first.verno, second.verno]).toEqual([WAVE_B_STORAGE_VERSION, WAVE_B_STORAGE_VERSION])
      expect({ moduleLoads, migrations, finalizations }).toEqual({
        moduleLoads: 1,
        migrations: 1,
        finalizations: 1,
      })
      first.close()
      second.close()

      current = createDbForTests(databaseName)
      await prepareBrowserWorkspaceSchema(current)
      await current.open()
      expect(current.verno).toBe(WAVE_B_STORAGE_VERSION)
      expect({ moduleLoads, migrations, finalizations }).toEqual({
        moduleLoads: 1,
        migrations: 1,
        finalizations: 1,
      })
    } finally {
      first?.close()
      second?.close()
      current?.close()
      await Dexie.delete(databaseName)
      vi.doUnmock(migrationPath)
      vi.resetModules()
    }
  })

  it('freezes the complete v89 reasoning migration dependency closure', () => {
    const entries = [
      'src/backcompat/reasoning-envelope-v89.ts',
      'src/backcompat/stream-journal-semantics-v89.ts',
    ]
    const scan = scanReachableLocalModuleGraph({
      entryPaths: entries,
      availablePaths: discoverLocalModulePaths({
        root: process.cwd(),
        directories: ['src'],
        files: [],
      }),
      root: process.cwd(),
      directories: ['src'],
      files: [],
      projectFile: () => null,
    })

    expect(scan.graph.diagnostics).toEqual([])
    expect(scan.graph.dependencies.get(entries[0] as string)).toEqual([
      'src/backcompat/generation-stream-events-v1.ts',
      'src/backcompat/reasoning-carriers-v80.ts',
      'src/backcompat/reasoning-envelope-v1.ts',
      'src/lib/same-value.ts',
    ])
    expect(scan.graph.dependencies.get(entries[1] as string)).toEqual([
      'src/backcompat/canonical-stream-event-v1.ts',
      'src/backcompat/generation-stream-events-v1.ts',
      'src/backcompat/persisted-stream-event-v1.ts',
      'src/backcompat/reasoning-carriers-v80.ts',
      'src/backcompat/reasoning-envelope-v1.ts',
      'src/backcompat/reasoning-envelope-v89.ts',
      'src/backcompat/stream-lease-schema-versions.ts',
    ])
    expect(scan.graph.paths).toEqual([
      'src/backcompat/canonical-stream-event-v1.ts',
      'src/backcompat/generation-stream-events-v1.ts',
      'src/backcompat/persisted-stream-event-v1.ts',
      'src/backcompat/reasoning-carriers-v80.ts',
      'src/backcompat/reasoning-envelope-v1.ts',
      'src/backcompat/reasoning-envelope-v89.ts',
      'src/backcompat/stream-journal-semantics-v89.ts',
      'src/backcompat/stream-lease-schema-versions.ts',
      'src/lib/same-value.ts',
    ])
  })
})

function importsBackcompat(source: string): boolean {
  return (
    /from\s+['"][^'"]*backcompat\//.test(source) ||
    /import\s*\([^)]*['"][^'"]*backcompat\//.test(source)
  )
}

function importsRuntimeDb(source: string): boolean {
  return /from\s+['"][^'"]*store\/(?:db|workspace-repository|browser-(?:repo|import-export|domain-mutations))(?:\.ts)?['"]/.test(
    source,
  )
}

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      out.push(...sourceFiles(path))
      continue
    }
    const ext = path.slice(path.lastIndexOf('.'))
    if (SOURCE_EXTENSIONS.has(ext)) out.push(path)
  }
  return out
}
