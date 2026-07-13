// The panel shape depends on the current model + effective capability:
//
// - Anthropic-style models (cache_control in supportedParameters): mode
//   toggle (off / automatic / manual) + TTL selector + pin counter hint.
// - Gemini: manual-only + "cache pins are last-wins" warning.
// - OpenAI: implicit-only badge — no knobs.
// - Unsupported models: collapse to a short note.
//
// The composer's cache-pin toggle is gated by `quirks.cacheMinTokens`, but
// that lives on the composer; this pane surfaces the minimum so the user
// understands why pinning may appear disabled there.

import { useCallback } from 'react'
import type { EffectiveCapability } from '../../core/capabilities'
import { cacheMinTokensFor } from '../../core/quirks'
import type { AnthropicCacheSettings, Chat, ConnectionKind } from '../../core/types'
import { updateChatSettings } from '../../store/chats'
import { Button } from '../primitives/Button'
import { InfoDisclosure } from './InfoDisclosure'

interface CachingPanelProps {
  chat: Chat
  capability: EffectiveCapability | null
  // Caching breakpoints are provider-specific wire features: Anthropic's
  // `cache_control` blocks, Gemini's manual cache, OpenRouter's header.
  // Local / OpenAI-compatible servers (llama.cpp, vLLM, LM Studio, OpenAI
  // proper) don't expose a user-facing caching surface, so the panel
  // is hidden entirely for those kinds rather than rendering controls that do
  // nothing. Only the kinds that can actually produce a cache breakpoint
  // are listed below.
  connectionKind: ConnectionKind
}

const CACHE_CAPABLE_KINDS: readonly ConnectionKind[] = ['openrouter', 'anthropic', 'google']

type Family = 'anthropic' | 'gemini' | 'openai' | 'unsupported'

// Match the model id to the caching-family that governs its wire shape.
// OpenRouter does NOT list `cache_control` in /endpoints supported_parameters
// even for Anthropic models — the header-level breakpoint is implicit — so
// model-family matching is the primary signal here. `supportsImplicitCaching`
// from the live row is still the OpenAI tell-tale since OpenRouter does set
// that boolean.
function familyFor(chat: Chat, capability: EffectiveCapability | null): Family {
  const id = chat.settings.model.toLowerCase()
  if (id.includes('claude') || id.includes('anthropic')) return 'anthropic'
  if (id.includes('gemini')) return 'gemini'
  if (
    id.includes('gpt') ||
    id.includes('openai') ||
    id.startsWith('o1') ||
    id.startsWith('o3') ||
    id.startsWith('o4')
  ) {
    return 'openai'
  }
  if (capability?.supportsImplicitCaching) return 'openai'
  return 'unsupported'
}

export function CachingPanel({ chat, capability, connectionKind }: CachingPanelProps) {
  const family = familyFor(chat, capability)
  const cache = chat.settings.anthropicCache
  const setCache = useCallback(
    (patch: Partial<AnthropicCacheSettings>) => {
      void updateChatSettings(chat.id, {
        anthropicCache: { ...cache, ...patch },
      })
    },
    [chat.id, cache],
  )
  const cacheMin = cacheMinTokensFor(chat.settings.model)

  // Hide the section entirely when there's nothing for the user to
  // configure — unsupported model, implicit caching (OpenAI), or no model
  // yet. Keeps the Context tab quiet.
  if (!CACHE_CAPABLE_KINDS.includes(connectionKind)) return null
  if (!chat.settings.model) return null
  if (family === 'unsupported') return null
  if (family === 'openai') return null

  const cacheEnabled = cache.mode !== 'off'
  // `-2` means cache through the second-to-last message, so regenerating the
  // last assistant turn is a cache hit (prefix up to the last user turn is
  // stable). `-1` caches through the last message. Positive values: pin
  // exactly the first N messages.
  const breakpointIndex = cache.breakpointIndex ?? -2

  return (
    <div data-ui="settings-section" data-ui-section={`caching-${family}`}>
      <h3>Caching</h3>
      <div data-ui="segmented">
        {(['off', 'on'] as const).map((m) => {
          const mode = m === 'off' ? 'off' : family === 'anthropic' ? 'automatic' : 'manual'
          const pressed = m === 'off' ? cache.mode === 'off' : cache.mode !== 'off'
          return (
            <Button
              key={m}
              type="button"
              data-ui="segmented-option"
              aria-pressed={pressed}
              onClick={() => setCache({ mode })}
            >
              {m}
            </Button>
          )
        })}
      </div>
      {cacheEnabled && family === 'anthropic' ? (
        <div data-ui="field-group" data-ui-field>
          <span>
            TTL
            <InfoDisclosure title="Anthropic caches expire after the selected idle time. 1h costs slightly more but survives between turns." />
          </span>
          <div data-ui="segmented">
            {(['5m', '1h'] as const).map((ttl) => (
              <Button
                key={ttl}
                type="button"
                data-ui="segmented-option"
                aria-pressed={cache.ttl === ttl}
                onClick={() => setCache({ ttl })}
              >
                {ttl}
              </Button>
            ))}
          </div>
        </div>
      ) : null}
      {cacheEnabled ? (
        <label data-ui="field-group" data-ui-field data-ui-inline-number-row>
          <span>
            Breakpoint
            <InfoDisclosure title="Negative: how far back from the latest message to cache. -2 (default) caches up to the message before last, so regenerating the last assistant turn is a cache hit. -1 caches through the last message. Positive: pin exactly the first N messages." />
          </span>
          <input
            type="number"
            value={breakpointIndex}
            step={1}
            onChange={(e) => {
              const v = Number(e.target.value)
              if (Number.isFinite(v)) setCache({ breakpointIndex: Math.round(v) })
            }}
          />
        </label>
      ) : null}
      {cacheEnabled && cacheMin !== undefined ? (
        <p data-ui="helper" data-ui-cache-min>
          Provider minimum: <strong>{cacheMin.toLocaleString()} tokens</strong> per cached block.
        </p>
      ) : null}
    </div>
  )
}
