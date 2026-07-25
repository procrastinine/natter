import { memo, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  type ConversationMutationSettlement,
  definePresentationInteraction,
} from '../../app/presentation-interactions'
import {
  createAppliedMessageView,
  projectAppliedMessageReasoningPresentation,
} from '../../core/continuation-content'
import {
  type GenerationCapability,
  generationCapabilityAvailable,
  generationCapabilityBlockedReason,
  pendingGenerationCapability,
} from '../../core/interaction-capability'
import { plaintextOf } from '../../core/message-content'
import { literalSearchHasMatchEndingAfter } from '../../core/search-query'
import type { Message, ProviderOutputMemberRef, ReasoningMemberRef } from '../../core/types'
import { useMessageStreamProjection } from '../../hooks/useMessageStreamProjection'
import { usePresentationInteraction } from '../../hooks/usePresentationInteraction'
import type {
  GenerationStartResult,
  MessageAttachmentRefMutation,
  WorkspaceFence,
} from '../../store/presentation-contracts'
import { AttachmentRefChips } from '../attachments/AttachmentRefChips'
import {
  BranchIcon,
  ChevronIcon,
  CloseIcon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  InfoIcon,
  PencilIcon,
  ReloadIcon,
  SendIcon,
  TrashIcon,
} from '../icons/Icon'
import { Button } from '../primitives/Button'
import type { BranchTreeInspectorSearchTools as InspectorSearchTools } from './BranchTreeInspectorSearch'
import { InlineEditor } from './InlineEditor'
import { MessageContent, messageTextSegmentsFromContent } from './MessageContent'
import { MessageInfo } from './MessageInfo'
import { ReasoningBlock } from './ReasoningBlock'
import { ToolEvidenceBlock } from './ToolEvidenceBlock'

const DEFAULT_MARKDOWN_CHAR_LIMIT = 100_000

const branchInspectorSearchInteraction = definePresentationInteraction<string>({
  id: 'branch-inspector.search-tools',
  label: 'Message search',
  concurrency: 'replace',
  lifetime: 'presenter',
})

export interface BranchTreeInspectorProps {
  message: Message
  presentationFence: WorkspaceFence
  bodyVersion: number
  bodyReady?: boolean
  onClose: () => void
  onActivate?: () => void
  onEdit?: (message: Message, text: string) => ConversationMutationSettlement
  onEditAndSend?: (message: Message, text: string) => GenerationStartResult
  onDelete?: () => ConversationMutationSettlement
  onRegenerate?: () => GenerationStartResult
  onContinue?: () => GenerationStartResult
  onForkChat?: () => ConversationMutationSettlement
  onToggleContextVisibility?: () => ConversationMutationSettlement
  onMutateAttachmentRef?: (mutation: MessageAttachmentRefMutation) => void | Promise<void>
  onToggleReasoningDetailHidden?: (member: ReasoningMemberRef) => ConversationMutationSettlement
  onToggleProviderOutputItemHidden?: (
    member: ProviderOutputMemberRef,
  ) => ConversationMutationSettlement
  editResendCapability?: GenerationCapability
  regenerateCapability?: GenerationCapability
  continueCapability?: GenerationCapability
  streamOnActivePath?: boolean
  searchQuery?: string
  searchMatched?: boolean
}

interface TextProjection {
  prefix: string
  totalChars: number
}

type BranchTreeInspectorComputation = 'render' | 'bounded-projection' | 'search-scan'
type BranchTreeInspectorComputationProbe = (operation: BranchTreeInspectorComputation) => void
let branchTreeInspectorComputationProbe: BranchTreeInspectorComputationProbe | undefined

export function observeBranchTreeInspectorComputations(
  observer: BranchTreeInspectorComputationProbe | undefined,
): void {
  branchTreeInspectorComputationProbe = observer
}

const StaticToolEvidenceBlock = memo(ToolEvidenceBlock)
const StaticAttachmentRefChips = memo(AttachmentRefChips)

function projectText(segments: readonly string[]): TextProjection {
  branchTreeInspectorComputationProbe?.('bounded-projection')
  const prefixParts: string[] = []
  let prefixChars = 0
  let totalChars = 0
  for (const segment of segments) {
    totalChars += segment.length
    if (prefixChars >= DEFAULT_MARKDOWN_CHAR_LIMIT) continue
    const retained = segment.slice(0, DEFAULT_MARKDOWN_CHAR_LIMIT - prefixChars)
    prefixParts.push(retained)
    prefixChars += retained.length
  }
  return { prefix: prefixParts.join(''), totalChars }
}

function textLengthOf(segments: readonly string[]): number {
  let length = 0
  for (const segment of segments) length += segment.length
  return length
}

const BranchTreeInspectorComponent = memo(function BranchTreeInspector({
  message,
  presentationFence,
  bodyVersion,
  bodyReady = true,
  onClose,
  onActivate,
  onEdit,
  onEditAndSend,
  onDelete,
  onRegenerate,
  onContinue,
  onForkChat,
  onToggleContextVisibility,
  onMutateAttachmentRef,
  onToggleReasoningDetailHidden,
  onToggleProviderOutputItemHidden,
  editResendCapability = pendingGenerationCapability('prompt-path'),
  regenerateCapability = pendingGenerationCapability('prompt-path'),
  continueCapability = pendingGenerationCapability('prompt-path'),
  streamOnActivePath = true,
  searchQuery,
  searchMatched = false,
}: BranchTreeInspectorProps) {
  branchTreeInspectorComputationProbe?.('render')
  const editResendAvailable = generationCapabilityAvailable(editResendCapability)
  const regenerateAvailable = generationCapabilityAvailable(regenerateCapability)
  const continueAvailable = generationCapabilityAvailable(continueCapability)
  const editResendBlockedReason = generationCapabilityBlockedReason(
    editResendCapability,
    'edit-resend',
  )
  const regenerateBlockedReason = generationCapabilityBlockedReason(
    regenerateCapability,
    'regenerate',
  )
  const continueBlockedReason = generationCapabilityBlockedReason(continueCapability, 'continue')
  const [fullMessageId, setFullMessageId] = useState<string | null>(null)
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [showInfo, setShowInfo] = useState(false)
  const [occurrenceCount, setOccurrenceCount] = useState(0)
  const [totalOccurrenceCount, setTotalOccurrenceCount] = useState(0)
  const [currentOccurrence, setCurrentOccurrence] = useState(-1)
  const appliedView = useMemo(() => createAppliedMessageView(message), [message])
  const searchToolsInteraction = usePresentationInteraction(branchInspectorSearchInteraction)
  const runSearchToolsInteraction = searchToolsInteraction.run
  const streamProjection = useMessageStreamProjection(
    message,
    presentationFence,
    message.role === 'assistant',
  )
  const activeAttempt = streamProjection.execution
  const availability = activeAttempt?.availability
  const liveSnapshot = streamProjection.liveProjection
  const presentationPending =
    streamProjection.presentation !== undefined ||
    (activeAttempt === undefined && liveSnapshot !== undefined)
  const streamTargetBusy = availability?.blocksReplacement === true
  const activeStreamingPresentation =
    availability !== undefined && availability.presentation !== 'none'
  const liveRendering =
    activeStreamingPresentation || liveSnapshot !== undefined || presentationPending
  const requestBusy = !bodyReady || streamTargetBusy
  const liveReasoning = liveSnapshot?.reasoning
  const finalError = appliedView.latestAttempt.metadata?.error
  const finalAbort = appliedView.latestAttempt.metadata?.abortReason
  const streamStatus: { text: string; tone?: 'warning' | 'error' } | null =
    availability?.presentation === 'remote-streaming'
      ? { text: 'This response is currently streaming in another tab.' }
      : activeStreamingPresentation && !streamOnActivePath
        ? { text: 'Streaming on another branch. Open this branch to follow live output.' }
        : activeStreamingPresentation
          ? liveSnapshot
            ? { text: 'Streaming response…' }
            : { text: 'Waiting for response…' }
          : availability?.state === 'provisional' || availability?.state === 'reconciling'
            ? { text: 'Checking response state…' }
            : streamTargetBusy
              ? { text: 'Waiting for response…' }
              : presentationPending
                ? { text: 'Finishing response…' }
                : finalError
                  ? {
                      text: `Error${finalError.statusCode ? ` ${finalError.statusCode}` : ''}: ${finalError.message}`,
                      tone: 'error',
                    }
                  : finalAbort === 'user'
                    ? {
                        text: 'Cancelled — partial response kept above. Continue to resume.',
                        tone: 'warning',
                      }
                    : finalAbort
                      ? { text: `Stream interrupted (${finalAbort}).`, tone: 'warning' }
                      : null
  const contentRef = useRef<HTMLElement | null>(null)
  const searchRangesRef = useRef<Range[]>([])
  const searchToolsRef = useRef<InspectorSearchTools | null>(null)
  const currentOccurrenceRef = useRef(-1)
  const idPrefix = useId()
  const renderedContent = liveSnapshot?.content ?? message.content
  const textSegments = useMemo(
    () => messageTextSegmentsFromContent(renderedContent),
    [renderedContent],
  )
  const boundedProjection = useMemo(
    () => (liveRendering ? undefined : projectText(textSegments)),
    [liveRendering, textSegments],
  )
  const totalChars = liveRendering
    ? (liveSnapshot?.textLength ?? textLengthOf(textSegments))
    : (boundedProjection?.totalChars ?? 0)
  const truncated = !liveRendering && totalChars > DEFAULT_MARKDOWN_CHAR_LIMIT
  const showingFull = truncated && fullMessageId === message.id
  const normalizedSearchQuery = searchQuery?.trim() ?? ''
  const editing = editingMessageId === message.id
  const renderedText = useMemo(
    () =>
      liveRendering ? '' : showingFull ? textSegments.join('') : (boundedProjection?.prefix ?? ''),
    [boundedProjection?.prefix, liveRendering, showingFull, textSegments],
  )
  const matchBeyondPrefix = useMemo(
    () =>
      truncated &&
      !showingFull &&
      normalizedSearchQuery.length > 0 &&
      literalSearchHasMatchEndingAfter(
        textSegments,
        normalizedSearchQuery,
        DEFAULT_MARKDOWN_CHAR_LIMIT,
      ),
    [normalizedSearchQuery, showingFull, textSegments, truncated],
  )
  const reasoningPresentation = useMemo(
    () =>
      liveReasoning
        ? projectAppliedMessageReasoningPresentation(appliedView, {
            attemptKind: liveSnapshot.attemptKind,
            streamId: liveSnapshot.streamId,
            projection: liveReasoning,
          })
        : projectAppliedMessageReasoningPresentation(appliedView),
    [appliedView, liveReasoning, liveSnapshot?.attemptKind, liveSnapshot?.streamId],
  )
  const infoMessage = useMemo<Message>(() => {
    if (!showInfo || !liveSnapshot) return message
    return {
      ...message,
      content: [...renderedContent],
      ...(liveSnapshot.generation
        ? {
            generation: message.generation
              ? { ...message.generation, ...liveSnapshot.generation }
              : liveSnapshot.generation,
          }
        : {}),
    }
  }, [liveSnapshot, message, renderedContent, showInfo])
  const titleId = `${idPrefix}-title`
  const contentId = `${idPrefix}-content-title`
  const detailsId = `${idPrefix}-details-title`
  currentOccurrenceRef.current = currentOccurrence

  useLayoutEffect(() => {
    searchToolsRef.current?.clearSearchHighlights()
    searchRangesRef.current = []
    if (
      editing ||
      liveRendering ||
      normalizedSearchQuery.length === 0 ||
      renderedText.length === 0 ||
      !contentRef.current ||
      contentRef.current.closest('[data-message-id]')?.getAttribute('data-message-id') !==
        message.id
    ) {
      setOccurrenceCount(0)
      setTotalOccurrenceCount(0)
      setCurrentOccurrence(-1)
      return () => searchToolsRef.current?.clearSearchHighlights()
    }
    setOccurrenceCount(0)
    setTotalOccurrenceCount(0)
    setCurrentOccurrence(-1)
    let disposed = false
    let scheduledFrame: number | null = null
    let scheduledMicrotask = false
    let observer: MutationObserver | null = null
    const refreshRanges = (resetCurrent: boolean) => {
      const tools = searchToolsRef.current
      if (disposed || !contentRef.current || !tools) return
      branchTreeInspectorComputationProbe?.('search-scan')
      const { ranges, totalCount } = tools.renderedSearchRanges(
        contentRef.current,
        normalizedSearchQuery,
      )
      const nextCurrent =
        ranges.length === 0
          ? -1
          : resetCurrent
            ? 0
            : Math.min(Math.max(currentOccurrenceRef.current, 0), ranges.length - 1)
      searchRangesRef.current = ranges
      currentOccurrenceRef.current = nextCurrent
      setOccurrenceCount(ranges.length)
      setTotalOccurrenceCount(totalCount)
      setCurrentOccurrence(nextCurrent)
      tools.paintSearchHighlights(ranges, nextCurrent)
      tools.scrollSearchRangeIntoView(ranges[nextCurrent])
    }
    const scheduleRangeRefresh = () => {
      if (scheduledFrame !== null || scheduledMicrotask) return
      if (typeof requestAnimationFrame === 'function') {
        scheduledFrame = requestAnimationFrame(() => {
          scheduledFrame = null
          refreshRanges(false)
        })
        return
      }
      scheduledMicrotask = true
      queueMicrotask(() => {
        scheduledMicrotask = false
        refreshRanges(false)
      })
    }
    const claim = runSearchToolsInteraction({
      target: message.id,
      action: () => import('./BranchTreeInspectorSearch'),
      commit: (tools) => {
        if (disposed || !contentRef.current) return
        searchToolsRef.current = tools
        tools.installSearchHighlightStyles()
        refreshRanges(true)
        const markdown = contentRef.current.querySelector('[data-ui="markdown"]')
        observer = markdown ? new MutationObserver(scheduleRangeRefresh) : null
        observer?.observe(markdown as Node, {
          childList: true,
          characterData: true,
          subtree: true,
        })
      },
    })
    return () => {
      disposed = true
      claim.releasePresenter()
      observer?.disconnect()
      if (scheduledFrame !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(scheduledFrame)
      }
      searchRangesRef.current = []
      searchToolsRef.current?.clearSearchHighlights()
    }
  }, [
    editing,
    message.id,
    normalizedSearchQuery,
    renderedText,
    runSearchToolsInteraction,
    liveRendering,
  ])

  const goToOccurrence = (direction: -1 | 1) => {
    if (occurrenceCount === 0) return
    const next = (currentOccurrence + direction + occurrenceCount) % occurrenceCount
    currentOccurrenceRef.current = next
    setCurrentOccurrence(next)
    searchToolsRef.current?.paintSearchHighlights(searchRangesRef.current, next)
    searchToolsRef.current?.scrollSearchRangeIntoView(searchRangesRef.current[next])
  }

  const searchHighlightLimited = totalOccurrenceCount > occurrenceCount

  const copyMessage = () =>
    navigator.clipboard.writeText(plaintextOf(renderedContent)).catch(() => undefined)

  const saveEditAndSend = onEditAndSend
    ? (text: string): GenerationStartResult => onEditAndSend(message, text)
    : undefined

  return (
    <aside
      data-ui="branch-tree-inspector"
      data-body-ready={bodyReady}
      data-body-version={bodyVersion}
      data-role={message.role}
      data-message-id={message.id}
      data-text-overflow={truncated ? (showingFull ? 'full' : 'prefix') : 'complete'}
      aria-labelledby={titleId}
    >
      <header data-ui="branch-tree-inspector-header">
        <div data-ui="branch-tree-inspector-heading">
          <h2 id={titleId}>
            {message.role.charAt(0).toUpperCase() + message.role.slice(1)} message
          </h2>
          <code data-ui="branch-tree-inspector-message-id">{message.id}</code>
          <span data-ui="branch-tree-inspector-char-count">
            {totalChars.toLocaleString()} text characters
          </span>
        </div>
        <Button
          type="button"
          data-ui="branch-tree-inspector-close"
          aria-label="Close message inspector"
          title="Close message inspector"
          onClick={onClose}
        >
          <CloseIcon size={16} />
        </Button>
        <div data-ui="branch-tree-inspector-actions">
          {onActivate ? (
            <Button
              type="button"
              data-ui="branch-tree-inspector-activate"
              data-tone="accent"
              aria-label="Open this branch"
              onClick={onActivate}
            >
              Open branch
            </Button>
          ) : null}
          <Button
            type="button"
            data-ui="branch-tree-inspector-action"
            data-action="copy"
            aria-label="Copy message"
            title="Copy message text"
            onClick={() => void copyMessage()}
          >
            <CopyIcon size={15} />
          </Button>
          {onEdit ? (
            <Button
              type="button"
              data-ui="branch-tree-inspector-action"
              data-action="edit"
              aria-label="Edit message"
              title="Edit message in place"
              aria-pressed={editing}
              disabled={!bodyReady || editing || streamTargetBusy}
              onClick={() => {
                setEditingMessageId(message.id)
              }}
            >
              <PencilIcon size={15} />
            </Button>
          ) : null}
          {message.role === 'assistant' && onRegenerate ? (
            <Button
              type="button"
              data-ui="branch-tree-inspector-action"
              data-action="regenerate"
              aria-label="Regenerate response"
              title={
                !bodyReady
                  ? 'Refreshing message details…'
                  : regenerateBlockedReason
                    ? regenerateBlockedReason
                    : streamTargetBusy
                      ? "Can't regenerate while this message is streaming."
                      : regenerateCapability.state === 'pending'
                        ? undefined
                        : 'Regenerate response'
              }
              disabled={!regenerateAvailable || requestBusy}
              onClick={() => {
                onRegenerate()
              }}
            >
              <ReloadIcon size={15} />
            </Button>
          ) : null}
          {message.role === 'assistant' && onContinue ? (
            <Button
              type="button"
              data-ui="branch-tree-inspector-action"
              data-action="continue"
              aria-label="Continue from here"
              title={
                !bodyReady
                  ? 'Refreshing message details…'
                  : streamTargetBusy
                    ? "Can't continue while streaming."
                    : (continueBlockedReason ??
                      (continueCapability.state === 'pending'
                        ? undefined
                        : 'Continue this assistant message'))
              }
              disabled={!continueAvailable || requestBusy}
              onClick={() => {
                onContinue()
              }}
            >
              <SendIcon size={15} />
            </Button>
          ) : null}
          {onForkChat ? (
            <Button
              type="button"
              data-ui="branch-tree-inspector-action"
              data-action="fork-chat"
              aria-label="Branch this chat from here"
              title="Branch this chat from here — opens in a new chat"
              onClick={() => void onForkChat()}
            >
              <BranchIcon size={15} />
            </Button>
          ) : null}
          {onToggleContextVisibility ? (
            <Button
              type="button"
              data-ui="branch-tree-inspector-action"
              data-action="toggle-visible"
              aria-pressed={Boolean(message.hiddenFromContext)}
              aria-label={
                message.hiddenFromContext
                  ? 'Show in context (send to model)'
                  : 'Hide from context (never send to model)'
              }
              title={
                message.hiddenFromContext
                  ? 'Hidden from context — click to include again'
                  : 'Hide from context — keep visible here but never send to the model'
              }
              onClick={() => void onToggleContextVisibility()}
            >
              {message.hiddenFromContext ? <EyeOffIcon size={15} /> : <EyeIcon size={15} />}
            </Button>
          ) : null}
          {onDelete ? (
            <Button
              type="button"
              data-ui="branch-tree-inspector-action"
              data-action="delete"
              data-variant="danger"
              aria-label="Delete message"
              title="Delete message"
              disabled={streamTargetBusy}
              onClick={() => void onDelete()}
            >
              <TrashIcon size={15} />
            </Button>
          ) : null}
          <Button
            type="button"
            data-ui="branch-tree-inspector-action"
            data-action="info"
            aria-expanded={showInfo}
            aria-label={showInfo ? 'Hide message info' : 'Show message info'}
            title={showInfo ? 'Hide info' : 'Info'}
            onClick={() => setShowInfo((visible) => !visible)}
          >
            <InfoIcon size={15} />
          </Button>
        </div>
      </header>

      {streamStatus ? (
        <div
          role="status"
          data-ui="branch-tree-inspector-stream-status"
          data-state={streamStatus.tone}
        >
          {streamStatus.text}
        </div>
      ) : null}

      <div data-ui="branch-tree-inspector-scroll">
        <section
          ref={contentRef}
          data-ui="branch-tree-inspector-content"
          aria-labelledby={contentId}
        >
          <h3 id={contentId}>Message content</h3>
          {!editing && normalizedSearchQuery.length > 0 ? (
            <>
              <div data-ui="branch-tree-inspector-search">
                <span data-ui="branch-tree-inspector-search-query" title={normalizedSearchQuery}>
                  Matches for “{normalizedSearchQuery}”
                </span>
                <output aria-live="polite" data-ui="branch-tree-inspector-search-status">
                  {(occurrenceCount > 0 ? currentOccurrence + 1 : 0).toLocaleString()} /{' '}
                  {occurrenceCount.toLocaleString()}
                  {searchHighlightLimited ? '+' : ''}
                </output>
                <Button
                  type="button"
                  aria-label="Previous occurrence in message"
                  data-ui="branch-tree-inspector-search-nav"
                  disabled={occurrenceCount === 0}
                  onClick={() => goToOccurrence(-1)}
                >
                  <ChevronIcon size={14} rotate={180} />
                </Button>
                <Button
                  type="button"
                  aria-label="Next occurrence in message"
                  data-ui="branch-tree-inspector-search-nav"
                  disabled={occurrenceCount === 0}
                  onClick={() => goToOccurrence(1)}
                >
                  <ChevronIcon size={14} />
                </Button>
              </div>
              {liveRendering ? (
                <span data-ui="branch-tree-inspector-search-overflow">
                  Search highlighting resumes when this response finishes streaming.
                </span>
              ) : null}
              {searchHighlightLimited ? (
                <span data-ui="branch-tree-inspector-search-overflow">
                  First {occurrenceCount.toLocaleString()} of{' '}
                  {totalOccurrenceCount.toLocaleString()} occurrences highlighted. Refine the search
                  to navigate the rest.
                </span>
              ) : null}
              {searchMatched && !liveRendering && occurrenceCount === 0 && !matchBeyondPrefix ? (
                <span data-ui="branch-tree-inspector-search-overflow">
                  This match is in Markdown source or other non-rendered text, so there is no
                  visible occurrence to highlight.
                </span>
              ) : null}
            </>
          ) : null}
          {!editing && truncated ? (
            <div
              data-ui="branch-tree-inspector-overflow"
              data-state={showingFull ? 'full' : 'prefix'}
            >
              <span>
                {showingFull
                  ? `Showing all ${totalChars.toLocaleString()} text characters.`
                  : `Showing the first ${DEFAULT_MARKDOWN_CHAR_LIMIT.toLocaleString()} of ${totalChars.toLocaleString()} text characters.`}
                {matchBeyondPrefix ? (
                  <span data-ui="branch-tree-inspector-search-overflow">
                    At least one search match is beyond this bounded preview. Show the full message
                    to inspect every occurrence.
                  </span>
                ) : null}
              </span>
              <Button
                type="button"
                data-ui="branch-tree-inspector-overflow-toggle"
                onClick={() => setFullMessageId(showingFull ? null : message.id)}
              >
                {showingFull ? 'Show bounded preview' : 'Show full message'}
              </Button>
            </div>
          ) : null}
          {editing && onEdit ? (
            <InlineEditor
              key={message.id}
              initial={plaintextOf(message.content)}
              onSave={(text) => onEdit(message, text)}
              onCancel={() => setEditingMessageId(null)}
              saveDisabled={!bodyReady || streamTargetBusy}
              attachmentsEnabled={false}
              {...(message.role === 'user' && saveEditAndSend
                ? {
                    onSaveAndSend: saveEditAndSend,
                    saveAndSendDisabled: !editResendAvailable || requestBusy,
                    ...(editResendBlockedReason
                      ? {
                          saveAndSendDisabledReason: editResendBlockedReason,
                        }
                      : requestBusy
                        ? {
                            saveAndSendDisabledReason:
                              'Wait for this generation to finish before sending again.',
                          }
                        : {}),
                  }
                : {})}
              ariaLabel={`Edit ${message.role} message`}
            />
          ) : (
            <>
              {reasoningPresentation.hasReasoning ? (
                <ReasoningBlock
                  presentation={reasoningPresentation}
                  streaming={liveRendering}
                  hasContent={totalChars > 0}
                  deferContentUntilOpen
                  toggleHiddenDisabled={!bodyReady || streamTargetBusy || Boolean(liveReasoning)}
                  {...(onToggleReasoningDetailHidden
                    ? {
                        onToggleHidden: onToggleReasoningDetailHidden,
                      }
                    : {})}
                />
              ) : null}
              <StaticToolEvidenceBlock
                message={message}
                appliedView={appliedView}
                toggleHiddenDisabled={!bodyReady || streamTargetBusy}
                {...(onToggleProviderOutputItemHidden
                  ? {
                      onToggleHidden: onToggleProviderOutputItemHidden,
                    }
                  : {})}
              />
              <MessageContent
                content={renderedContent}
                text={liveRendering ? '' : renderedText}
                textSegments={liveRendering ? textSegments : undefined}
                streaming={liveRendering}
                renderRevision={bodyVersion}
                messageId={message.id}
                attachmentRefs={message.attachmentRefs}
                {...(onMutateAttachmentRef ? { onMutateAttachmentRef } : {})}
              />
              <StaticAttachmentRefChips
                refs={message.attachmentRefs}
                messageId={message.id}
                {...(onMutateAttachmentRef ? { onMutateMessageRef: onMutateAttachmentRef } : {})}
              />
            </>
          )}
        </section>

        {showInfo ? (
          <section data-ui="branch-tree-inspector-details" aria-labelledby={detailsId}>
            <h3 id={detailsId}>Message details</h3>
            <MessageInfo
              message={infoMessage}
              appliedView={appliedView}
              reasoningPresentation={reasoningPresentation}
            />
          </section>
        ) : null}
      </div>
    </aside>
  )
})

export const BranchTreeInspector = BranchTreeInspectorComponent
