import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { requestPresentationText } from '../../app/presentation-dialog'
import { aggregateCalibrationSamples } from '../../core/token-calibration'
import type { Chat, MessageId, TokenCalibrationSample } from '../../core/types'
import type { UsePrivacyRoutingResult } from '../../hooks/useModelCatalog'
import { catalogApplication } from '../../store/catalog-application'
import { getTags, setChatTagsFromNames } from '../../store/chat-metadata-application'
import { interchangeApplication } from '../../store/interchange-application'
import { useToastStore } from '../../store/zustand/toastStore'
import {
  BranchTreeIcon,
  CloseIcon,
  CogIcon,
  DownloadIcon,
  FileIcon,
  InfoIcon,
  MenuIcon,
  PencilIcon,
  StructureEditIcon,
  TagIcon,
} from '../icons/Icon'
import { exportChatAsTxt, triggerBrowserDownload } from '../import-export/chat-download'
import {
  importExportErrorMessage,
  natterJsonFilename,
  triggerJsonDownload,
} from '../import-export/json-file'
import { Button, IconButton } from '../primitives/Button'
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

interface ChatHeaderProps {
  chat: Chat | undefined
  paintedBranchLeafId: MessageId | null | undefined
  presentationOnly?: boolean
  settingsOpen: boolean
  onToggleSettings: () => void
  editTreeActive?: boolean
  onToggleEditTree?: () => void
  treeViewActive?: boolean
  onTreeViewIntent?: () => void
  onToggleTreeView?: () => void
  mobileConnectionControl?: ReactNode
  privacyRouting: UsePrivacyRoutingResult
}

export function ChatHeader({
  chat,
  paintedBranchLeafId,
  presentationOnly = false,
  settingsOpen,
  onToggleSettings,
  editTreeActive,
  onToggleEditTree,
  treeViewActive,
  onTreeViewIntent,
  onToggleTreeView,
  mobileConnectionControl,
  privacyRouting,
}: ChatHeaderProps) {
  const chatId = chat?.id ?? null
  const [editing, setEditing] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const [showInfo, setShowInfo] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const titleLabelRef = useRef<HTMLButtonElement | null>(null)
  const mobileMenuRef = useRef<HTMLDivElement | null>(null)
  const pushToast = useToastStore((s) => s.push)

  // Cancel any in-progress title edit when the active chat changes — otherwise
  // the editor would stay open against the next chat's title (confusing).
  // biome-ignore lint/correctness/useExhaustiveDependencies: chatId changes are the reset trigger; the effect does not need the value itself.
  useEffect(() => {
    setEditing(false)
    setDraftTitle('')
    setShowInfo(false)
    setMobileMenuOpen(false)
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
  const commitEdit = useCallback(() => {
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
    setEditing(false)
    setDraftTitle('')
    void catalogApplication.chat.setManualTitle(chat.id, trimmed).catch((error: unknown) => {
      console.error('Failed to update chat title', error)
      pushToast({ level: 'danger', text: 'Failed to update chat title.' })
    })
  }, [chat, draftTitle, cancelEdit, pushToast])

  const handleDownload = useCallback(async () => {
    if (!chat || paintedBranchLeafId === undefined) return
    const { filename, content } = await exportChatAsTxt(chat.id, paintedBranchLeafId)
    triggerBrowserDownload(filename, content)
  }, [chat, paintedBranchLeafId])
  const handleExportJson = useCallback(async () => {
    if (!chat) return
    try {
      const envelope = await interchangeApplication.exportChat(chat.id)
      triggerJsonDownload(
        natterJsonFilename('chat', chat.title || 'Untitled chat', chat.id),
        envelope,
      )
      pushToast({ level: 'success', text: 'Exported chat JSON.', durationMs: 2500 })
    } catch (error) {
      console.error('Failed to export chat JSON', error)
      pushToast({ level: 'danger', text: importExportErrorMessage(error) })
    }
  }, [chat, pushToast])
  const handleEditTags = useCallback(async () => {
    if (!chat) return
    const tags = await getTags(chat.tags)
    const byId = new Map(tags.map((tag) => [tag.id, tag]))
    const currentNames = chat.tags
      .map((tagId) => byId.get(tagId)?.name)
      .filter((name): name is string => Boolean(name))
      .join(', ')
    const value = await requestPresentationText({
      title: 'Set tags',
      inputLabel: 'Tags, comma-separated',
      initialValue: currentNames,
      confirmLabel: 'Save',
    })
    if (value === null) return
    await setChatTagsFromNames(chat.id, tagNamesFromPrompt(value))
  }, [chat])

  useEffect(() => {
    if (!mobileMenuOpen) return
    const onPointerDown = (event: PointerEvent) => {
      const root = mobileMenuRef.current
      if (!root || root.contains(event.target as Node)) return
      setMobileMenuOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileMenuOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [mobileMenuOpen])

  const displayTitle = chat?.title.trim().length ? chat.title : 'Untitled chat'
  const editTreeUnavailable = !!treeViewActive
  const editTreeLabel = editTreeUnavailable
    ? 'Return to conversation to edit the tree'
    : editTreeActive
      ? 'Exit edit tree mode'
      : 'Enter edit tree mode'
  const editTreeTitle = editTreeUnavailable
    ? 'Return to conversation to edit the tree'
    : editTreeActive
      ? 'Exit edit tree mode (Esc)'
      : 'Edit tree mode (⇧⌘E)'

  // When no chat is active there's no title to edit, no streaming to abort,
  // and no chat-model panel to toggle — render nothing.
  if (!chat) {
    return null
  }

  return (
    <span
      data-ui="chat-header-content"
      data-presentation-only={presentationOnly || undefined}
      inert={presentationOnly || undefined}
    >
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
          <Button
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
          </Button>
          <IconButton
            type="button"
            data-ui="icon-button"
            data-size="sm"
            data-role="chat-title-edit"
            aria-label="Edit chat title"
            title="Rename chat"
            onClick={beginEdit}
          >
            <PencilIcon size={14} />
          </IconButton>
        </div>
      )}
      <span data-ui="header-spacer" />
      {onToggleTreeView ? (
        <IconButton
          type="button"
          data-ui="icon-button"
          data-role="chat-branch-tree"
          aria-label={treeViewActive ? 'Return to conversation' : 'View conversation tree'}
          aria-pressed={!!treeViewActive}
          title={treeViewActive ? 'Return to conversation' : 'View conversation tree'}
          onPointerEnter={onTreeViewIntent}
          onPointerDown={onTreeViewIntent}
          onFocus={onTreeViewIntent}
          onClick={onToggleTreeView}
          data-state={treeViewActive ? 'active' : undefined}
        >
          <BranchTreeIcon size={18} />
        </IconButton>
      ) : null}
      {onToggleEditTree ? (
        <IconButton
          type="button"
          data-ui="icon-button"
          data-role="chat-edit-tree"
          aria-label={editTreeLabel}
          aria-pressed={!!editTreeActive}
          title={editTreeTitle}
          disabled={editTreeUnavailable}
          onClick={onToggleEditTree}
          data-state={editTreeActive && !editTreeUnavailable ? 'active' : undefined}
        >
          <StructureEditIcon size={18} />
        </IconButton>
      ) : null}
      <IconButton
        type="button"
        data-ui="icon-button"
        data-role="chat-tags"
        aria-label="Edit chat tags"
        title="Tags"
        onClick={() => void handleEditTags()}
      >
        <TagIcon size={18} />
      </IconButton>
      <span data-ui="desktop-header-privacy">
        <HeaderPrivacyBadge chat={chat} routing={privacyRouting} />
      </span>
      <IconButton
        type="button"
        data-ui="icon-button"
        data-role="chat-download"
        aria-label="Download chat as .txt"
        title="Download chat (.txt)"
        disabled={paintedBranchLeafId === undefined}
        onClick={() => void handleDownload()}
      >
        <DownloadIcon size={18} />
      </IconButton>
      <IconButton
        type="button"
        data-ui="icon-button"
        data-role="chat-export"
        aria-label="Export chat JSON"
        title="Export chat JSON"
        onClick={() => void handleExportJson()}
      >
        <FileIcon size={18} />
      </IconButton>
      <IconButton
        type="button"
        data-ui="icon-button"
        data-role="chat-info"
        aria-label={showInfo ? 'Hide chat info' : 'Show chat info'}
        aria-expanded={showInfo}
        title="Chat info"
        onClick={() => setShowInfo((v) => !v)}
      >
        <InfoIcon size={18} />
      </IconButton>
      <IconButton
        type="button"
        data-ui="icon-button"
        data-role="settings-cog"
        aria-label="Toggle chat settings"
        aria-expanded={settingsOpen}
        title="Chat settings"
        onClick={onToggleSettings}
      >
        <CogIcon size={20} />
      </IconButton>
      <div data-ui="chat-controls-menu-root" ref={mobileMenuRef}>
        <IconButton
          type="button"
          data-ui="icon-button"
          data-role="chat-controls-menu"
          aria-label="Open chat controls"
          aria-haspopup="dialog"
          aria-expanded={mobileMenuOpen}
          title="Chat controls"
          onClick={() => setMobileMenuOpen((open) => !open)}
        >
          <MenuIcon size={20} />
        </IconButton>
        {mobileMenuOpen ? (
          <div data-ui="chat-controls-menu" role="dialog" aria-label="Chat controls">
            {mobileConnectionControl ? (
              <section data-ui="chat-controls-menu-section" data-section="connection">
                <div data-ui="chat-controls-menu-connection">{mobileConnectionControl}</div>
              </section>
            ) : null}
            <Button
              type="button"
              data-ui="mobile-menu-action"
              disabled={!chat}
              onClick={() => {
                beginEdit()
                setMobileMenuOpen(false)
              }}
            >
              <PencilIcon size={16} />
              <span>Rename chat</span>
            </Button>
            {onToggleEditTree ? (
              <Button
                type="button"
                data-ui="mobile-menu-action"
                data-role="mobile-chat-edit-tree"
                aria-label={editTreeLabel}
                aria-pressed={!!editTreeActive}
                title={editTreeTitle}
                disabled={editTreeUnavailable}
                data-state={editTreeActive && !editTreeUnavailable ? 'active' : undefined}
                onClick={() => {
                  onToggleEditTree()
                  setMobileMenuOpen(false)
                }}
              >
                <StructureEditIcon size={16} />
                <span>{editTreeActive ? 'Exit edit tree' : 'Edit tree'}</span>
              </Button>
            ) : null}
            {onToggleTreeView ? (
              <Button
                type="button"
                data-ui="mobile-menu-action"
                data-role="mobile-chat-branch-tree"
                aria-pressed={!!treeViewActive}
                title={treeViewActive ? 'Return to conversation' : 'View conversation tree'}
                data-state={treeViewActive ? 'active' : undefined}
                onPointerEnter={onTreeViewIntent}
                onPointerDown={onTreeViewIntent}
                onFocus={onTreeViewIntent}
                onClick={() => {
                  onToggleTreeView()
                  setMobileMenuOpen(false)
                }}
              >
                <BranchTreeIcon size={16} />
                <span>{treeViewActive ? 'Return to conversation' : 'View conversation tree'}</span>
              </Button>
            ) : null}
            <Button
              type="button"
              data-ui="mobile-menu-action"
              onClick={() => {
                setMobileMenuOpen(false)
                void handleEditTags()
              }}
            >
              <TagIcon size={16} />
              <span>Tags</span>
            </Button>
            <div data-ui="mobile-menu-action" data-kind="privacy">
              <span data-ui="mobile-menu-action-icon">
                <HeaderPrivacyBadge chat={chat} routing={privacyRouting} />
              </span>
              <span>Privacy</span>
            </div>
            <Button
              type="button"
              data-ui="mobile-menu-action"
              onClick={() => {
                setMobileMenuOpen(false)
                void handleDownload()
              }}
            >
              <DownloadIcon size={16} />
              <span>Download .txt</span>
            </Button>
            <Button
              type="button"
              data-ui="mobile-menu-action"
              onClick={() => {
                setMobileMenuOpen(false)
                void handleExportJson()
              }}
            >
              <FileIcon size={16} />
              <span>Export JSON</span>
            </Button>
            <Button
              type="button"
              data-ui="mobile-menu-action"
              onClick={() => {
                setShowInfo(true)
                setMobileMenuOpen(false)
              }}
            >
              <InfoIcon size={16} />
              <span>Chat info</span>
            </Button>
          </div>
        ) : null}
      </div>
      {showInfo ? (
        <div data-ui="chat-info-popover" role="dialog" aria-label="Chat info">
          <div data-ui="chat-info-popover-header">
            <span>Chat info</span>
            <IconButton
              type="button"
              data-ui="icon-button"
              data-size="sm"
              aria-label="Close chat info"
              onClick={() => setShowInfo(false)}
            >
              <CloseIcon size={14} />
            </IconButton>
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
    </span>
  )
}

function tagNamesFromPrompt(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}
