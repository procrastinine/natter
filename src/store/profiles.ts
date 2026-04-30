// ConnectionProfile CRUD + lifecycle. See `plan/02-data-model.md §2.6` and
// `plan/09-privacy.md §9.2.A`.
//
// Profiles describe an endpoint + creds bundle ("OpenRouter", "OpenAI direct",
// "Local llama.cpp"). Many ChatPresets can share one profile. Deletion is
// blocked while non-archived presets or chats reference it; a force path moves
// dependents into a "connection missing" state on explicit user request.

import type { ConnectionKind, ConnectionProfile, KeyId, ProfileId } from '../core/types'
import { newId } from '../lib/ulid'
import { postEvent } from './broadcast'
import { getDb } from './db'
import { clearEndpointsCacheForProfile, clearModelsCacheForProfile } from './models-cache'
import { clearPrivacyPoliciesForProfile, clearProvidersForProfile } from './privacy-cache'

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
  readonly presetIds: ProfileId[]
  readonly chatIds: string[]
  constructor(profileId: ProfileId, presetIds: ProfileId[], chatIds: string[]) {
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
function kindDefaults(
  kind: ConnectionKind,
  _baseUrl: string,
): {
  supportsEndpointsApi: boolean
  supportsGenerationApi: boolean
  supportsPrivacyScrape: boolean
} {
  switch (kind) {
    case 'openrouter':
      return {
        supportsEndpointsApi: true,
        supportsGenerationApi: true,
        supportsPrivacyScrape: true,
      }
    case 'openai-compatible': {
      return {
        supportsEndpointsApi: false,
        supportsGenerationApi: false,
        supportsPrivacyScrape: false,
      }
    }
    case 'anthropic':
    case 'google':
    case 'llama-server':
    case 'custom':
      return {
        supportsEndpointsApi: false,
        supportsGenerationApi: false,
        supportsPrivacyScrape: false,
      }
  }
}

export async function createProfile(input: CreateProfileInput): Promise<ConnectionProfile> {
  const now = input.now ?? Date.now()
  const defaults = kindDefaults(input.kind, input.baseUrl)
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
  await getDb().profiles.put(profile)
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
export async function countProfiles(
  opts: { includeArchived?: boolean } = {},
): Promise<number> {
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
  const db = getDb()
  const existing = await db.profiles.get(profileId)
  if (!existing) throw new ProfileMissingError(profileId)
  const now = opts.now ?? Date.now()
  const baseUrlChanged = patch.baseUrl !== undefined && patch.baseUrl !== existing.baseUrl
  const kindChanged = patch.kind !== undefined && patch.kind !== existing.kind
  const kindOverrides: Partial<ConnectionProfile> = {}
  if (kindChanged) {
    const effectiveBaseUrl = patch.baseUrl ?? existing.baseUrl
    const defaults = kindDefaults(patch.kind as ConnectionKind, effectiveBaseUrl)
    if (patch.supportsEndpointsApi === undefined) {
      kindOverrides.supportsEndpointsApi = defaults.supportsEndpointsApi
    }
    if (patch.supportsGenerationApi === undefined) {
      kindOverrides.supportsGenerationApi = defaults.supportsGenerationApi
    }
    if (patch.supportsPrivacyScrape === undefined) {
      kindOverrides.supportsPrivacyScrape = defaults.supportsPrivacyScrape
    }
  }
  const next: ConnectionProfile = {
    ...existing,
    ...patch,
    ...kindOverrides,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: now,
  }
  await db.profiles.put(next)
  if (baseUrlChanged || kindChanged) {
    await invalidateCachesForProfile(profileId)
  }
  postEvent({ kind: 'profile-mutated', profileId })
  return next
}

async function invalidateCachesForProfile(profileId: ProfileId): Promise<void> {
  const db = getDb()
  await Promise.all([
    clearModelsCacheForProfile(profileId),
    clearEndpointsCacheForProfile(profileId),
    clearPrivacyPoliciesForProfile(profileId),
    clearProvidersForProfile(profileId),
    db.presetResolutions.where('profileId').equals(profileId).delete(),
  ])
}

export async function duplicateProfile(
  sourceId: ProfileId,
  opts: { name?: string; now?: number } = {},
): Promise<ConnectionProfile> {
  const source = await getProfile(sourceId)
  if (!source) throw new ProfileMissingError(sourceId)
  const now = opts.now ?? Date.now()
  const copy: ConnectionProfile = {
    ...source,
    id: newId(),
    name: opts.name ?? `${source.name} (copy)`,
    createdAt: now,
    updatedAt: now,
  }
  delete copy.lastUsedAt
  copy.archived = false
  await getDb().profiles.put(copy)
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
  const existing = await db.profiles.get(profileId)
  if (!existing) return
  await db.profiles.put({ ...existing, lastUsedAt: now })
}

// Returns the non-archived presets and non-archived chats that reference this
// profile. Used by delete() to compute the blocker set and by the UI to show
// "Move N presets and M chats to a replacement."
export async function profileDependents(
  profileId: ProfileId,
): Promise<{ presetIds: ProfileId[]; chatIds: string[] }> {
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
  const db = getDb()
  const existing = await db.profiles.get(profileId)
  if (!existing) throw new ProfileMissingError(profileId)
  const deps = await profileDependents(profileId)
  if (opts.reassignTo !== undefined) {
    const target = await db.profiles.get(opts.reassignTo)
    if (!target) throw new ProfileMissingError(opts.reassignTo)
    const now = opts.now ?? Date.now()
    await reassignDependents(profileId, opts.reassignTo, now)
  } else if (!opts.force) {
    if (deps.presetIds.length > 0 || deps.chatIds.length > 0) {
      throw new ProfileInUseError(profileId, deps.presetIds, deps.chatIds)
    }
  }
  await db.profiles.delete(profileId)
  await invalidateCachesForProfile(profileId)
  // Drop the primary KeyRecord iff no other profile still references it.
  const otherRefs = await db.profiles.filter((p) => p.apiKeyRef === existing.apiKeyRef).count()
  if (otherRefs === 0) await db.keys.delete(existing.apiKeyRef)
  postEvent({ kind: 'profile-deleted', profileId })
}

async function reassignDependents(from: ProfileId, to: ProfileId, now: number): Promise<void> {
  const db = getDb()
  const presets = await db.presets.where('connectionProfileId').equals(from).toArray()
  for (const preset of presets) {
    await db.presets.put({
      ...preset,
      connectionProfileId: to,
      settings: { ...preset.settings, profileId: to },
      updatedAt: now,
    })
    postEvent({ kind: 'preset-mutated', presetId: preset.id })
  }
  const chats = await db.chats.toArray()
  for (const chat of chats) {
    if (chat.settings.profileId !== from) continue
    await db.chats.put({
      ...chat,
      settings: { ...chat.settings, profileId: to },
      updatedAt: now,
    })
    postEvent({
      kind: 'chat-mutated',
      chatId: chat.id,
      metaVersion: chat.metaVersion,
      summaryVersion: chat.summaryVersion,
      affected: [{ kind: 'chat-meta', chatId: chat.id }],
    })
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
