// @vitest-environment node

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()

describe('branch selection architecture boundary', () => {
  it('keeps point-first paint and authoritative spine under one staged selection owner', () => {
    const protocol = source('src/store/workspace-protocol.ts')
    const adapter = source('src/store/conversation-repository-adapter.ts')
    const controller = source('src/store/conversation-controller.ts')

    expect(protocol).toContain("kind: 'branch.open'")
    expect(protocol).toContain('export type WorkspaceQueryStage<Q extends WorkspaceQuery>')
    expect(protocol).toContain('? ConversationDestinationPoint')
    expect(protocol).toContain('onStage?: (stage: ReadEnvelope<WorkspaceQueryStage<Q>>) => void')
    expect(protocol).not.toContain("kind: 'branch.open-selection'")
    expect(protocol).not.toContain("kind: 'branch.destination-point'")
    expect(protocol).not.toContain("kind: 'branch.spine'")
    expect(protocol).not.toContain("kind: 'branch.destination-tail'")
    expect(adapter).toContain('openSelection: async')
    expect(adapter).toContain("{ kind: 'branch.open', chatId, target, bodyDemand: 'terminal' }")
    expect(adapter).toContain('onStage: (stage) => onPoint(')
    expect(adapter).not.toContain('loadDestinationTail')
    expect(controller).not.toContain('requestDestinationTail')
    expect(controller).toContain('acceptDestinationPoint(')
    expect(source('src/main.tsx')).toContain(
      'conversationController.setNavigationPort(browserConversationNavigationPort)',
    )
    expect(source('src/app/App.tsx')).not.toContain('ConversationNavigationPort')
    expect(source('src/app/App.tsx')).not.toContain('setNavigationPort(')
    expect(source('src/app/App.tsx')).not.toContain('bindNavigationPort(')
    expect(source('src/hooks/useConversationFrame.ts')).not.toContain('acknowledgeTranscriptPaint(')
    expect(
      sourceFiles(join(root, 'src'))
        .filter((file) =>
          readFileSync(file, 'utf8').includes('conversationController.acknowledgeTranscriptPaint('),
        )
        .map((file) => relative(root, file)),
    ).toEqual([])
    expect(controller).toContain('private paintedFrame: ConversationPaintedFrame | null = null')
    expect(existsSync(join(root, 'src/core/branch-resolve.ts'))).toBe(false)
    expect(
      sourceFiles(join(root, 'src')).filter((file) =>
        readFileSync(file, 'utf8').includes('resolveLastUpdatedBranchBelow'),
      ),
    ).toEqual([])
  })

  it('keeps semantic cursor ownership inside the per-tab conversation controller', () => {
    expect(
      sourceFiles(join(root, 'src')).flatMap((file) => {
        const text = readFileSync(file, 'utf8')
        return text.includes('class TabBranchCursor') ? [relative(root, file)] : []
      }),
    ).toEqual(['src/store/conversation-controller.ts'])
    expect(source('src/store/conversation-controller.ts')).toContain(
      'cursor: TabBranchCursor.empty()',
    )
    expect(existsSync(join(root, 'src/core/persistent-cursor.ts'))).toBe(false)
  })

  it('keeps every production steering ingress on the inventoried controller/query boundary', () => {
    const files = sourceFiles(join(root, 'src'))
    const containing = (needle: string) =>
      files
        .filter((file) => readFileSync(file, 'utf8').includes(needle))
        .map((file) => relative(root, file))
        .sort()

    expect(containing('conversationController.navigate(')).toEqual([
      'src/hooks/useConversationCursor.ts',
    ])
    expect(containing('conversationController.acceptLocalResult(')).toEqual([
      'src/app/conversation-actions.ts',
      'src/store/generation-admission-controller.ts',
      'src/store/new-chat-seed.ts',
    ])
    expect(containing('committedConversationTransition(')).toEqual([
      'src/store/generation-engine.ts',
      'src/store/repository.ts',
    ])
    expect(containing("kind: 'select-target'")).toEqual([])
    expect(containing("kind: 'reconcile-structure'")).toEqual([])
    expect(containing('transitionPresentations')).toEqual([])
    expect(containing('transitionPathHeaders')).toEqual([])
    expect(
      files
        .filter((file) =>
          /(?:(?:kind\s*:|case)\s*'branch\.open'|query\.kind\s*===\s*'branch\.open')/u.test(
            readFileSync(file, 'utf8'),
          ),
        )
        .map((file) => relative(root, file))
        .sort(),
    ).toEqual([
      'src/store/branch-text.ts',
      'src/store/browser-repo.ts',
      'src/store/conversation-repository-adapter.ts',
      'src/store/workspace-protocol.ts',
    ])
    expect(
      files
        .filter((file) =>
          /(?:kind\s*:|case)\s*'branch\.destination-point'/u.test(readFileSync(file, 'utf8')),
        )
        .map((file) => relative(root, file))
        .sort(),
    ).toEqual([])

    expect(source('src/ui/chat/BranchTreeView.tsx')).toContain('node.newestLeafId')
    expect(source('src/app/Shell.tsx')).toContain(
      'navigateConversationMessage(activeChatId, messageId, observedTipId)',
    )
  })

  it('keeps selection proof reads point- and page-bounded without a whole-chat fallback', () => {
    const resolver = source('src/store/browser-active-branch-spine.ts')
    expect(resolver).toContain('const PATH_PROOF_FRAME_ROWS = 64')
    expect(resolver).toContain('const DESCENDANT_CHILD_PAGE_ROWS = 64')
    expect(resolver).toContain('private async readParentWalkFrame(')
    expect(resolver).toContain('private async readChildPage(')
    expect(resolver).toContain(".where('[chatId+treeParentKey+siblingIndex+id]')")
    expect(resolver).not.toMatch(/where\('chatId'\)\.equals\([^)]*\)\.toArray\(\)/)
  })

  it('keeps a provisional destination point separate while branch selection stays interactive', () => {
    const controller = source('src/store/conversation-controller.ts')
    const shell = source('src/app/Shell.tsx')
    const messages = source('src/ui/chat/MessageList.tsx')

    expect(controller).toContain("kind: 'point'")
    expect(controller).toContain('if (retained) return')
    expect(controller).toContain('visibleReady,')
    expect(shell).toContain('const activeComposerProps:')
    expect(shell).toContain(
      "generationCapability: NonNullable<ComposerProps['generationCapability']>",
    )
    expect(shell).toContain('| null = activeChatId')
    expect(shell).toContain('const visiblePresentationOnly =')
    expect(shell).toContain('presentationOnly={visiblePresentationOnly}')
    expect(shell).toContain('generationCapability: activeSendCapability')
    expect(shell).toContain('generationCapabilityController.captureFrame(')
    expect(shell).toContain('generationCapabilityFrame.capability(')
    expect(shell).not.toContain('connectionAvailability,\n    !transcriptPresentationOnly,')
    expect(shell).not.toContain('Resolving the active branch before sending.')
    expect(shell).toContain('const composerPresentation = useSampleAndHoldPresentation(')
    expect(shell).toContain('presentationOnly={composerPresentation.retained}')
    expect(shell).not.toContain('foreignPaintedFrame ? null')
    expect(shell).toContain('{transcriptFocusMode ? displayedTranscriptComposer : null}')
    expect(shell).toContain('{transcriptFocusMode ? null : displayedTranscriptComposer}')
    expect(messages).toContain('data-branch-counts="known"')
    expect(messages).toContain("const presentationOnly = binding.currency !== 'current'")
    expect(messages).not.toContain('inert={presentationOnly || undefined}')
    expect(messages).toContain("if (e.key === '[' || e.key === ']')")
    expect(messages.indexOf("if (e.key === '[' || e.key === ']'")).toBeLessThan(
      messages.indexOf('if (presentationOnly) return', messages.indexOf('const onKey')),
    )
    expect(messages).toContain('const rowPresentationOnly = presentationOnly || intentOnly')
    expect(messages).toContain('presentationOnly={rowPresentationOnly}')
  })
})

function source(path: string): string {
  return readFileSync(join(root, path), 'utf8')
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))
      ? [path]
      : []
  })
}
