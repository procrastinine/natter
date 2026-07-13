// A preset is a named ChatSettings bundle pinned to a ConnectionProfile. Many
// presets can share one profile. Preset edits do NOT propagate to chats that
// were already created from the preset — chats are their own snapshots. The
// MRU preset (greatest non-archived `lastUsedAt`) seeds new chats.

import { withProfileApiDefaults } from '../core/provider-defaults'
import type {
  ChatPreset,
  ChatSettings,
  ConnectionProfile,
  PresetId,
  ProfileId,
} from '../core/types'
import { newId } from '../lib/ulid'
import { runAuthoritativeTransaction } from './authoritative-write'
import { postEvent } from './broadcast'
import { getDb } from './db'
import { ProfileMissingError } from './profiles'
import { getWorkspaceRepository } from './workspace-repository'

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
  sortIndex?: number
  now?: number
  lastUsedAt?: number
}

export async function createPreset(input: CreatePresetInput): Promise<ChatPreset> {
  const db = getDb()
  const now = input.now ?? Date.now()
  const presetId = input.id ?? newId()
  const { value: preset } = await runAuthoritativeTransaction({
    db,
    lockNames: [`preset:${presetId}`, 'presets:order'],
    tables: [db.presets, db.profiles, db.settings],
    now,
    write: async (tx) => {
      const profile = await tx
        .table<ConnectionProfile, ProfileId>('profiles')
        .get(input.connectionProfileId)
      if (!profile) throw new ProfileMissingError(input.connectionProfileId)
      const rows =
        input.sortIndex === undefined ? await tx.table<ChatPreset>('presets').toArray() : []
      const row: ChatPreset = {
        id: presetId,
        name: input.name,
        connectionProfileId: input.connectionProfileId,
        settings: normalizePresetSettings(input.settings, input.connectionProfileId, profile),
        sortIndex:
          input.sortIndex ??
          (rows.length === 0 ? 0 : Math.max(...rows.map((candidate) => candidate.sortIndex)) + 1),
        createdAt: now,
        updatedAt: now,
      }
      if (input.lastUsedAt !== undefined) row.lastUsedAt = input.lastUsedAt
      await tx.table('presets').put(row)
      return { value: row, changed: true }
    },
  })
  postEvent({ kind: 'preset-mutated', presetId: preset.id })
  return preset
}

export async function getPreset(presetId: PresetId): Promise<ChatPreset | undefined> {
  return getDb().presets.get(presetId)
}

export async function listPresets(opts: { includeArchived?: boolean } = {}): Promise<ChatPreset[]> {
  const rows = await getDb().presets.toArray()
  const visible = opts.includeArchived ? rows : rows.filter((p) => p.archived !== true)
  return sortPresetsForPicker(visible)
}

export async function updatePreset(
  presetId: PresetId,
  patch: Partial<Omit<ChatPreset, 'id' | 'createdAt'>>,
  opts: { now?: number } = {},
): Promise<ChatPreset> {
  const db = getDb()
  const now = opts.now ?? Date.now()
  const { value: next } = await runAuthoritativeTransaction({
    db,
    lockNames: [`preset:${presetId}`],
    tables: [db.presets, db.profiles, db.settings],
    now,
    write: async (tx) => {
      const table = tx.table<ChatPreset, PresetId>('presets')
      const existing = await table.get(presetId)
      if (!existing) throw new PresetMissingError(presetId)
      const row: ChatPreset = {
        ...existing,
        ...patch,
        id: existing.id,
        createdAt: existing.createdAt,
        updatedAt: now,
      }
      const targetProfileId = patch.connectionProfileId ?? existing.connectionProfileId
      if (patch.connectionProfileId !== undefined || patch.settings) {
        const targetProfile = await tx
          .table<ConnectionProfile, ProfileId>('profiles')
          .get(targetProfileId)
        if (!targetProfile) throw new ProfileMissingError(targetProfileId)
        row.settings = normalizePresetSettings(row.settings, targetProfileId, targetProfile)
      }
      await table.put(row)
      return { value: row, changed: true }
    },
  })
  postEvent({ kind: 'preset-mutated', presetId })
  return next
}

export async function duplicatePreset(
  sourceId: PresetId,
  opts: { name?: string; now?: number } = {},
): Promise<ChatPreset> {
  const now = opts.now ?? Date.now()
  const copyId = newId()
  const db = getDb()
  const { value: copy } = await runAuthoritativeTransaction({
    db,
    lockNames: [`preset:${sourceId}`, `preset:${copyId}`, 'presets:order'],
    tables: [db.presets, db.settings],
    now,
    write: async (tx) => {
      const table = tx.table<ChatPreset, PresetId>('presets')
      const source = await table.get(sourceId)
      if (!source) throw new PresetMissingError(sourceId)
      const rows = await table.toArray()
      const next: ChatPreset = {
        ...source,
        id: copyId,
        name: opts.name ?? `${source.name} (copy)`,
        settings: { ...source.settings },
        sortIndex:
          rows.length === 0 ? 0 : Math.max(...rows.map((candidate) => candidate.sortIndex)) + 1,
        createdAt: now,
        updatedAt: now,
        archived: false,
      }
      delete next.lastUsedAt
      await table.put(next)
      return { value: next, changed: true }
    },
  })
  postEvent({ kind: 'preset-mutated', presetId: copy.id })
  return copy
}

export async function reorderPresets(
  orderedIds: readonly PresetId[],
  opts: { now?: number } = {},
): Promise<void> {
  const db = getDb()
  const ids = Array.from(new Set(orderedIds))
  const now = opts.now ?? Date.now()
  const { value: updates } = await runAuthoritativeTransaction({
    db,
    lockNames: ['presets:order'],
    tables: [db.presets, db.settings],
    now,
    write: async (tx) => {
      const table = tx.table<ChatPreset, PresetId>('presets')
      const rows = await table.bulkGet(ids)
      const next: ChatPreset[] = []
      for (const [index, id] of ids.entries()) {
        const row = rows[index]
        if (!row) throw new PresetMissingError(id)
        if (row.sortIndex === index) continue
        next.push({ ...row, sortIndex: index, updatedAt: now })
      }
      if (next.length > 0) await table.bulkPut(next)
      return { value: next, changed: next.length > 0 }
    },
  })
  if (updates.length === 0) return
  for (const row of updates) {
    postEvent({ kind: 'preset-mutated', presetId: row.id })
  }
}

function sortPresetsForPicker(rows: ChatPreset[]): ChatPreset[] {
  return rows.sort((left, right) => {
    if (left.sortIndex !== right.sortIndex) return left.sortIndex - right.sortIndex
    if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt
    return left.id.localeCompare(right.id)
  })
}

function normalizePresetSettings(
  settings: ChatSettings,
  profileId: ProfileId,
  profile: ConnectionProfile,
): ChatSettings {
  const aligned = { ...settings, profileId }
  return withProfileApiDefaults(aligned, profile)
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
  const now = opts.now ?? Date.now()
  const result = await getWorkspaceRepository().deletePresetAndClearBreadcrumbs(presetId, now)
  if (result.kind === 'missing') throw new PresetMissingError(presetId)
}

export async function bumpPresetLastUsedAt(presetId: PresetId, now = Date.now()): Promise<void> {
  const db = getDb()
  await runAuthoritativeTransaction({
    db,
    lockNames: [`preset:${presetId}`],
    tables: [db.presets, db.settings],
    now,
    write: async (tx) => {
      const table = tx.table<ChatPreset, PresetId>('presets')
      const existing = await table.get(presetId)
      if (!existing) return { value: undefined, changed: false }
      await table.put({ ...existing, lastUsedAt: now })
      return { value: undefined, changed: true }
    },
  })
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

export async function pickPreferredPreset(
  opts: { presetId?: PresetId | null; profileId?: ProfileId | null } = {},
): Promise<ChatPreset | null> {
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
