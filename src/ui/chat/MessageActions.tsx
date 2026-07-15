// Always-visible, low-weight icon-only buttons trail the message body.
// Edit-tree mode reveals a second row for structural operations while
// preserving the default action row.
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

import { useCallback, useEffect, useRef, useState } from 'react'
import { cursorKeyOf } from '../../core/active-path'
import { hasAppliedSuccessfulContinuation } from '../../core/continuation-content'
import { structuralEffectsCursorPatch, structuralEffectsUndoCursorPatch } from '../../core/messages'
import type { Message } from '../../core/types'
import { applyStructuralSnapshot } from '../../core/undo'
import {
  deletePairOp,
  deleteSingleOp,
  deleteTurnOp,
  deleteVariantOp,
} from '../../hooks/useMessageOps'
// The type imports above are used by the props interface even when the
// runtime references shrink; leaving them here keeps the component's
// public contract readable from a single file.
import { useChatStore } from '../../store/zustand/chatStore'
import { useToastStore } from '../../store/zustand/toastStore'
import { useUiStore } from '../../store/zustand/uiStore'
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
  streamTargetBusy?: boolean
  disabledReason?: string
  // Structural ops.
  onRegenerate?: () => void | Promise<void>
  onContinue?: () => void | Promise<void>
  // The per-message branch action forks the chat from this node into a
  // brand-new chat row (core/chat-fork.ts). There is NO separate in-tree
  // branch-sibling button — alternate siblings come from regenerate /
  // edit-&-send / insert-sibling (in edit-tree mode).
  onForkChat?: () => void | Promise<void>
  onToggleContextVisibility?: () => void | Promise<void>
  // Copy override — if unset, falls back to a navigator.clipboard write
  // of the plaintext content.
  onCopy?: () => void | Promise<void>
  // Chat-scoped deletion context. Passed through from the list because
  // the delete helpers need the active chat to compute the pair / turn chain.
  chatId: string
  roleMismatch?: boolean
}

// Shared delete workflow: execute with atomic pre-image → toast w/ undo. Used by
// both the default row (pair/single via confirm dialog) and the edit-tree
// structural row (variant/turn direct).
function useRunDelete(chatId: string, message: Message, roleMismatch: boolean | undefined) {
  const cascadeDelete = useUiStore((s) => s.cascadeDelete)
  const pushToast = useToastStore((s) => s.push)
  return useCallback(
    async (kind: 'pair' | 'variant' | 'turn' | 'single') => {
      const chatStore = useChatStore.getState()
      const navigationIntent = chatStore.beginNavigationIntent(chatId)
      const committedPathProducer = chatStore.registerCommittedPathProducer(
        chatId,
        navigationIntent,
      )
      if (!committedPathProducer) return
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
      const priorCursor = useChatStore.getState().getCursor(chatId) ?? {}
      let result: Awaited<ReturnType<typeof op>> | undefined
      try {
        result = await op({
          chatId,
          messageId: message.id,
          cursor: priorCursor,
          ...(cascadeDelete ? { cascade: true } : {}),
        })
      } catch (err) {
        pushToast({
          level: 'danger',
          text: `Delete failed: ${err instanceof Error ? err.message : 'unknown error'}`,
        })
        return
      } finally {
        if (!result) {
          chatStore.sealCommittedPathProducer(chatId, committedPathProducer)
        }
      }
      chatStore.selectCommittedPathForProducer(
        chatId,
        committedPathProducer,
        Object.fromEntries(
          result.selectedPathHeaders.map((header) => [cursorKeyOf(header.parentId), header.id]),
        ),
        {
          phase: 'terminal',
          pathHeaders: result.selectedPathHeaders,
          structuralHeaders: result.structuralHeaders,
          presentations: result.presentations,
        },
        structuralEffectsCursorPatch(result.effects),
      )
      chatStore.sealCommittedPathProducer(chatId, committedPathProducer)
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
          const undoStore = useChatStore.getState()
          const undoIntent = undoStore.beginNavigationIntent(chatId)
          const undoProducer = undoStore.registerCommittedPathProducer(chatId, undoIntent)
          if (!undoProducer) return
          try {
            const restored = await applyStructuralSnapshot(result.preImage, {
              cursor: priorCursor,
              presentationWindowLimit: 10,
            })
            if (!restored) return
            const state = useChatStore.getState()
            const selections: Record<string, string> = {}
            for (const header of restored.selectedPathHeaders) {
              selections[cursorKeyOf(header.parentId)] = header.id
            }
            state.selectCommittedPathForProducer(
              chatId,
              undoProducer,
              selections,
              {
                phase: 'terminal',
                pathHeaders: restored.selectedPathHeaders,
                structuralHeaders: restored.structuralHeaders,
                presentations: restored.presentations,
              },
              structuralEffectsUndoCursorPatch(priorCursor, result.effects),
            )
          } finally {
            useChatStore.getState().sealCommittedPathProducer(chatId, undoProducer)
          }
        },
      })
    },
    [chatId, cascadeDelete, message.id, pushToast, roleMismatch],
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
    streamTargetBusy = false,
    disabledReason,
    onRegenerate,
    onContinue,
    onForkChat,
    onToggleContextVisibility,
    onCopy,
    chatId,
    roleMismatch,
  } = props
  const [copied, setCopied] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const copyTimerRef = useRef<number | null>(null)
  const isAssistant = message.role === 'assistant'
  const abortReason = hasAppliedSuccessfulContinuation(message)
    ? undefined
    : message.generation?.abortReason
  const runDelete = useRunDelete(chatId, message, roleMismatch)

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

  const disabledTitle = disabledReason ?? 'Add a connection to send messages.'
  const generationDisabled = !hasConnection || generationBusy
  const continuationDisabled = generationDisabled || streamTargetBusy
  const generationDisabledTitle = !hasConnection
    ? disabledTitle
    : 'A request is already running for this chat.'
  const continuationDisabledTitle = streamTargetBusy
    ? "Can't continue while streaming."
    : generationDisabledTitle
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
        disabled={isEditing || streamTargetBusy}
        aria-label="Edit message"
        title={streamTargetBusy ? "Can't edit while streaming." : 'Edit (Enter)'}
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
          onClick={() => void onRegenerate()}
          disabled={generationDisabled}
          aria-label="Regenerate response"
          title={!generationDisabled ? 'Regenerate (⇧⌘R)' : generationDisabledTitle}
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
          onClick={() => void onContinue()}
          disabled={continuationDisabled}
          aria-label={abortReason ? 'Continue partial response' : 'Continue from here'}
          title={
            !continuationDisabled
              ? abortReason
                ? 'Continue this partial response'
                : 'Continue this assistant message'
              : continuationDisabledTitle
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
          aria-label="Branch this chat from here"
          title="Branch this chat from here — opens in a new chat"
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
        disabled={onToggleContextVisibility === undefined}
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
      </IconButton>
      <IconButton
        type="button"
        data-ui="icon-button"
        data-size="sm"
        data-role="message-action"
        data-action="delete-pair"
        onClick={() => setConfirmOpen(true)}
        disabled={streamTargetBusy}
        aria-label={deleteLabel}
        title={streamTargetBusy ? "Can't delete while streaming." : deleteTooltip}
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
            setConfirmOpen(false)
            await runDelete(deletePair ? 'pair' : 'single')
          }}
        />
      ) : null}
    </div>
  )
}

interface MessageEditTreeActionsProps {
  message: Message
  chatId: string
  onInsert?: (slot: InsertSlot) => void | Promise<void>
  roleMismatch?: boolean
  streamTargetBusy?: boolean
}

// Structural-ops row for edit-tree mode. Rendered BELOW the default
// action row so narrow viewports don't collide the insert/delete text
// buttons with the variant arrows + k/N label on the same line. Inserts
// hug the leading edge; deletes hug the trailing edge so destructive
// actions are physically separated from additive ones.
export function MessageEditTreeActions({
  message,
  chatId,
  onInsert,
  roleMismatch,
  streamTargetBusy = false,
}: MessageEditTreeActionsProps) {
  const runDelete = useRunDelete(chatId, message, roleMismatch)
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
        <Button
          data-ui="edit-tree-action"
          tone="danger"
          appearance="soft"
          size="xs"
          data-action="delete-variant"
          onClick={() => void runDelete('variant')}
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
          onClick={() => void runDelete('turn')}
          disabled={streamTargetBusy}
        >
          Delete turn
        </Button>
      </div>
    </div>
  )
}
