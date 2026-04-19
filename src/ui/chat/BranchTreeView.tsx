// Branch-tree visualizer. See `plan/08-branching.md §8.7`.
//
// V1 scope:
//   - indent-based tree (no Dagre); one row per live message
//   - role badge + 1-line content preview + sibling count
//   - active-path highlight
//   - click: put node on active path in this tab (via the shared
//     `resolveLastUpdatedBranchBelow` helper below)
//   - middle-click / Cmd-click: anchor passthrough opens the node in a
//     new tab at `#/chat/<chatId>/message/<nodeId>`
//   - search: filter rows whose content contains the query (plain substring)
//
// Out of scope here: drag-reorder (V2), graphical layout (V2).

import { type MouseEvent, useCallback, useMemo, useState } from 'react'
import { chatHref } from '../../app/router'
import { activePath, cursorKeyOf, groupByParent, indexById } from '../../core/active-path'
import { resolveLastUpdatedBranchBelow } from '../../core/branch-resolve'
import type { ChatId, CursorMap, Message, MessageId } from '../../core/types'
import { useChatStore } from '../../store/zustand/chatStore'
import { CloseIcon } from '../icons/Icon'

export interface BranchTreeViewProps {
  chatId: ChatId
  messages: readonly Message[]
  onClose: () => void
}

interface TreeRow {
  message: Message
  depth: number
  siblingCount: number
}

function buildTreeRows(messages: readonly Message[]): TreeRow[] {
  const byParent = groupByParent(messages)
  const rows: TreeRow[] = []
  const walk = (parentId: MessageId | null, depth: number): void => {
    const kids = (byParent.get(parentId) ?? []).filter((m) => !m.deleted)
    const sorted = [...kids].sort((a, b) => a.siblingIndex - b.siblingIndex)
    for (const kid of sorted) {
      rows.push({ message: kid, depth, siblingCount: sorted.length })
      walk(kid.id, depth + 1)
    }
  }
  walk(null, 0)
  return rows
}

function previewOf(message: Message): string {
  for (const item of message.content) {
    if (item.type === 'text' || item.type === 'output_text') {
      const text = item.text.trim()
      if (text) return text.slice(0, 120).replace(/\s+/g, ' ')
    }
  }
  return '(no text)'
}

// Walk up from `messageId` via `parentId`, writing cursor entries so the
// node lands on the active path. Paired with `resolveLastUpdatedBranchBelow`
// to fill in the descendant chain.
function cursorForNode(
  messages: readonly Message[],
  targetId: MessageId,
  base: CursorMap,
): CursorMap {
  const byId = indexById(messages)
  const next: CursorMap = { ...base }
  let cur: Message | undefined = byId.get(targetId)
  while (cur) {
    const parentId = cur.parentId
    next[cursorKeyOf(parentId)] = cur.id
    cur = parentId ? byId.get(parentId) : undefined
  }
  return next
}

export function BranchTreeView({ chatId, messages, onClose }: BranchTreeViewProps) {
  const [query, setQuery] = useState('')
  const cursor = useChatStore((s) => s.cursors[chatId])
  const rows = useMemo(() => buildTreeRows(messages), [messages])
  const byId = useMemo(() => indexById(messages), [messages])
  const activeIds = useMemo(() => {
    const path = activePath(messages, cursor ?? {})
    return new Set(path.map((m) => m.id))
  }, [messages, cursor])
  const q = query.trim().toLowerCase()
  const filtered = q ? rows.filter((r) => previewOf(r.message).toLowerCase().includes(q)) : rows

  const handleSelect = useCallback(
    (messageId: MessageId) => {
      const base = useChatStore.getState().getCursor(chatId) ?? {}
      const seeded = cursorForNode(messages, messageId, base)
      resolveLastUpdatedBranchBelow(
        {
          targetId: messageId,
          byParent: groupByParent(messages),
          byId,
        },
        seeded,
      )
      useChatStore.getState().setCursor(chatId, seeded)
      onClose()
    },
    [chatId, messages, byId, onClose],
  )

  const anchorClick = (messageId: MessageId) => (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return
    }
    e.preventDefault()
    handleSelect(messageId)
  }

  return (
    <div
      data-ui="branch-tree-overlay"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div data-ui="branch-tree" role="dialog" aria-modal="true" aria-label="Branch tree">
        <div data-ui="branch-tree-header">
          <h2>Branch tree</h2>
          <input
            data-ui="branch-tree-search"
            type="search"
            placeholder="Search content…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search branch tree"
          />
          <button
            type="button"
            data-ui="icon-button"
            data-size="sm"
            data-role="branch-tree-close"
            aria-label="Close branch tree"
            onClick={onClose}
          >
            <CloseIcon size={14} />
          </button>
        </div>
        {filtered.length === 0 ? (
          <p data-ui="branch-tree-empty">No matching nodes.</p>
        ) : (
          <ul data-ui="branch-tree-list">
            {filtered.map((row) => {
              const on = activeIds.has(row.message.id)
              return (
                <li
                  key={row.message.id}
                  data-ui="branch-tree-row"
                  data-role={row.message.role}
                  data-active={on ? 'true' : 'false'}
                  data-depth={row.depth}
                >
                  <a
                    data-ui="branch-tree-node"
                    href={chatHref(chatId, row.message.id)}
                    rel="noopener"
                    onClick={anchorClick(row.message.id)}
                    aria-label={`Focus message (${row.message.role})`}
                    title="Click to focus; ⌘-click to open in a new tab"
                  >
                    <span data-ui="branch-tree-role">{row.message.role}</span>
                    <span data-ui="branch-tree-preview">{previewOf(row.message)}</span>
                    {row.siblingCount > 1 ? (
                      <span data-ui="branch-tree-variants">{row.siblingCount} variants</span>
                    ) : null}
                  </a>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
