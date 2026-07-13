// Inserts a chain of user-typed messages under the requested slot:
// - "at-end": append-as-child under the active-path leaf (composer button)
// - "before" / "after" / "after-all" / "sibling": explicit tree insertion

import { useCallback, useEffect, useMemo, useState } from 'react'
import { type PasteImportSlot, pasteImport } from '../../core/messages'
import type { ChatId, ContentItem, CursorMap, MessageRole } from '../../core/types'
import { newId } from '../../lib/ulid'
import { useAnnouncementStore } from '../../store/zustand/announcementStore'
import { useChatStore } from '../../store/zustand/chatStore'
import { CloseIcon, TrashIcon } from '../icons/Icon'
import { Button, IconButton } from '../primitives/Button'
import { Dialog } from '../primitives/Dialog'

interface ImportModalProps {
  // Existing chat to import into. Pass `null` together with
  // `materializeChat` when the import is running on the new-chat
  // surface — the chat row is created lazily, only if the user
  // actually clicks Import.
  chatId: ChatId | null
  slot: PasteImportSlot
  cursor: CursorMap
  // Initial role for the first row; defaults to "user" because the common
  // path is "paste a user turn from another app."
  defaultRole?: MessageRole
  // Optional late-binding chat creator. When provided and `chatId` is
  // null, invoked ONCE on commit to materialize the chat row, right
  // before the import mutation runs. Cancel / close never calls it;
  // route-level temporary-chat cleanup owns empty-row disposal.
  materializeChat?: () => Promise<ChatId>
  onClose: () => void
  onDone?: () => void
}

interface Row {
  id: string
  role: MessageRole
  text: string
}

const ROLE_OPTIONS: MessageRole[] = ['user', 'assistant', 'system', 'tool']

function slotLabel(slot: PasteImportSlot): string {
  switch (slot.kind) {
    case 'at-end':
      return 'end of active path'
    case 'after-all':
      return slot.parentId === null
        ? 'before all current root messages'
        : 'after this parent, before all of its children'
    case 'before':
      return 'before this message'
    case 'after':
      return 'after this message'
    case 'sibling':
      return 'as a sibling of this message'
  }
}

export function ImportModal({
  chatId,
  slot,
  cursor,
  defaultRole = 'user',
  materializeChat,
  onClose,
  onDone,
}: ImportModalProps) {
  const [rows, setRows] = useState<Row[]>([{ id: newId(), role: defaultRole, text: '' }])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Sibling-insert forces all rows to the target's role per §8.4.9 #1.
  // For simplicity, the first row's role is fixed if it's a sibling.
  const isSiblingSlot = slot.kind === 'sibling'
  useEffect(() => {
    if (!isSiblingSlot) return
    setRows((prev) => {
      if (prev.length === 0) return prev
      const first = prev[0] as Row
      if (first.role === defaultRole) return prev
      return [{ ...first, role: defaultRole }, ...prev.slice(1)]
    })
  }, [defaultRole, isSiblingSlot])

  const addRow = useCallback(() => {
    setRows((prev) => {
      const last = prev[prev.length - 1]
      const nextRole: MessageRole = last?.role === 'user' ? 'assistant' : 'user'
      return [...prev, { id: newId(), role: nextRole, text: '' }]
    })
  }, [])

  const removeRow = useCallback((index: number) => {
    setRows((prev) => {
      if (prev.length <= 1) return prev
      return prev.filter((_, i) => i !== index)
    })
  }, [])

  const commit = useCallback(async () => {
    if (busy) return
    // Trim each row but keep empty ones — messages may legitimately be
    // empty (placeholder turn, deliberate blank). Only the full-zero
    // case errors, which is unreachable through the UI (the modal
    // always has at least one row) but worth defending against.
    const cleaned = rows.map((r) => ({ role: r.role, text: r.text.trim() }))
    if (cleaned.length === 0) {
      setError('Add at least one message to import.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      let effectiveChatId: ChatId | null = chatId
      if (effectiveChatId === null) {
        if (!materializeChat) {
          throw new Error('import: no chat to write into and no materializeChat callback')
        }
        effectiveChatId = await materializeChat()
      }
      const result = await pasteImport({
        chatId: effectiveChatId,
        slot,
        cursor,
        messages: cleaned.map((r) => ({
          role: r.role,
          content: [{ type: 'text', text: r.text } satisfies ContentItem],
        })),
      })
      const currentCursor = useChatStore.getState().getCursor(effectiveChatId) ?? {}
      useChatStore.getState().setCursor(effectiveChatId, {
        ...currentCursor,
        ...result.effects.cursorUpdates,
      })
      useAnnouncementStore.getState().announce({
        text: `Imported ${cleaned.length} ${cleaned.length === 1 ? 'message' : 'messages'} (${slotLabel(slot)}).`,
      })
      onDone?.()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? `Import failed: ${err.message}` : 'Import failed.')
    } finally {
      setBusy(false)
    }
  }, [busy, rows, chatId, slot, cursor, materializeChat, onDone, onClose])

  const roleOptions = useMemo(() => ROLE_OPTIONS, [])

  return (
    <Dialog
      overlayUi="import-modal-overlay"
      scrimUi="import-modal-scrim"
      surfaceUi="import-modal"
      ariaLabel="Import messages"
      scrimLabel="Close import modal"
      onClose={onClose}
      surfaceProps={{ 'aria-busy': busy || undefined }}
    >
      <div data-ui="import-modal-header">
        <h2>Import messages</h2>
        <IconButton
          type="button"
          data-ui="icon-button"
          data-size="sm"
          data-role="import-modal-close"
          aria-label="Close import modal"
          onClick={onClose}
        >
          <CloseIcon size={14} />
        </IconButton>
      </div>
      {chatId ? (
        <p data-ui="import-modal-slot">
          Inserting at: <strong>{slotLabel(slot)}</strong>
        </p>
      ) : null}
      <div data-ui="import-modal-rows">
        {rows.map((row, i) => (
          <div key={row.id} data-ui="import-modal-row" data-role={row.role}>
            <div data-ui="import-modal-row-head">
              <label>
                Role
                <select
                  data-ui="import-modal-role"
                  value={row.role}
                  disabled={isSiblingSlot && i === 0}
                  onChange={(e) =>
                    setRows((prev) =>
                      prev.map((r, idx) =>
                        idx === i ? { ...r, role: e.target.value as MessageRole } : r,
                      ),
                    )
                  }
                >
                  {roleOptions.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </label>
              {rows.length > 1 ? (
                <Button
                  data-ui="import-modal-remove"
                  tone="danger"
                  onClick={() => removeRow(i)}
                  aria-label="Remove this message"
                  title="Remove this message"
                >
                  <TrashIcon size={14} />
                </Button>
              ) : null}
            </div>
            <textarea
              data-ui="import-modal-text"
              value={row.text}
              onChange={(e) =>
                setRows((prev) =>
                  prev.map((r, idx) => (idx === i ? { ...r, text: e.target.value } : r)),
                )
              }
              placeholder="Paste or type the message text…"
              rows={4}
              aria-label={`Message ${i + 1}`}
            />
          </div>
        ))}
      </div>
      <div data-ui="import-modal-footer">
        <Button
          data-ui="import-modal-add-row"
          onClick={addRow}
          disabled={isSiblingSlot}
          title={
            isSiblingSlot
              ? 'Sibling import creates one variant; use insert-after to chain.'
              : 'Stack another message onto this import. Rows commit as a parent→child chain in the order shown — useful for pasting a back-and-forth from another app.'
          }
        >
          + Add another message to this chain
        </Button>
        <span data-ui="import-modal-spacer" />
        <Button data-ui="import-modal-cancel" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          data-ui="import-modal-submit"
          tone="accent"
          appearance="solid"
          busy={busy}
          busyLabel="Importing…"
          onClick={() => void commit()}
        >
          Import
        </Button>
      </div>
      {error ? (
        <p data-ui="import-modal-error" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  )
}
