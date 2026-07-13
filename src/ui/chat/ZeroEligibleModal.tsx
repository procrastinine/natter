// Fires when the privacy filter eliminates every provider for the
// chat's model. Blocks the send and offers three quick fixes:
//   1. Switch model — dismiss and open the model picker
//   2. Disable Pareto for this chat — flips `privacy.paretoFilter`
//   3. Show providers — dismiss and let the user edit the picker
//
// Never auto-routes to a training provider. The modal is the only exit
// from a zero-eligible state other than the user's explicit choice.

import { useRef } from 'react'
import type { ChatId } from '../../core/types'
import { getChat, updateChatSettings } from '../../store/chats'
import { chatRowDependencies } from '../../store/reactive-dependencies'
import { useRepositoryQuery } from '../../store/reactive-query'
import { useUiStore } from '../../store/zustand/uiStore'
import { Button } from '../primitives/Button'
import { Dialog } from '../primitives/Dialog'

interface ZeroEligibleModalProps {
  chatId: ChatId
}

export function ZeroEligibleModal({ chatId }: ZeroEligibleModalProps) {
  const chat = useRepositoryQuery(
    JSON.stringify(['chat', chatId]),
    () => getChat(chatId),
    undefined,
    chatRowDependencies(chatId),
  )
  const dismiss = useUiStore((s) => s.setZeroEligibleChatId)
  const okRef = useRef<HTMLButtonElement | null>(null)
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
    <Dialog
      overlayUi="zero-eligible-overlay"
      scrimUi="zero-eligible-scrim"
      surfaceUi="zero-eligible-dialog"
      labelledBy="zero-eligible-title"
      scrimLabel="Close provider warning"
      backdrop="dim"
      initialFocusRef={okRef}
      onClose={close}
    >
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
        <Button data-ui="field-inline-action" onClick={() => void disablePareto()}>
          Disable Pareto for this chat
        </Button>
        <Button data-ui="field-inline-action" onClick={close}>
          Show the picker
        </Button>
        <Button
          ref={okRef}
          data-ui="primary-button"
          tone="accent"
          appearance="solid"
          onClick={close}
        >
          OK
        </Button>
      </footer>
    </Dialog>
  )
}
