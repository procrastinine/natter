// Backcompat tests: old chats + old messages stored before Phase B should
// still work in every code path. Guards against NaN / crash / absurd
// values when fields are missing.
//
// Critical scenarios the user called out:
//   - Old chat with no tokenCalibration → gauge uses tier 3 anchor.
//   - Old message with no originalCharCount / cachedTokenEstimate →
//     fresh-path computation, no throw.
//   - Mix of old and new messages in the same path → each handled per row.
//   - corrupt/missing/bad typed fields on the message → clamp / ignore.
//
// Also confirms that Phase B additions are strictly pure-add: nothing
// they changed would break a row written by a Phase-A binary.

import { describe, expect, it, vi } from 'vitest'
import { computeCutoffPlan, messageCost } from '../../src/core/context-cutoff'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { tokenCalibrationKey } from '../../src/core/model-ids'
import { estimatePromptSize, estimateSettingsPromptSize } from '../../src/core/prompt-size'
import {
  addSampleToChat,
  calibrationFieldsForCreate,
  calibrationFieldsForEdit,
  charsPerToken,
  RATIO_BOUNDS,
} from '../../src/core/token-calibration'
import type {
  Chat,
  ChatSettings,
  Message,
  MessageRole,
  TokenCalibrationSample,
} from '../../src/core/types'

// Fake the settings store so Dexie isn't required.
vi.mock('../../src/store/settings', () => {
  const state = new Map<string, unknown>()
  return {
    async getSetting<T>(key: string): Promise<T | undefined> {
      return state.get(key) as T | undefined
    },
    async setSetting<T>(key: string, value: T): Promise<void> {
      state.set(key, value)
    },
    async updateSetting<T>(
      key: string,
      updater: (current: T | undefined) => T | undefined | Promise<T | undefined>,
    ): Promise<T | undefined> {
      const next = await updater(state.get(key) as T | undefined)
      if (next === undefined) state.delete(key)
      else state.set(key, next)
      return next
    },
    async deleteSetting(key: string): Promise<void> {
      state.delete(key)
    },
  }
})

function makeLegacyMessage(role: MessageRole, text: string, partial: Partial<Message> = {}): Message {
  return {
    id: `legacy-${Math.random().toString(36).slice(2, 8)}`,
    chatId: 'chat-1',
    parentId: null,
    siblingIndex: 0,
    turnId: 't',
    turnIndex: 0,
    createdAt: 1,
    role,
    origin: role === 'user' ? 'user' : 'generated',
    content: [{ type: role === 'assistant' ? 'output_text' : 'text', text }],
    nodeVersion: 0,
    deleted: false,
    // Deliberately NO Phase B fields: no originalCharCount / originalTokenEstimate /
    // originalModelId / charCountDelta / cachedTokenEstimate / cachedMediaTokens.
    ...partial,
  }
}

function makeLegacyChatSettings(overrides: Partial<ChatSettings> = {}): ChatSettings {
  const s = cloneDefaultChatSettings()
  s.model = 'openai/gpt-4o-mini'
  s.profileId = 'profile-1'
  return { ...s, ...overrides }
}

describe('backcompat — calibration resolver against pre-Phase-B chat', () => {
  it('falls through to tier 3 anchor when chat has no tokenCalibration field', () => {
    const chat = {
      // No tokenCalibration key at all — simulating a rehydrated old row.
    } as Pick<Chat, 'tokenCalibration'>
    expect(charsPerToken('openai/gpt-4o', chat, null)).toBe(RATIO_BOUNDS.gpt.anchor)
  })

  it('falls through when tokenCalibration is explicitly undefined', () => {
    expect(charsPerToken('openai/gpt-4o', { tokenCalibration: undefined }, null)).toBe(
      RATIO_BOUNDS.gpt.anchor,
    )
  })

  it('falls through when null chat is passed (e.g. first send on new chat)', () => {
    expect(charsPerToken('openai/gpt-4o', null, null)).toBe(RATIO_BOUNDS.gpt.anchor)
  })

  it('tolerates a chat shape without the field entirely', () => {
    // `{}` — most legacy rows won't even have `tokenCalibration: undefined`.
    expect(charsPerToken('openai/gpt-4o', {}, null)).toBe(RATIO_BOUNDS.gpt.anchor)
  })

  it('handles corrupt samples (negative sums, 0 tokens) gracefully', () => {
    const chat = {
      tokenCalibration: {
        'openai/gpt-4o': {
          totalTextChars: -500,
          totalTextTokens: 0,
          sampleCount: 10,
          updatedAt: 0,
        },
      },
    }
    // Guarded by ratioFromSample → falls to anchor.
    expect(charsPerToken('openai/gpt-4o', chat, null)).toBe(RATIO_BOUNDS.gpt.anchor)
  })
})

describe('backcompat — gauge against pre-Phase-B message rows', () => {
  it('estimatePromptSize: fresh-path works on legacy messages (no crash, no NaN)', () => {
    const path = [
      makeLegacyMessage('user', 'hello'),
      makeLegacyMessage('assistant', 'hi there'),
    ]
    const est = estimatePromptSize({
      systemPrompt: 'you are kind',
      activePathMessages: path,
      draftText: '',
      tokenizer: 'gpt',
      currentModelId: 'openai/gpt-4o',
    })
    expect(Number.isFinite(est.total)).toBe(true)
    expect(est.total).toBeGreaterThan(0)
  })

  it('messageCost: same-model cache eligibility defaults to fresh when no cache present', () => {
    const m = makeLegacyMessage('user', 'hello')
    const cost = messageCost(m, { family: 'gpt', currentModelId: 'openai/gpt-4o' })
    expect(Number.isFinite(cost.text)).toBe(true)
    expect(cost.text).toBeGreaterThan(0)
  })

  it('computeCutoffPlan: legacy chat + legacy messages return valid plan', () => {
    const path = [
      makeLegacyMessage('user', 'a'.repeat(100)),
      makeLegacyMessage('assistant', 'b'.repeat(100)),
    ]
    const plan = computeCutoffPlan({
      messages: path,
      settings: makeLegacyChatSettings(),
      tokenizer: 'gpt',
      providerCap: null,
    })
    expect(plan.applied).toBe(false) // no cap → full path
    expect(plan.kept.length).toBe(2)
    expect(Number.isFinite(plan.total)).toBe(true)
  })

  it('estimateSettingsPromptSize: wires through attachment resolver + currentModelId without crashing', () => {
    const path = [makeLegacyMessage('user', 'hello')]
    const est = estimateSettingsPromptSize(
      makeLegacyChatSettings(),
      path,
      '',
      'cl100k_base',
    )
    expect(Number.isFinite(est.total)).toBe(true)
  })
})

describe('backcompat — mixed paths (some new, some old)', () => {
  it('respects per-row originalModelId when present; fresh when absent', () => {
    // First message: legacy (no fields). Second message: Phase-B row.
    const legacy = makeLegacyMessage('user', 'a'.repeat(35))
    const phaseB: Message = {
      ...makeLegacyMessage('assistant', 'b'.repeat(35)),
      originalCharCount: 35,
      originalTokenEstimate: 10,
      originalModelId: 'openai/gpt-4o',
      charCountDelta: 0,
      cachedTokenEstimate: 777,
      cachedMediaTokens: 0,
    }
    const est = estimatePromptSize({
      systemPrompt: '',
      activePathMessages: [legacy, phaseB],
      draftText: '',
      tokenizer: 'gpt',
      currentModelId: 'openai/gpt-4o',
    })
    // legacy uses fresh (10 tokens); phase-B uses cache (777). Total ≥ 787.
    expect(est.historyTokens).toBeGreaterThanOrEqual(787)
  })

  it('after model switch, legacy messages use fresh path regardless', () => {
    // Old message has NO originalModelId. When currentModelId is present,
    // cacheEligibleFor returns true for originalModelId===undefined
    // (Phase-B backcompat contract, since the original model is unknown),
    // and with NO cache field, the path falls through to fresh.
    const legacy = makeLegacyMessage('user', 'a'.repeat(35))
    const est = estimatePromptSize({
      systemPrompt: '',
      activePathMessages: [legacy],
      draftText: '',
      tokenizer: 'claude',
      currentModelId: 'anthropic/claude-opus-4.7',
    })
    // 35 chars / claude 3.8 cpt = 10 tokens
    expect(est.historyTokens).toBe(10)
  })
})

describe('backcompat — calibration helpers tolerate legacy inputs', () => {
  it('calibrationFieldsForCreate with no prior calibration returns tier-3 result', () => {
    const fields = calibrationFieldsForCreate(
      [{ type: 'text', text: 'hello world' }],
      'openai/gpt-4o',
      null, // legacy chat — no tokenCalibration
      null, // no global
    )
    // 11 chars / 3.5 = 4 (ceil)
    expect(fields.originalCharCount).toBe(11)
    expect(fields.originalTokenEstimate).toBe(4)
    expect(fields.originalCalibrationKey).toBe(tokenCalibrationKey('openai/gpt-4o'))
  })

  it('calibrationFieldsForEdit with missing originalCharCount sets delta = 0', () => {
    const patch = calibrationFieldsForEdit(
      [{ type: 'text', text: 'x'.repeat(100) }],
      undefined, // legacy row — no original
      undefined,
      undefined,
      'openai/gpt-4o',
      null,
      null,
    )
    expect(patch.charCountDelta).toBe(0)
    expect(patch.cachedTokenEstimate).toBeGreaterThan(0)
  })

  it('addSampleToChat initializes tokenCalibration on legacy chat', () => {
    const legacyChat: { tokenCalibration?: Record<string, TokenCalibrationSample> | undefined } = {}
    const outcome = addSampleToChat(legacyChat, 'openai/gpt-4o', 350, 100, 1000)
    expect(outcome.accepted).toBe(true)
    expect(legacyChat.tokenCalibration).toBeDefined()
    expect(
      (legacyChat.tokenCalibration as Record<string, { sampleCount: number }>)[
        tokenCalibrationKey('openai/gpt-4o')
      ]?.sampleCount,
    ).toBe(1)
  })
})

describe('backcompat — absurd / corrupt legacy data', () => {
  it('message with content: null does not crash the gauge', () => {
    const corrupt: Message = {
      ...makeLegacyMessage('user', 'placeholder'),
      content: null as unknown as Message['content'],
    }
    expect(() =>
      estimatePromptSize({
        systemPrompt: '',
        activePathMessages: [corrupt],
        draftText: '',
        tokenizer: 'gpt',
      }),
    ).not.toThrow()
  })

  it('message with cachedTokenEstimate: NaN falls back to fresh', () => {
    const m: Message = {
      ...makeLegacyMessage('user', 'a'.repeat(35)),
      cachedTokenEstimate: Number.NaN,
    }
    const est = estimatePromptSize({
      systemPrompt: '',
      activePathMessages: [m],
      draftText: '',
      tokenizer: 'gpt',
      currentModelId: 'openai/gpt-4o',
    })
    // NaN cache ignored → fresh path: 35/3.5 = 10
    expect(est.historyTokens).toBe(10)
  })

  it('message with cachedTokenEstimate: Infinity falls back to fresh', () => {
    const m: Message = {
      ...makeLegacyMessage('user', 'a'.repeat(35)),
      cachedTokenEstimate: Number.POSITIVE_INFINITY,
    }
    const est = estimatePromptSize({
      systemPrompt: '',
      activePathMessages: [m],
      draftText: '',
      tokenizer: 'gpt',
      currentModelId: 'openai/gpt-4o',
    })
    expect(Number.isFinite(est.historyTokens)).toBe(true)
  })
})
