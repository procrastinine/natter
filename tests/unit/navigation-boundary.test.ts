import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const SRC_ROOT = join(process.cwd(), 'src')
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx'])
const SOURCE_RECORDS = sourceFiles(SRC_ROOT).map((file) => ({
  rel: relative(SRC_ROOT, file).split(sep).join('/'),
  source: readFileSync(file, 'utf8'),
}))

const ROUTER = 'app/router.ts'
const CONTROLLER = 'store/conversation-controller.ts'
const CURSOR = 'hooks/useConversationCursor.ts'
const ACTIONS = 'app/conversation-actions.ts'
const COMMAND_CLIENT = 'store/conversation-command-client.ts'
const ADMISSION_CONTROLLER = 'store/generation-admission-controller.ts'
const GENERATION_ENGINE = 'store/generation-engine.ts'
const REPOSITORY_ADAPTER = 'store/conversation-repository-adapter.ts'
const SHELL = 'app/Shell.tsx'

describe('unified tab conversation ownership boundary', () => {
  it('makes the router the sole hash/history writer and route-arrival publisher', () => {
    expect(filesContaining(/window\.location\.hash\s*=(?!=)/)).toEqual([])
    expect(filesContaining(/history\.pushState\s*\(/)).toEqual([ROUTER])
    expect(filesContaining(/history\.replaceState\s*\(/)).toEqual([
      ROUTER,
      'lib/preload-recovery.ts',
    ])
    expect(filesContaining(/addEventListener\s*\(\s*['"]hashchange['"]/)).toEqual([ROUTER])
    expect(filesContaining(/\bpublishRouteChange\s*\(/)).toEqual([ROUTER])
    expect(filesContaining(/conversationController\.setNavigationPort\s*\(/)).toEqual(['main.tsx'])
    expect(filesContaining(/\breplaceConversationUrl\s*\(/)).toEqual([CONTROLLER])
  })

  it('keeps per-tab branch selection and presentation sessions inside ConversationController', () => {
    expect(filesContaining(/private readonly sessions\s*=\s*new Map<ChatId, ChatSession>/)).toEqual(
      [CONTROLLER],
    )
    expect(filesContaining(/\bpresentationRequest\b/)).toEqual([CONTROLLER])
    expect(filesContaining(/readonly visibleReady:/)).toEqual([CONTROLLER])
    expect(filesContaining(/\bpresentationResidents\b/)).toEqual([CONTROLLER])
    expect(filesContaining(/\bpendingRevealTargetId\b/)).toEqual([CONTROLLER])
    expect(filesContaining(/\bwritePersistedSession\s*\(/)).toEqual([CONTROLLER])
    expect(filesContaining(/\bCONVERSATION_SESSION_PREFIX\b/)).toEqual([
      CONTROLLER,
      'store/workspace-tab-session.ts',
    ])
    expect(sourceRecordsImportingLegacyRuntime()).toEqual([])
    for (const rel of LEGACY_RUNTIME_MODULES) {
      expect(existsSync(join(SRC_ROOT, rel))).toBe(false)
    }

    expect(reactPresentationStateDeclarations(SHELL)).toEqual([])
    expect(sourceRecord(SHELL)).not.toMatch(
      /\b(?:pendingTreeOpen|pendingTreeExitChatId|retainedAlternateViewsChatId)\b/,
    )
  })

  it('routes UI selection through useConversationCursor and UI mutations through conversationActions', () => {
    expect(filesContaining(/conversationController\.navigate\s*\(/)).toEqual([CURSOR])
    expect(filesContaining(/conversationController\.resolveSiblingPosition\s*\(/)).toEqual([CURSOR])

    const cursorConsumers = filesContaining(
      /\bnavigateConversation(?:Message|SiblingPosition)\s*\(/,
    ).filter((rel) => rel !== CURSOR)
    for (const rel of cursorConsumers) {
      const source = sourceRecord(rel)
      expect(
        source.includes("from '../../hooks/useConversationCursor'") ||
          source.includes("from '../hooks/useConversationCursor'"),
      ).toBe(true)
    }

    expect(filesContaining(/\bconversationActions\.\w+\s*\(/)).toEqual([
      'app/Shell.tsx',
      'ui/chat/ImportModal.tsx',
      'ui/chat/MessageList.tsx',
    ])
    expect(filesContaining(/\bloadConversationActions\s*\(/)).toEqual([
      'app/Shell.tsx',
      'app/conversation-actions-capability.ts',
      'ui/sidebar/ChatList.tsx',
    ])
    expect(uiFilesImportingLowerMutationCapabilities()).toEqual([])
  })

  it('makes GenerationEngine the sole generation starter and admission the sole generation selection owner', () => {
    expect(filesContaining(/generationEngine\.start\s*\(/)).toEqual([COMMAND_CLIENT])
    expect(sourceRecord(COMMAND_CLIENT)).not.toContain("from './conversation-controller'")
    expect(sourceRecord(COMMAND_CLIENT)).not.toMatch(/conversationController\./)

    const generationKinds = [
      'new-chat-send',
      'send',
      'reply',
      'regenerate',
      'edit-resend',
      'continue',
    ] as const
    for (const kind of generationKinds) {
      expect(sourceRecord(COMMAND_CLIENT)).toContain(`kind: '${kind}'`)
    }

    const acceptPrepared = classMethodSource(ADMISSION_CONTROLLER, 'acceptPrepared')
    expect(acceptPrepared).toContain("claim.strategy === 'continue'")
    expect(acceptPrepared).toContain("kind: 'preserve'")
    expect(acceptPrepared).toContain("kind: 'select-transition'")
    expect(acceptPrepared).toContain('receipt: input.selection')
    expect(acceptPrepared).toContain('revealTargetMessageId: claim.assistantMessageId')
    expect(acceptPrepared).not.toContain('transitionPresentations')
    expect(acceptPrepared).not.toContain('transitionPathHeaders')
    expect(filesContaining(/generationAdmissionController\.acceptPrepared\s*\(/)).toEqual([
      GENERATION_ENGINE,
    ])
    expect(sourceRecord(GENERATION_ENGINE)).not.toMatch(
      /conversationController\.(?:acceptLocalResult|claimOperation)\s*\(/,
    )
  })

  it('treats remote deltas as observations that preserve the resolved tab leaf', () => {
    const receiveEffect = classMethodSource(REPOSITORY_ADAPTER, 'receiveEffect')
    expect(receiveEffect).toContain('this.controller.applyCommittedEffects(')
    expect(receiveEffect).toContain('conversationCommittedEffectsForDelta(')
    expect(receiveEffect).not.toMatch(
      /(?:navigate|requestPresentation|claimOperation|acceptLocalResult|lastUpdatedLeafId)/,
    )

    const applyCommittedEffects = classMethodSource(CONTROLLER, 'applyCommittedEffects')
    expect(applyCommittedEffects).not.toMatch(
      /(?:navigate|requestPresentation|installReveal|claimOperation|acceptLocalResult)/,
    )
  })

  it('keeps numeric freshness counters internal and removes legacy navigation authority', () => {
    expect(filesContaining(/\bnavigationRevision\b/)).toEqual([])
    expect(filesContaining(/\boriginNavigationRevision\b/)).toEqual([])
    expect(filesContaining(/\bselectionRevision\b/)).toEqual([
      'hooks/useActiveBranchFrame.ts',
      'hooks/useConversationFrame.ts',
      CONTROLLER,
    ])
    expect(sourceRecord(CURSOR)).not.toContain('selectionRevision')
    expect(sourceRecord(ACTIONS)).not.toContain('selectionRevision')
  })

  it('feeds each paint surface one sealed controller binding without rebuilding readiness or state', () => {
    const transcript = sourceRecord('ui/chat/MessageList.tsx')
    const tree = sourceRecord('ui/chat/BranchTreeView.tsx')
    const shell = sourceRecord('app/Shell.tsx')
    const paintConsumers = [
      'ui/chat/MessageList.tsx',
      'ui/chat/Message.tsx',
      'ui/chat/BranchTreeView.tsx',
      'ui/chat/BranchTreeInspector.tsx',
    ] as const

    for (const source of [transcript, tree]) {
      expect(source).not.toMatch(/\bgetWorkspaceRepository\s*\(/)
      expect(source).not.toMatch(/\bload(?:Spine|Topology|TranscriptPage|DestinationTail)\s*\(/)
      expect(source).not.toMatch(/\bcreateMessageTreeProjection\s*\(/)
      expect(source).not.toMatch(/\bcreateMessageTopologyIndex\s*\(/)
    }
    const transcriptProps = interfacePropertyNames('ui/chat/MessageList.tsx', 'MessageListProps')
    expect(transcriptProps.filter((property) => property === 'binding')).toHaveLength(1)
    expect(transcript).toContain('binding: ConversationTranscriptSurface')
    expect(transcriptProps).not.toEqual(
      expect.arrayContaining(['branchSnapshot', 'branchSpine', 'activePath']),
    )
    const treeProps = interfacePropertyNames('ui/chat/BranchTreeView.tsx', 'BranchTreeViewProps')
    expect(treeProps.filter((property) => property === 'binding')).toHaveLength(1)
    expect(tree).toContain('binding: ConversationTreeSurface')
    expect(treeProps).not.toEqual(
      expect.arrayContaining(['projection', 'acceptedPath', 'headerById', 'changedHeaderKeys']),
    )
    expect(shell).toContain('binding={transcriptBinding}')
    expect(shell).toContain('binding={treeBinding}')
    expect(shell).not.toContain('presentationBindingReady')
    expect(shell).not.toMatch(/activePresentation\?\.visible\s*===\s*activeSurfaceTarget\.binding/)
    expect(shell).not.toMatch(/activeSurfaceTarget\.binding\.(?:currency|reveal)/)

    for (const rel of paintConsumers) {
      const source = sourceRecord(rel)
      expect(source).not.toMatch(
        /\b(?:useConversationSnapshot|useConversationFrame|useAttemptExecutionsForChat|useAttemptTargetSnapshot)\s*\(/,
      )
    }
    expect(sourceRecord('hooks/useActiveBranchFrame.ts')).toContain(
      'const activeStreams = useAttemptExecutionsForChat(activeChatId)',
    )
    expect(shell).toContain('frame: activeConversation')
  })

  it('inventories every navigation, presentation, committed-selection, and count capability', () => {
    expect(
      filesContaining(/\bnavigateConversationMessage\s*\(/).filter((rel) => rel !== CURSOR),
    ).toEqual(['app/Shell.tsx', 'ui/chat/BranchControls.tsx', 'ui/chat/MessageList.tsx'])
    expect(
      filesContaining(/\bnavigateConversationSiblingPosition\s*\(/).filter((rel) => rel !== CURSOR),
    ).toEqual(['ui/chat/BranchControls.tsx'])
    expect(filesContaining(/conversationController\.requestPresentation\s*\(/)).toEqual([SHELL])
    expect(filesContaining(/conversationController\.setPresentation\s*\(/)).toEqual([])
    expect(filesContaining(/conversationController\.installPresentationResourcePort\s*\(/)).toEqual(
      [SHELL],
    )
    expect(filesContaining(/\binstallCommittedSelection\s*\(/)).toEqual([CONTROLLER])
    expect(filesContaining(/\brequestForkUpdates\s*\(/)).toEqual([CONTROLLER])
    expect(filesContaining(/\bcommittedConversationTransition\s*\(/)).toEqual([
      GENERATION_ENGINE,
      'store/repository.ts',
    ])
    expect(filesContaining(/\bsealConversationSelection\s*\(/)).toEqual([
      'core/messages.ts',
      CONTROLLER,
      REPOSITORY_ADAPTER,
    ])
    expect(filesContaining(/\bmaterializeCommittedBranchSelection\s*\(/)).toEqual([])
    expect(filesContaining(/\.forkFor\s*\(/)).toEqual([CONTROLLER, 'ui/chat/MessageList.tsx'])
    expect(sourceRecord('core/active-branch-spine.ts')).toMatch(/\bforkFor\(messageId:/)
    expect(sourceRecord('ui/chat/BranchControls.tsx')).not.toMatch(
      /\b(?:liveByParent|childLists|childSlotMembers|getWorkspaceRepository)\b/,
    )
  })
})

const LEGACY_RUNTIME_MODULES = [
  'hooks/useBranchUrlSync.ts',
  'hooks/useChat.ts',
  'hooks/useContinue.ts',
  'hooks/useMessageOps.ts',
  'store/zustand/chatStore.ts',
  'store/zustand/searchStore.ts',
  'store/zustand/streamStore.ts',
] as const

function sourceRecord(rel: string): string {
  const record = SOURCE_RECORDS.find((candidate) => candidate.rel === rel)
  if (!record) throw new Error(`MissingSourceRecord:${rel}`)
  return record.source
}

function filesContaining(pattern: RegExp): string[] {
  return SOURCE_RECORDS.filter(({ source }) => pattern.test(source))
    .map(({ rel }) => rel)
    .sort()
}

function sourceRecordsImportingLegacyRuntime(): string[] {
  return SOURCE_RECORDS.filter(({ source }) =>
    LEGACY_RUNTIME_MODULES.some((rel) => source.includes(rel.replace(/\.ts$/, ''))),
  )
    .map(({ rel }) => rel)
    .sort()
}

function uiFilesImportingLowerMutationCapabilities(): string[] {
  const lowerMutationModules = new Set([
    '../store/conversation-command-client',
    '../store/generation-engine',
    '../store/conversation-workspace',
    '../../store/conversation-command-client',
    '../../store/generation-engine',
    '../../store/conversation-workspace',
  ])
  const readOnlyRuntimeExports = new Set([
    'getWorkspaceRuntimeState',
    'subscribeWorkspaceRuntimeState',
  ])
  return SOURCE_RECORDS.filter(({ rel }) => rel.startsWith('ui/') || rel === 'app/Shell.tsx')
    .filter(({ rel }) => {
      const file = parsedSource(rel)
      return file.statements.some((statement) => {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
          return false
        }
        const module = statement.moduleSpecifier.text
        const clause = statement.importClause
        if (clause?.isTypeOnly) return false
        if (lowerMutationModules.has(module)) {
          const bindings = clause?.namedBindings
          if (!bindings || !ts.isNamedImports(bindings)) return true
          return bindings.elements.some((element) => !element.isTypeOnly)
        }
        if (module !== '../store/workspace-runtime' && module !== '../../store/workspace-runtime') {
          return false
        }
        const bindings = clause?.namedBindings
        return (
          !bindings ||
          !ts.isNamedImports(bindings) ||
          bindings.elements.some((element) => !readOnlyRuntimeExports.has(element.name.text))
        )
      })
    })
    .map(({ rel }) => rel)
    .sort()
}

function classMethodSource(rel: string, name: string): string {
  const file = parsedSource(rel)
  let match: ts.MethodDeclaration | undefined
  visit(file, (node) => {
    if (
      ts.isMethodDeclaration(node) &&
      node.body &&
      ((ts.isIdentifier(node.name) && node.name.text === name) ||
        (ts.isStringLiteral(node.name) && node.name.text === name))
    ) {
      match = node
    }
  })
  if (!match) throw new Error(`MissingClassMethod:${rel}:${name}`)
  return match.getText(file)
}

function interfacePropertyNames(rel: string, name: string): string[] {
  const file = parsedSource(rel)
  const declaration = file.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === name,
  )
  if (!declaration) throw new Error(`MissingInterface:${rel}:${name}`)
  return declaration.members
    .map((member) => member.name)
    .filter((property): property is ts.PropertyName => property !== undefined)
    .map((property) => property.getText(file))
    .sort()
}

function reactPresentationStateDeclarations(rel: string): string[] {
  const file = parsedSource(rel)
  const matches = new Set<string>()
  visit(file, (node) => {
    if (
      !ts.isVariableDeclaration(node) ||
      !ts.isArrayBindingPattern(node.name) ||
      !node.initializer ||
      !ts.isCallExpression(node.initializer) ||
      !ts.isIdentifier(node.initializer.expression) ||
      node.initializer.expression.text !== 'useState'
    ) {
      return
    }
    const stateBinding = node.name.elements[0]
    if (
      !stateBinding ||
      ts.isOmittedExpression(stateBinding) ||
      !ts.isIdentifier(stateBinding.name)
    ) {
      return
    }
    const stateName = stateBinding.name.text
    const typeText =
      node.initializer.typeArguments?.map((type) => type.getText(file)).join(' ') ?? ''
    const initialText = node.initializer.arguments[0]?.getText(file) ?? ''
    if (
      /(?:presentation|surface|treeView|pendingTree|retainedAlternate)/iu.test(stateName) ||
      /\bConversationSurface\b/u.test(typeText) ||
      /^['"](?:transcript|tree)['"]$/u.test(initialText)
    ) {
      matches.add(stateName)
    }
  })
  return [...matches].sort()
}

function parsedSource(rel: string): ts.SourceFile {
  return ts.createSourceFile(
    rel,
    sourceRecord(rel),
    ts.ScriptTarget.Latest,
    true,
    rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
}

function visit(node: ts.Node, visitor: (node: ts.Node) => void): void {
  visitor(node)
  ts.forEachChild(node, (child) => visit(child, visitor))
}

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const files: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) files.push(...sourceFiles(path))
    else if (SOURCE_EXTENSIONS.has(extname(path))) files.push(path)
  }
  return files
}
