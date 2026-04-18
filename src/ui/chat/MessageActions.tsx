import { useCallback, useState } from 'react'
import type { Message } from '../../core/types'
import { CopyIcon, InfoIcon, PencilIcon, ReloadIcon } from '../icons/Icon'

export interface MessageActionsProps {
  message: Message
  showInfo: boolean
  onToggleInfo: () => void
  onCopy?: () => void
  onEdit?: () => void
  onRegenerate?: () => void
}

// Always-visible, low-weight row of secondary actions beneath the message
// content. Right-aligned to the text-width column so the actions sit at the
// trailing edge of the message body. Icon-only — Copy / Edit / Regenerate /
// Info — for a tighter design language. Edit and Regenerate are placeholders
// until in-place edit / regen wiring lands in Phase 9.
export function MessageActions({
  message,
  showInfo,
  onToggleInfo,
  onCopy,
  onEdit,
  onRegenerate,
}: MessageActionsProps) {
  const isAssistant = message.role === 'assistant'
  const [copied, setCopied] = useState(false)
  const handleCopy = useCallback(async () => {
    if (onCopy) {
      onCopy()
      return
    }
    const plain = message.content
      .map((p) =>
        p.type === 'text' || p.type === 'output_text' ? p.text : '',
      )
      .join('')
    try {
      await navigator.clipboard.writeText(plain)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // navigator.clipboard can reject in non-secure contexts; swallow rather
      // than surface a banner — the user can select+copy as a fallback.
    }
  }, [message.content, onCopy])
  return (
    <div data-ui="message-actions">
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
        onClick={onEdit}
        disabled={!onEdit}
        aria-label="Edit message"
        title="Edit (coming soon)"
      >
        <PencilIcon size={14} />
      </button>
      {isAssistant ? (
        <button
          type="button"
          data-ui="icon-button"
          data-size="sm"
          data-role="message-action"
          data-action="regenerate"
          onClick={onRegenerate}
          disabled={!onRegenerate}
          aria-label="Regenerate response"
          title="Regenerate (coming soon)"
        >
          <ReloadIcon size={14} />
        </button>
      ) : null}
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
    </div>
  )
}
