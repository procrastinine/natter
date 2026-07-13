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

import type { PromptPreset, PromptPresetId, PromptPresetKind } from '../core/types'
import { newId } from '../lib/ulid'
import { runAuthoritativeTransaction } from './authoritative-write'
import { postEvent } from './broadcast'
import { getDb } from './db'
import { getWorkspaceRepository } from './workspace-repository'

type PromptSettingSaveFlusher = () => Promise<void>

const pendingPromptSettingSaves = new Map<string, Set<Promise<unknown>>>()
const promptSettingSaveFlushers = new Map<string, Set<PromptSettingSaveFlusher>>()

export function trackPendingPromptSettingSave<T>(chatId: string, save: Promise<T>): Promise<T> {
  let saves = pendingPromptSettingSaves.get(chatId)
  if (!saves) {
    saves = new Set()
    pendingPromptSettingSaves.set(chatId, saves)
  }
  const tracked = save.finally(() => {
    const current = pendingPromptSettingSaves.get(chatId)
    current?.delete(tracked)
    if (current?.size === 0) pendingPromptSettingSaves.delete(chatId)
  })
  saves.add(tracked)
  return tracked
}

export function registerPromptSettingSaveFlusher(
  chatId: string,
  flush: PromptSettingSaveFlusher,
): () => void {
  let flushers = promptSettingSaveFlushers.get(chatId)
  if (!flushers) {
    flushers = new Set()
    promptSettingSaveFlushers.set(chatId, flushers)
  }
  flushers.add(flush)
  return () => {
    const current = promptSettingSaveFlushers.get(chatId)
    current?.delete(flush)
    if (current?.size === 0) promptSettingSaveFlushers.delete(chatId)
  }
}

export async function flushPendingPromptSettingSaves(chatId: string): Promise<void> {
  const flushers = promptSettingSaveFlushers.get(chatId)
  const initial = [
    ...(pendingPromptSettingSaves.get(chatId) ?? []),
    ...[...(flushers ?? [])].map((flush) => flush()),
  ]
  if (initial.length > 0) {
    const results = await Promise.allSettled(initial)
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    if (failed) throw failed.reason
  }

  for (;;) {
    const pending = pendingPromptSettingSaves.get(chatId)
    if (!pending?.size) return
    const results = await Promise.allSettled([...pending])
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    if (failed) throw failed.reason
  }
}

export function __promptSettingSaveRegistrySizeForTests(): {
  pendingChats: number
  pendingSaves: number
  flusherChats: number
  flushers: number
} {
  return {
    pendingChats: pendingPromptSettingSaves.size,
    pendingSaves: [...pendingPromptSettingSaves.values()].reduce(
      (sum, saves) => sum + saves.size,
      0,
    ),
    flusherChats: promptSettingSaveFlushers.size,
    flushers: [...promptSettingSaveFlushers.values()].reduce(
      (sum, flushers) => sum + flushers.size,
      0,
    ),
  }
}

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

interface CreatePromptPresetInput {
  id?: PromptPresetId
  kind: PromptPresetKind
  name: string
  text: string
  now?: number
  lastUsedAt?: number
}

export async function createPromptPreset(input: CreatePromptPresetInput): Promise<PromptPreset> {
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
  const db = getDb()
  await runAuthoritativeTransaction({
    db,
    lockNames: [`prompt-preset:${preset.id}`],
    tables: [db.promptPresets, db.settings],
    now,
    write: async (tx) => {
      await tx.table('promptPresets').put(preset)
      return { value: undefined, changed: true }
    },
  })
  postEvent({ kind: 'prompt-preset-mutated', promptPresetId: preset.id })
  return preset
}

export async function getPromptPreset(presetId: PromptPresetId): Promise<PromptPreset | undefined> {
  return getDb().promptPresets.get(presetId)
}

export async function listPromptPresets(kind?: PromptPresetKind): Promise<PromptPreset[]> {
  const table = getDb().promptPresets
  const rows = kind ? await table.where('kind').equals(kind).toArray() : await table.toArray()
  rows.sort((a, b) => a.name.localeCompare(b.name))
  return rows
}

interface UpdatePromptPresetPatch {
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
  const now = opts.now ?? Date.now()
  const existing = await getDb().promptPresets.get(presetId)
  if (!existing) throw new PromptPresetMissingError(presetId)
  const result = await getWorkspaceRepository().updatePromptPresetAndPropagate({
    presetId,
    patch,
    slot: SLOTS[existing.kind],
    now,
  })
  if (result.kind === 'missing') throw new PromptPresetMissingError(presetId)
  return result.promptPreset
}

// Delete a preset. Clears any pins pointing at it on chats + ChatPresets;
// preserves their denormalized text.
export async function deletePromptPreset(
  presetId: PromptPresetId,
  opts: { now?: number } = {},
): Promise<void> {
  const now = opts.now ?? Date.now()
  const existing = await getDb().promptPresets.get(presetId)
  if (!existing) throw new PromptPresetMissingError(presetId)
  const result = await getWorkspaceRepository().deletePromptPresetAndClearPins({
    presetId,
    slot: SLOTS[existing.kind],
    now,
  })
  if (result.kind === 'missing') throw new PromptPresetMissingError(presetId)
}

export async function bumpPromptPresetLastUsedAt(
  presetId: PromptPresetId,
  now = Date.now(),
): Promise<void> {
  const db = getDb()
  await runAuthoritativeTransaction({
    db,
    lockNames: [`prompt-preset:${presetId}`],
    tables: [db.promptPresets, db.settings],
    now,
    write: async (tx) => {
      const table = tx.table<PromptPreset, PromptPresetId>('promptPresets')
      const existing = await table.get(presetId)
      if (!existing) return { value: undefined, changed: false }
      await table.put({ ...existing, lastUsedAt: now })
      return { value: undefined, changed: true }
    },
  })
}
