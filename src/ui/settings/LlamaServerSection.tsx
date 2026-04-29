// llama-server-specific chat settings. Only rendered on llama-server
// profiles; the visibility gate is in ChatModelPanel.
//
// Exposes:
// - Protocol toggle (Chat / Text) — flips between /v1/chat/completions
//   and /v1/completions at dispatch time.
// Text-template editing lives on the Generation tab next to Stop sequences.

import type { Chat, ConnectionProfile } from '../../core/types'
import { updateChatSettings } from '../../store/chats'

interface LlamaServerSectionProps {
  chat: Chat
  profile: ConnectionProfile
}

export function LlamaServerSection({ chat }: LlamaServerSectionProps) {
  const protocol = chat.settings.protocol ?? 'chat'
  // Wire default is true. An explicit `false` is only persisted when the
  // user opts out; persisting true would be noise.
  const reuseCache = chat.settings.cachePrompt !== false

  const setProtocol = (next: 'chat' | 'text') => {
    void updateChatSettings(chat.id, { protocol: next })
  }

  const setReuseCache = (next: boolean) => {
    // Write undefined when matching the server default to keep payloads
    // clean (and to avoid the preset drift that would otherwise flag
    // the chat as diverged from a preset that doesn't carry the field).
    const patch: Partial<import('../../core/types').ChatSettings> = next
      ? {}
      : { cachePrompt: false }
    if (next && chat.settings.cachePrompt !== undefined) {
      // Unset an explicit `false` by rewriting the sub-object without it.
      // updateChatSettings merges top-level, so deleting a key via patch
      // isn't supported; shallow-clone and omit instead.
      const { cachePrompt: _drop, ...rest } = chat.settings
      void updateChatSettings(chat.id, rest)
      return
    }
    void updateChatSettings(chat.id, patch)
  }

  return (
    <section data-ui="settings-section" data-ui-section="llama-server">
      <h3>llama-server</h3>
      <div data-ui="field-group">
        <span id="llama-protocol" data-ui="field-label">
          Wire protocol
        </span>
        <div data-ui="segmented">
          <button
            type="button"
            aria-pressed={protocol === 'chat'}
            data-ui="segmented-option"
            data-active={protocol === 'chat'}
            onClick={() => setProtocol('chat')}
          >
            Chat completion
          </button>
          <button
            type="button"
            aria-pressed={protocol === 'text'}
            data-ui="segmented-option"
            data-active={protocol === 'text'}
            onClick={() => setProtocol('text')}
          >
            Text completion
          </button>
        </div>
        <span data-ui="helper">
          {protocol === 'chat'
            ? 'Posts to /v1/chat/completions. The server applies its own chat template to the messages.'
            : 'Posts to /v1/completions with a client-rendered prompt. Pick the chat template on the Generation tab.'}
        </span>
      </div>
      <div data-ui="field-group">
        <label>
          <input
            type="checkbox"
            data-ui="llama-cache-prompt"
            checked={reuseCache}
            onChange={(e) => setReuseCache(e.target.checked)}
          />
          &nbsp;Reuse KV cache between requests
        </label>
        <span data-ui="helper">
          Sends <code>cache_prompt</code>. When on (llama-server default), the shared prompt prefix
          is not re-evaluated — faster reprocessing, slight nondeterminism possible on some
          backends. Turn off to force a fresh prompt evaluation each send.
        </span>
      </div>
    </section>
  )
}
