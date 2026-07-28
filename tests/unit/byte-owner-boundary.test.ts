import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { resolveMutationTableNames } from '../../src/store/browser-mutation-plan'
import { buildChat } from '../../src/store/chats'
import {
  PHYSICAL_STORAGE_BOUNDARY_FILES,
  PHYSICAL_STORAGE_POLICY,
  PHYSICAL_STORAGE_TABLE_NAMES,
} from '../../src/store/physical-storage-tables'

const SRC_ROOT = join(process.cwd(), 'src')
const MUTATION_METHODS = new Set([
  'add',
  'bulkAdd',
  'bulkDelete',
  'bulkPut',
  'clear',
  'delete',
  'modify',
  'put',
  'update',
])
const BYTE_OWNER_TABLES = new Set<string>(PHYSICAL_STORAGE_TABLE_NAMES)
const NORMAL_PORT_TABLES = new Map<string, ReadonlySet<string>>([
  ['store/byte-owner-mutation.ts', BYTE_OWNER_TABLES],
  ['store/discovery-cache-storage.ts', new Set(['discoveryPayloadMetadata', 'discoveryPayloads'])],
  ['store/stream-journal-storage.ts', new Set(['streamChunks', 'streamLeases'])],
  ['store/storage-compaction-state.ts', new Set(['settings'])],
  ['store/workspace-meta.ts', new Set(['settings'])],
  [
    'store/chat-sidebar-projection.ts',
    new Set(['chatSidebarAggregates', 'chatSidebarRows', 'settings']),
  ],
  [
    'store/preset-order.ts',
    new Set(['presetOrderBlocks', 'presetOrderMembership', 'presetOrderState']),
  ],
  ['store/stream-journal-integrity.ts', new Set(['settings'])],
  ['store/workspace-meta.ts', new Set(['workspaceFence'])],
])
const EPHEMERAL_PHYSICAL_PORTS = new Map<
  string,
  { readonly tables: ReadonlySet<string>; readonly rationale: string }
>([
  [
    'store/locks.ts',
    {
      tables: new Set(['browserLocks']),
      rationale: 'bounded lease coordination rows expire and are not durable workspace bytes',
    },
  ],
])
const BOUNDARY_FILES = new Map(Object.entries(PHYSICAL_STORAGE_BOUNDARY_FILES))
const BACKCOMPAT_BOUNDARY = {
  prefix: 'backcompat/',
  rationale: 'version-gated old-shape migration boundary',
} as const

describe('byte-owner mutation boundary', () => {
  it('classifies every physical NatterDb table from the schema declaration', () => {
    expect(natterDbTableNames()).toEqual([...PHYSICAL_STORAGE_TABLE_NAMES].sort())
    expect(Object.keys(PHYSICAL_STORAGE_POLICY).sort()).toEqual(
      [...PHYSICAL_STORAGE_TABLE_NAMES].sort(),
    )
    for (const policy of Object.values(PHYSICAL_STORAGE_POLICY)) {
      expect(Object.isFrozen(policy.effectKinds)).toBe(true)
      expect(Object.isFrozen(policy.groupEffectKinds)).toBe(true)
      expect(policy.groupEffectKinds.every((kind) => policy.effectKinds.includes(kind))).toBe(true)
    }
  })

  it('keeps every semantic and physical byte-owner mutation behind a typed port', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(SRC_ROOT)) {
      const path = relative(SRC_ROOT, file).split(sep).join('/')
      const allowedTables = path.startsWith(BACKCOMPAT_BOUNDARY.prefix)
        ? BYTE_OWNER_TABLES
        : BOUNDARY_FILES.has(path)
          ? BYTE_OWNER_TABLES
          : (NORMAL_PORT_TABLES.get(path) ?? EPHEMERAL_PHYSICAL_PORTS.get(path)?.tables)
      for (const mutation of byteOwnerMutations(file)) {
        if (allowedTables?.has(mutation.tableName)) continue
        if (
          path === 'store/browser-repo.ts' &&
          mutation.tableName === 'settings' &&
          mutation.keyLiteral === 'stream-admission-sequence'
        ) {
          continue
        }
        offenders.push(`${path}:${mutation.line}:${mutation.tableName}.${mutation.method}`)
      }
    }
    expect(offenders).toEqual([])
    expect(
      [
        ...BOUNDARY_FILES.values(),
        ...[...EPHEMERAL_PHYSICAL_PORTS.values()].map(({ rationale }) => rationale),
        BACKCOMPAT_BOUNDARY.rationale,
      ].every(Boolean),
    ).toBe(true)
  })

  it('confines raw chat and sidebar reconstruction to exact migration and replacement owners', () => {
    const guarded = new Set(['chats', 'chatSidebarRows', 'chatSidebarAggregates'])
    const observed = sourceFiles(SRC_ROOT)
      .flatMap((file) => {
        const path = relative(SRC_ROOT, file).split(sep).join('/')
        if (path.startsWith(BACKCOMPAT_BOUNDARY.prefix)) return []
        return byteOwnerMutations(file).flatMap((mutation) =>
          guarded.has(mutation.tableName)
            ? [`${path}#${mutation.owner}:${mutation.tableName}.${mutation.method}`]
            : [],
        )
      })
      .sort()

    expect(observed).toEqual(
      [
        'store/browser-import-export.ts#restorePreparedBrowserWorkspaceRows:chatSidebarAggregates.restoreBulkPut',
        'store/browser-import-export.ts#restorePreparedBrowserWorkspaceRows:chatSidebarRows.bulkPut',
        'store/browser-import-export.ts#restorePreparedBrowserWorkspaceRows:chats.bulkPut',
        'store/chat-sidebar-projection.ts#rebuildChatSidebarProjectionRowsInTransaction:chatSidebarAggregates.bulkAdd',
        'store/chat-sidebar-projection.ts#rebuildChatSidebarProjectionRowsInTransaction:chatSidebarAggregates.clear',
        'store/chat-sidebar-projection.ts#rebuildChatSidebarProjectionRowsInTransaction:chatSidebarRows.bulkAdd',
        'store/chat-sidebar-projection.ts#rebuildChatSidebarProjectionRowsInTransaction:chatSidebarRows.clear',
        'store/db.ts#registerSchema@populate:chatSidebarAggregates.put',
        'store/db.ts#registerSchema@v2:chats.modify',
        'store/db.ts#registerSchema@v5:chats.modify',
        'store/db.ts#registerSchema@v8:chats.modify',
        'store/db.ts#registerSchema@v9:chats.modify',
        'store/db.ts#registerSchema@v14:chats.modify',
        'store/db.ts#registerSchema@v15:chats.modify',
      ].sort(),
    )

    expect(
      versionGatedReferences(join(SRC_ROOT, 'store/db.ts'), [
        'backfillChatArchivedKeys',
        'backfillChatTemporaryKeys',
      ]),
    ).toEqual([])
    expect(readFileSync(join(SRC_ROOT, 'store/db.ts'), 'utf8')).toContain(
      'db.version(WAVE_A_STORAGE_VERSION)',
    )
  })

  it('uses inline-primary-key add semantics at every normal owner port', () => {
    const offenders = [
      'store/byte-owner-mutation.ts',
      'store/discovery-cache-storage.ts',
      'store/stream-journal-storage.ts',
    ].flatMap((path) =>
      multiArgumentAddCalls(join(SRC_ROOT, path)).map((line) => `${path}:${line}`),
    )
    expect(offenders).toEqual([])
  })

  it('keeps the post-commit debt ledger out of semantic mutation scopes', () => {
    const semanticPlans = [
      resolveMutationTableNames([], { initialChat: buildChat() }),
      resolveMutationTableNames([], { promoteChatId: 'chat' }),
      resolveMutationTableNames([{ kind: 'chat-meta', chatId: 'chat' }]),
      resolveMutationTableNames([{ kind: 'children', chatId: 'chat', parentId: null }]),
      resolveMutationTableNames([{ kind: 'draft', chatId: 'chat' }]),
      resolveMutationTableNames([{ kind: 'message', messageId: 'message' }]),
      resolveMutationTableNames([{ kind: 'attachment', attachmentId: 'attachment' }]),
    ]
    for (const plan of semanticPlans) expect(plan).not.toContain('settings')

    const settingsPlans = [
      resolveMutationTableNames([], {
        streamAdmission: { streamId: 'stream' } as never,
      }),
      resolveMutationTableNames([], { settingReadKeys: ['setting'] }),
    ]
    for (const plan of settingsPlans) expect(plan).toContain('settings')

    const source = readFileSync(join(SRC_ROOT, 'store/byte-owner-mutation.ts'), 'utf8')
    expect(source).not.toContain('withStorageCompactionDebtStore')
  })

  it('keeps configuration owner transactions free of ledger-only settings widening', () => {
    const source = readFileSync(join(SRC_ROOT, 'store/browser-configuration-domain.ts'), 'utf8')
    for (const tableName of [
      'chats',
      'keys',
      'presets',
      'profiles',
      'promptPresets',
      'textTemplates',
    ]) {
      expect(source).not.toMatch(new RegExp(`\\b${tableName}: \\['settings'\\]`, 'u'))
    }
  })

  it('keeps live compaction debt recording single-owner and migration calls version-gated', () => {
    const importers = sourceFiles(SRC_ROOT)
      .map((file) => ({
        path: relative(SRC_ROOT, file).split(sep).join('/'),
        source: readFileSync(file, 'utf8'),
      }))
      .filter(({ path }) => path !== 'store/storage-compaction-state.ts')
      .filter(({ source }) => source.includes('accumulateStorageCompactionDebt'))
      .map(({ path }) => path)
    expect(importers).toEqual(['store/byte-owner-mutation.ts', 'store/db.ts'])
    expect(
      versionGatedReferences(join(SRC_ROOT, 'store/db.ts'), ['accumulateStorageCompactionDebt']),
    ).toEqual([
      'accumulateStorageCompactionDebt@inactive-normalizer',
      'accumulateStorageCompactionDebt@v94',
      'accumulateStorageCompactionDebt@v97',
    ])

    const port = readFileSync(join(SRC_ROOT, 'store/byte-owner-mutation.ts'), 'utf8')
    const policy = readFileSync(join(SRC_ROOT, 'store/physical-storage-tables.ts'), 'utf8')
    expect(policy).not.toContain('RETIRED_SETTINGS_KEYS')
    expect(port).toContain("key === 'global:token-calibration'")
    expect(port).toContain('putTokenCalibrationSettingByteOwner')

    const repository = readFileSync(join(SRC_ROOT, 'store/browser-repo.ts'), 'utf8')
    expect(repository).toContain('PHYSICAL_STORAGE_POLICY')
    expect(repository).not.toContain('PHYSICAL_MUTATION_EFFECT_KINDS')
    expect(repository).not.toContain('PHYSICAL_EFFECT_GROUP_TABLES')
  })
})

interface OwnerMutation {
  readonly tableName: string
  readonly method: string
  readonly line: number
  readonly owner: string
  readonly keyLiteral?: string
}

function natterDbTableNames(): string[] {
  const file = join(SRC_ROOT, 'store/db.ts')
  const sourceFile = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const names: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name?.text === 'NatterDb') {
      for (const member of node.members) {
        if (
          ts.isPropertyDeclaration(member) &&
          ts.isIdentifier(member.name) &&
          member.type &&
          ts.isTypeReferenceNode(member.type) &&
          ts.isIdentifier(member.type.typeName) &&
          member.type.typeName.text === 'Table'
        ) {
          names.push(member.name.text)
        }
      }
    }
    node.forEachChild(visit)
  }
  visit(sourceFile)
  return names.sort()
}

function byteOwnerMutations(file: string): OwnerMutation[] {
  const source = readFileSync(file, 'utf8')
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const mutations: OwnerMutation[] = []
  const visit = (node: ts.Node, inheritedAliases: ReadonlyMap<string, string>): void => {
    const aliases = opensLexicalScope(node)
      ? new Map(inheritedAliases)
      : inheritedAliases instanceof Map
        ? inheritedAliases
        : new Map(inheritedAliases)
    if (ts.isFunctionLike(node)) {
      for (const parameter of node.parameters) {
        if (ts.isIdentifier(parameter.name)) aliases.delete(parameter.name.text)
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const tableName = ownerTableForExpression(node.initializer, aliases)
      if (tableName) aliases.set(node.name.text, tableName)
      else aliases.delete(node.name.text)
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text
      const tableName = ownerTableForExpression(node.expression.expression, aliases)
      if (tableName && MUTATION_METHODS.has(method)) {
        const keyLiteral = objectKeyLiteral(node.arguments[0])
        mutations.push({
          tableName,
          method,
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          owner: mutationOwner(node),
          ...(keyLiteral ? { keyLiteral } : {}),
        })
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'restoreBulkPut'
    ) {
      const tableName = node.arguments[0]
        ? ownerTableForExpression(node.arguments[0], aliases)
        : undefined
      if (tableName) {
        mutations.push({
          tableName,
          method: 'restoreBulkPut',
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          owner: mutationOwner(node),
        })
      }
    }
    node.forEachChild((child) => visit(child, aliases))
  }
  visit(sourceFile, new Map())
  return mutations
}

function enclosingFunctionName(node: ts.Node): string {
  for (
    let current: ts.Node | undefined = node.parent;
    current;
    current = current.parent as ts.Node | undefined
  ) {
    if (
      (ts.isFunctionDeclaration(current) ||
        ts.isMethodDeclaration(current) ||
        ts.isFunctionExpression(current)) &&
      current.name &&
      ts.isIdentifier(current.name)
    ) {
      return current.name.text
    }
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) {
      return current.parent.name.text
    }
  }
  return '<module>'
}

function mutationOwner(node: ts.Node): string {
  const owner = enclosingFunctionName(node)
  const context = dexieSchemaContext(node)
  return context && owner === 'registerSchema' ? `${owner}@${context}` : owner
}

function dexieSchemaContext(node: ts.Node): string | undefined {
  for (
    let current: ts.Node | undefined = node.parent;
    current;
    current = current.parent as ts.Node | undefined
  ) {
    if (!ts.isCallExpression(current) || !ts.isPropertyAccessExpression(current.expression)) {
      continue
    }
    const method = current.expression.name.text
    if (method === 'upgrade') {
      const version = dexieVersionLabel(current.expression.expression)
      if (version !== undefined) return version === 'current' ? version : `v${version}`
    }
    if (method === 'on' && stringLiteral(current.arguments[0]) === 'populate') return 'populate'
  }
  return undefined
}

function dexieVersionLabel(node: ts.Node): number | 'current' | undefined {
  let version: number | 'current' | undefined
  const visit = (current: ts.Node): void => {
    if (version !== undefined) return
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      current.expression.name.text === 'version'
    ) {
      const value = current.arguments[0]
      if (value && ts.isNumericLiteral(value)) version = Number(value.text)
      else if (value && ts.isIdentifier(value) && value.text === 'CURRENT_DB_VERSION') {
        version = 'current'
      } else if (value && ts.isIdentifier(value) && value.text === 'WAVE_A_STORAGE_VERSION') {
        version = 94
      } else if (value && ts.isIdentifier(value) && value.text === 'WAVE_B_STORAGE_VERSION') {
        version = 97
      }
      return
    }
    current.forEachChild(visit)
  }
  visit(node)
  return version
}

function versionGatedReferences(file: string, names: readonly string[]): string[] {
  const sourceFile = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const requested = new Set(names)
  const references: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && requested.has(node.text) && !ts.isImportSpecifier(node.parent)) {
      references.push(
        `${node.text}@${
          dexieSchemaContext(node) ??
          (ancestorFunctionName(node) === 'normalizeInactiveBrowserWorkspaceDatabase'
            ? 'inactive-normalizer'
            : 'live')
        }`,
      )
    }
    node.forEachChild(visit)
  }
  visit(sourceFile)
  return references.sort()
}

function ancestorFunctionName(node: ts.Node): string | undefined {
  let current = node.parent
  for (;;) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text
    if (ts.isSourceFile(current)) return undefined
    current = current.parent
  }
}

function opensLexicalScope(node: ts.Node): boolean {
  return (
    ts.isSourceFile(node) ||
    ts.isBlock(node) ||
    ts.isFunctionLike(node) ||
    ts.isCatchClause(node) ||
    ts.isModuleBlock(node)
  )
}

function ownerTableForExpression(
  expression: ts.Expression,
  aliases: ReadonlyMap<string, string>,
): string | undefined {
  if (ts.isParenthesizedExpression(expression)) {
    return ownerTableForExpression(expression.expression, aliases)
  }
  if (ts.isIdentifier(expression)) return aliases.get(expression.text)
  if (ts.isPropertyAccessExpression(expression)) {
    if (
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === 'db' &&
      BYTE_OWNER_TABLES.has(expression.name.text)
    ) {
      return expression.name.text
    }
    return ownerTableForExpression(expression.expression, aliases)
  }
  if (ts.isCallExpression(expression)) {
    if (
      ts.isPropertyAccessExpression(expression.expression) &&
      expression.expression.name.text === 'table'
    ) {
      const tableName = stringLiteral(expression.arguments[0])
      return tableName && BYTE_OWNER_TABLES.has(tableName) ? tableName : undefined
    }
    if (ts.isPropertyAccessExpression(expression.expression)) {
      return ownerTableForExpression(expression.expression.expression, aliases)
    }
  }
  return undefined
}

function objectKeyLiteral(expression: ts.Expression | undefined): string | undefined {
  if (!expression || !ts.isObjectLiteralExpression(expression)) return undefined
  for (const property of expression.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      ((ts.isIdentifier(property.name) && property.name.text === 'key') ||
        (ts.isStringLiteralLike(property.name) && property.name.text === 'key'))
    ) {
      return stringLiteral(property.initializer)
    }
  }
  return undefined
}

function stringLiteral(expression: ts.Expression | undefined): string | undefined {
  return expression && ts.isStringLiteralLike(expression) ? expression.text : undefined
}

function multiArgumentAddCalls(file: string): number[] {
  const sourceFile = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const lines: number[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'add' &&
      node.arguments.length !== 1
    ) {
      lines.push(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1)
    }
    node.forEachChild(visit)
  }
  visit(sourceFile)
  return lines
}

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) out.push(...sourceFiles(path))
    else if (path.endsWith('.ts') || path.endsWith('.tsx')) out.push(path)
  }
  return out
}
