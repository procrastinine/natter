import { memo, useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Message, MessageRole } from '../../core/types'
import { useRetainedMessageStreamProjection } from '../../hooks/useMessageStreamProjection'
import { getStreamClientId } from '../../store/stream-leases'
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
import type { BranchTreeInspectorSearchTools as InspectorSearchTools } from './BranchTreeInspectorSearch'
import { InlineEditor, plaintextOf } from './InlineEditor'
import { MessageContent, messageTextSegmentsFromContent } from './MessageContent'
import { MessageInfo } from './MessageInfo'
import { ReasoningBlock } from './ReasoningBlock'
import { ToolEvidenceBlock } from './ToolEvidenceBlock'

const DEFAULT_MARKDOWN_CHAR_LIMIT = 100_000
const SEARCH_SCAN_CHUNK_CHARS = 64 * 1024

export interface BranchTreeInspectorProps {
  message: Message
  onClose: () => void
  onActivate?: () => void
  onEdit?: (message: Message, text: string) => void | Promise<void>
  onEditAndSend?: (message: Message, text: string) => void | Promise<void>
  onDelete?: () => void | Promise<void>
  onRegenerate?: () => void | Promise<void>
  onContinue?: () => void | Promise<void>
  onForkChat?: () => void | Promise<void>
  onToggleContextVisibility?: () => void | Promise<void>
  onToggleReasoningDetailHidden?: (detailIndex: number) => void | Promise<void>
  onToggleProviderOutputItemHidden?: (itemIndex: number) => void | Promise<void>
  hasConnection?: boolean
  generationBusy?: boolean
  streamOnActivePath?: boolean
  searchQuery?: string
  searchMatched?: boolean
}

interface TextProjection {
  prefix: string
  totalChars: number
}

function roleLabel(role: MessageRole): string {
  return role.charAt(0).toLocaleUpperCase() + role.slice(1)
}

type BranchTreeInspectorComputation = 'render' | 'bounded-projection' | 'search-scan'
type BranchTreeInspectorComputationProbe = (operation: BranchTreeInspectorComputation) => void
let branchTreeInspectorComputationProbe: BranchTreeInspectorComputationProbe | undefined

function setBranchTreeInspectorComputationProbeForTests(
  probe: BranchTreeInspectorComputationProbe | undefined,
): void {
  if (import.meta.env.MODE === 'test') branchTreeInspectorComputationProbe = probe
}

const StaticToolEvidenceBlock = memo(ToolEvidenceBlock)
const StaticAttachmentRefChips = memo(AttachmentRefChips)

function projectText(segments: readonly string[]): TextProjection {
  if (import.meta.env.MODE === 'test') {
    branchTreeInspectorComputationProbe?.('bounded-projection')
  }
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

function hasMatchBeyondPrefix(
  segments: readonly string[],
  query: string,
  prefixChars: number,
): boolean {
  const needle = query.toLocaleLowerCase()
  if (needle.length === 0) return false
  const retainedLength = needle.length - 1
  let trailing = ''
  let processedChars = 0

  for (const segment of segments) {
    for (let offset = 0; offset < segment.length; offset += SEARCH_SCAN_CHUNK_CHARS) {
      const lowered = segment.slice(offset, offset + SEARCH_SCAN_CHUNK_CHARS).toLocaleLowerCase()
      const searchable = `${trailing}${lowered}`
      const searchableStart = processedChars - trailing.length
      let matchIndex = searchable.indexOf(needle)
      while (matchIndex >= 0) {
        if (searchableStart + matchIndex + needle.length > prefixChars) return true
        matchIndex = searchable.indexOf(needle, matchIndex + Math.max(1, needle.length))
      }
      processedChars += lowered.length
      if (retainedLength > 0) {
        trailing = searchable.slice(-retainedLength)
      }
    }
  }
  return false
}

const BranchTreeInspectorComponent = memo(function BranchTreeInspector({
  message,
  onClose,
  onActivate,
  onEdit,
  onEditAndSend,
  onDelete,
  onRegenerate,
  onContinue,
  onForkChat,
  onToggleContextVisibility,
  onToggleReasoningDetailHidden,
  onToggleProviderOutputItemHidden,
  hasConnection = false,
  generationBusy = false,
  streamOnActivePath = true,
  searchQuery,
  searchMatched = false,
}: BranchTreeInspectorProps) {
  if (import.meta.env.MODE === 'test') branchTreeInspectorComputationProbe?.('render')
  const [fullMessageId, setFullMessageId] = useState<string | null>(null)
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [editError, setEditError] = useState<{ messageId: string; text: string } | null>(null)
  const [showInfo, setShowInfo] = useState(false)
  const [occurrenceCount, setOccurrenceCount] = useState(0)
  const [totalOccurrenceCount, setTotalOccurrenceCount] = useState(0)
  const [currentOccurrence, setCurrentOccurrence] = useState(-1)
  const [activeStream, liveSnapshot] = useRetainedMessageStreamProjection(
    message,
    message.role === 'assistant',
  )
  const persistedStreamBusy =
    message.generation?.status === 'streaming' && message.generation.finishedAt === undefined
  const streamTargetBusy =
    activeStream !== undefined || persistedStreamBusy || liveSnapshot !== undefined
  const requestBusy = generationBusy || streamTargetBusy
  const remoteStreaming =
    activeStream !== undefined && activeStream.ownerClientId !== getStreamClientId()
  const liveReasoningRows = liveSnapshot?.reasoningRows
  const showOriginalFailure = !message.continuationAttempts?.some(
    (attempt) => attempt.status === 'done' && attempt.unappliedText === undefined,
  )
  const finalError = showOriginalFailure ? message.generation?.error : undefined
  const finalAbort = showOriginalFailure ? message.generation?.abortReason : undefined
  const streamStatus: { text: string; tone?: 'warning' | 'error' } | null = remoteStreaming
    ? { text: 'This response is currently streaming in another tab.' }
    : activeStream && !streamOnActivePath
      ? { text: 'Streaming on another branch. Open this branch to follow live output.' }
      : activeStream
        ? liveSnapshot
          ? { text: 'Streaming response…' }
          : { text: 'Waiting for response…' }
        : persistedStreamBusy
          ? liveSnapshot || !generationBusy
            ? { text: 'Finishing response…' }
            : { text: 'Preparing response…' }
          : liveSnapshot
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
    () => (streamTargetBusy ? undefined : projectText(textSegments)),
    [streamTargetBusy, textSegments],
  )
  const totalChars = streamTargetBusy
    ? (liveSnapshot?.textLength ?? textLengthOf(textSegments))
    : (boundedProjection?.totalChars ?? 0)
  const truncated = !streamTargetBusy && totalChars > DEFAULT_MARKDOWN_CHAR_LIMIT
  const showingFull = truncated && fullMessageId === message.id
  const normalizedSearchQuery = searchQuery?.trim() ?? ''
  const editing = editingMessageId === message.id
  const renderedText = useMemo(
    () =>
      streamTargetBusy
        ? ''
        : showingFull
          ? textSegments.join('')
          : (boundedProjection?.prefix ?? ''),
    [boundedProjection?.prefix, showingFull, streamTargetBusy, textSegments],
  )
  const matchBeyondPrefix = useMemo(
    () =>
      truncated &&
      !showingFull &&
      normalizedSearchQuery.length > 0 &&
      hasMatchBeyondPrefix(textSegments, normalizedSearchQuery, DEFAULT_MARKDOWN_CHAR_LIMIT),
    [normalizedSearchQuery, showingFull, textSegments, truncated],
  )
  const liveReasoningDetails = useMemo(
    () => liveReasoningRows?.map((row) => row.detail),
    [liveReasoningRows],
  )
  const renderedReasoningDetails = liveReasoningDetails ?? message.reasoningDetails
  const infoMessage = useMemo<Message>(() => {
    if (!showInfo || !liveSnapshot) return message
    return {
      ...message,
      content: renderedContent,
      ...(liveReasoningDetails ? { reasoningDetails: liveReasoningDetails } : {}),
      ...(liveSnapshot.generation
        ? {
            generation: message.generation
              ? { ...message.generation, ...liveSnapshot.generation }
              : liveSnapshot.generation,
          }
        : {}),
    }
  }, [liveReasoningDetails, liveSnapshot, message, renderedContent, showInfo])
  const toggleReasoningDetailHidden = useCallback(
    (detailIndex: number) => {
      void onToggleReasoningDetailHidden?.(detailIndex)
    },
    [onToggleReasoningDetailHidden],
  )
  const toggleProviderOutputItemHidden = useCallback(
    (itemIndex: number) => {
      void onToggleProviderOutputItemHidden?.(itemIndex)
    },
    [onToggleProviderOutputItemHidden],
  )
  const titleId = `${idPrefix}-title`
  const contentId = `${idPrefix}-content-title`
  const detailsId = `${idPrefix}-details-title`
  currentOccurrenceRef.current = currentOccurrence

  useLayoutEffect(() => {
    searchToolsRef.current?.clearSearchHighlights()
    searchRangesRef.current = []
    if (
      editing ||
      streamTargetBusy ||
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
      if (import.meta.env.MODE === 'test') branchTreeInspectorComputationProbe?.('search-scan')
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
    void import('./BranchTreeInspectorSearch').then((tools) => {
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
    })
    return () => {
      disposed = true
      observer?.disconnect()
      if (scheduledFrame !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(scheduledFrame)
      }
      searchRangesRef.current = []
      searchToolsRef.current?.clearSearchHighlights()
    }
  }, [editing, message.id, normalizedSearchQuery, renderedText, streamTargetBusy])

  const goToOccurrence = (direction: -1 | 1) => {
    if (occurrenceCount === 0) return
    const next = (currentOccurrence + direction + occurrenceCount) % occurrenceCount
    currentOccurrenceRef.current = next
    setCurrentOccurrence(next)
    searchToolsRef.current?.paintSearchHighlights(searchRangesRef.current, next)
    searchToolsRef.current?.scrollSearchRangeIntoView(searchRangesRef.current[next])
  }

  const searchHighlightLimited = totalOccurrenceCount > occurrenceCount

  const copyMessage = async () => {
    try {
      await navigator.clipboard.writeText(plaintextOf(renderedContent))
    } catch {
      return
    }
  }

  const submitEdit = async (
    text: string,
    action: ((message: Message, text: string) => void | Promise<void>) | undefined,
    busyMessage: string,
    fallbackMessage: string,
  ) => {
    if (!action) return
    if (streamTargetBusy) {
      setEditError({ messageId: message.id, text: busyMessage })
      return
    }
    try {
      await action(message, text)
      setEditingMessageId((current) => (current === message.id ? null : current))
      setEditError(null)
    } catch (error) {
      setEditError({
        messageId: message.id,
        text: error instanceof Error ? error.message : fallbackMessage,
      })
    }
  }

  const saveEdit = (text: string) =>
    submitEdit(
      text,
      onEdit,
      'Wait for this generation to finish before editing it.',
      'Unable to save this edit.',
    )
  const saveEditAndSend = (text: string) =>
    requestBusy
      ? setEditError({
          messageId: message.id,
          text: 'Wait for the current generation to finish before sending again.',
        })
      : submitEdit(
          text,
          onEditAndSend,
          'Wait for the current generation to finish before sending again.',
          'Unable to send this edit.',
        )

  return (
    <aside
      data-ui="branch-tree-inspector"
      data-role={message.role}
      data-message-id={message.id}
      data-text-overflow={truncated ? (showingFull ? 'full' : 'prefix') : 'complete'}
      aria-labelledby={titleId}
    >
      <header data-ui="branch-tree-inspector-header">
        <div data-ui="branch-tree-inspector-heading">
          <h2 id={titleId}>{roleLabel(message.role)} message</h2>
          <code data-ui="branch-tree-inspector-message-id">{message.id}</code>
          <span data-ui="branch-tree-inspector-char-count">
            {totalChars.toLocaleString()} text characters
          </span>
        </div>
        <button
          type="button"
          data-ui="branch-tree-inspector-close"
          aria-label="Close message inspector"
          title="Close message inspector"
          onClick={onClose}
        >
          <CloseIcon size={16} />
        </button>
        <div data-ui="branch-tree-inspector-actions">
          {onActivate ? (
            <button
              type="button"
              data-ui="branch-tree-inspector-activate"
              data-tone="accent"
              aria-label="Open this branch"
              onClick={onActivate}
            >
              Open branch
            </button>
          ) : null}
          <button
            type="button"
            data-ui="branch-tree-inspector-action"
            data-action="copy"
            aria-label="Copy message"
            title="Copy message text"
            onClick={() => void copyMessage()}
          >
            <CopyIcon size={15} />
          </button>
          {onEdit ? (
            <button
              type="button"
              data-ui="branch-tree-inspector-action"
              data-action="edit"
              aria-label="Edit message"
              title="Edit message in place"
              aria-pressed={editing}
              disabled={editing || streamTargetBusy}
              onClick={() => {
                setEditError(null)
                setEditingMessageId(message.id)
              }}
            >
              <PencilIcon size={15} />
            </button>
          ) : null}
          {message.role === 'assistant' && onRegenerate ? (
            <button
              type="button"
              data-ui="branch-tree-inspector-action"
              data-action="regenerate"
              aria-label="Regenerate response"
              title={
                !hasConnection
                  ? 'Add a connection to regenerate.'
                  : requestBusy
                    ? 'A request is already running for this chat.'
                    : 'Regenerate response'
              }
              disabled={!hasConnection || requestBusy}
              onClick={() => void onRegenerate()}
            >
              <ReloadIcon size={15} />
            </button>
          ) : null}
          {message.role === 'assistant' && onContinue ? (
            <button
              type="button"
              data-ui="branch-tree-inspector-action"
              data-action="continue"
              aria-label="Continue from here"
              title={
                streamTargetBusy
                  ? "Can't continue while streaming."
                  : generationBusy
                    ? 'A request is already running for this chat.'
                    : hasConnection
                      ? 'Continue this assistant message'
                      : 'Add a connection to continue.'
              }
              disabled={!hasConnection || requestBusy}
              onClick={() => void onContinue()}
            >
              <SendIcon size={15} />
            </button>
          ) : null}
          {onForkChat ? (
            <button
              type="button"
              data-ui="branch-tree-inspector-action"
              data-action="fork-chat"
              aria-label="Branch this chat from here"
              title="Branch this chat from here — opens in a new chat"
              onClick={() => void onForkChat()}
            >
              <BranchIcon size={15} />
            </button>
          ) : null}
          {onToggleContextVisibility ? (
            <button
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
            </button>
          ) : null}
          {onDelete ? (
            <button
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
            </button>
          ) : null}
          <button
            type="button"
            data-ui="branch-tree-inspector-action"
            data-action="info"
            aria-expanded={showInfo}
            aria-label={showInfo ? 'Hide message info' : 'Show message info'}
            title={showInfo ? 'Hide info' : 'Info'}
            onClick={() => setShowInfo((visible) => !visible)}
          >
            <InfoIcon size={15} />
          </button>
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
                <button
                  type="button"
                  aria-label="Previous occurrence in message"
                  data-ui="branch-tree-inspector-search-nav"
                  disabled={occurrenceCount === 0}
                  onClick={() => goToOccurrence(-1)}
                >
                  <ChevronIcon size={14} rotate={180} />
                </button>
                <button
                  type="button"
                  aria-label="Next occurrence in message"
                  data-ui="branch-tree-inspector-search-nav"
                  disabled={occurrenceCount === 0}
                  onClick={() => goToOccurrence(1)}
                >
                  <ChevronIcon size={14} />
                </button>
              </div>
              {streamTargetBusy ? (
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
              {searchMatched && !streamTargetBusy && occurrenceCount === 0 && !matchBeyondPrefix ? (
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
              <button
                type="button"
                data-ui="branch-tree-inspector-overflow-toggle"
                onClick={() => setFullMessageId(showingFull ? null : message.id)}
              >
                {showingFull ? 'Show bounded preview' : 'Show full message'}
              </button>
            </div>
          ) : null}
          {editing ? (
            <>
              <InlineEditor
                key={message.id}
                initial={plaintextOf(message.content)}
                onSave={saveEdit}
                onCancel={() => {
                  setEditingMessageId(null)
                  setEditError(null)
                }}
                attachmentsEnabled={false}
                saveContentOnly
                {...(message.role === 'user' && onEditAndSend
                  ? {
                      onSaveAndSend: (text: string) => saveEditAndSend(text),
                      saveAndSendDisabled: !hasConnection || requestBusy,
                      ...(!hasConnection
                        ? { saveAndSendDisabledReason: 'Add a connection to send messages.' }
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
              {editError?.messageId === message.id ? (
                <div data-ui="branch-tree-inspector-edit-error" role="alert">
                  Edit failed: {editError.text}
                </div>
              ) : null}
            </>
          ) : (
            <>
              {renderedReasoningDetails && renderedReasoningDetails.length > 0 ? (
                <ReasoningBlock
                  details={renderedReasoningDetails}
                  {...(liveReasoningRows
                    ? { detailsNormalized: true, liveRows: liveReasoningRows }
                    : {})}
                  streaming={streamTargetBusy}
                  hasContent={totalChars > 0}
                  deferContentUntilOpen
                  toggleHiddenDisabled={streamTargetBusy || Boolean(liveReasoningRows)}
                  {...(onToggleReasoningDetailHidden
                    ? {
                        onToggleHidden: toggleReasoningDetailHidden,
                      }
                    : {})}
                />
              ) : null}
              <StaticToolEvidenceBlock
                message={message}
                toggleHiddenDisabled={streamTargetBusy}
                {...(onToggleProviderOutputItemHidden
                  ? {
                      onToggleHidden: toggleProviderOutputItemHidden,
                    }
                  : {})}
              />
              <MessageContent
                key={`${message.id}:${message.nodeVersion}`}
                content={renderedContent}
                text={streamTargetBusy ? '' : renderedText}
                textSegments={streamTargetBusy ? textSegments : undefined}
                streaming={streamTargetBusy}
                messageId={message.id}
                attachmentRefs={message.attachmentRefs}
              />
              <StaticAttachmentRefChips refs={message.attachmentRefs} messageId={message.id} />
            </>
          )}
        </section>

        {showInfo ? (
          <section data-ui="branch-tree-inspector-details" aria-labelledby={detailsId}>
            <h3 id={detailsId}>Message details</h3>
            <MessageInfo message={infoMessage} />
          </section>
        ) : null}
      </div>
    </aside>
  )
})

export const BranchTreeInspector =
  BranchTreeInspectorComponent as typeof BranchTreeInspectorComponent & {
    __setComputationProbeForTests: (probe: BranchTreeInspectorComputationProbe | undefined) => void
  }
if (import.meta.env.MODE === 'test') {
  BranchTreeInspector.__setComputationProbeForTests = setBranchTreeInspectorComputationProbeForTests
}
