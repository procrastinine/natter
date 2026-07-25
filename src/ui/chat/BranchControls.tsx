import { type KeyboardEvent, type MouseEvent, useEffect, useRef, useState } from 'react'
import { chatHref } from '../../app/router'
import type { ActiveBranchForkSlot } from '../../core/active-branch-spine'
import type { ChatId, Message } from '../../core/types'
import {
  navigateConversationMessage,
  navigateConversationSiblingPosition,
  resolveConversationSiblingPosition,
} from '../../hooks/useConversationCursor'
import { announceVariantPosition } from '../../store/zustand/announcementStore'
import { Button } from '../primitives/Button'

export type BranchNavigationContext = ActiveBranchForkSlot

interface BranchControlsProps {
  chatId: ChatId
  message: Message
  context: BranchNavigationContext
}

export function BranchControls({ chatId, message, context }: BranchControlsProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)
  const committedRef = useRef(false)

  useEffect(() => {
    if (!editing) return
    committedRef.current = false
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [editing])

  const slot = context
  if (slot.liveCount < 2) return null

  const jumpTo = (targetId: string, position: number) => {
    navigateConversationMessage(chatId, targetId)
    announceVariantPosition(position, slot.liveCount)
  }
  const atStart = slot.position === 0
  const atEnd = slot.position === slot.liveCount - 1

  const handleJumpAnchor =
    (targetId: string, position: number) => (event: MouseEvent<HTMLAnchorElement>) => {
      if (hasModifiedActivation(event)) return
      event.preventDefault()
      jumpTo(targetId, position)
    }

  const beginEdit = () => {
    setDraft(String(slot.position + 1))
    setEditing(true)
  }

  const resolvePosition = (raw: string): number | null => {
    const parsed = Number.parseInt(raw, 10)
    if (!Number.isFinite(parsed)) return null
    return Math.min(slot.liveCount, Math.max(1, parsed)) - 1
  }

  const commitEdit = () => {
    if (committedRef.current) return
    committedRef.current = true
    const position = resolvePosition(draft)
    setEditing(false)
    if (position === null || position === slot.position) return
    navigateConversationSiblingPosition(chatId, slot.parentId, position)
    announceVariantPosition(position, slot.liveCount)
  }

  const commitEditInNewTab = () => {
    if (committedRef.current) return
    committedRef.current = true
    const position = resolvePosition(draft)
    setEditing(false)
    if (position === null || typeof window === 'undefined') return
    const opened = window.open('about:blank', '_blank')
    if (!opened) return
    opened.opener = null
    void resolveConversationSiblingPosition(chatId, slot.parentId, position).then(
      (targetId) => {
        if (!targetId) {
          opened.close()
          return
        }
        opened.location.replace(chatHref(chatId, targetId))
      },
      () => opened.close(),
    )
  }

  const handleEditKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      if (event.metaKey || event.ctrlKey) commitEditInNewTab()
      else commitEdit()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      committedRef.current = true
      setEditing(false)
    }
  }

  return (
    <div data-ui="branch-controls">
      {atStart ? (
        <UnavailableArrow
          branchRole="first"
          label="First variant unavailable"
          title="Already at first variant"
        >
          «
        </UnavailableArrow>
      ) : (
        <a
          data-ui="branch-arrow"
          data-role="first"
          href={chatHref(chatId, slot.firstMessageId)}
          rel="noopener"
          aria-label="First variant"
          title="Jump to first variant"
          onClick={handleJumpAnchor(slot.firstMessageId, 0)}
        >
          «
        </a>
      )}
      {slot.previousMessageId === null ? (
        <UnavailableArrow
          branchRole="prev"
          label="Previous variant unavailable"
          title="Already at first variant"
        >
          ‹
        </UnavailableArrow>
      ) : (
        <a
          data-ui="branch-arrow"
          data-role="prev"
          href={chatHref(chatId, slot.previousMessageId)}
          rel="noopener"
          aria-label="Previous variant"
          title="Previous variant ( [ )"
          onClick={handleJumpAnchor(slot.previousMessageId, slot.position - 1)}
        >
          ‹
        </a>
      )}
      {editing ? (
        <span data-ui="branch-count-editor">
          <input
            ref={inputRef}
            data-ui="branch-count-input"
            type="text"
            inputMode="numeric"
            value={draft}
            size={Math.max(2, draft.length + 1)}
            onChange={(event) => setDraft(event.target.value.replace(/[^0-9]/g, ''))}
            onKeyDown={handleEditKey}
            onBlur={commitEdit}
            aria-label="Jump to variant number (⏎ jumps · ⌘⏎ opens in a new tab)"
            title="⏎ jump · ⌘⏎ new tab · Esc cancel"
          />
          <span data-ui="branch-count-of">/ {slot.liveCount}</span>
        </span>
      ) : (
        <a
          data-ui="branch-count"
          href={chatHref(chatId, message.id)}
          rel="noopener"
          aria-label={`Variant ${slot.position + 1} of ${slot.liveCount}. Click to jump to a variant number.`}
          title="Click to enter a variant number — ⌘-click to open this variant in a new tab"
          onClick={(event) => {
            if (hasModifiedActivation(event)) return
            event.preventDefault()
            beginEdit()
          }}
        >
          {slot.position + 1} / {slot.liveCount}
        </a>
      )}
      {slot.nextMessageId === null ? (
        <UnavailableArrow
          branchRole="next"
          label="Next variant unavailable"
          title="Already at last variant"
        >
          ›
        </UnavailableArrow>
      ) : (
        <a
          data-ui="branch-arrow"
          data-role="next"
          href={chatHref(chatId, slot.nextMessageId)}
          rel="noopener"
          aria-label="Next variant"
          title="Next variant ( ] )"
          onClick={handleJumpAnchor(slot.nextMessageId, slot.position + 1)}
        >
          ›
        </a>
      )}
      {atEnd ? (
        <UnavailableArrow
          branchRole="last"
          label="Last variant unavailable"
          title="Already at last variant"
        >
          »
        </UnavailableArrow>
      ) : (
        <a
          data-ui="branch-arrow"
          data-role="last"
          href={chatHref(chatId, slot.lastMessageId)}
          rel="noopener"
          aria-label="Last variant"
          title="Jump to last variant"
          onClick={handleJumpAnchor(slot.lastMessageId, slot.liveCount - 1)}
        >
          »
        </a>
      )}
    </div>
  )
}

function hasModifiedActivation(event: MouseEvent<HTMLAnchorElement>): boolean {
  return (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
}

function UnavailableArrow({
  branchRole,
  label,
  title,
  children,
}: {
  branchRole: string
  label: string
  title: string
  children: string
}) {
  return (
    <Button
      data-ui="branch-arrow"
      data-role={branchRole}
      appearance="ghost"
      disabled
      aria-label={label}
      title={title}
    >
      {children}
    </Button>
  )
}
