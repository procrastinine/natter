import { describe, expect, it } from 'vitest'
import { cloneDefaultChatSettings, UNKNOWN_POLICY } from '../../src/core/defaults'
import {
  CURRENT_OPENROUTER_MODEL_IDS,
  LATEST_OPENROUTER_MODEL_IDS,
  OPENROUTER_PROBE_MODEL_IDS,
} from '../../src/core/latest-models'

describe('defaults', () => {
  it('DEFAULT_CHAT_SETTINGS matches the Phase 0 snapshot', () => {
    expect(cloneDefaultChatSettings()).toMatchInlineSnapshot(`
      {
        "allowFallbacks": true,
        "anthropicCache": {
          "mode": "off",
          "ttl": "5m",
        },
        "api": "auto",
        "appendPrompt": "",
        "autoContinueToolLoop": true,
        "cacheRemoteImages": true,
        "contextStrategy": {
          "kind": "sliding_window",
          "onOverflow": "ask",
          "reservedForCompletion": 512,
        },
        "continuePrefill": false,
        "continueSystemPrompt": "Continue the chat from the last assistant message. The last assistant message is incomplete. Output only the continuation. Do not repeat prior content, do not add filler text, and do not restate the user question.

      The original system prompt (for reference):
      \`\`\`
      [SYSTEM_PROMPT]
      \`\`\`",
        "continueUserPrompt": "Now please generate only the continuation of the last message, with zero filler text.",
        "defaultPrefill": "",
        "enabledPluginIds": [],
        "enabledToolIds": [],
        "mediaContextStrategy": "echo-all",
        "mediaEchoN": 5,
        "model": "",
        "privacy": {
          "byokEnabled": false,
          "denyDataCollection": true,
          "paretoFilter": true,
          "zdrOnly": false,
        },
        "profileId": "",
        "reasoning": {
          "echoAsThinkTags": false,
          "exclude": false,
          "include": {
            "encrypted": true,
            "summary": false,
            "text": false,
          },
          "mode": "default",
          "summary": "auto",
        },
        "responses": {
          "store": false,
        },
        "sampling": {},
        "serviceTier": "auto",
        "stripExifOnUpload": true,
        "systemPrompt": "",
        "systemRole": "system",
        "toolCallContext": {
          "include": true,
        },
        "toolContextStrategy": "echo-all",
        "toolContextSummarizeAfterN": 6,
        "tools": {
          "anthropic": {
            "enabledServerToolIds": [],
          },
          "google": {
            "enabledServerToolIds": [],
          },
          "openai": {
            "enabledServerToolIds": [],
          },
          "openrouter": {
            "enabledServerToolIds": [],
          },
        },
        "trustedToolIds": [],
        "userIdMode": "omit",
      }
    `)
  })

  it('DEFAULT_PRIVACY_PREFS is privacy-first', () => {
    expect(cloneDefaultChatSettings().privacy).toEqual({
      denyDataCollection: true,
      zdrOnly: false,
      paretoFilter: true,
      byokEnabled: false,
    })
  })

  it('UNKNOWN_POLICY is worst-case on every dimension', () => {
    expect(UNKNOWN_POLICY).toEqual({
      training: true,
      trainingOpenRouter: true,
      retainsPrompts: true,
      canPublish: false,
      requiresUserIDs: true,
      termsOfServiceURL: '',
      privacyPolicyURL: '',
    })
  })

  it('cloneDefaultChatSettings returns an independent deep copy', () => {
    const a = cloneDefaultChatSettings()
    const b = cloneDefaultChatSettings()
    expect(a).toEqual(b)
    expect(a).not.toBe(b)
    expect(a.reasoning).not.toBe(b.reasoning)
    a.reasoning.mode = 'off'
    expect(b.reasoning.mode).toBe('default')
    expect(cloneDefaultChatSettings().reasoning.mode).toBe('default')
  })

  it('clones default privacy preferences independently', () => {
    const a = cloneDefaultChatSettings().privacy
    a.paretoFilter = false
    expect(cloneDefaultChatSettings().privacy.paretoFilter).toBe(true)
  })

  it('keeps current and upcoming OpenRouter model preferences separate and immutable', () => {
    expect(CURRENT_OPENROUTER_MODEL_IDS).toEqual([
      'anthropic/claude-opus-4.8',
      'anthropic/claude-sonnet-5',
      'anthropic/claude-fable-5',
      'openai/gpt-5.6-sol',
      'google/gemini-3.6-flash',
      'google/gemini-3.5-flash-lite',
      'z-ai/glm-5.2',
      'moonshotai/kimi-k3',
    ])
    expect(LATEST_OPENROUTER_MODEL_IDS).toEqual([
      ...CURRENT_OPENROUTER_MODEL_IDS,
      'google/gemini-3.5-pro',
    ])
    expect(OPENROUTER_PROBE_MODEL_IDS).toEqual([
      'google/gemini-3.5-flash-lite',
      'z-ai/glm-5.2',
      'moonshotai/kimi-k3',
      'google/gemini-3.6-flash',
      'openai/gpt-5.6-luna',
      'anthropic/claude-haiku-4.5',
    ])
    expect(Object.isFrozen(CURRENT_OPENROUTER_MODEL_IDS)).toBe(true)
    expect(Object.isFrozen(LATEST_OPENROUTER_MODEL_IDS)).toBe(true)
    expect(Object.isFrozen(OPENROUTER_PROBE_MODEL_IDS)).toBe(true)
  })
})
