// Debounced keeper of `chat.previewText`. Subscribes to `chat-mutated`
// broadcast events and schedules a preview-refresh per affected chat.
// Coalesces stream-flush bursts into a single trailing refresh so the
// sidebar preview updates ~once per logical change, not once per token.
//
// Runs at the store layer (not in a React component) so the preview
// stays fresh even when the sidebar isn't mounted (e.g. focus-mode
// collapse) and so the invariant doesn't depend on the UI tree.

import type { ChatId } from '../core/types'
import { onEvent } from './broadcast'
import { refreshChatPreview } from './chats'

// 750ms collapses stream-flush bursts (~200-500ms apart) into a single
// trailing refresh without making user-visible edit latency noticeable
// in the sidebar.
const REFRESH_DEBOUNCE_MS = 750

const timers = new Map<ChatId, ReturnType<typeof setTimeout>>()
let installed = false

function scheduleRefresh(chatId: ChatId): void {
  const existing = timers.get(chatId)
  if (existing !== undefined) clearTimeout(existing)
  const timer = setTimeout(() => {
    timers.delete(chatId)
    void refreshChatPreview(chatId).catch((err: unknown) => {
      console.error('refreshChatPreview failed', { chatId, err })
    })
  }, REFRESH_DEBOUNCE_MS)
  timers.set(chatId, timer)
}

// Installs the broadcast listener. Idempotent — re-calling is a no-op.
// Intended to be called once at app mount (e.g. from Shell's useEffect).
export function installChatPreviewMaintainer(): void {
  if (installed) return
  installed = true
  onEvent((event) => {
    if (event.kind === 'chat-deleted') {
      const t = timers.get(event.chatId)
      if (t !== undefined) clearTimeout(t)
      timers.delete(event.chatId)
      return
    }
    if (event.kind !== 'chat-mutated') return
    // Only structural changes (message writes / tree re-parents) can
    // affect the preview. Chat-meta-only events (rename, archive) never
    // move `previewText`, so skip them.
    const hasStructuralChange = event.affected.some(
      (a) => a.kind === 'message' || a.kind === 'children',
    )
    if (!hasStructuralChange) return
    scheduleRefresh(event.chatId)
  })
}
