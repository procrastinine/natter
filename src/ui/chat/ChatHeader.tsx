import { useLiveQuery } from 'dexie-react-hooks'
import { useCallback, useEffect, useRef, useState } from 'react'
import { exportChatAsTxt, triggerBrowserDownload } from '../../core/chat-export'
import { aggregateCalibrationSamples } from '../../core/token-calibration'
import type { ChatId, CursorMap } from '../../core/types'
import { getChat, setManualTitle } from '../../store/chats'
import { useChatStore } from '../../store/zustand/chatStore'
import type { TokenCalibrationSample } from '../../core/types'
import { CloseIcon, CogIcon, DownloadIcon, EditTreeIcon, InfoIcon, PencilIcon } from '../icons/Icon'
import { HeaderPrivacyBadge } from './HeaderPrivacyBadge'

function formatCalibrationRatio(sample: TokenCalibrationSample): string {
  if (sample.totalTextTokens <= 0) return '—'
  return (sample.totalTextChars / sample.totalTextTokens).toFixed(2)
}

function calibrationEntries(
  samples: Record<string, TokenCalibrationSample> | undefined,
): Array<[string, TokenCalibrationSample]> {
  return Object.entries(aggregateCalibrationSamples(samples)).sort(([a], [b]) => a.localeCompare(b))
}

// Stable empty reference so useChatStore's selector doesn't allocate a fresh
// `{}` every render — React 19's useSyncExternalStore detects that as an
// infinite loop ("getSnapshot should be cached").
const EMPTY_CURSOR: CursorMap = Object.freeze({}) as CursorMap

export interface ChatHeaderProps {
  chatId: ChatId | null
  settingsOpen: boolean
  onToggleSettings: () => void
  editTreeActive?: boolean
  onToggleEditTree?: () => void
}

export function ChatHeader({
  chatId,
  settingsOpen,
  onToggleSettings,
  editTreeActive,
  onToggleEditTree,
}: ChatHeaderProps) {
  const chat = useLiveQuery(
    () => (chatId ? getChat(chatId) : Promise.resolve(undefined)),
    [chatId],
    undefined,
  )
  const cursor = useChatStore((s) => (chatId ? (s.cursors[chatId] ?? EMPTY_CURSOR) : EMPTY_CURSOR))
  const [editing, setEditing] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const [showInfo, setShowInfo] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const titleLabelRef = useRef<HTMLButtonElement | null>(null)

  // Cancel any in-progress title edit when the active chat changes — otherwise
  // the editor would stay open against the next chat's title (confusing).
  // biome-ignore lint/correctness/useExhaustiveDependencies: chatId changes are the reset trigger; the effect does not need the value itself.
  useEffect(() => {
    setEditing(false)
    setDraftTitle('')
    setShowInfo(false)
  }, [chatId])

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editing])

  const beginEdit = useCallback(() => {
    if (!chat) return
    setDraftTitle(chat.title)
    setEditing(true)
  }, [chat])
  const cancelEdit = useCallback(() => {
    setEditing(false)
    setDraftTitle('')
  }, [])
  const commitEdit = useCallback(async () => {
    if (!chat) return
    const trimmed = draftTitle.trim()
    if (trimmed.length === 0) {
      // Empty trim is a no-op cancel rather than a hard error: the user
      // probably meant to discard the edit. Closing edit mode silently is
      // less obnoxious than "Title cannot be empty."
      cancelEdit()
      return
    }
    // Whether or not the title actually changed, exit edit mode silently.
    // "Unchanged" is not an error worth surfacing to the user.
    await setManualTitle(chat.id, trimmed)
    setEditing(false)
    setDraftTitle('')
  }, [chat, draftTitle, cancelEdit])

  const handleDownload = useCallback(async () => {
    if (!chat) return
    const { filename, content } = await exportChatAsTxt(chat.id, cursor)
    triggerBrowserDownload(filename, content)
  }, [chat, cursor])

  const displayTitle = chat?.title?.trim().length ? chat.title : 'Untitled chat'

  // When no chat is active there's no title to edit, no streaming to abort,
  // and no chat-model panel to toggle — render nothing.
  if (!chat) {
    return null
  }

  return (
    <>
      {editing ? (
        <input
          ref={inputRef}
          data-ui="chat-title-editor"
          type="text"
          value={draftTitle}
          onChange={(e) => setDraftTitle(e.target.value)}
          onBlur={() => void commitEdit()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void commitEdit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              cancelEdit()
            }
          }}
          maxLength={200}
          aria-label="Chat title"
        />
      ) : (
        <div data-ui="chat-title" data-title-status={chat.titleStatus}>
          <button
            type="button"
            ref={titleLabelRef}
            data-ui="chat-title-label"
            onKeyDown={(e) => {
              if (e.key === 'F2' || e.key === 'Enter') {
                e.preventDefault()
                beginEdit()
              }
            }}
            onDoubleClick={beginEdit}
          >
            {displayTitle}
          </button>
          <button
            type="button"
            data-ui="icon-button"
            data-size="sm"
            data-role="chat-title-edit"
            aria-label="Edit chat title"
            title="Rename chat"
            onClick={beginEdit}
          >
            <PencilIcon size={14} />
          </button>
        </div>
      )}
      <span data-ui="header-spacer" />
      {onToggleEditTree ? (
        <button
          type="button"
          data-ui="icon-button"
          data-role="chat-edit-tree"
          aria-label={editTreeActive ? 'Exit edit tree mode' : 'Enter edit tree mode'}
          aria-pressed={editTreeActive ? true : false}
          title={editTreeActive ? 'Exit edit tree mode (Esc)' : 'Edit tree mode (⇧⌘E)'}
          onClick={onToggleEditTree}
          data-state={editTreeActive ? 'active' : undefined}
        >
          <EditTreeIcon size={18} />
        </button>
      ) : null}
      <HeaderPrivacyBadge chatId={chat.id} />
      <button
        type="button"
        data-ui="icon-button"
        data-role="chat-download"
        aria-label="Download chat as .txt"
        title="Download chat (.txt)"
        onClick={() => void handleDownload()}
      >
        <DownloadIcon size={18} />
      </button>
      <button
        type="button"
        data-ui="icon-button"
        data-role="chat-info"
        aria-label={showInfo ? 'Hide chat info' : 'Show chat info'}
        aria-expanded={showInfo}
        title="Chat info"
        onClick={() => setShowInfo((v) => !v)}
      >
        <InfoIcon size={18} />
      </button>
      <button
        type="button"
        data-ui="icon-button"
        data-role="settings-cog"
        aria-label="Toggle chat model panel"
        aria-expanded={settingsOpen}
        title="Model settings"
        onClick={onToggleSettings}
      >
        <CogIcon size={20} />
      </button>
      {showInfo ? (
        <div data-ui="chat-info-popover" role="dialog" aria-label="Chat info">
          <div data-ui="chat-info-popover-header">
            <span>Chat info</span>
            <button
              type="button"
              data-ui="icon-button"
              data-size="sm"
              aria-label="Close chat info"
              onClick={() => setShowInfo(false)}
            >
              <CloseIcon size={14} />
            </button>
          </div>
          <dl data-ui="chat-info-popover-fields">
            <div>
              <dt>Title</dt>
              <dd>{displayTitle}</dd>
            </div>
            <div>
              <dt>Created</dt>
              <dd>{new Date(chat.createdAt).toLocaleString()}</dd>
            </div>
            <div>
              <dt>Updated</dt>
              <dd>{new Date(chat.updatedAt).toLocaleString()}</dd>
            </div>
            <div>
              <dt>Word count</dt>
              <dd>{chat.wordCount.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Total cost</dt>
              <dd>${chat.totalCostUsd.toFixed(6)}</dd>
            </div>
            <div>
              <dt>Model</dt>
              <dd>{chat.settings.model || '—'}</dd>
            </div>
            {calibrationEntries(chat.tokenCalibration).map(([calibrationKey, sample]) => (
              <div key={`cal-${calibrationKey}`}>
                <dt title={`Learned chars/token ratio for ${calibrationKey}`}>
                  Calib {calibrationKey}
                </dt>
                <dd>
                  {formatCalibrationRatio(sample)} c/tok · {sample.sampleCount.toLocaleString()}{' '}
                  sample{sample.sampleCount === 1 ? '' : 's'}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </>
  )
}
