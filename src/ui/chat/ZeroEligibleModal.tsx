// Zero-eligible-providers modal. See `plan/09-privacy.md §9.6` +
// `plan/10-ui.md §10.13.1`.
//
// Fires when the privacy filter eliminates every provider for the
// chat's model. Blocks the send and offers three quick fixes:
//   1. Switch model — dismiss and open the model picker
//   2. Disable Pareto for this chat — flips `privacy.paretoFilter`
//   3. Show providers — dismiss and let the user edit the picker
//
// Never auto-routes to a training provider. The modal is the only exit
// from a zero-eligible state other than the user's explicit choice.

import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useRef } from 'react'
import type { ChatId } from '../../core/types'
import { getChat, updateChatSettings } from '../../store/chats'
import { useUiStore } from '../../store/zustand/uiStore'

interface ZeroEligibleModalProps {
  chatId: ChatId
}

export function ZeroEligibleModal({ chatId }: ZeroEligibleModalProps) {
  const chat = useLiveQuery(() => getChat(chatId), [chatId], undefined)
  const dismiss = useUiStore((s) => s.setZeroEligibleChatId)
  const okRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    okRef.current?.focus()
  }, [])
  if (!chat) return null

  const modelLabel = chat.settings.model || 'this model'

  const close = () => dismiss(null)
  const disablePareto = async () => {
    await updateChatSettings(chatId, {
      privacy: { ...chat.settings.privacy, paretoFilter: false },
    })
    close()
  }

  return (
    <div
      data-ui="zero-eligible-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="zero-eligible-title"
    >
      <button
        type="button"
        data-ui="zero-eligible-scrim"
        aria-label="Close provider warning"
        tabIndex={-1}
        onClick={close}
      />
      <div data-ui="zero-eligible-dialog">
        <header data-ui="zero-eligible-header">
          <h2 id="zero-eligible-title">No providers match the privacy filter</h2>
        </header>
        <div data-ui="zero-eligible-body">
          <p>
            Every provider for <code>{modelLabel}</code> either trains on prompts, retains for an
            unknown period, or was manually ignored. The request was blocked, the chat won&rsquo;t
            silently route to a training provider.
          </p>
          <p data-ui="helper">Pick a fix:</p>
        </div>
        <footer data-ui="zero-eligible-actions">
          <button type="button" data-ui="field-inline-action" onClick={() => void disablePareto()}>
            Disable Pareto for this chat
          </button>
          <button type="button" data-ui="field-inline-action" onClick={close}>
            Show the picker
          </button>
          <button ref={okRef} type="button" data-ui="primary-button" onClick={close}>
            OK
          </button>
        </footer>
      </div>
    </div>
  )
}
