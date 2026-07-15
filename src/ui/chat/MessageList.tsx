import {
  lazy,
  memo,
  Suspense,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  beginRouteIntent,
  cancelRouteIntent,
  chatHref,
  isRouteIntentCurrent,
  navigateForIntent,
} from '../../app/router'
import { cursorKeyOf, indexById, type MessageTreeProjection } from '../../core/active-path'
import type { EffectiveCapability } from '../../core/capabilities'
import { computeBranchTitle, forkChatFromMessage } from '../../core/chat-fork'
import type { LongMessageDisplayMode, RenderWindowLoadMode } from '../../core/global-settings'
import { swipeProjected } from '../../core/messages'
import { UNLIMITED_CONTEXT } from '../../core/prompt-size'
import { prefillClassFor } from '../../core/quirks'
import type {
  ChatId,
  ChatSettings,
  CursorMap,
  MessageAttachmentRef,
  MessageId,
  MessageRole,
  Message as MessageRow,
  ModelEndpoint,
} from '../../core/types'
import type { StructuralMessageHeader } from '../../hooks/useBranchUrlSync'
import { useChat } from '../../hooks/useChat'
import {
  continueFromMessage,
  dismissMessageGenerationNotice,
  editAndResend,
  editInPlace,
  type MessageOpsContext,
  mutateMessageAttachmentReference,
  regenerateFromMessage,
  toggleMessageContextHidden,
  toggleProviderOutputItemHidden,
  toggleReasoningDetailHidden,
} from '../../hooks/useMessageOps'
import type { MessageAttachmentRefMutation } from '../../store/attachments'
import { getChat, listChatSidebarRows } from '../../store/chats'
import type { MessageHeaderRow } from '../../store/message-storage'
import type { ActiveBranchWindowSnapshot } from '../../store/repository'
import { announceVariantPosition } from '../../store/zustand/announcementStore'
import { useChatStore } from '../../store/zustand/chatStore'
import { useToastStore } from '../../store/zustand/toastStore'
import { Button } from '../primitives/Button'
import type { BranchNavigationContext } from './BranchControls'
import { Message } from './Message'
import type { InsertSlot } from './MessageActions'
import { PrefillSettingsPrompt } from './PrefillSettingsPrompt'

const ImportModal = lazy(() =>
  import('./ImportModal').then((module) => ({ default: module.ImportModal })),
)

interface MessageListProps {
  chatId: ChatId
  chatSettings: ChatSettings
  hasConnection: boolean
  capability?: EffectiveCapability
  prefillRecommendationEndpoints?: readonly ModelEndpoint[]
  longMessageDisplayMode?: LongMessageDisplayMode
  messageRenderWindowSize: number
  messageRenderWindowLoadMode: RenderWindowLoadMode
  branchSnapshot: ActiveBranchWindowSnapshot | null
  treeProjection: MessageTreeProjection<StructuralMessageHeader>
  authoritativePathHeaders?: readonly MessageHeaderRow[]
  presentationOnly?: boolean
  allowPresentationStreamProjection?: boolean
  onLoadOlderMessages: () => void
}

// Stable reference so `useChatStore(selector)` doesn't allocate a fresh `{}`
// every render — that triggers React 19's infinite-rerender detection via
// `useSyncExternalStore` (getSnapshot must return a stable value).
const EMPTY_CURSOR: CursorMap = Object.freeze({})
const EMPTY_ENDPOINTS: readonly ModelEndpoint[] = Object.freeze([])
const EMPTY_MESSAGE_HEADERS: readonly MessageHeaderRow[] = Object.freeze([])

interface InsertTarget {
  messageId: MessageId
  slot: InsertSlot
  defaultRole: MessageRole
}

type MessageListIndexOperation = 'path-index'
let messageListIndexProbe: ((operation: MessageListIndexOperation) => void) | undefined

export function __setMessageListIndexProbeForTests(
  probe: ((operation: MessageListIndexOperation) => void) | undefined,
): void {
  messageListIndexProbe = probe
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
export const MessageList = memo(function MessageList({
  chatId,
  chatSettings,
  hasConnection,
  capability,
  prefillRecommendationEndpoints = EMPTY_ENDPOINTS,
  longMessageDisplayMode = 'full',
  messageRenderWindowSize,
  messageRenderWindowLoadMode,
  branchSnapshot,
  treeProjection,
  authoritativePathHeaders,
  presentationOnly = false,
  allowPresentationStreamProjection = false,
  onLoadOlderMessages,
}: MessageListProps) {
  const cursor = useChatStore((state) => state.getCursor(chatId) ?? EMPTY_CURSOR)
  const messages = useStableMessageRows(branchSnapshot?.branchWindow ?? [])
  const branchHeaders = branchSnapshot?.branchHeaders ?? EMPTY_MESSAGE_HEADERS
  const activePathHeaders = authoritativePathHeaders ?? branchHeaders
  const pathById = useMemo(() => {
    messageListIndexProbe?.('path-index')
    return indexById(messages)
  }, [messages])
  const { liveByParent } = treeProjection
  const branchContext: BranchNavigationContext = treeProjection
  const visiblePath = messages
  const hiddenOlderCount = branchSnapshot?.windowOffset ?? 0
  const branchLength =
    authoritativePathHeaders?.length ?? branchSnapshot?.branchLength ?? visiblePath.length
  const path = visiblePath
  const hasAnyReasoningDetails = useMemo(
    () => path.some((m) => (m.reasoningDetails?.length ?? 0) > 0),
    [path],
  )
  const { sendFrom } = useChat()
  const pushToast = useToastStore((s) => s.push)
  const [insertTarget, setInsertTarget] = useState<InsertTarget | null>(null)
  // Track the set of user-message ids whose content was edited in THIS
  // tab session; used to surface the "stale reply?" hint under their
  // next assistant on the active path. The stale-session lives only in
  // memory — reloads wipe it per §10.6 "Edit action" session-local hint.
  const [staleHintFor, setStaleHintFor] = useState<Set<MessageId>>(() => new Set())

  const opsCtx = useMemo<MessageOpsContext>(() => ({ chatId, sendFrom }), [chatId, sendFrom])

  // Prefill UI gating for the inline editor's "Save & Send" path. The
  // button hides on `unsupported` models (Claude ≥ 4.6 / OpenAI / gpt-oss);
  // on every other class it shows up next to Save & Send.
  const prefillSupported = chatSettings.model
    ? prefillClassFor(chatSettings.model) !== 'unsupported'
    : false
  const prefillSettingsPrompt = useMemo(
    () =>
      prefillSupported ? (
        <PrefillSettingsPrompt
          chatId={chatId}
          settings={chatSettings}
          endpoints={prefillRecommendationEndpoints}
        />
      ) : undefined,
    [chatId, chatSettings, prefillRecommendationEndpoints, prefillSupported],
  )
  // Track the focused message id via a ref; the DOM's `:focus-within` +
  // `data-message-id` tuple on each <article> identifies which message the
  // user is navigating. Keeps keyboard shortcuts tied to "the message just
  // clicked" without forcing a controlled-selection state.
  const listRef = useRef<HTMLDivElement | null>(null)
  const loadOlderRef = useRef<HTMLDivElement | null>(null)
  const pendingPrependAnchorRef = useRef<{ scrollTop: number; scrollHeight: number } | null>(null)
  const focusedMessageId = useCallback((): MessageId | null => {
    const el = listRef.current?.querySelector<HTMLElement>('[data-ui="message"]:focus-within')
    return el?.getAttribute('data-message-id') ?? null
  }, [])

  useEffect(() => {
    if (presentationOnly) setInsertTarget(null)
  }, [presentationOnly])

  const handleEditInPlace = useCallback(
    async (m: MessageRow, text: string) => {
      await editInPlace(chatId, m, text, {
        ...(authoritativePathHeaders ? { pathHeaders: authoritativePathHeaders } : {}),
      })
      if (m.role === 'user') {
        setStaleHintFor((prev) => {
          if (prev.has(m.id)) return prev
          const next = new Set(prev)
          next.add(m.id)
          return next
        })
      }
    },
    [authoritativePathHeaders, chatId],
  )
  const handleToggleReasoningHidden = useCallback(
    async (m: MessageRow, detailIndex: number) => {
      try {
        await toggleReasoningDetailHidden(chatId, m.id, detailIndex, {
          ...(authoritativePathHeaders ? { pathHeaders: authoritativePathHeaders } : {}),
        })
      } catch (error) {
        pushToast({
          level: 'danger',
          text: `Reasoning visibility update failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        })
      }
    },
    [authoritativePathHeaders, chatId, pushToast],
  )
  const handleToggleToolHidden = useCallback(
    async (m: MessageRow, itemIndex: number) => {
      try {
        await toggleProviderOutputItemHidden(chatId, m.id, itemIndex, {
          ...(authoritativePathHeaders ? { pathHeaders: authoritativePathHeaders } : {}),
        })
      } catch (error) {
        pushToast({
          level: 'danger',
          text: `Tool visibility update failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        })
      }
    },
    [authoritativePathHeaders, chatId, pushToast],
  )
  const handleToggleContextVisibility = useCallback(
    async (m: MessageRow) => {
      await toggleMessageContextHidden(chatId, m.id, {
        ...(authoritativePathHeaders ? { pathHeaders: authoritativePathHeaders } : {}),
      })
    },
    [authoritativePathHeaders, chatId],
  )
  const handleDismissGenerationNotice = useCallback(
    async (m: MessageRow) => {
      await dismissMessageGenerationNotice(chatId, m.id, {
        ...(authoritativePathHeaders ? { pathHeaders: authoritativePathHeaders } : {}),
      })
    },
    [authoritativePathHeaders, chatId],
  )
  const handleMutateAttachmentRef = useCallback(
    async (m: MessageRow, mutation: MessageAttachmentRefMutation) => {
      await mutateMessageAttachmentReference(chatId, m.id, mutation, {
        ...(authoritativePathHeaders ? { pathHeaders: authoritativePathHeaders } : {}),
      })
    },
    [authoritativePathHeaders, chatId],
  )

  const handleEditAndSend = useCallback(
    async (
      m: MessageRow,
      text: string,
      opts?: { prefillText?: string; attachmentRefs?: MessageAttachmentRef[] },
    ) => {
      try {
        const prefillText = opts?.prefillText ?? ''
        await editAndResend(opsCtx, m, text, {
          ...(prefillText.length > 0
            ? { prefillContent: [{ type: 'text', text: prefillText }] }
            : {}),
          ...(opts?.attachmentRefs ? { attachmentRefs: opts.attachmentRefs } : {}),
        })
      } catch (err) {
        pushToast({
          level: 'danger',
          text: err instanceof Error ? `Send failed: ${err.message}` : 'Send failed.',
        })
      }
    },
    [opsCtx, pushToast],
  )

  const handleRegenerate = useCallback(
    async (m: MessageRow) => {
      try {
        await regenerateFromMessage(opsCtx, m)
      } catch (err) {
        pushToast({
          level: 'danger',
          text: err instanceof Error ? `Regenerate failed: ${err.message}` : 'Regenerate failed.',
        })
      }
    },
    [opsCtx, pushToast],
  )

  const handleContinue = useCallback(
    async (m: MessageRow) => {
      try {
        await continueFromMessage(opsCtx, m)
      } catch (err) {
        pushToast({
          level: 'danger',
          text: err instanceof Error ? `Continue failed: ${err.message}` : 'Continue failed.',
        })
      }
    },
    [opsCtx, pushToast],
  )

  const handleForkChat = useCallback(
    async (m: MessageRow) => {
      const routeIntent = beginRouteIntent()
      try {
        const sourceChat = await getChat(chatId)
        if (!sourceChat) {
          pushToast({ level: 'danger', text: 'Chat not found.' })
          return
        }
        const existing = await listChatSidebarRows()
        const defaultTitle = computeBranchTitle(
          sourceChat.title,
          existing.map((c) => c.title),
        )
        if (!isRouteIntentCurrent(routeIntent)) return
        const chosen =
          typeof window !== 'undefined'
            ? window.prompt('Name the new chat:', defaultTitle)
            : defaultTitle
        if (chosen === null) return
        const title = chosen.trim() || defaultTitle
        const currentCursor = useChatStore.getState().getCursor(chatId) ?? EMPTY_CURSOR
        const result = await forkChatFromMessage({
          chatId,
          messageId: m.id,
          title,
          cursor: currentCursor,
        })
        pushToast({
          level: 'success',
          text: `Forked to "${title}" (${result.messageCount} messages).`,
        })
        navigateForIntent(routeIntent, chatHref(result.chatId))
      } catch (err) {
        pushToast({
          level: 'danger',
          text: err instanceof Error ? `Fork failed: ${err.message}` : 'Fork failed.',
        })
      } finally {
        cancelRouteIntent(routeIntent)
      }
    },
    [chatId, pushToast],
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
    if (presentationOnly) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      const activeTag = (document.activeElement?.tagName ?? '').toLowerCase()
      const isTyping = activeTag === 'input' || activeTag === 'textarea'
      if (isTyping) return
      const focusedId = focusedMessageId()
      if (!focusedId) return
      const focused = pathById.get(focusedId)
      if (!focused) return
      if (e.key === '[' || e.key === ']') {
        e.preventDefault()
        const direction = e.key === '[' ? -1 : 1
        const base = useChatStore.getState().getCursor(chatId) ?? {}
        const { cursorUpdates } = swipeProjected({
          projection: treeProjection,
          targetId: focusedId,
          direction,
          cursor: base,
        })
        const chosenId = cursorUpdates[cursorKeyOf(focused.parentId)]
        useChatStore.getState().navigateWithCursorPatch(chatId, cursorUpdates)
        if (chosenId) {
          const siblings = liveByParent.get(focused.parentId) ?? []
          const targetIndex = siblings.findIndex((candidate) => candidate.id === chosenId)
          if (targetIndex >= 0) announceVariantPosition(targetIndex, siblings.length)
        }
        return
      }
      if (e.key === 'R' && e.shiftKey && (e.metaKey || e.ctrlKey) && focused.role === 'assistant') {
        e.preventDefault()
        void handleRegenerate(focused)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    chatId,
    pathById,
    liveByParent,
    treeProjection,
    focusedMessageId,
    handleRegenerate,
    presentationOnly,
  ])

  const activePathIndexById = useMemo(() => {
    const indexes = new Map<MessageId, number>()
    for (let index = 0; index < activePathHeaders.length; index += 1) {
      const header = activePathHeaders[index]
      if (header) indexes.set(header.id, index)
    }
    return indexes
  }, [activePathHeaders])

  const roleMismatchIdsOnPath = useMemo(() => {
    const set = new Set<MessageId>()
    for (let i = 1; i < activePathHeaders.length; i += 1) {
      const prev = activePathHeaders[i - 1]
      const cur = activePathHeaders[i]
      if (!prev || !cur) continue
      if (prev.role === cur.role) {
        set.add(cur.id)
      }
    }
    return set
  }, [activePathHeaders])

  const excludedIds = useMemo(() => {
    return computeExcludedIds(activePathHeaders, pathById, chatSettings, capability)
  }, [activePathHeaders, pathById, chatSettings, capability])
  const effectiveRenderedMessageCount = visiblePath.length
  const loadOlderMessages = useCallback(() => {
    if (presentationOnly) return
    if (hiddenOlderCount <= 0) return
    const container = listRef.current?.closest<HTMLDivElement>('[data-ui="scroll-region"]')
    if (container) {
      pendingPrependAnchorRef.current = {
        scrollTop: container.scrollTop,
        scrollHeight: container.scrollHeight,
      }
    }
    onLoadOlderMessages()
  }, [hiddenOlderCount, onLoadOlderMessages, presentationOnly])

  const visiblePathLength = visiblePath.length
  useLayoutEffect(() => {
    void visiblePathLength
    const anchor = pendingPrependAnchorRef.current
    if (!anchor) return
    pendingPrependAnchorRef.current = null
    const container = listRef.current?.closest<HTMLDivElement>('[data-ui="scroll-region"]')
    if (!container) return
    const delta = container.scrollHeight - anchor.scrollHeight
    container.scrollTop = anchor.scrollTop + delta
  }, [visiblePathLength])

  useEffect(() => {
    if (presentationOnly) return
    if (messageRenderWindowLoadMode !== 'auto') return
    if (hiddenOlderCount <= 0) return
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
  }, [hiddenOlderCount, loadOlderMessages, messageRenderWindowLoadMode, presentationOnly])

  const blockPresentationInteraction = useCallback(
    (event: SyntheticEvent) => {
      if (!presentationOnly) return
      event.preventDefault()
      event.stopPropagation()
    },
    [presentationOnly],
  )

  return (
    <div
      data-ui="message-list"
      role="log"
      aria-live={presentationOnly ? 'off' : 'polite'}
      aria-relevant="additions"
      ref={listRef}
      data-render-window-size={messageRenderWindowSize}
      data-rendered-count={effectiveRenderedMessageCount}
      data-total-count={branchLength}
      inert={presentationOnly || undefined}
      aria-busy={presentationOnly || undefined}
      data-presentation-only={presentationOnly || undefined}
      onClickCapture={blockPresentationInteraction}
      onAuxClickCapture={blockPresentationInteraction}
      onContextMenuCapture={blockPresentationInteraction}
      onKeyDownCapture={blockPresentationInteraction}
      onSubmitCapture={blockPresentationInteraction}
    >
      {hiddenOlderCount > 0 ? (
        <div ref={loadOlderRef} data-ui="message-window-load">
          <Button
            type="button"
            data-ui="load-more-messages"
            onClick={loadOlderMessages}
            disabled={presentationOnly}
          >
            Load more
          </Button>
          <span>{hiddenOlderCount} older</span>
        </div>
      ) : null}
      {visiblePath.map((m, visibleIndex) => {
        const activePathIndex = activePathIndexById.get(m.id)
        const bodyVersion = branchHeaders[hiddenOlderCount + visibleIndex]?.bodyVersion as number
        const prev =
          activePathIndex !== undefined && activePathIndex > 0
            ? activePathHeaders[activePathIndex - 1]
            : undefined
        const showStaleHint = m.role === 'assistant' && prev && staleHintFor.has(prev.id)
        const hasSiblingVariants = (liveByParent.get(m.parentId)?.length ?? 0) > 1
        return (
          <Message
            key={m.id}
            chatId={chatId}
            message={m}
            bodyVersion={bodyVersion}
            {...(hasSiblingVariants ? { branchContext } : {})}
            hasAnyReasoningDetails={m.generation?.error ? hasAnyReasoningDetails : false}
            hasConnection={hasConnection}
            presentationOnly={presentationOnly}
            allowPresentationStreamProjection={allowPresentationStreamProjection}
            onEditInPlace={handleEditInPlace}
            onToggleContextVisibility={handleToggleContextVisibility}
            onDismissGenerationNotice={handleDismissGenerationNotice}
            onMutateAttachmentRef={handleMutateAttachmentRef}
            onToggleReasoningDetailHidden={handleToggleReasoningHidden}
            onToggleProviderOutputItemHidden={handleToggleToolHidden}
            {...(m.role === 'user'
              ? {
                  onEditAndSend: handleEditAndSend,
                  ...(prefillSupported
                    ? {
                        showPrefillButton: true,
                        defaultPrefill: chatSettings.defaultPrefill ?? '',
                        prefillSettingsPrompt,
                      }
                    : {}),
                }
              : {})}
            {...(m.role === 'assistant'
              ? {
                  onRegenerate: handleRegenerate,
                  // Continue is offered on EVERY assistant — completed,
                  // aborted, or errored — so the user can extend any
                  // response in place. Original generation and reasoning
                  // metadata stay untouched.
                  onContinue: handleContinue,
                }
              : {})}
            onForkChat={handleForkChat}
            onInsert={openInsert}
            {...(capability ? { capability } : {})}
            {...(roleMismatchIdsOnPath.has(m.id) ? { roleMismatch: true } : {})}
            {...(showStaleHint ? { staleReplyHint: true } : {})}
            {...(excludedIds.has(m.id) ? { excludedFromContext: true } : {})}
            longMessageDisplayMode={longMessageDisplayMode}
          />
        )
      })}
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
            cursor={cursor}
            presentationWindowLimit={Math.max(
              1,
              branchSnapshot?.windowLimit ?? messageRenderWindowSize,
            )}
            defaultRole={insertTarget.defaultRole}
            onClose={() => setInsertTarget(null)}
            onDone={() => setInsertTarget(null)}
          />
        </Suspense>
      ) : null}
    </div>
  )
})

function useStableMessageRows(messages: readonly MessageRow[]): readonly MessageRow[] {
  const rowCacheRef = useRef(new Map<MessageId, { nodeVersion: number; message: MessageRow }>())
  const arrayCacheRef = useRef<readonly MessageRow[]>([])

  return useMemo(() => {
    const nextCache = new Map<MessageId, { nodeVersion: number; message: MessageRow }>()
    const nextRows = messages.map((message) => {
      const cached = rowCacheRef.current.get(message.id)
      if (cached && cached.nodeVersion === message.nodeVersion) {
        nextCache.set(message.id, cached)
        return cached.message
      }
      const next = { nodeVersion: message.nodeVersion, message }
      nextCache.set(message.id, next)
      return message
    })
    rowCacheRef.current = nextCache
    const prevRows = arrayCacheRef.current
    if (
      prevRows.length === nextRows.length &&
      prevRows.every((message, index) => message === nextRows[index])
    ) {
      return prevRows
    }
    arrayCacheRef.current = nextRows
    return nextRows
  }, [messages])
}

// Compute which messages would be trimmed out of the next request given
// the chat's context settings. Uses a chars/4 approximation — the real
// tokenizer machinery lives in core/prompt-size but this runs per render
// so cheap wins. Result drives the dashed-ring on profile glyphs.
//
// Algorithm:
// - System prompt tokens are taken off the budget up front.
// - The first `keepFirstPairs * 2` messages are pinned.
// - The walk goes backward from the end, accumulating, until the budget
//   overflows; everything untouched is "excluded".
type ContextEstimateRow = Pick<
  MessageHeaderRow,
  | 'id'
  | 'hiddenFromContext'
  | 'originalCharCount'
  | 'charCountDelta'
  | 'cachedTokenEstimate'
  | 'originalTokenEstimate'
>

function computeExcludedIds(
  path: readonly ContextEstimateRow[],
  hydratedById: ReadonlyMap<MessageId, MessageRow>,
  settings: ChatSettings,
  capability?: EffectiveCapability,
): Set<MessageId> {
  const out = new Set<MessageId>()
  if (path.length === 0) return out
  // Live provider cap beats stale defaults. Without capability, exclusion
  // can't be honestly computed, so the trim-cost side is skipped (only
  // hiddenFromContext messages are marked). The 128k fallback formerly
  // carried here produced false "excluded" rings on 1M-context Gemini
  // models whenever the chat grew past 128k.
  const providerCap = capability?.maxPromptTokens ?? capability?.contextLength
  const customMaxStored = settings.customMaxContext
  // `-1` means the user opted out of the local cap; no trim markers.
  if (customMaxStored === UNLIMITED_CONTEXT) {
    for (const m of path) if (m.hiddenFromContext) out.add(m.id)
    return out
  }
  const modelCap = customMaxStored ?? providerCap
  const maxCompletionStored = settings.maxCompletionTokens
  const maxCompletion =
    maxCompletionStored === UNLIMITED_CONTEXT ? 0 : (maxCompletionStored ?? 4096)
  const budget = modelCap !== undefined ? Math.max(0, modelCap - maxCompletion) : undefined
  const strategy = settings.contextStrategy
  const keepFirst = Math.max(0, (strategy.keepFirstPairs ?? 0) * 2)
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
    const hydrated = hydratedById.get(m.id)
    // Cold headers intentionally omit bodies. Do not hydrate an unestimated
    // legacy row or guess from its truncated preview just to draw a trim ring.
    if (!hydrated) return undefined
    let chars = 0
    for (const item of hydrated.content) {
      if (item.type === 'text' || item.type === 'output_text') chars += item.text.length
    }
    return Math.ceil(chars / 4)
  }
  // User-hidden messages are unconditionally excluded — they don't occupy
  // any budget either. Filter them out of the working set first.
  const eligible = path.filter((m) => !m.hiddenFromContext)
  for (const m of path) if (m.hiddenFromContext) out.add(m.id)
  // No budget means trim-based exclusion can't be computed, only the
  // hiddenFromContext set stays.
  if (budget === undefined) return out

  const sysTokens = Math.ceil(settings.systemPrompt.length / 4)
  let spent = sysTokens
  const kept = new Set<MessageId>()
  for (let i = 0; i < Math.min(keepFirst, eligible.length); i += 1) {
    const m = eligible[i]
    if (!m) continue
    const cost = tokensFor(m)
    if (cost === undefined) return out
    spent += cost
    kept.add(m.id)
  }
  for (let i = eligible.length - 1; i >= keepFirst; i -= 1) {
    const m = eligible[i]
    if (!m) continue
    const cost = tokensFor(m)
    if (cost === undefined) return out
    if (spent + cost > budget) break
    spent += cost
    kept.add(m.id)
  }
  for (const m of eligible) if (!kept.has(m.id)) out.add(m.id)
  return out
}
