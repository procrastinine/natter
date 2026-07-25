import { newId } from '../lib/ulid'
import { cloneDefaultChatSettings } from './defaults'
import { normalizeReasoningSettings } from './reasoning'
import type {
  Chat,
  ChatId,
  ChatSettings,
  PresetId,
  PromptPresetId,
  PromptPresetKind,
} from './types'

export interface CreateChatInput {
  id?: ChatId
  title?: string
  settings?: ChatSettings
  presetId?: PresetId
  temporary?: boolean
  now?: number
}

export function createChatRow(input: CreateChatInput = {}): Chat {
  const now = input.now ?? Date.now()
  return {
    id: input.id ?? newId(),
    title: input.title ?? '',
    titleStatus: 'untitled',
    createdAt: now,
    updatedAt: now,
    lastViewedAt: now,
    wordCount: 0,
    totalCostUsd: 0,
    metaVersion: 0,
    summaryVersion: 0,
    structuralVersion: 0,
    configurationVersion: 0,
    settings: normalizeChatSettings(structuredClone(input.settings ?? cloneDefaultChatSettings())),
    lastUpdatedLeafId: null,
    lastBranchUpdatedAt: now,
    archived: false,
    pinned: false,
    folderId: null,
    tags: [],
    previewText: '',
    ...(input.presetId === undefined ? {} : { presetId: input.presetId }),
    ...(input.temporary === true ? { temporary: true } : {}),
  }
}

type OptionalKeys<T> = {
  [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? K : never
}[keyof T]

export type ChatSettingsPatch = {
  [K in keyof ChatSettings]?: K extends OptionalKeys<ChatSettings>
    ? ChatSettings[K] | undefined
    : ChatSettings[K]
}

export interface SerializedChatSettingsPatch {
  set: Partial<ChatSettings>
  clear: readonly (keyof ChatSettings)[]
}

export interface PromptPresetSlot {
  textKey:
    | 'systemPrompt'
    | 'appendPrompt'
    | 'continueSystemPrompt'
    | 'continueUserPrompt'
    | 'defaultPrefill'
  pinKey:
    | 'systemPromptPresetId'
    | 'appendPromptPresetId'
    | 'continueSystemPromptPresetId'
    | 'continueUserPromptPresetId'
    | 'defaultPrefillPresetId'
}

const PROMPT_PRESET_SLOTS: Record<PromptPresetKind, PromptPresetSlot> = {
  system: { textKey: 'systemPrompt', pinKey: 'systemPromptPresetId' },
  append: { textKey: 'appendPrompt', pinKey: 'appendPromptPresetId' },
  'continue-system': {
    textKey: 'continueSystemPrompt',
    pinKey: 'continueSystemPromptPresetId',
  },
  'continue-user': {
    textKey: 'continueUserPrompt',
    pinKey: 'continueUserPromptPresetId',
  },
  prefill: { textKey: 'defaultPrefill', pinKey: 'defaultPrefillPresetId' },
}

export function promptPresetSlotForKind(kind: PromptPresetKind): PromptPresetSlot {
  return { ...PROMPT_PRESET_SLOTS[kind] }
}

export function applyLocalPromptValue(
  settings: ChatSettings,
  kind: PromptPresetKind,
  text: string,
): ChatSettings {
  const next = { ...settings }
  const slot = promptPresetSlotForKind(kind)
  ;(next as unknown as Record<string, unknown>)[slot.textKey] = text
  delete (next as Partial<ChatSettings>)[slot.pinKey]
  return next
}

type ChatSettingsFieldPath = readonly [keyof ChatSettings, ...string[]]

export type ChatSettingsFieldPatch =
  | {
      readonly path: ChatSettingsFieldPath
      readonly value?: unknown
      readonly membership?: never
    }
  | {
      readonly path: ChatSettingsFieldPath
      readonly membership: {
        readonly member: unknown
        readonly present: boolean
      }
      readonly value?: never
    }

export function serializeChatSettingsPatch(patch: ChatSettingsPatch): SerializedChatSettingsPatch {
  const set: Partial<ChatSettings> = {}
  const clear: Array<keyof ChatSettings> = []
  for (const key of Object.keys(patch) as Array<keyof ChatSettings>) {
    const value = patch[key]
    if (value === undefined) clear.push(key)
    else (set as Record<keyof ChatSettings, unknown>)[key] = structuredClone(value)
  }
  return { set, clear }
}

export function applyChatSettingsPatch(
  settings: ChatSettings,
  patch: ChatSettingsPatch,
): ChatSettings {
  const next = structuredClone(settings)
  const target = next as Record<keyof ChatSettings, unknown>
  for (const key of Object.keys(patch) as Array<keyof ChatSettings>) {
    const value = patch[key]
    if (value === undefined) delete (next as Partial<ChatSettings>)[key]
    else target[key] = structuredClone(value)
  }
  return normalizeChatSettings(next)
}

export function applySerializedChatSettingsPatch(
  settings: ChatSettings,
  patch: SerializedChatSettingsPatch,
): ChatSettings {
  const next = structuredClone(settings)
  for (const key of patch.clear) delete (next as Partial<ChatSettings>)[key]
  const target = next as Record<keyof ChatSettings, unknown>
  for (const key of Object.keys(patch.set) as Array<keyof ChatSettings>) {
    target[key] = structuredClone(patch.set[key])
  }
  return normalizeChatSettings(next)
}

export function applyChatSettingsFieldPatches(
  settings: ChatSettings,
  patches: readonly ChatSettingsFieldPatch[],
): ChatSettings {
  const next = structuredClone(settings) as unknown as Record<string, unknown>
  for (const patch of patches) {
    const path = patch.path.map(String)
    if (path.length === 0 || path.some(isUnsafeSettingsPathSegment)) {
      throw new Error('InvalidChatSettingsFieldPath')
    }
    let owner = next
    for (let index = 0; index < path.length - 1; index += 1) {
      const segment = path[index]
      if (segment === undefined) throw new Error('InvalidChatSettingsFieldPath')
      const value = owner[segment]
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        owner[segment] = {}
      }
      owner = owner[segment] as Record<string, unknown>
    }
    const leaf = path[path.length - 1]
    if (leaf === undefined) throw new Error('InvalidChatSettingsFieldPath')
    if (patch.membership) {
      const current = Array.isArray(owner[leaf]) ? (owner[leaf] as unknown[]) : []
      const index = current.findIndex((value) => sameJsonValue(value, patch.membership.member))
      if (patch.membership.present && index < 0) {
        owner[leaf] = [...current, structuredClone(patch.membership.member)]
      } else if (!patch.membership.present && index >= 0) {
        owner[leaf] = current.filter((_, candidateIndex) => candidateIndex !== index)
      }
    } else if (patch.value === undefined) delete owner[leaf]
    else owner[leaf] = structuredClone(patch.value)
  }
  return normalizeChatSettings(next as unknown as ChatSettings)
}

export function normalizeChatSettings(settings: ChatSettings): ChatSettings {
  const reasoning = normalizeReasoningSettings(settings.reasoning)
  return reasoning === settings.reasoning ? settings : { ...settings, reasoning }
}

export function sameChatSettings(left: ChatSettings, right: ChatSettings): boolean {
  return sameJsonValue(left, right)
}

export function uniqueChatTagNames(names: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of names) {
    const name = raw.trim()
    if (name.length === 0) continue
    const lower = chatTagNameLower(name)
    if (seen.has(lower)) continue
    seen.add(lower)
    result.push(name)
  }
  return result
}

export function chatTagNameLower(name: string): string {
  return name.trim().toLocaleLowerCase('en-US')
}

export function sameOrderedIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

const CHAT_SETTINGS_PROMPT_PIN_KEYS = [
  'systemPromptPresetId',
  'appendPromptPresetId',
  'continueSystemPromptPresetId',
  'continueUserPromptPresetId',
  'defaultPrefillPresetId',
] as const

const CHAT_SETTINGS_PROMPT_PIN_SLOTS = [
  ['system', 'systemPromptPresetId'],
  ['append', 'appendPromptPresetId'],
  ['continue-system', 'continueSystemPromptPresetId'],
  ['continue-user', 'continueUserPromptPresetId'],
  ['prefill', 'defaultPrefillPresetId'],
] as const satisfies readonly (readonly [
  PromptPresetKind,
  (typeof CHAT_SETTINGS_PROMPT_PIN_KEYS)[number],
])[]

export function chatSettingsPromptPresetReferences(
  settings: ChatSettings,
): readonly { readonly id: PromptPresetId; readonly kind: PromptPresetKind }[] {
  return CHAT_SETTINGS_PROMPT_PIN_SLOTS.flatMap(([kind, key]) => {
    const id = settings[key]
    return id ? [{ id, kind }] : []
  })
}

export function nextChatCalibrationGeneration(
  chat: Pick<Chat, 'tokenCalibrationGeneration'>,
): number {
  const current =
    typeof chat.tokenCalibrationGeneration === 'number' &&
    Number.isSafeInteger(chat.tokenCalibrationGeneration) &&
    chat.tokenCalibrationGeneration >= 0
      ? chat.tokenCalibrationGeneration
      : 0
  if (current >= Number.MAX_SAFE_INTEGER) throw new Error('ChatCalibrationGenerationExhausted')
  return current + 1
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (
    typeof left === 'number' &&
    typeof right === 'number' &&
    Number.isNaN(left) &&
    Number.isNaN(right)
  ) {
    return true
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false
    }
    return left.every((value, index) => sameJsonValue(value, right[index]))
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord).filter((key) => leftRecord[key] !== undefined)
  const rightKeys = Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every(
    (key) => Object.hasOwn(rightRecord, key) && sameJsonValue(leftRecord[key], rightRecord[key]),
  )
}

function isUnsafeSettingsPathSegment(segment: string): boolean {
  return segment === '__proto__' || segment === 'prototype' || segment === 'constructor'
}
