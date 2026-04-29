// ChatPreset CRUD + MRU selection. See `plan/02-data-model.md §2.6a` and
// `plan/09-privacy.md §9.2.B`.
//
// A preset is a named ChatSettings bundle pinned to a ConnectionProfile. Many
// presets can share one profile. Preset edits do NOT propagate to chats that
// were already created from the preset — chats are their own snapshots. The
// MRU preset (greatest non-archived `lastUsedAt`) seeds new chats per §9.2.1.

import type { ChatPreset, ChatSettings, PresetId, ProfileId } from '../core/types'
import { newId } from '../lib/ulid'
import {
  DEFAULT_OPENROUTER_PROVIDER_SORT,
  migrateLegacyProviderSettings,
} from '../backcompat/provider-settings'
import { postEvent } from './broadcast'
import { getDb } from './db'
import { ProfileMissingError } from './profiles'

export class PresetMissingError extends Error {
  readonly presetId: PresetId
  constructor(presetId: PresetId) {
    super(`PresetMissing:${presetId}`)
    this.name = 'PresetMissingError'
    this.presetId = presetId
  }
}

interface CreatePresetInput {
  id?: PresetId
  name: string
  connectionProfileId: ProfileId
  settings: ChatSettings
  now?: number
  lastUsedAt?: number
}

export async function createPreset(input: CreatePresetInput): Promise<ChatPreset> {
  const db = getDb()
  const profile = await db.profiles.get(input.connectionProfileId)
  if (!profile) throw new ProfileMissingError(input.connectionProfileId)
  const now = input.now ?? Date.now()
  const preset: ChatPreset = {
    id: input.id ?? newId(),
    name: input.name,
    connectionProfileId: input.connectionProfileId,
    // `settings.profileId` is kept in sync with `connectionProfileId` (§2.6a).
    settings: normalizePresetSettings(input.settings, input.connectionProfileId, profile.kind),
    createdAt: now,
    updatedAt: now,
  }
  if (input.lastUsedAt !== undefined) preset.lastUsedAt = input.lastUsedAt
  await db.presets.put(preset)
  postEvent({ kind: 'preset-mutated', presetId: preset.id })
  return preset
}

export async function getPreset(presetId: PresetId): Promise<ChatPreset | undefined> {
  return getDb().presets.get(presetId)
}

export async function listPresets(opts: { includeArchived?: boolean } = {}): Promise<ChatPreset[]> {
  const rows = await getDb().presets.toArray()
  return opts.includeArchived ? rows : rows.filter((p) => p.archived !== true)
}

export async function updatePreset(
  presetId: PresetId,
  patch: Partial<Omit<ChatPreset, 'id' | 'createdAt'>>,
  opts: { now?: number } = {},
): Promise<ChatPreset> {
  const db = getDb()
  const existing = await db.presets.get(presetId)
  if (!existing) throw new PresetMissingError(presetId)
  const now = opts.now ?? Date.now()
  const next: ChatPreset = {
    ...existing,
    ...patch,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: now,
  }
  // Keep `settings.profileId` aligned with `connectionProfileId`.
  const targetProfileId = patch.connectionProfileId ?? existing.connectionProfileId
  if (patch.connectionProfileId !== undefined || patch.settings) {
    const targetProfile = await db.profiles.get(targetProfileId)
    if (!targetProfile) throw new ProfileMissingError(targetProfileId)
    next.settings = normalizePresetSettings(next.settings, targetProfileId, targetProfile.kind)
  }
  await db.presets.put(next)
  postEvent({ kind: 'preset-mutated', presetId })
  return next
}

export async function duplicatePreset(
  sourceId: PresetId,
  opts: { name?: string; now?: number } = {},
): Promise<ChatPreset> {
  const source = await getPreset(sourceId)
  if (!source) throw new PresetMissingError(sourceId)
  const now = opts.now ?? Date.now()
  const copy: ChatPreset = {
    ...source,
    id: newId(),
    name: opts.name ?? `${source.name} (copy)`,
    settings: { ...source.settings },
    createdAt: now,
    updatedAt: now,
  }
  delete copy.lastUsedAt
  copy.archived = false
  await getDb().presets.put(copy)
  postEvent({ kind: 'preset-mutated', presetId: copy.id })
  return copy
}

function normalizePresetSettings(
  settings: ChatSettings,
  profileId: ProfileId,
  kind: string,
): ChatSettings {
  const aligned = { ...settings, profileId }
  if (kind !== 'openrouter') return aligned
  return migrateLegacyProviderSettings(aligned, {
    defaultSort: DEFAULT_OPENROUTER_PROVIDER_SORT,
  }).settings
}

export async function archivePreset(presetId: PresetId, now = Date.now()): Promise<void> {
  await updatePreset(presetId, { archived: true }, { now })
}

export async function unarchivePreset(presetId: PresetId, now = Date.now()): Promise<void> {
  await updatePreset(presetId, { archived: false }, { now })
}

// Delete a preset. Chats that were created from this preset keep their
// settings; their `presetId` breadcrumb is cleared. See §9.2.B.
export async function deletePreset(presetId: PresetId, opts: { now?: number } = {}): Promise<void> {
  const db = getDb()
  const existing = await db.presets.get(presetId)
  if (!existing) throw new PresetMissingError(presetId)
  const now = opts.now ?? Date.now()
  const chats = await db.chats.where('presetId').equals(presetId).toArray()
  for (const chat of chats) {
    const { presetId: _, ...rest } = chat
    await db.chats.put({ ...rest, updatedAt: now })
    postEvent({
      kind: 'chat-mutated',
      chatId: chat.id,
      metaVersion: chat.metaVersion,
      summaryVersion: chat.summaryVersion,
      affected: [{ kind: 'chat-meta', chatId: chat.id }],
    })
  }
  await db.presets.delete(presetId)
  postEvent({ kind: 'preset-deleted', presetId })
}

export async function bumpPresetLastUsedAt(presetId: PresetId, now = Date.now()): Promise<void> {
  const db = getDb()
  const existing = await db.presets.get(presetId)
  if (!existing) return
  await db.presets.put({ ...existing, lastUsedAt: now })
}

function pickDefaultPreset(rows: ChatPreset[]): ChatPreset | null {
  if (rows.length === 0) return null
  const withLastUsed = rows.filter((p) => p.lastUsedAt !== undefined)
  if (withLastUsed.length > 0) {
    withLastUsed.sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
    return withLastUsed[0] ?? null
  }
  const sorted = [...rows].sort((a, b) => a.createdAt - b.createdAt)
  return sorted[0] ?? null
}

// Selects the default preset for new chats per §9.2.1:
//   1. Non-archived with greatest `lastUsedAt`.
//   2. (Fresh install) first non-archived preset by `createdAt` ascending.
//   3. `null` when no presets exist.
export async function pickMruPreset(): Promise<ChatPreset | null> {
  return pickDefaultPreset(await listPresets())
}

export async function pickMruPresetForProfile(profileId: ProfileId): Promise<ChatPreset | null> {
  const active = await listPresets()
  return pickDefaultPreset(active.filter((p) => p.connectionProfileId === profileId))
}

export async function pickPreferredPreset(opts: {
  presetId?: PresetId | null
  profileId?: ProfileId | null
} = {}): Promise<ChatPreset | null> {
  if (opts.presetId) {
    const preset = await getPreset(opts.presetId)
    if (
      preset &&
      preset.archived !== true &&
      (opts.profileId === undefined ||
        opts.profileId === null ||
        preset.connectionProfileId === opts.profileId)
    ) {
      return preset
    }
  }
  if (opts.profileId) {
    const scoped = await pickMruPresetForProfile(opts.profileId)
    if (scoped) return scoped
  }
  return pickMruPreset()
}

// Per-preset JSON export. Strips `lastUsedAt`/`archived` and includes a
// `connectionSketch` so the importer can suggest a matching connection. No key
// material travels with the export; the importer wires up a key. See §9.2.B.
interface PresetExport {
  schemaVersion: 1
  preset: Omit<ChatPreset, 'lastUsedAt' | 'archived'>
  connectionSketch: {
    name: string
    kind: string
    baseUrl: string
  }
}

export async function exportPreset(presetId: PresetId): Promise<PresetExport> {
  const preset = await getPreset(presetId)
  if (!preset) throw new PresetMissingError(presetId)
  const profile = await getDb().profiles.get(preset.connectionProfileId)
  if (!profile) throw new ProfileMissingError(preset.connectionProfileId)
  const { lastUsedAt: _lastUsedAt, archived: _archived, ...rest } = preset
  return {
    schemaVersion: 1,
    preset: rest,
    connectionSketch: {
      name: profile.name,
      kind: profile.kind,
      baseUrl: profile.baseUrl,
    },
  }
}
