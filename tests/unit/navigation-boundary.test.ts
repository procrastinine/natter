import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const SRC_ROOT = join(process.cwd(), 'src')
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx'])

const PATCH_NAVIGATION_WRITERS = new Set([
  'app/Shell.tsx',
  'ui/chat/BranchControls.tsx',
  'ui/chat/MessageList.tsx',
])

const RECONCILIATION_WRITERS = new Set(['hooks/useBranchUrlSync.ts'])
const GUARDED_PATCH_WRITERS = new Set([
  'app/Shell.tsx',
  'hooks/useBranchUrlSync.ts',
  'ui/chat/MessageActions.tsx',
])
const GUARDED_STRUCTURAL_WRITERS = new Set(['app/Shell.tsx', 'ui/chat/MessageActions.tsx'])
const PATH_SELECTION_WRITERS = new Set([
  'hooks/useChat.ts',
  'hooks/useMessageOps.ts',
  'ui/chat/ImportModal.tsx',
])
const CHAT_STORE_MODULE = 'store/zustand/chatStore.ts'
const ROUTE_INTENT_USERS = new Set([
  'app/Shell.tsx',
  'app/router.ts',
  'lib/debug-fake-stream.ts',
  'ui/chat/MessageList.tsx',
  'ui/sidebar/ChatList.tsx',
  'ui/storage/StorageView.tsx',
])

describe('tab branch navigation boundary', () => {
  it('keeps hot cursor writers on bounded patch APIs', () => {
    expect(filesCalling(/\bnavigateWithCursorPatch\s*\(/)).toEqual(
      [...PATCH_NAVIGATION_WRITERS].sort(),
    )
    expect(filesCalling(/\bpatchCursorForIntent\s*\(/)).toEqual([...GUARDED_PATCH_WRITERS].sort())
    expect(filesCalling(/\bselectPathForIntent\s*\(/)).toEqual([...PATH_SELECTION_WRITERS].sort())
    expect(filesCalling(/\bsetCursorForIntent\s*\(/)).toEqual(
      [...GUARDED_STRUCTURAL_WRITERS].sort(),
    )
    expect(chatStoreConsumerFilesCalling(/\.navigateToCursor\s*\(/)).toEqual([])
    expect(chatStoreConsumerFilesCalling(/\.reconcileCursor\s*\(/)).toEqual([])
  })

  it('keeps repository reconciliation separate from user navigation intents', () => {
    expect(filesCalling(/\breconcileCursorPatch\s*\(/)).toEqual([...RECONCILIATION_WRITERS].sort())
  })

  it('keeps the per-chat branch registry private', () => {
    expect(chatStoreConsumerFilesCalling(/\.branches\b/)).toEqual([])
    expect(sourceRecord(CHAT_STORE_MODULE).source).not.toMatch(/^\s*branches\s*:/mu)
  })

  it('does not use numeric navigation revisions as async authority', () => {
    expect(filesCalling(/\bnavigationRevision\??\s*:\s*number\b/)).toEqual([])
  })

  it('keeps delayed whole-route navigation behind the opaque tab intent boundary', () => {
    expect(filesCalling(/\bbeginRouteIntent\s*\(/)).toEqual([...ROUTE_INTENT_USERS].sort())
    expect(filesCalling(/\bcancelRouteIntent\s*\(/)).toEqual([...ROUTE_INTENT_USERS].sort())
    expect(routeIntentsWithoutFinallyCleanup()).toEqual([])
    expect(filesCalling(/\b(?:navigateForIntent|navigateToChatForIntent)\s*\(/)).toEqual(
      [...ROUTE_INTENT_USERS].sort(),
    )
    expect(filesCalling(/\bnavigateToChatForIntent\s*\(/)).toEqual([
      'app/Shell.tsx',
      'app/router.ts',
      'lib/debug-fake-stream.ts',
    ])
    expect(filesCalling(/\bnavigateToChat\s*\(/)).toEqual([])
    expect(asyncUnguardedRouteCalls()).toEqual([])
  })

  it('centralizes browser history writes and silent branch URL projections', () => {
    expect(filesCalling(/window\.location\.hash\s*=(?!=)/)).toEqual([])
    expect(filesCalling(/history\.pushState\s*\(/)).toEqual(['app/router.ts'])
    expect(filesCalling(/history\.replaceState\s*\(/)).toEqual(['app/router.ts'])
    expect(filesCalling(/addEventListener\s*\(\s*['"]hashchange['"]/)).toEqual(['app/router.ts'])
    expect(filesCalling(/\breplaceRoute\s*\(/)).toEqual([
      'app/router.ts',
      'hooks/useBranchUrlSync.ts',
      'hooks/useChat.ts',
    ])
  })

  it('restricts non-blocking repository reads to active branch presentation observers', () => {
    expect(filesCalling(/\buseRepositoryPresentationQuery\s*\(/)).toEqual([
      'app/Shell.tsx',
      'hooks/useBranchUrlSync.ts',
    ])
    expect(
      sourceRecords()
        .filter(
          ({ rel, source }) =>
            rel !== 'store/reactive-query.ts' && source.includes('useRepositoryPresentationQuery'),
        )
        .map(({ rel }) => rel)
        .sort(),
    ).toEqual(['app/Shell.tsx', 'hooks/useBranchUrlSync.ts', 'ui/chat/BranchTreeView.tsx'])
    expect(sourceRecord('app/Shell.tsx').source).not.toMatch(
      /activeBranchHandoff|activeBranchSnapshotOverride|refreshTranscriptForTreeHandoff|flushSync/,
    )
  })

  it('keeps structural projection ownership above transcript and tree consumers', () => {
    expect(sourceRecord('ui/chat/MessageList.tsx').source).not.toMatch(
      /\bcreateMessageTreeProjection\s*\(/,
    )
    expect(sourceRecord('ui/chat/BranchTreeView.tsx').source).not.toMatch(
      /\bcreateMessageTreeProjection\s*\(/,
    )
    expect(
      sourceRecord('hooks/useBranchUrlSync.ts').source.match(/\bcreateMessageTreeProjection\s*\(/g),
    ).toHaveLength(2)
    expect(
      sourceRecord('app/Shell.tsx').source.match(/\bcreateMessageTreeProjection\s*\(/g),
    ).toHaveLength(1)
  })

  it('invalidates body hydration from body rows rather than structural headers', () => {
    const shell = sourceRecord('app/Shell.tsx').source
    const tree = sourceRecord('ui/chat/BranchTreeView.tsx').source
    expect(shell).toContain("primaryKeys('messageBodies', ...activeBodyWindowIntentIds)")
    expect(shell).not.toContain("primaryKeys('messages', ...activeBodyWindowIntentIds)")
    expect(tree).toContain("primaryKeys('messageBodies', inspectedMessageId)")
    expect(tree).not.toContain("primaryKeys('messages', inspectedMessageId)")
  })
})

function filesCalling(pattern: RegExp): string[] {
  return sourceRecords()
    .filter(({ source }) => pattern.test(source))
    .map(({ rel }) => rel)
    .sort()
}

function chatStoreConsumerFilesCalling(pattern: RegExp): string[] {
  return sourceRecords()
    .filter(
      ({ rel, source }) => rel !== CHAT_STORE_MODULE && source.includes('store/zustand/chatStore'),
    )
    .filter(({ source }) => pattern.test(source))
    .map(({ rel }) => rel)
    .sort()
}

function sourceRecord(rel: string): { rel: string; source: string } {
  return {
    rel,
    source: readFileSync(join(SRC_ROOT, rel), 'utf8'),
  }
}

function sourceRecords(): Array<{ rel: string; source: string }> {
  return sourceFiles(SRC_ROOT).map((file) =>
    sourceRecord(relative(SRC_ROOT, file).split(sep).join('/')),
  )
}

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) out.push(...sourceFiles(path))
    else if (SOURCE_EXTENSIONS.has(path.slice(path.lastIndexOf('.')))) out.push(path)
  }
  return out
}

function asyncUnguardedRouteCalls(): string[] {
  const unguarded = new Set(['navigate', 'navigateHome', 'navigateNew', 'navigateToChat'])
  const calls: string[] = []
  for (const { rel, source } of sourceRecords()) {
    const file = ts.createSourceFile(
      rel,
      source,
      ts.ScriptTarget.Latest,
      true,
      rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    )
    const visit = (node: ts.Node, afterAwaitBoundary: boolean) => {
      const isFunction =
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node)
      const isAsync = Boolean(
        isFunction &&
          ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword),
      )
      const delayed = afterAwaitBoundary || isAsync
      if (
        delayed &&
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        unguarded.has(node.expression.text)
      ) {
        const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
        calls.push(`${rel}:${line}:${node.expression.text}`)
      }
      node.forEachChild((child) => visit(child, delayed))
    }
    visit(file, false)
  }
  return calls.sort()
}

function routeIntentsWithoutFinallyCleanup(): string[] {
  const failures: string[] = []
  for (const { rel, source } of sourceRecords()) {
    if (rel === 'app/router.ts') continue
    const file = ts.createSourceFile(
      rel,
      source,
      ts.ScriptTarget.Latest,
      true,
      rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    )
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        (node.expression.text === 'beginRouteIntent' ||
          node.expression.text === 'beginWorkspaceReplacementRouteIntent')
      ) {
        const declaration = ancestor(node, ts.isVariableDeclaration)
        const owner = ancestor(node, isFunctionNode)
        const name =
          declaration && ts.isIdentifier(declaration.name) ? declaration.name.text : undefined
        const cleaned = Boolean(owner && name && hasFinallyRouteIntentCleanup(owner, name))
        if (!cleaned) {
          const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
          failures.push(`${rel}:${line}:${name ?? '<unbound>'}`)
        }
      }
      node.forEachChild(visit)
    }
    visit(file)
  }
  return failures.sort()
}

function ancestor<T extends ts.Node>(
  node: ts.Node,
  predicate: (candidate: ts.Node) => candidate is T,
): T | undefined {
  let current = node.parent
  for (;;) {
    if (predicate(current)) return current
    if (ts.isSourceFile(current)) return undefined
    current = current.parent
  }
}

function isFunctionNode(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  )
}

function insideFinally(node: ts.Node, owner: ts.Node): boolean {
  let current = node.parent
  while (current !== owner) {
    if (
      ts.isBlock(current) &&
      ts.isTryStatement(current.parent) &&
      current.parent.finallyBlock === current
    ) {
      return true
    }
    if (ts.isSourceFile(current)) return false
    current = current.parent
  }
  return false
}

function hasFinallyRouteIntentCleanup(owner: ts.Node, name: string): boolean {
  let found = false
  const inspect = (candidate: ts.Node) => {
    if (
      ts.isCallExpression(candidate) &&
      ts.isIdentifier(candidate.expression) &&
      candidate.expression.text === 'cancelRouteIntent' &&
      candidate.arguments.some((argument) => ts.isIdentifier(argument) && argument.text === name) &&
      insideFinally(candidate, owner)
    ) {
      found = true
      return
    }
    candidate.forEachChild(inspect)
  }
  owner.forEachChild(inspect)
  return found
}
