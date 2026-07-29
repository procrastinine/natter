// Always-visible, low-weight icon-only buttons trail the message body.
// Edit-tree mode reveals a second row for structural operations while
// preserving the default action row.
//
// The user's rule for "modify user prompt":
//   - Edit in place — never creates a sibling, never fires an API call.
//   - Edit & Send — creates a user sibling of the original AND fires one
//     assistant completion. Shown as an extra button inside the inline
//     editor.
//   - Regenerate (assistant only) — creates an assistant sibling under
//     the same user parent.
//
// This component owns only the action row + Info/Edit disclosures; the
// inline editor body lives inside <Message> so the row can swap the
// content block for a textarea cleanly.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConversationDeleteMode } from '../../app/conversation-actions'
import type {
  ConversationMutationSettlement,
  GenerationSubmission,
} from '../../app/presentation-interactions'
import type { AppliedMessageView } from '../../core/continuation-content'
import type { Message } from '../../core/types'
import {
  BranchIcon,
  CheckIcon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  InfoIcon,
  PencilIcon,
  ReloadIcon,
  SendIcon,
  TrashIcon,
} from '../icons/Icon'
import { Button, IconButton } from '../primitives/Button'
import { ConfirmDeleteDialog } from './ConfirmDeleteDialog'

export type InsertSlot = 'before' | 'after' | 'sibling'

const COPY_CONFIRM_MS = 2500

interface MessageActionsProps {
  message: Message
  appliedView: AppliedMessageView
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
  generationBusy?: boolean
  streamTargetBusy?: boolean
  mutationDisabled?: boolean
  structuralDisabled?: boolean
  structuralMutationPending?: boolean
  onCancelStructuralMutation?: () => void
  // Structural ops.
  onRegenerate?: () => GenerationSubmission
  onContinue?: () => GenerationSubmission
  // The per-message branch action forks the chat from this node into a
  // brand-new chat row (store/chat-fork.ts). There is NO separate in-tree
  // branch-sibling button — alternate siblings come from regenerate /
  // edit-&-send / insert-sibling (in edit-tree mode).
  onForkChat?: () => ConversationMutationSettlement
  onToggleContextVisibility?: () => ConversationMutationSettlement
  // Copy override — if unset, falls back to a navigator.clipboard write
  // of the plaintext content.
  onCopy?: () => void | Promise<void>
  onDelete: (mode: ConversationDeleteMode) => ConversationMutationSettlement
  roleMismatch?: boolean
}

export function MessageActions(props: MessageActionsProps) {
  const {
    message,
    appliedView,
    showInfo,
    onToggleInfo,
    isEditing,
    onBeginEdit,
    generationBusy = false,
    streamTargetBusy = false,
    mutationDisabled = false,
    structuralDisabled = false,
    structuralMutationPending = false,
    onCancelStructuralMutation,
    onRegenerate,
    onContinue,
    onForkChat,
    onToggleContextVisibility,
    onCopy,
    onDelete,
    roleMismatch,
  } = props
  const [copied, setCopied] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const copyTimerRef = useRef<number | null>(null)
  const isAssistant = message.role === 'assistant'
  const abortReason = appliedView.latestAttempt.metadata?.abortReason

  const previewText =
    message.content
      .map((p) => (p.type === 'text' || p.type === 'output_text' ? p.text : ''))
      .join('')
      .trim()
      .slice(0, 200) || `(empty ${message.role} message)`

  const markCopied = useCallback(() => {
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current)
    }
    setCopied(true)
    copyTimerRef.current = window.setTimeout(() => {
      setCopied(false)
      copyTimerRef.current = null
    }, COPY_CONFIRM_MS)
  }, [])

  useEffect(
    () => () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current)
      }
    },
    [],
  )

  useEffect(() => {
    if (structuralDisabled) setConfirmOpen(false)
  }, [structuralDisabled])

  const handleCopy = useCallback(async () => {
    if (onCopy) {
      await onCopy()
      markCopied()
      return
    }
    const plain = message.content
      .map((p) => (p.type === 'text' || p.type === 'output_text' ? p.text : ''))
      .join('')
    try {
      await navigator.clipboard.writeText(plain)
      markCopied()
    } catch {
      // navigator.clipboard can reject in non-secure contexts; swallow
      // rather than surface a banner — the user can select+copy as a
      // fallback.
    }
  }, [markCopied, message.content, onCopy])

  const regenerationTitle = streamTargetBusy
    ? 'Replace the active stream with a regenerated response.'
    : generationBusy
      ? 'Starts a new request and replaces the current preparation.'
      : undefined
  const continuationTitle = streamTargetBusy
    ? 'Replace the active stream with a continuation.'
    : generationBusy
      ? 'Starts a new request and replaces the current preparation.'
      : undefined
  const deleteLabel = structuralMutationPending ? 'Cancel conversation update' : 'Delete message'
  const deleteTooltip = structuralMutationPending
    ? 'Cancel the pending structural update'
    : 'Delete this message…'

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
      <IconButton
        type="button"
        data-ui="icon-button"
        data-size="sm"
        data-role="message-action"
        data-action="copy"
        onClick={() => void handleCopy()}
        aria-label={copied ? 'Copied' : 'Copy message'}
        title={copied ? 'Copied' : 'Copy'}
      >
        {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
      </IconButton>
      <IconButton
        type="button"
        data-ui="icon-button"
        data-size="sm"
        data-role="message-action"
        data-action="edit"
        aria-pressed={isEditing}
        onClick={onBeginEdit}
        disabled={mutationDisabled || isEditing || streamTargetBusy}
        aria-label="Edit message"
        title={
          mutationDisabled
            ? 'Refreshing this message before editing.'
            : streamTargetBusy
              ? "Can't edit while streaming."
              : 'Edit (Enter)'
        }
      >
        <PencilIcon size={14} />
      </IconButton>
      {isAssistant && onRegenerate ? (
        <IconButton
          type="button"
          data-ui="icon-button"
          data-size="sm"
          data-role="message-action"
          data-action="regenerate"
          onClick={() => {
            onRegenerate()
          }}
          aria-label="Regenerate response"
          title={regenerationTitle ?? 'Regenerate (⇧⌘R)'}
        >
          <ReloadIcon size={14} />
        </IconButton>
      ) : null}
      {isAssistant && onContinue ? (
        <IconButton
          type="button"
          data-ui="icon-button"
          data-size="sm"
          data-role="message-action"
          data-action="continue"
          onClick={() => {
            onContinue()
          }}
          aria-label={abortReason ? 'Continue partial response' : 'Continue from here'}
          title={
            continuationTitle ??
            (abortReason ? 'Continue this partial response' : 'Continue this assistant message')
          }
        >
          <SendIcon size={14} />
        </IconButton>
      ) : null}
      {onForkChat ? (
        <IconButton
          type="button"
          data-ui="icon-button"
          data-size="sm"
          data-role="message-action"
          data-action="fork-chat"
          onClick={() => void onForkChat()}
          disabled={structuralDisabled}
          aria-label="Branch this chat from here"
          title={
            structuralDisabled
              ? 'Resolving this branch before structural changes.'
              : 'Branch this chat from here — opens in a new chat'
          }
        >
          <BranchIcon size={14} />
        </IconButton>
      ) : null}
      <IconButton
        type="button"
        data-ui="icon-button"
        data-size="sm"
        data-role="message-action"
        data-action="toggle-visible"
        aria-pressed={Boolean(message.hiddenFromContext)}
        onClick={() => void onToggleContextVisibility?.()}
        disabled={mutationDisabled || onToggleContextVisibility === undefined}
        aria-label={
          message.hiddenFromContext
            ? 'Show in context (send to model)'
            : 'Hide from context (never send to model)'
        }
        title={
          mutationDisabled
            ? 'Refreshing this message before changing context visibility.'
            : message.hiddenFromContext
              ? 'Hidden from context — click to include again'
              : 'Hide from context — keep visible here but never send to the model'
        }
      >
        {message.hiddenFromContext ? <EyeOffIcon size={14} /> : <EyeIcon size={14} />}
      </IconButton>
      <IconButton
        type="button"
        data-ui="icon-button"
        data-size="sm"
        data-role="message-action"
        data-action="delete-pair"
        onClick={() =>
          structuralMutationPending ? onCancelStructuralMutation?.() : setConfirmOpen(true)
        }
        disabled={
          streamTargetBusy ||
          (structuralDisabled && !structuralMutationPending) ||
          (structuralMutationPending && !onCancelStructuralMutation)
        }
        aria-label={deleteLabel}
        title={
          structuralMutationPending
            ? deleteTooltip
            : structuralDisabled
              ? 'Resolving this branch before structural changes.'
              : streamTargetBusy
                ? "Can't delete while streaming."
                : deleteTooltip
        }
      >
        <TrashIcon size={14} />
      </IconButton>
      <IconButton
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
      </IconButton>
      {confirmOpen ? (
        <ConfirmDeleteDialog
          previewText={previewText}
          pairDisabled={Boolean(roleMismatch)}
          pairDefault={!roleMismatch}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={async (deletePair) => {
            if (structuralDisabled) return
            const outcome = await onDelete(deletePair ? 'pair' : 'single')
            if (outcome.kind === 'succeeded') setConfirmOpen(false)
          }}
        />
      ) : null}
    </div>
  )
}

interface MessageEditTreeActionsProps {
  onInsert?: (slot: InsertSlot) => void | Promise<void>
  onDelete: (mode: ConversationDeleteMode) => ConversationMutationSettlement
  streamTargetBusy?: boolean
  structuralMutationPending?: boolean
  onCancelStructuralMutation?: () => void
}

// Structural-ops row for edit-tree mode. Rendered BELOW the default
// action row so narrow viewports don't collide the insert/delete text
// buttons with the variant arrows + k/N label on the same line. Inserts
// hug the leading edge; deletes hug the trailing edge so destructive
// actions are physically separated from additive ones.
export function MessageEditTreeActions({
  onInsert,
  onDelete,
  streamTargetBusy = false,
  structuralMutationPending = false,
  onCancelStructuralMutation,
}: MessageEditTreeActionsProps) {
  return (
    <div data-ui="message-edit-tree-row">
      <div data-ui="edit-tree-group" data-side="inserts">
        {onInsert ? (
          <>
            <Button
              data-ui="edit-tree-action"
              tone="success"
              appearance="soft"
              size="xs"
              data-action="insert-before"
              onClick={() => void onInsert('before')}
              disabled={streamTargetBusy}
            >
              + Insert before
            </Button>
            <Button
              data-ui="edit-tree-action"
              tone="success"
              appearance="soft"
              size="xs"
              data-action="insert-after"
              onClick={() => void onInsert('after')}
              disabled={streamTargetBusy}
            >
              + Insert after
            </Button>
            <Button
              data-ui="edit-tree-action"
              tone="success"
              appearance="soft"
              size="xs"
              data-action="insert-sibling"
              onClick={() => void onInsert('sibling')}
              disabled={streamTargetBusy}
            >
              + Insert sibling
            </Button>
          </>
        ) : null}
      </div>
      <div data-ui="edit-tree-group" data-side="deletes">
        {structuralMutationPending ? (
          <Button
            data-ui="edit-tree-action"
            tone="danger"
            appearance="soft"
            size="xs"
            data-action="cancel-structure"
            onClick={onCancelStructuralMutation}
            disabled={!onCancelStructuralMutation}
          >
            Cancel update
          </Button>
        ) : (
          <>
            <Button
              data-ui="edit-tree-action"
              tone="danger"
              appearance="soft"
              size="xs"
              data-action="delete-variant"
              onClick={() => void onDelete('variant')}
              disabled={streamTargetBusy}
            >
              Delete variant
            </Button>
            <Button
              data-ui="edit-tree-action"
              tone="danger"
              appearance="soft"
              size="xs"
              data-action="delete-turn"
              onClick={() => void onDelete('turn')}
              disabled={streamTargetBusy}
            >
              Delete turn
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
