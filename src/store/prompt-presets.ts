// PromptPreset CRUD + pin-propagation. See `plan/02-data-model.md §2.6b`.
//
// A PromptPreset is a workspace-global, kind-scoped snapshot of a single
// prompt text (system / continue-system / continue-user). The chat's
// `{kind}Prompt` field is the canonical storage; `{kind}PromptPresetId` is
// an optional pin back to the preset. When the pin is set and the preset
// text changes, the chat's field is rewritten in the same transaction so
// downstream readers (daemon, transforms, UI) never need to consult the
// preset table.
//
// Pin semantics:
//   - Editing the text locally (through updateChatSettings) clears the pin —
//     that's the default action; the user chose "save to this chat only."
//   - Load preset -> sets pin + copies text.
//   - Save to existing (overwrite) -> updates preset text; pin stays.
//   - Save as new -> creates preset; pin to it.
//   - Delete preset -> clears pin on chats/ChatPresets; their last-propagated
//     text is preserved.

import type {
  Chat,
  ChatPreset,
  ChatSettings,
  PromptPreset,
  PromptPresetId,
  PromptPresetKind,
} from '../core/types'
import { newId } from '../lib/ulid'
import { postEvent } from './broadcast'
import { getDb } from './db'

export class PromptPresetMissingError extends Error {
  readonly presetId: PromptPresetId
  constructor(presetId: PromptPresetId) {
    super(`PromptPresetMissing:${presetId}`)
    this.name = 'PromptPresetMissingError'
    this.presetId = presetId
  }
}

// Maps a kind onto the two ChatSettings fields it controls. Keeps the rest
// of the file free of per-kind branching.
interface SlotAccessors {
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

const SLOTS: Record<PromptPresetKind, SlotAccessors> = {
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

export function slotFor(kind: PromptPresetKind): SlotAccessors {
  return SLOTS[kind]
}

export interface CreatePromptPresetInput {
  id?: PromptPresetId
  kind: PromptPresetKind
  name: string
  text: string
  now?: number
  lastUsedAt?: number
}

export async function createPromptPreset(
  input: CreatePromptPresetInput,
): Promise<PromptPreset> {
  const now = input.now ?? Date.now()
  const preset: PromptPreset = {
    id: input.id ?? newId(),
    kind: input.kind,
    name: input.name,
    text: input.text,
    createdAt: now,
    updatedAt: now,
  }
  if (input.lastUsedAt !== undefined) preset.lastUsedAt = input.lastUsedAt
  await getDb().promptPresets.put(preset)
  postEvent({ kind: 'prompt-preset-mutated', promptPresetId: preset.id })
  return preset
}

export async function getPromptPreset(
  presetId: PromptPresetId,
): Promise<PromptPreset | undefined> {
  return getDb().promptPresets.get(presetId)
}

export async function listPromptPresets(
  kind?: PromptPresetKind,
): Promise<PromptPreset[]> {
  const table = getDb().promptPresets
  const rows = kind ? await table.where('kind').equals(kind).toArray() : await table.toArray()
  rows.sort((a, b) => a.name.localeCompare(b.name))
  return rows
}

export interface UpdatePromptPresetPatch {
  name?: string
  text?: string
}

// Update a preset. When `text` changes, every chat / ChatPreset whose pin
// references this preset has its denormalized text field rewritten in the
// same transaction. Renames don't cascade.
export async function updatePromptPreset(
  presetId: PromptPresetId,
  patch: UpdatePromptPresetPatch,
  opts: { now?: number } = {},
): Promise<PromptPreset> {
  const db = getDb()
  const now = opts.now ?? Date.now()
  const touchedChats: Chat[] = []
  const touchedChatPresetIds: string[] = []
  const result = await db.transaction(
    'rw',
    db.promptPresets,
    db.chats,
    db.presets,
    async () => {
      const existing = await db.promptPresets.get(presetId)
      if (!existing) throw new PromptPresetMissingError(presetId)
      const next: PromptPreset = {
        ...existing,
        ...patch,
        id: existing.id,
        kind: existing.kind,
        createdAt: existing.createdAt,
        updatedAt: now,
      }
      await db.promptPresets.put(next)
      if (patch.text !== undefined && patch.text !== existing.text) {
        const slot = SLOTS[existing.kind]
        const chatHits: Chat[] = []
        await db.chats.toCollection().each((chat) => {
          if (chat.settings[slot.pinKey] === presetId) chatHits.push(chat)
        })
        for (const chat of chatHits) {
          const nextSettings: ChatSettings = { ...chat.settings }
          ;(nextSettings as unknown as Record<string, unknown>)[slot.textKey] = patch.text
          const written: Chat = { ...chat, settings: nextSettings, updatedAt: now }
          await db.chats.put(written)
          touchedChats.push(written)
        }
        const presetHits: ChatPreset[] = []
        await db.presets.toCollection().each((preset) => {
          if (preset.settings[slot.pinKey] === presetId) presetHits.push(preset)
        })
        for (const preset of presetHits) {
          const nextSettings: ChatSettings = { ...preset.settings }
          ;(nextSettings as unknown as Record<string, unknown>)[slot.textKey] = patch.text
          await db.presets.put({ ...preset, settings: nextSettings, updatedAt: now })
          touchedChatPresetIds.push(preset.id)
        }
      }
      return next
    },
  )
  postEvent({ kind: 'prompt-preset-mutated', promptPresetId: presetId })
  for (const chat of touchedChats) {
    postEvent({
      kind: 'chat-mutated',
      chatId: chat.id,
      metaVersion: chat.metaVersion,
      summaryVersion: chat.summaryVersion,
      affected: [{ kind: 'chat-meta', chatId: chat.id }],
    })
  }
  for (const id of touchedChatPresetIds) {
    postEvent({ kind: 'preset-mutated', presetId: id })
  }
  return result
}

// Delete a preset. Clears any pins pointing at it on chats + ChatPresets;
// preserves their denormalized text.
export async function deletePromptPreset(
  presetId: PromptPresetId,
  opts: { now?: number } = {},
): Promise<void> {
  const db = getDb()
  const now = opts.now ?? Date.now()
  const touchedChats: Chat[] = []
  const touchedChatPresetIds: string[] = []
  await db.transaction('rw', db.promptPresets, db.chats, db.presets, async () => {
    const existing = await db.promptPresets.get(presetId)
    if (!existing) throw new PromptPresetMissingError(presetId)
    const slot = SLOTS[existing.kind]
    const chatHits: Chat[] = []
    await db.chats.toCollection().each((chat) => {
      if (chat.settings[slot.pinKey] === presetId) chatHits.push(chat)
    })
    for (const chat of chatHits) {
      const nextSettings: ChatSettings = { ...chat.settings }
      delete (nextSettings as Partial<ChatSettings>)[slot.pinKey]
      const written: Chat = { ...chat, settings: nextSettings, updatedAt: now }
      await db.chats.put(written)
      touchedChats.push(written)
    }
    const presetHits: ChatPreset[] = []
    await db.presets.toCollection().each((preset) => {
      if (preset.settings[slot.pinKey] === presetId) presetHits.push(preset)
    })
    for (const preset of presetHits) {
      const nextSettings: ChatSettings = { ...preset.settings }
      delete (nextSettings as Partial<ChatSettings>)[slot.pinKey]
      await db.presets.put({ ...preset, settings: nextSettings, updatedAt: now })
      touchedChatPresetIds.push(preset.id)
    }
    await db.promptPresets.delete(presetId)
  })
  postEvent({ kind: 'prompt-preset-deleted', promptPresetId: presetId })
  for (const chat of touchedChats) {
    postEvent({
      kind: 'chat-mutated',
      chatId: chat.id,
      metaVersion: chat.metaVersion,
      summaryVersion: chat.summaryVersion,
      affected: [{ kind: 'chat-meta', chatId: chat.id }],
    })
  }
  for (const id of touchedChatPresetIds) {
    postEvent({ kind: 'preset-mutated', presetId: id })
  }
}

export async function bumpPromptPresetLastUsedAt(
  presetId: PromptPresetId,
  now = Date.now(),
): Promise<void> {
  const db = getDb()
  const existing = await db.promptPresets.get(presetId)
  if (!existing) return
  await db.promptPresets.put({ ...existing, lastUsedAt: now })
}
