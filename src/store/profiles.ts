// Profiles describe an endpoint + creds bundle ("OpenRouter", "OpenAI direct",
// "Local llama.cpp"). Many ChatPresets can share one profile. Deletion is
// blocked while non-archived presets or chats reference it; a force path moves
// dependents into a "connection missing" state on explicit user request.

import { connectionKindDefaults } from '../core/connection-defaults'
import type { ConnectionKind, ConnectionProfile, KeyId, PresetId, ProfileId } from '../core/types'
import { newId } from '../lib/ulid'
import { runAuthoritativeTransaction } from './authoritative-write'
import { postEvent } from './broadcast'
import { getDb } from './db'
import { getWorkspaceRepository } from './workspace-repository'

export class ProfileMissingError extends Error {
  readonly profileId: ProfileId
  constructor(profileId: ProfileId) {
    super(`ProfileMissing:${profileId}`)
    this.name = 'ProfileMissingError'
    this.profileId = profileId
  }
}

export class ProfileInUseError extends Error {
  readonly profileId: ProfileId
  readonly presetIds: PresetId[]
  readonly chatIds: string[]
  constructor(profileId: ProfileId, presetIds: PresetId[], chatIds: string[]) {
    super(`ProfileInUse:${profileId}:presets=${presetIds.length}:chats=${chatIds.length}`)
    this.name = 'ProfileInUseError'
    this.profileId = profileId
    this.presetIds = presetIds
    this.chatIds = chatIds
  }
}

interface CreateProfileInput {
  id?: ProfileId
  name: string
  kind: ConnectionKind
  baseUrl: string
  apiKeyRef: KeyId
  apiKeyFallbackRefs?: KeyId[]
  managementApiKeyRef?: KeyId
  defaultHeaders?: Record<string, string>
  appTitle?: string
  appUrl?: string
  appCategories?: string[]
  supportsEndpointsApi?: boolean
  supportsGenerationApi?: boolean
  supportsPrivacyScrape?: boolean
  capabilityOverrides?: Record<string, Partial<unknown>>
  debugRequests?: boolean
  now?: number
}

// Kind-specific defaults for connection capabilities. OpenRouter gets the full
// feature set; everything else is conservative. Provider transport modes live
// on ChatSettings, not on the connection profile.
export async function createProfile(input: CreateProfileInput): Promise<ConnectionProfile> {
  const now = input.now ?? Date.now()
  const defaults = connectionKindDefaults(input.kind, input.baseUrl)
  const profile: ConnectionProfile = {
    id: input.id ?? newId(),
    name: input.name,
    kind: input.kind,
    baseUrl: input.baseUrl,
    apiKeyRef: input.apiKeyRef,
    defaultHeaders: input.defaultHeaders ?? {},
    appTitle: input.appTitle ?? 'llm-api-frontend',
    appUrl: input.appUrl ?? '',
    supportsEndpointsApi: input.supportsEndpointsApi ?? defaults.supportsEndpointsApi,
    supportsGenerationApi: input.supportsGenerationApi ?? defaults.supportsGenerationApi,
    supportsPrivacyScrape: input.supportsPrivacyScrape ?? defaults.supportsPrivacyScrape,
    createdAt: now,
    updatedAt: now,
  }
  if (input.apiKeyFallbackRefs?.length) {
    profile.apiKeyFallbackRefs = [...input.apiKeyFallbackRefs]
  }
  if (input.managementApiKeyRef !== undefined) {
    profile.managementApiKeyRef = input.managementApiKeyRef
  }
  if (input.appCategories?.length) profile.appCategories = [...input.appCategories]
  if (input.debugRequests !== undefined) profile.debugRequests = input.debugRequests
  const db = getDb()
  await runAuthoritativeTransaction({
    db,
    lockNames: [`profile:${profile.id}`],
    tables: [db.profiles, db.settings],
    now,
    write: async (tx) => {
      await tx.table('profiles').put(profile)
      return { value: undefined, changed: true }
    },
  })
  postEvent({ kind: 'profile-mutated', profileId: profile.id })
  return profile
}

export async function getProfile(profileId: ProfileId): Promise<ConnectionProfile | undefined> {
  return getDb().profiles.get(profileId)
}

export async function listProfiles(
  opts: { includeArchived?: boolean } = {},
): Promise<ConnectionProfile[]> {
  const rows = await getDb().profiles.toArray()
  return opts.includeArchived ? rows : rows.filter((p) => p.archived !== true)
}

// Count non-archived profiles. Cheaper than `listProfiles().length` when
// used for reactive "is a connection configured?" checks that don't need
// the row contents. Goes through the store layer so daemon-mode can wire a
// COUNT query behind the same signature.
export async function countProfiles(opts: { includeArchived?: boolean } = {}): Promise<number> {
  const rows = await getDb().profiles.toArray()
  return opts.includeArchived ? rows.length : rows.filter((p) => p.archived !== true).length
}

// Shallow patch of a profile. Honors two implicit cache-invalidation rules:
// (1) changing `baseUrl` drops /models, /endpoints, /privacyPolicies, and
//     /providers caches for this profile (§9.2.A: "Changing baseUrl flushes
//     cached endpoints/models/providers/privacyPolicies/presetResolutions"),
// (2) `updatedAt` is bumped on any successful change, and
// (3) changing `kind` re-applies kindDefaults() for the capability flags —
//     otherwise the old kind's flags persist (e.g. a profile switched from
//     openrouter to custom would keep `supportsEndpointsApi: true` and spam
//     /models/<id>/endpoints against a local server that doesn't implement it).
//     Callers can still override any flag by including it in `patch`.
export async function updateProfile(
  profileId: ProfileId,
  patch: Partial<Omit<ConnectionProfile, 'id' | 'createdAt'>>,
  opts: { now?: number } = {},
): Promise<ConnectionProfile> {
  const now = opts.now ?? Date.now()
  const result = await getWorkspaceRepository().updateProfileAndInvalidateCaches({
    profileId,
    patch,
    now,
  })
  if (result.kind === 'missing') throw new ProfileMissingError(profileId)
  return result.profile
}

export async function duplicateProfile(
  sourceId: ProfileId,
  opts: { name?: string; now?: number } = {},
): Promise<ConnectionProfile> {
  const now = opts.now ?? Date.now()
  const copyId = newId()
  const db = getDb()
  const { value: copy } = await runAuthoritativeTransaction({
    db,
    lockNames: [`profile:${sourceId}`, `profile:${copyId}`],
    tables: [db.profiles, db.settings],
    now,
    write: async (tx) => {
      const source = await tx.table<ConnectionProfile, ProfileId>('profiles').get(sourceId)
      if (!source) throw new ProfileMissingError(sourceId)
      const next: ConnectionProfile = {
        ...source,
        id: copyId,
        name: opts.name ?? `${source.name} (copy)`,
        createdAt: now,
        updatedAt: now,
        archived: false,
      }
      delete next.lastUsedAt
      await tx.table('profiles').put(next)
      return { value: next, changed: true }
    },
  })
  postEvent({ kind: 'profile-mutated', profileId: copy.id })
  return copy
}

export async function archiveProfile(profileId: ProfileId, now = Date.now()): Promise<void> {
  await updateProfile(profileId, { archived: true }, { now })
}

export async function unarchiveProfile(profileId: ProfileId, now = Date.now()): Promise<void> {
  await updateProfile(profileId, { archived: false }, { now })
}

export async function bumpProfileLastUsedAt(profileId: ProfileId, now = Date.now()): Promise<void> {
  const db = getDb()
  await runAuthoritativeTransaction({
    db,
    lockNames: [`profile:${profileId}`],
    tables: [db.profiles, db.settings],
    now,
    write: async (tx) => {
      const table = tx.table<ConnectionProfile, ProfileId>('profiles')
      const existing = await table.get(profileId)
      if (!existing) return { value: undefined, changed: false }
      await table.put({ ...existing, lastUsedAt: now })
      return { value: undefined, changed: true }
    },
  })
}

// Returns the non-archived presets and non-archived chats that reference this
// profile. Used by delete() to compute the blocker set and by the UI to show
// "Move N presets and M chats to a replacement."
export async function profileDependents(
  profileId: ProfileId,
): Promise<{ presetIds: PresetId[]; chatIds: string[] }> {
  const db = getDb()
  const presets = await db.presets.where('connectionProfileId').equals(profileId).toArray()
  const chats = await db.chats.toArray()
  return {
    presetIds: presets.filter((p) => p.archived !== true).map((p) => p.id),
    chatIds: chats
      .filter((c) => c.archived !== true && c.settings.profileId === profileId)
      .map((c) => c.id),
  }
}

interface DeleteProfileOptions {
  force?: boolean
  reassignTo?: ProfileId
  now?: number
}

// Hard-delete a connection profile. Behavior depends on options:
// - No options: throws `ProfileInUseError` if any non-archived preset or chat
//   references this profile. Safe default per §9.2.A.
// - `reassignTo`: rewrites referencing presets and chats to the target profile
//   before deletion. Throws if the target doesn't exist.
// - `force: true`: proceed despite dependents. Presets/chats are left pointing
//   at the now-deleted id; the UI shows a "connection missing" state.
export async function deleteProfile(
  profileId: ProfileId,
  opts: DeleteProfileOptions = {},
): Promise<void> {
  const result = await getWorkspaceRepository().deleteProfileAndReassign({
    profileId,
    ...(opts.force === undefined ? {} : { force: opts.force }),
    ...(opts.reassignTo === undefined ? {} : { reassignTo: opts.reassignTo }),
    now: opts.now ?? Date.now(),
  })
  if (result.kind === 'missing-profile' || result.kind === 'missing-target') {
    throw new ProfileMissingError(result.profileId)
  }
  if (result.kind === 'in-use') {
    throw new ProfileInUseError(profileId, result.presetIds, result.chatIds)
  }
}

// Per-profile JSON export. Strips `apiKeyRef` and `managementApiKeyRef` so no
// key material rides along — the importer wires up a new KeyRecord. See
// §9.2.A "Export / Import".
interface ProfileExport {
  schemaVersion: 1
  profile: Omit<
    ConnectionProfile,
    'apiKeyRef' | 'apiKeyFallbackRefs' | 'managementApiKeyRef' | 'lastUsedAt' | 'archived'
  >
}

export async function exportProfile(profileId: ProfileId): Promise<ProfileExport> {
  const profile = await getProfile(profileId)
  if (!profile) throw new ProfileMissingError(profileId)
  const {
    apiKeyRef: _apiKeyRef,
    apiKeyFallbackRefs: _apiKeyFallbackRefs,
    managementApiKeyRef: _managementApiKeyRef,
    lastUsedAt: _lastUsedAt,
    archived: _archived,
    ...rest
  } = profile
  return { schemaVersion: 1, profile: rest }
}
