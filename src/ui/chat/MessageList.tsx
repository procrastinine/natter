import {
  lazy,
  memo,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { type ConversationDeleteMode, conversationActions } from '../../app/conversation-actions'
import type {
  ConversationMutationRunner,
  GenerationSubmission,
} from '../../app/presentation-interactions'
import type { ActiveBranchForkSlot } from '../../core/active-branch-spine'
import type { EffectiveCapability } from '../../core/capabilities'
import type { ChatSettingsPatch } from '../../core/chat-metadata'
import { resolveCutoff } from '../../core/context-cutoff'
import { groupUserAnchoredContextItems, selectContextPairs } from '../../core/context-selection'
import type { PrefillPlan } from '../../core/effective-endpoint-routing'
import type { LongMessageDisplayMode, RenderWindowLoadMode } from '../../core/global-settings'
import { UNLIMITED_CONTEXT } from '../../core/prompt-size'
import type {
  ChatId,
  ChatSettings,
  MessageAttachmentRef,
  MessageId,
  MessageRole,
  Message as MessageRow,
  ProviderOutputMemberRef,
  ReasoningMemberRef,
} from '../../core/types'
import { navigateConversationMessage } from '../../hooks/useConversationCursor'
import { useStreamStableBranchPath } from '../../hooks/useStreamStablePromptEstimate'
import type {
  ConversationTranscriptSurface,
  MessageAttachmentRefMutation,
  MessageHeaderRow,
  TranscriptBodyWindow,
  TranscriptBodyWindowRow,
  WorkspaceFence,
} from '../../store/presentation-contracts'
import {
  transcriptBodyPageRows,
  transcriptBodyWindowFindRow,
  transcriptBodyWindowPages,
  transcriptBodyWindowRows,
} from '../../store/transcript-window'
import { announceVariantPosition } from '../../store/zustand/announcementStore'
import { Button } from '../primitives/Button'
import { Message } from './Message'
import type { InsertSlot } from './MessageActions'
import { PrefillSettingsPrompt } from './PrefillSettingsPrompt'
import { useScrollRegionState } from './ScrollRegion'

const ImportModal = lazy(() =>
  import('./ImportModal').then((module) => ({ default: module.ImportModal })),
)

interface MessageListProps {
  readonly kind?: 'ready'
  binding: ConversationTranscriptSurface
  mutationsUnavailable?: boolean
  structuralMutationPending?: boolean
  runConversationMutation: ConversationMutationRunner
  chatSettings: ChatSettings
  capability?: EffectiveCapability
  prefillPlan: PrefillPlan
  longMessageDisplayMode?: LongMessageDisplayMode
  messageInitialRenderWork: number
  messageRenderWindowLoadMode: RenderWindowLoadMode
  contextPreviewFrozen?: boolean
  transcriptLoadFailed?: boolean
  onLoadOlderMessages: () => void
  onEditAndSendMessage: (
    message: MessageRow,
    text: string,
    options?: { prefillText?: string; attachmentRefs?: MessageAttachmentRef[] },
  ) => GenerationSubmission
  onRegenerateMessage: (
    message: MessageRow,
    options?: { settingsPatch?: ChatSettingsPatch },
  ) => GenerationSubmission
  onContinueMessage: (message: MessageRow) => GenerationSubmission
  generationSubmissionPending?: boolean
  onCancelStructuralMutation?: () => void
}

interface PointMessageListProps {
  readonly kind: 'point'
  readonly chatId: ChatId
  readonly workspaceFence: WorkspaceFence
  readonly window: TranscriptBodyWindow
  readonly longMessageDisplayMode?: LongMessageDisplayMode
}

type MessageListSurfaceProps = MessageListProps | PointMessageListProps

interface InsertTarget {
  messageId: MessageId
  slot: InsertSlot
  defaultRole: MessageRole
}

type RenderableMessageRow = Pick<
  TranscriptBodyWindowRow,
  'message' | 'bodyVersion' | 'bodyExact'
> & {
  readonly intentOnly?: boolean
  readonly fork?: ActiveBranchForkSlot
}

// Pick the conversational counterpart of a role. user↔assistant is the
// natural "next line of dialogue" pairing; system / tool / developer
// stay as themselves because their counterparts aren't well-defined.
function oppositeRole(role: MessageRole): MessageRole {
  if (role === 'user') return 'assistant'
  if (role === 'assistant') return 'user'
  return role
}

// Memoized at the list level so prefs changes (theme, send shortcut,
// chat width) on the Shell don't cascade into a re-render of the
// markdown-heavy children.
const MessageListSurface = memo(function MessageListSurface(props: MessageListSurfaceProps) {
  const point = props.kind === 'point'
  const chatId = point ? props.chatId : props.binding.seal.chatId
  const branchSnapshot = point ? props.window : props.binding.window
  const presentationFence = point ? props.workspaceFence : props.binding.seal
  const branchSpine = point ? null : props.binding.spine
  const activePath = branchSpine?.path ?? null
  const presentationOnly = point ? true : props.binding.currency !== 'current'
  const mutationsUnavailable = point ? true : props.mutationsUnavailable === true
  const structuralMutationPending = point ? false : props.structuralMutationPending === true
  const runConversationMutation = point ? null : props.runConversationMutation
  const chatSettings = point ? null : props.chatSettings
  const capability = point ? undefined : props.capability
  const prefillPlan = point ? null : props.prefillPlan
  const longMessageDisplayMode = props.longMessageDisplayMode ?? 'full'
  const messageInitialRenderWork = point ? 1 : props.messageInitialRenderWork
  const messageRenderWindowLoadMode = point ? 'manual' : props.messageRenderWindowLoadMode
  const contextPreviewFrozen = point ? false : props.contextPreviewFrozen === true
  const transcriptLoadFailed = point ? false : props.transcriptLoadFailed === true
  const onLoadOlderMessages = point ? null : props.onLoadOlderMessages
  const onEditAndSendMessage = point ? null : props.onEditAndSendMessage
  const onRegenerateMessage = point ? null : props.onRegenerateMessage
  const onContinueMessage = point ? null : props.onContinueMessage
  const generationSubmissionPending = point ? false : props.generationSubmissionPending === true
  const onCancelStructuralMutation = point ? undefined : props.onCancelStructuralMutation
  const hiddenOlderCount = branchSnapshot.offset
  const staleBodyCount = branchSnapshot.staleBodyCount
  const canRetryLoadedBodies = transcriptLoadFailed && staleBodyCount > 0
  const branchLength = activePath?.length ?? 0
  const [insertTarget, setInsertTarget] = useState<InsertTarget | null>(null)
  // Track the set of user-message ids whose content was edited in THIS
  // tab session; used to surface the "stale reply?" hint under their
  // next assistant on the active path. The stale-session lives only in
  // memory — reloads wipe it per §10.6 "Edit action" session-local hint.
  const [staleHintFor, setStaleHintFor] = useState<Set<MessageId>>(() => new Set())
  const contextPreviewPath = useStreamStableBranchPath(activePath, contextPreviewFrozen)
  // Prefill UI gating for the inline editor's "Save & Send" path. The
  // button hides on `unsupported` models (Claude ≥ 4.6 / OpenAI / gpt-oss);
  // on every other class it shows up next to Save & Send.
  const prefillSupported = prefillPlan !== null && prefillPlan.availability !== 'unsupported'
  const prefillSettingsPrompt = useMemo(
    () =>
      prefillSupported ? <PrefillSettingsPrompt chatId={chatId} plan={prefillPlan} /> : undefined,
    [chatId, prefillPlan, prefillSupported],
  )
  // Track the focused message id via a ref; the DOM's `:focus-within` +
  // `data-message-id` tuple on each <article> identifies which message the
  // user is navigating. Keeps keyboard shortcuts tied to "the message just
  // clicked" without forcing a controlled-selection state.
  const listRef = useRef<HTMLDivElement | null>(null)
  const loadOlderRef = useRef<HTMLDivElement | null>(null)
  const scrollRegionState = useScrollRegionState()
  const focusedMessageId = useCallback((): MessageId | null => {
    const el = listRef.current?.querySelector<HTMLElement>('[data-ui="message"]:focus-within')
    return el?.getAttribute('data-message-id') ?? null
  }, [])

  useEffect(() => {
    if (mutationsUnavailable) setInsertTarget(null)
  }, [mutationsUnavailable])

  const handleBeginEdit = useCallback(
    (presentationFence: WorkspaceFence, message: MessageRow) =>
      conversationActions.beginMessageEditSession(presentationFence, message.chatId, message.id),
    [],
  )

  const handleEditInPlace = useCallback(
    (m: MessageRow, text: string) => {
      if (!runConversationMutation) throw new Error('ConversationPointMutationUnavailable')
      return runConversationMutation(
        { kind: 'edit', chatId, messageId: m.id },
        (signal) => conversationActions.editMessage(chatId, m, text, signal),
        m.role === 'user'
          ? () => {
              setStaleHintFor((prev) => {
                if (prev.has(m.id)) return prev
                const next = new Set(prev)
                next.add(m.id)
                return next
              })
            }
          : undefined,
      )
    },
    [chatId, runConversationMutation],
  )
  const handleToggleReasoningHidden = useCallback(
    (m: MessageRow, member: ReasoningMemberRef) => {
      if (!runConversationMutation) throw new Error('ConversationPointMutationUnavailable')
      return runConversationMutation(
        { kind: 'reasoning', chatId, messageId: m.id, member },
        (signal) => conversationActions.toggleReasoning(chatId, m, member, signal),
      )
    },
    [chatId, runConversationMutation],
  )
  const handleToggleToolHidden = useCallback(
    (m: MessageRow, member: ProviderOutputMemberRef) => {
      if (!runConversationMutation) throw new Error('ConversationPointMutationUnavailable')
      return runConversationMutation(
        { kind: 'provider-output', chatId, messageId: m.id, member },
        (signal) => conversationActions.toggleProviderOutput(chatId, m, member, signal),
      )
    },
    [chatId, runConversationMutation],
  )
  const handleToggleContextVisibility = useCallback(
    (m: MessageRow) => {
      if (!runConversationMutation) throw new Error('ConversationPointMutationUnavailable')
      return runConversationMutation({ kind: 'context', chatId, messageId: m.id }, (signal) =>
        conversationActions.toggleContext(chatId, m, signal),
      )
    },
    [chatId, runConversationMutation],
  )
  const handleDismissGenerationNotice = useCallback(
    (m: MessageRow) => {
      if (!runConversationMutation) throw new Error('ConversationPointMutationUnavailable')
      return runConversationMutation(
        { kind: 'generation-notice', chatId, messageId: m.id },
        (signal) => conversationActions.dismissGenerationNotice(chatId, m, signal),
      )
    },
    [chatId, runConversationMutation],
  )
  const handleMutateAttachmentRef = useCallback(
    (m: MessageRow, mutation: MessageAttachmentRefMutation) =>
      conversationActions.mutateAttachment(m, mutation),
    [],
  )

  const handleEditAndSend = useCallback(
    (
      m: MessageRow,
      text: string,
      opts?: { prefillText?: string; attachmentRefs?: MessageAttachmentRef[] },
    ) => {
      if (!onEditAndSendMessage) throw new Error('ConversationPointGenerationUnavailable')
      return onEditAndSendMessage(m, text, opts)
    },
    [onEditAndSendMessage],
  )

  const handleRegenerate = useCallback(
    (m: MessageRow, options?: { settingsPatch?: ChatSettingsPatch }) => {
      if (!onRegenerateMessage) throw new Error('ConversationPointGenerationUnavailable')
      return onRegenerateMessage(m, options)
    },
    [onRegenerateMessage],
  )

  const handleContinue = useCallback(
    (m: MessageRow) => {
      if (!onContinueMessage) throw new Error('ConversationPointGenerationUnavailable')
      return onContinueMessage(m)
    },
    [onContinueMessage],
  )

  const handleForkChat = useCallback(
    (m: MessageRow) => {
      if (!runConversationMutation) throw new Error('ConversationPointMutationUnavailable')
      return runConversationMutation({ kind: 'fork', chatId, messageId: m.id }, (signal) =>
        conversationActions.forkMessage(chatId, m, signal),
      )
    },
    [chatId, runConversationMutation],
  )

  const handleDeleteMessage = useCallback(
    (m: MessageRow, mode: ConversationDeleteMode, roleMismatch = false) => {
      if (!runConversationMutation) throw new Error('ConversationPointMutationUnavailable')
      return runConversationMutation({ kind: 'delete', chatId }, (signal, reportPhase) =>
        conversationActions.deleteMessage(chatId, m.id, mode, roleMismatch, signal, reportPhase),
      )
    },
    [chatId, runConversationMutation],
  )

  // Smart role defaults per the user's "insert should be smart" rule:
  //   - sibling of M   → same role as M (siblings are variants)
  //   - before M       → opposite of M (forms a conversation pair with M)
  //   - after M        → opposite of M (the next turn in the dialogue).
  //                      This also handles the "after the last message"
  //                      case naturally: if the chat ends on user, an
  //                      assistant is seeded; if it ends on assistant, a
  //                      user is seeded.
  const openInsert = useCallback((target: MessageRow, slot: InsertSlot) => {
    const defaultRole = slot === 'sibling' ? target.role : oppositeRole(target.role)
    setInsertTarget({ messageId: target.id, slot, defaultRole })
  }, [])

  // Keyboard affordances per §10.6 / §10.14. `[` / `]` swipe variants,
  // `⇧⌘R` regenerates the focused assistant. Ignored while typing in a
  // textarea/input so users don't fight with their composer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      const activeTag = (document.activeElement?.tagName ?? '').toLowerCase()
      const isTyping = activeTag === 'input' || activeTag === 'textarea'
      if (isTyping) return
      const focusedId = focusedMessageId()
      if (!focusedId) return
      const focusedRow = transcriptBodyWindowFindRow(branchSnapshot, focusedId)
      if (!focusedRow) return
      const focused = focusedRow.message
      if (e.key === '[' || e.key === ']') {
        e.preventDefault()
        if (!branchSpine) return
        const slot = branchSpine.forkFor(focusedId)
        if (!slot || slot.liveCount < 2) return
        const movingBackward = e.key === '['
        const chosenId = movingBackward
          ? (slot.previousMessageId ?? slot.lastMessageId)
          : (slot.nextMessageId ?? slot.firstMessageId)
        const targetIndex = movingBackward
          ? (slot.position - 1 + slot.liveCount) % slot.liveCount
          : (slot.position + 1) % slot.liveCount
        navigateConversationMessage(chatId, chosenId)
        announceVariantPosition(targetIndex, slot.liveCount)
        return
      }
      if (mutationsUnavailable) return
      if (e.key === 'R' && e.shiftKey && (e.metaKey || e.ctrlKey) && focused.role === 'assistant') {
        e.preventDefault()
        void handleRegenerate(focused)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    branchSnapshot,
    branchSpine,
    chatId,
    focusedMessageId,
    handleRegenerate,
    mutationsUnavailable,
  ])

  const roleMismatchIdsOnPath = useMemo(() => {
    const set = new Set<MessageId>()
    if (!activePath) return set
    for (const { header } of transcriptBodyWindowRows(branchSnapshot)) {
      const prev = header.parentId ? activePath.get(header.parentId) : undefined
      if (prev?.role === header.role) set.add(header.id)
    }
    return set
  }, [activePath, branchSnapshot])

  const excludedIds = useMemo(() => {
    if (!chatSettings) return new Set<MessageId>()
    return computeExcludedIds(
      contextPreviewPath?.materializeNodes() ?? [],
      chatSettings,
      capability,
    )
  }, [capability, chatSettings, contextPreviewPath])
  const renderableMessageRows = useMemo(() => {
    return [...transcriptBodyWindowPages(branchSnapshot)].flatMap((page) => [
      ...transcriptBodyPageRows(page),
    ])
  }, [branchSnapshot])
  const branchCountsKnown =
    !point &&
    renderableMessageRows.every(({ message }) => Boolean(branchSpine?.forkFor(message.id)))
  const effectiveRenderedMessageCount = renderableMessageRows.length
  const loadOlderMessages = useCallback(() => {
    if (presentationOnly) return
    if (!onLoadOlderMessages) return
    if (hiddenOlderCount <= 0 && !canRetryLoadedBodies) return
    onLoadOlderMessages()
  }, [canRetryLoadedBodies, hiddenOlderCount, onLoadOlderMessages, presentationOnly])

  useEffect(() => {
    if (presentationOnly) return
    if (messageRenderWindowLoadMode !== 'auto') return
    if (hiddenOlderCount <= 0) return
    if (scrollRegionState !== 'pinned') return
    if (typeof IntersectionObserver === 'undefined') return
    const target = loadOlderRef.current
    const root = listRef.current?.closest<HTMLDivElement>('[data-ui="scroll-region"]')
    if (!target || !root) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadOlderMessages()
      },
      { root, rootMargin: '240px 0px 0px 0px', threshold: 0 },
    )
    observer.observe(target)
    return () => observer.disconnect()
  }, [
    hiddenOlderCount,
    loadOlderMessages,
    messageRenderWindowLoadMode,
    presentationOnly,
    scrollRegionState,
  ])

  const renderMessageRow = useCallback(
    ({
      message: m,
      bodyVersion,
      bodyExact,
      intentOnly = false,
      fork,
    }: RenderableMessageRow): ReactNode => {
      const rowMutationsUnavailable = mutationsUnavailable || intentOnly
      const showStaleHint =
        m.role === 'assistant' && m.parentId !== null && staleHintFor.has(m.parentId)
      const branchContext = fork ?? branchSpine?.forkFor(m.id)
      const hasSiblingVariants = (branchContext?.liveCount ?? 0) > 1
      return (
        <Message
          key={m.id}
          chatId={chatId}
          message={m}
          bodyVersion={bodyVersion}
          bodyExact={bodyExact}
          {...(hasSiblingVariants && branchContext ? { branchContext } : {})}
          generationSubmissionPending={generationSubmissionPending}
          structuralMutationPending={structuralMutationPending}
          {...(onCancelStructuralMutation ? { onCancelStructuralMutation } : {})}
          presentationOnly={rowMutationsUnavailable}
          presentationFence={presentationFence}
          onBeginEdit={handleBeginEdit}
          onEditInPlace={handleEditInPlace}
          onToggleContextVisibility={handleToggleContextVisibility}
          onDismissGenerationNotice={handleDismissGenerationNotice}
          onMutateAttachmentRef={handleMutateAttachmentRef}
          onToggleReasoningDetailHidden={handleToggleReasoningHidden}
          onToggleProviderOutputItemHidden={handleToggleToolHidden}
          {...(!point && m.role === 'user'
            ? {
                onEditAndSend: handleEditAndSend,
                ...(prefillSupported
                  ? {
                      showPrefillButton: true,
                      defaultPrefill: chatSettings?.defaultPrefill ?? '',
                      prefillSettingsPrompt,
                    }
                  : {}),
              }
            : {})}
          {...(!point && m.role === 'assistant'
            ? {
                onRegenerate: handleRegenerate,
                onContinue: handleContinue,
              }
            : {})}
          onForkChat={handleForkChat}
          onDeleteMessage={handleDeleteMessage}
          onInsert={openInsert}
          {...(roleMismatchIdsOnPath.has(m.id) ? { roleMismatch: true } : {})}
          {...(showStaleHint ? { staleReplyHint: true } : {})}
          {...(excludedIds.has(m.id) ? { excludedFromContext: true } : {})}
          longMessageDisplayMode={longMessageDisplayMode}
        />
      )
    },
    [
      branchSpine,
      chatId,
      chatSettings?.defaultPrefill,
      excludedIds,
      generationSubmissionPending,
      handleContinue,
      handleBeginEdit,
      handleDismissGenerationNotice,
      handleEditAndSend,
      handleEditInPlace,
      handleDeleteMessage,
      handleForkChat,
      handleMutateAttachmentRef,
      handleRegenerate,
      handleToggleContextVisibility,
      handleToggleReasoningHidden,
      handleToggleToolHidden,
      longMessageDisplayMode,
      openInsert,
      prefillSettingsPrompt,
      prefillSupported,
      mutationsUnavailable,
      roleMismatchIdsOnPath,
      staleHintFor,
      structuralMutationPending,
      onCancelStructuralMutation,
      point,
      presentationFence,
    ],
  )

  return (
    <div
      data-ui="message-list"
      data-chat-id={chatId}
      data-presentation-kind={point ? 'point' : 'ready'}
      role="log"
      aria-live={presentationOnly ? 'off' : 'polite'}
      aria-relevant="additions"
      ref={listRef}
      data-initial-render-work={messageInitialRenderWork}
      data-rendered-count={effectiveRenderedMessageCount}
      data-total-count={point ? undefined : branchLength}
      data-branch-counts={branchCountsKnown ? 'known' : 'pending'}
      aria-busy={presentationOnly || undefined}
      data-presentation-only={presentationOnly || undefined}
    >
      {hiddenOlderCount > 0 || canRetryLoadedBodies ? (
        <div ref={loadOlderRef} data-ui="message-window-load">
          <Button
            type="button"
            data-ui="load-more-messages"
            onClick={loadOlderMessages}
            disabled={presentationOnly}
          >
            {transcriptLoadFailed ? 'Retry' : 'Load more'}
          </Button>
          {hiddenOlderCount > 0 ? <span>{hiddenOlderCount} older</span> : null}
        </div>
      ) : null}
      {renderableMessageRows.map(renderMessageRow)}
      {insertTarget ? (
        <Suspense
          fallback={
            <div data-ui="surface-loading" data-placement="overlay" role="status">
              Loading import…
            </div>
          }
        >
          <ImportModal
            chatId={chatId}
            slot={{
              kind: insertTarget.slot,
              messageId: insertTarget.messageId,
            }}
            defaultRole={insertTarget.defaultRole}
            onClose={() => setInsertTarget(null)}
            onDone={() => setInsertTarget(null)}
          />
        </Suspense>
      ) : null}
    </div>
  )
})

export const MessageList = MessageListSurface
export const MessageListPoint = MessageListSurface

// Compute which messages would be trimmed out of the next request given
// the chat's context settings. Uses a chars/4 approximation — the real
// tokenizer machinery lives in core/prompt-size but this runs per render
// so cheap wins. Result drives the dashed-ring on profile glyphs.
//
type ContextEstimateRow = Pick<
  MessageHeaderRow,
  | 'id'
  | 'role'
  | 'hiddenFromContext'
  | 'originalCharCount'
  | 'charCountDelta'
  | 'cachedTokenEstimate'
  | 'originalTokenEstimate'
>

function computeExcludedIds(
  path: readonly ContextEstimateRow[],
  settings: ChatSettings,
  capability?: EffectiveCapability,
): Set<MessageId> {
  const out = new Set<MessageId>()
  if (path.length === 0) return out
  for (const message of path) {
    if (message.hiddenFromContext) out.add(message.id)
  }
  if (settings.contextStrategy.kind !== 'sliding_window') return out
  const providerCap = capability?.maxPromptTokens ?? capability?.contextLength
  const cutoff = resolveCutoff(settings, providerCap ?? null)
  if (!Number.isFinite(cutoff)) return out
  const maxCompletionStored = settings.maxCompletionTokens
  const maxCompletion =
    maxCompletionStored === UNLIMITED_CONTEXT ? 0 : (maxCompletionStored ?? 4096)
  const budget = Math.max(0, cutoff - maxCompletion)
  const tokensFor = (m: ContextEstimateRow): number | undefined => {
    if (typeof m.cachedTokenEstimate === 'number' && Number.isFinite(m.cachedTokenEstimate)) {
      return Math.max(0, Math.ceil(m.cachedTokenEstimate))
    }
    if (typeof m.originalTokenEstimate === 'number' && Number.isFinite(m.originalTokenEstimate)) {
      return Math.max(0, Math.ceil(m.originalTokenEstimate))
    }
    if (typeof m.originalCharCount === 'number' && Number.isFinite(m.originalCharCount)) {
      const delta =
        typeof m.charCountDelta === 'number' && Number.isFinite(m.charCountDelta)
          ? m.charCountDelta
          : 0
      return Math.ceil(Math.max(0, m.originalCharCount + delta) / 4)
    }
    return undefined
  }
  const eligible = path.filter((m) => !m.hiddenFromContext)
  const grouped = groupUserAnchoredContextItems(eligible)
  const bucketCost = (messages: readonly ContextEstimateRow[]): number | undefined => {
    let total = 0
    for (const message of messages) {
      const cost = tokensFor(message)
      if (cost === undefined) return undefined
      total += cost
    }
    return total
  }
  const preambleTokens = bucketCost(grouped.preamble)
  if (preambleTokens === undefined) return out
  const pairCosts: number[] = []
  for (const pair of grouped.pairs) {
    const cost = bucketCost(pair)
    if (cost === undefined) return out
    pairCosts.push(cost)
  }
  const selection = selectContextPairs({
    pairCount: grouped.pairs.length,
    keepFirstPairs: settings.contextStrategy.keepFirstPairs ?? 0,
    availableTokens: budget - Math.ceil(settings.systemPrompt.length / 4) - preambleTokens,
    pairCost: ({ pairIndex }) => pairCosts[pairIndex] ?? 0,
  })
  const kept = new Set<MessageId>()
  for (const message of grouped.preamble) kept.add(message.id)
  for (let index = 0; index < selection.headPairCount; index += 1) {
    for (const message of grouped.pairs[index] ?? []) kept.add(message.id)
  }
  for (let index = selection.tailStart; index < grouped.pairs.length; index += 1) {
    for (const message of grouped.pairs[index] ?? []) kept.add(message.id)
  }
  for (const m of eligible) if (!kept.has(m.id)) out.add(m.id)
  return out
}
