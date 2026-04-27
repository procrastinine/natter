// Per-message action row. See `plan/10-ui.md §10.6` + `§10.6.1` and
// `plan/08-branching.md §8.4`. Always-visible, low-weight icon-only buttons
// trail the message body; Edit-tree mode REVEALS a second row below the
// default one that carries the structural ops (insert-before /
// insert-after / insert-sibling / delete-variant / delete-turn). The
// default icon row is preserved in edit-tree mode so users don't lose
// copy / edit / regenerate / continue / fork / info / delete-pair while
// restructuring.
//
// The user's rule for "modify user prompt":
//   - Edit in place — never creates a sibling, never fires an API call.
//   - Edit & Send — creates a user sibling of the original AND fires one
//     assistant completion. Shown as an extra button inside the inline
//     editor; disabled when no connection is configured.
//   - Regenerate (assistant only) — creates an assistant sibling under
//     the same user parent; disabled when no connection is configured.
//
// This component owns only the action row + Info/Edit disclosures; the
// inline editor body lives inside <Message> so the row can swap the
// content block for a textarea cleanly.

import { useCallback, useState } from 'react'
import type { Message, MessageId } from '../../core/types'
import { applyStructuralSnapshot, snapshotMessages } from '../../core/undo'
import {
  deletePairOp,
  deleteSingleOp,
  deleteTurnOp,
  deleteVariantOp,
} from '../../hooks/useMessageOps'
// The type imports above are used by the props interface even when the
// runtime references shrink; leaving them here keeps the component's
// public contract readable from a single file.
import { toggleMessageHidden } from '../../store/chats'
import { useToastStore } from '../../store/zustand/toastStore'
import { useUiStore } from '../../store/zustand/uiStore'
import {
  BranchIcon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  InfoIcon,
  PencilIcon,
  ReloadIcon,
  SendIcon,
  TrashIcon,
} from '../icons/Icon'
import { ConfirmDeleteDialog } from './ConfirmDeleteDialog'

export type InsertSlot = 'before' | 'after' | 'sibling'

export interface MessageActionsProps {
  message: Message
  showInfo: boolean
  onToggleInfo: () => void
  // In-tab editing swap: <Message> renders InlineEditor when `isEditing` is
  // true. The pencil button calls onBeginEdit; Cancel/Save inside the
  // editor clears via onEndEdit.
  isEditing: boolean
  onBeginEdit: () => void
  // Permission flags. The buttons stay VISIBLE (discoverable) but
  // disabled with a tooltip so the user understands why the action
  // can't run right now.
  hasConnection: boolean
  generationBusy?: boolean
  disabledReason?: string
  // Structural ops.
  onRegenerate?: () => void | Promise<void>
  onContinue?: () => void | Promise<void>
  // The per-message branch action forks the chat from this node into a
  // brand-new chat row (core/chat-fork.ts). There is NO separate in-tree
  // branch-sibling button — alternate siblings come from regenerate /
  // edit-&-send / insert-sibling (in edit-tree mode).
  onForkChat?: () => void | Promise<void>
  // Copy override — if unset, falls back to a navigator.clipboard write
  // of the plaintext content.
  onCopy?: () => void | Promise<void>
  // Chat-scoped deletion context. Passed through from the list because
  // the delete helpers need the full message set + cursor to compute
  // the pair / turn chain.
  chatId: string
  cursor: Record<string, MessageId>
  roleMismatch?: boolean
}

// Shared delete workflow: snapshot → execute → toast w/ undo. Used by
// both the default row (pair/single via confirm dialog) and the edit-tree
// structural row (variant/turn direct).
function useRunDelete(
  chatId: string,
  message: Message,
  cursor: Record<string, MessageId>,
  roleMismatch: boolean | undefined,
) {
  const cascadeDelete = useUiStore((s) => s.cascadeDelete)
  const pushToast = useToastStore((s) => s.push)
  return useCallback(
    async (kind: 'pair' | 'variant' | 'turn' | 'single') => {
      // Role-mismatched adjacencies almost always want a single-node
      // delete: the user is cleaning up the one stray turn that
      // delete-splice produced. Pair-delete would eat the NEIGHBORING
      // valid message too, which is the opposite of the user's intent.
      const effectiveKind: 'pair' | 'variant' | 'turn' | 'single' =
        kind === 'pair' && roleMismatch ? 'single' : kind
      const op =
        effectiveKind === 'pair'
          ? deletePairOp
          : effectiveKind === 'turn'
            ? deleteTurnOp
            : effectiveKind === 'variant'
              ? deleteVariantOp
              : deleteSingleOp
      const snapshot = await snapshotMessages(chatId, [message.id])
      try {
        await op({
          chatId,
          messageId: message.id,
          cursor,
          ...(cascadeDelete ? { cascade: true } : {}),
        })
      } catch (err) {
        pushToast({
          level: 'danger',
          text: `Delete failed: ${err instanceof Error ? err.message : 'unknown error'}`,
        })
        return
      }
      pushToast({
        level: 'info',
        text:
          effectiveKind === 'pair'
            ? 'Deleted pair.'
            : effectiveKind === 'variant'
              ? 'Deleted variant.'
              : effectiveKind === 'turn'
                ? 'Deleted turn.'
                : 'Deleted message.',
        undo: async () => {
          await applyStructuralSnapshot({
            chatId,
            previousRows: snapshot,
            newMessageIds: [],
            attachmentIds: [],
          })
        },
      })
    },
    [chatId, cursor, cascadeDelete, message.id, pushToast, roleMismatch],
  )
}

export function MessageActions(props: MessageActionsProps) {
  const {
    message,
    showInfo,
    onToggleInfo,
    isEditing,
    onBeginEdit,
    hasConnection,
    generationBusy = false,
    disabledReason,
    onRegenerate,
    onContinue,
    onForkChat,
    onCopy,
    chatId,
    cursor,
    roleMismatch,
  } = props
  const [copied, setCopied] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const isAssistant = message.role === 'assistant'
  const abortReason = message.generation?.abortReason
  const runDelete = useRunDelete(chatId, message, cursor, roleMismatch)

  const previewText =
    message.content
      .map((p) => (p.type === 'text' || p.type === 'output_text' ? p.text : ''))
      .join('')
      .trim()
      .slice(0, 200) || `(empty ${message.role} message)`

  const handleCopy = useCallback(async () => {
    if (onCopy) {
      await onCopy()
      return
    }
    const plain = message.content
      .map((p) => (p.type === 'text' || p.type === 'output_text' ? p.text : ''))
      .join('')
    try {
      await navigator.clipboard.writeText(plain)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // navigator.clipboard can reject in non-secure contexts; swallow
      // rather than surface a banner — the user can select+copy as a
      // fallback.
    }
  }, [message.content, onCopy])

  const disabledTitle = disabledReason ?? 'Add a connection to send messages.'
  const generationDisabled = !hasConnection || generationBusy
  const generationDisabledTitle = !hasConnection
    ? disabledTitle
    : 'A request is already running for this chat.'
  const deleteLabel = 'Delete message'
  const deleteTooltip = 'Delete this message…'

  return (
    <div data-ui="message-actions" data-mode="default">
      {roleMismatch ? (
        <span
          data-ui="message-role-mismatch"
          role="status"
          title="Adjacent same-role messages — the API may reject or merge them. Deleting removes only this message."
        >
          adjacency
        </span>
      ) : null}
      <button
        type="button"
        data-ui="icon-button"
        data-size="sm"
        data-role="message-action"
        data-action="copy"
        onClick={() => void handleCopy()}
        aria-label={copied ? 'Copied' : 'Copy message'}
        title={copied ? 'Copied' : 'Copy'}
      >
        <CopyIcon size={14} />
      </button>
      <button
        type="button"
        data-ui="icon-button"
        data-size="sm"
        data-role="message-action"
        data-action="edit"
        aria-pressed={isEditing}
        onClick={onBeginEdit}
        disabled={isEditing}
        aria-label="Edit message"
        title="Edit (Enter)"
      >
        <PencilIcon size={14} />
      </button>
      {isAssistant && onRegenerate ? (
        <button
          type="button"
          data-ui="icon-button"
          data-size="sm"
          data-role="message-action"
          data-action="regenerate"
          onClick={() => void onRegenerate()}
          disabled={generationDisabled}
          aria-label="Regenerate response"
          title={!generationDisabled ? 'Regenerate (⇧⌘R)' : generationDisabledTitle}
        >
          <ReloadIcon size={14} />
        </button>
      ) : null}
      {isAssistant && onContinue ? (
        <button
          type="button"
          data-ui="icon-button"
          data-size="sm"
          data-role="message-action"
          data-action="continue"
          onClick={() => void onContinue()}
          disabled={generationDisabled}
          aria-label={abortReason ? 'Continue partial response' : 'Continue from here'}
          title={
            !generationDisabled
              ? abortReason
                ? 'Continue this partial response'
                : 'Continue this assistant message'
              : generationDisabledTitle
          }
        >
          <SendIcon size={14} />
        </button>
      ) : null}
      {onForkChat ? (
        <button
          type="button"
          data-ui="icon-button"
          data-size="sm"
          data-role="message-action"
          data-action="fork-chat"
          onClick={() => void onForkChat()}
          aria-label="Branch this chat from here"
          title="Branch this chat from here — opens in a new chat"
        >
          <BranchIcon size={14} />
        </button>
      ) : null}
      <button
        type="button"
        data-ui="icon-button"
        data-size="sm"
        data-role="message-action"
        data-action="toggle-visible"
        aria-pressed={Boolean(message.hiddenFromContext)}
        onClick={() => void toggleMessageHidden(message.id)}
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
      >
        {message.hiddenFromContext ? <EyeOffIcon size={14} /> : <EyeIcon size={14} />}
      </button>
      <button
        type="button"
        data-ui="icon-button"
        data-size="sm"
        data-role="message-action"
        data-action="delete-pair"
        onClick={() => setConfirmOpen(true)}
        aria-label={deleteLabel}
        title={deleteTooltip}
      >
        <TrashIcon size={14} />
      </button>
      <button
        type="button"
        data-ui="icon-button"
        data-size="sm"
        data-role="message-action"
        data-action="info"
        aria-expanded={showInfo}
        aria-label={showInfo ? 'Hide message info' : 'Show message info'}
        title={showInfo ? 'Hide info' : 'Info'}
        onClick={onToggleInfo}
      >
        <InfoIcon size={14} />
      </button>
      {confirmOpen ? (
        <ConfirmDeleteDialog
          previewText={previewText}
          pairDisabled={Boolean(roleMismatch)}
          pairDefault={!roleMismatch}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={async (deletePair) => {
            setConfirmOpen(false)
            await runDelete(deletePair ? 'pair' : 'single')
          }}
        />
      ) : null}
    </div>
  )
}

export interface MessageEditTreeActionsProps {
  message: Message
  chatId: string
  cursor: Record<string, MessageId>
  onInsert?: (slot: InsertSlot) => void | Promise<void>
  roleMismatch?: boolean
}

// Structural-ops row for edit-tree mode. Rendered BELOW the default
// action row so narrow viewports don't collide the insert/delete text
// buttons with the variant arrows + k/N label on the same line. Inserts
// hug the leading edge; deletes hug the trailing edge so destructive
// actions are physically separated from additive ones.
export function MessageEditTreeActions({
  message,
  chatId,
  cursor,
  onInsert,
  roleMismatch,
}: MessageEditTreeActionsProps) {
  const runDelete = useRunDelete(chatId, message, cursor, roleMismatch)
  return (
    <div data-ui="message-edit-tree-row">
      <div data-ui="edit-tree-group" data-side="inserts">
        {onInsert ? (
          <>
            <button
              type="button"
              data-ui="edit-tree-action"
              data-tone="success"
              data-action="insert-before"
              onClick={() => void onInsert('before')}
            >
              + Insert before
            </button>
            <button
              type="button"
              data-ui="edit-tree-action"
              data-tone="success"
              data-action="insert-after"
              onClick={() => void onInsert('after')}
            >
              + Insert after
            </button>
            <button
              type="button"
              data-ui="edit-tree-action"
              data-tone="success"
              data-action="insert-sibling"
              onClick={() => void onInsert('sibling')}
            >
              + Insert sibling
            </button>
          </>
        ) : null}
      </div>
      <div data-ui="edit-tree-group" data-side="deletes">
        <button
          type="button"
          data-ui="edit-tree-action"
          data-tone="danger"
          data-action="delete-variant"
          onClick={() => void runDelete('variant')}
        >
          Delete variant
        </button>
        <button
          type="button"
          data-ui="edit-tree-action"
          data-tone="danger"
          data-action="delete-turn"
          onClick={() => void runDelete('turn')}
        >
          Delete turn
        </button>
      </div>
    </div>
  )
}
