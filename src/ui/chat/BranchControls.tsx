// Prev / Next swipe anchors + editable variant-count + first/last
// jumps. See `plan/10-ui.md §10.6` and `plan/08-branching.md §8.4.3`.
//
// Every arrow/label is an `<a>` anchor so middle-click / Cmd-click
// falls through to the browser and opens the sibling in a new tab at
// `#/chat/<id>/message/<siblingId>`. Plain left-click is intercepted
// and applied in-tab via the shared `swipe()` helper. Left-clicking
// the variant-count label swaps it for an input so the user can jump
// to an arbitrary sibling number.

import {
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { chatHref } from '../../app/router'
import { cursorKeyOf, groupByParent, indexById } from '../../core/active-path'
import { resolveLastUpdatedBranchBelow } from '../../core/branch-resolve'
import { swipe } from '../../core/messages'
import type { ChatId, CursorMap, Message } from '../../core/types'
import { useChatStore } from '../../store/zustand/chatStore'

export interface BranchControlsProps {
  chatId: ChatId
  message: Message
  messages: readonly Message[]
}

export function BranchControls({ chatId, message, messages }: BranchControlsProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)
  // The flag guards `onBlur` from firing a redundant commit after Enter
  // has already committed — some browsers still fire blur as the input
  // unmounts. "commit already happened this cycle" is treated as a no-op.
  const committedRef = useRef(false)

  useEffect(() => {
    if (!editing) return
    committedRef.current = false
    const el = inputRef.current
    if (!el) return
    el.focus()
    el.select()
  }, [editing])

  const byParent = groupByParent(messages)
  const siblings = (byParent.get(message.parentId) ?? []).filter((m) => !m.deleted)
  const sorted = [...siblings].sort((a, b) => a.siblingIndex - b.siblingIndex)
  const idx = sorted.findIndex((s) => s.id === message.id)
  const jumpTo = useCallback(
    (targetId: string) => {
      const cursor = useChatStore.getState().getCursor(chatId) ?? {}
      const nextCursor: CursorMap = {
        ...cursor,
        [cursorKeyOf(message.parentId)]: targetId,
      }
      resolveLastUpdatedBranchBelow(
        {
          targetId,
          byParent,
          byId: indexById(messages),
        },
        nextCursor,
      )
      useChatStore.getState().setCursor(chatId, nextCursor)
    },
    [chatId, message.parentId, byParent, messages],
  )

  if (siblings.length < 2) return null
  if (idx < 0) return null
  // Non-circular: prev/first are disabled at variant 1; next/last are
  // disabled at variant N. Users who want wrap-around can still use
  // the keyboard `[` `]` shortcuts which still cycle (matching the
  // existing §8.4.3 contract).
  const atStart = idx === 0
  const atEnd = idx === sorted.length - 1
  const prev = atStart ? null : (sorted[idx - 1] as Message)
  const next = atEnd ? null : (sorted[idx + 1] as Message)
  const first = sorted[0] as Message
  const last = sorted[sorted.length - 1] as Message

  const applyStep = (direction: -1 | 1) => {
    const cursor = useChatStore.getState().getCursor(chatId) ?? {}
    const { cursorUpdates } = swipe({
      messages,
      targetId: message.id,
      direction,
      cursor,
    })
    const nextCursor: CursorMap = { ...cursor, ...cursorUpdates }
    const chosenId = cursorUpdates[cursorKeyOf(message.parentId)]
    if (chosenId) {
      resolveLastUpdatedBranchBelow(
        {
          targetId: chosenId,
          byParent,
          byId: indexById(messages),
        },
        nextCursor,
      )
    }
    useChatStore.getState().setCursor(chatId, nextCursor)
  }

  const handleAnchorStep = (direction: -1 | 1) => (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return
    }
    e.preventDefault()
    applyStep(direction)
  }

  const handleJumpAnchor = (targetId: string) => (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return
    }
    e.preventDefault()
    jumpTo(targetId)
  }

  const beginEdit = () => {
    setDraft(String(idx + 1))
    setEditing(true)
  }

  const resolveTarget = (raw: string): Message | null => {
    const parsed = Number.parseInt(raw, 10)
    if (!Number.isFinite(parsed)) return null
    const clamped = Math.min(sorted.length, Math.max(1, parsed))
    return sorted[clamped - 1] ?? null
  }

  const commitEdit = () => {
    if (committedRef.current) return
    committedRef.current = true
    const target = resolveTarget(draft)
    setEditing(false)
    if (!target || target.id === message.id) return
    jumpTo(target.id)
  }

  // Cmd/Ctrl+Enter — open the target variant in a NEW tab at
  // `#/chat/<id>/message/<targetId>` instead of navigating in-tab.
  // Matches the rest of BranchControls where any anchor can be
  // opened in a new tab via Cmd-click; the keyboard path gets the
  // same affordance so users don't have to reach for the mouse.
  const commitEditInNewTab = () => {
    if (committedRef.current) return
    committedRef.current = true
    const target = resolveTarget(draft)
    setEditing(false)
    if (!target) return
    if (typeof window !== 'undefined') {
      window.open(chatHref(chatId, target.id), '_blank', 'noopener')
    }
  }

  const handleEditKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (e.metaKey || e.ctrlKey) {
        commitEditInNewTab()
      } else {
        commitEdit()
      }
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      committedRef.current = true
      setEditing(false)
    }
  }

  return (
    <div data-ui="branch-controls">
      {atStart ? (
        <span
          data-ui="branch-arrow"
          data-role="first"
          data-state="disabled"
          aria-disabled="true"
          title="Already at first variant"
        >
          «
        </span>
      ) : (
        <a
          data-ui="branch-arrow"
          data-role="first"
          href={chatHref(chatId, first.id)}
          rel="noopener"
          aria-label="First variant"
          title="Jump to first variant"
          onClick={handleJumpAnchor(first.id)}
        >
          «
        </a>
      )}
      {atStart || !prev ? (
        <span
          data-ui="branch-arrow"
          data-role="prev"
          data-state="disabled"
          aria-disabled="true"
          title="Already at first variant"
        >
          ‹
        </span>
      ) : (
        <a
          data-ui="branch-arrow"
          data-role="prev"
          href={chatHref(chatId, prev.id)}
          rel="noopener"
          aria-label="Previous variant"
          title="Previous variant ( [ )"
          onClick={handleAnchorStep(-1)}
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
            onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ''))}
            onKeyDown={handleEditKey}
            onBlur={commitEdit}
            aria-label="Jump to variant number (⏎ jumps · ⌘⏎ opens in a new tab)"
            title="⏎ jump · ⌘⏎ new tab · Esc cancel"
          />
          <span data-ui="branch-count-of">/ {sorted.length}</span>
        </span>
      ) : (
        <a
          data-ui="branch-count"
          href={chatHref(chatId, message.id)}
          rel="noopener"
          aria-label={`Variant ${idx + 1} of ${sorted.length}. Click to jump to a variant number.`}
          title="Click to enter a variant number — ⌘-click to open this variant in a new tab"
          onClick={(e) => {
            if (
              e.defaultPrevented ||
              e.button !== 0 ||
              e.metaKey ||
              e.ctrlKey ||
              e.shiftKey ||
              e.altKey
            ) {
              return
            }
            e.preventDefault()
            beginEdit()
          }}
        >
          {idx + 1} / {sorted.length}
        </a>
      )}
      {atEnd || !next ? (
        <span
          data-ui="branch-arrow"
          data-role="next"
          data-state="disabled"
          aria-disabled="true"
          title="Already at last variant"
        >
          ›
        </span>
      ) : (
        <a
          data-ui="branch-arrow"
          data-role="next"
          href={chatHref(chatId, next.id)}
          rel="noopener"
          aria-label="Next variant"
          title="Next variant ( ] )"
          onClick={handleAnchorStep(1)}
        >
          ›
        </a>
      )}
      {atEnd ? (
        <span
          data-ui="branch-arrow"
          data-role="last"
          data-state="disabled"
          aria-disabled="true"
          title="Already at last variant"
        >
          »
        </span>
      ) : (
        <a
          data-ui="branch-arrow"
          data-role="last"
          href={chatHref(chatId, last.id)}
          rel="noopener"
          aria-label="Last variant"
          title="Jump to last variant"
          onClick={handleJumpAnchor(last.id)}
        >
          »
        </a>
      )}
    </div>
  )
}
