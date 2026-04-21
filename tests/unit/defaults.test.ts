import { describe, expect, it } from 'vitest'
import {
  cloneDefaultChatSettings,
  cloneDefaultPrivacyPrefs,
  DEFAULT_CHAT_SETTINGS,
  DEFAULT_PRIVACY_PREFS,
  SEED_DEFAULT_MODEL_CANDIDATES,
  UNKNOWN_POLICY,
} from '../../src/core/defaults'

describe('defaults', () => {
  it('DEFAULT_CHAT_SETTINGS matches the Phase 0 snapshot', () => {
    expect(DEFAULT_CHAT_SETTINGS).toMatchInlineSnapshot(`
      {
        "allowFallbacks": true,
        "anthropicCache": {
          "mode": "off",
          "ttl": "5m",
        },
        "api": "auto",
        "autoContinueToolLoop": true,
        "cacheRemoteImages": true,
        "contextStrategy": {
          "kind": "sliding_window",
          "onOverflow": "ask",
          "reservedForCompletion": 512,
        },
        "enabledPluginIds": [],
        "enabledServerToolIds": [],
        "enabledToolIds": [],
        "mediaContextStrategy": "echo-all",
        "mediaEchoN": 5,
        "model": "",
        "privacy": {
          "byokEnabled": false,
          "denyDataCollection": true,
          "ignoreProviders": [],
          "onlyProviders": [],
          "paretoFilter": true,
          "usePreferredOrdering": true,
          "zdrOnly": false,
        },
        "profileId": "",
        "reasoning": {
          "exclude": false,
          "include": {
            "encrypted": true,
            "summary": false,
            "text": false,
          },
          "mode": "default",
          "summary": "auto",
        },
        "sampling": {},
        "serviceTier": "auto",
        "stripExifOnUpload": true,
        "systemPrompt": "",
        "systemRole": "system",
        "toolContextStrategy": "echo-all",
        "toolContextSummarizeAfterN": 6,
        "trustedToolIds": [],
        "userIdMode": "omit",
      }
    `)
  })

  it('DEFAULT_PRIVACY_PREFS is privacy-first', () => {
    expect(DEFAULT_PRIVACY_PREFS).toEqual({
      denyDataCollection: true,
      zdrOnly: false,
      paretoFilter: true,
      usePreferredOrdering: true,
      ignoreProviders: [],
      onlyProviders: [],
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

  it('DEFAULT_CHAT_SETTINGS is frozen to prevent accidental mutation', () => {
    expect(Object.isFrozen(DEFAULT_CHAT_SETTINGS)).toBe(true)
    expect(Object.isFrozen(DEFAULT_CHAT_SETTINGS.reasoning)).toBe(true)
    expect(Object.isFrozen(DEFAULT_CHAT_SETTINGS.contextStrategy)).toBe(true)
    expect(Object.isFrozen(DEFAULT_CHAT_SETTINGS.privacy)).toBe(true)
  })

  it('cloneDefaultChatSettings returns an independent deep copy', () => {
    const a = cloneDefaultChatSettings()
    const b = cloneDefaultChatSettings()
    expect(a).toEqual(b)
    expect(a).not.toBe(b)
    expect(a.reasoning).not.toBe(b.reasoning)
    a.reasoning.mode = 'off'
    expect(b.reasoning.mode).toBe('default')
    expect(DEFAULT_CHAT_SETTINGS.reasoning.mode).toBe('default')
  })

  it('cloneDefaultPrivacyPrefs yields an independent copy', () => {
    const a = cloneDefaultPrivacyPrefs()
    a.paretoFilter = false
    expect(DEFAULT_PRIVACY_PREFS.paretoFilter).toBe(true)
  })

  it('SEED_DEFAULT_MODEL_CANDIDATES matches the first-run seed preference list', () => {
    expect(SEED_DEFAULT_MODEL_CANDIDATES).toMatchInlineSnapshot(`
      [
        "anthropic/claude-opus-4.7",
        "openai/gpt-5.4",
        "google/gemini-3.1-pro",
        "z-ai/glm-5.1",
      ]
    `)
    expect(Object.isFrozen(SEED_DEFAULT_MODEL_CANDIDATES)).toBe(true)
  })
})
