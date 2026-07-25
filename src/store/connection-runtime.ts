import {
  type ConnectionDispatchProfileProof,
  connectionDispatchKeyRefs,
} from '../core/connection-dispatch-proof'
import type { ChatId, ConnectionProfile, KeyId, KeyRecord, ProfileId } from '../core/types'
import { raceWithAbortSignal } from '../lib/abort'
import { captureKeyForDispatch, getKey } from './keys'
import type { WorkspaceWriteAuthority } from './workspace-protocol'
import { registerWorkspaceTabSessionParticipant } from './workspace-tab-session'

export const CONNECTION_RUNTIME_KEY_PREFERENCE_LIMIT = 256

export interface ConnectionRuntimeKeyCandidate {
  readonly ref: KeyId | null
  readonly index: number
  readonly resolve: () => Promise<string>
}

interface ConnectionRuntimeKeyIssue {
  readonly ref: KeyId
  readonly index: number
  readonly kind: 'missing'
}

export class ConnectionRuntimeKeysUnavailableError extends Error {
  readonly profileId: ProfileId
  readonly issues: readonly ConnectionRuntimeKeyIssue[]

  constructor(profileId: ProfileId, issues: readonly ConnectionRuntimeKeyIssue[]) {
    super(`ConnectionRuntimeKeysUnavailable:${profileId}:missing=${issues.length}`)
    this.name = 'ConnectionRuntimeKeysUnavailableError'
    this.profileId = profileId
    this.issues = Object.freeze(issues.map((issue) => Object.freeze({ ...issue })))
  }
}

interface ConnectionRuntimeKeyAccess {
  exists: (ref: KeyId) => Promise<boolean>
  resolve: (ref: KeyId) => Promise<string>
}

export interface CapturedConnectionRuntimeKeys {
  readonly candidates: readonly ConnectionRuntimeKeyCandidate[]
}

export interface CapturedConnectionRuntimeKeyPreference {
  readonly ref: KeyId | null
}

interface ConnectionRuntimeKeyPreference {
  readonly profileId: ProfileId
  readonly ref: KeyId
}

export class ConnectionRuntimeKeyPreferenceSession {
  private readonly preferredKeyByChat = new Map<ChatId, ConnectionRuntimeKeyPreference>()
  private readonly limit: number

  constructor(limit: number = CONNECTION_RUNTIME_KEY_PREFERENCE_LIMIT) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error('ConnectionRuntimeKeyPreferenceLimitInvalid')
    }
    this.limit = limit
  }

  get retainedChatCount(): number {
    return this.preferredKeyByChat.size
  }

  order(
    profileId: ProfileId,
    chatId: ChatId,
    candidates: readonly ConnectionRuntimeKeyCandidate[],
  ): readonly ConnectionRuntimeKeyCandidate[] {
    const selected = this.takePreference(
      profileId,
      chatId,
      candidates.flatMap((candidate) => (candidate.ref ? [candidate.ref] : [])),
    )
    if (!selected) return candidates
    const { preferred, preferredIndex } = selected
    const candidate = candidates[preferredIndex]
    if (!candidate) return candidates
    if (candidate.index === 0) return candidates
    this.preferredKeyByChat.set(chatId, preferred)
    if (preferredIndex === 0) return candidates
    return Object.freeze([
      candidate,
      ...candidates.slice(0, preferredIndex),
      ...candidates.slice(preferredIndex + 1),
    ])
  }

  capture(
    profileId: ProfileId,
    chatId: ChatId,
    refs: readonly KeyId[],
  ): CapturedConnectionRuntimeKeyPreference {
    const selected = this.takePreference(profileId, chatId, refs)
    if (!selected || selected.preferredIndex === 0) return Object.freeze({ ref: null })
    this.preferredKeyByChat.set(chatId, selected.preferred)
    return Object.freeze({ ref: selected.preferred.ref })
  }

  accept(chatId: ChatId, profileId: ProfileId, ref: KeyId): void {
    this.preferredKeyByChat.delete(chatId)
    this.preferredKeyByChat.set(chatId, { profileId, ref })
    if (this.preferredKeyByChat.size <= this.limit) return
    const oldestChatId = this.preferredKeyByChat.keys().next().value
    if (oldestChatId !== undefined) this.preferredKeyByChat.delete(oldestChatId)
  }

  deleteChat(chatId: ChatId): void {
    this.preferredKeyByChat.delete(chatId)
  }

  resetWorkspace(): void {
    this.preferredKeyByChat.clear()
  }

  private takePreference(
    profileId: ProfileId,
    chatId: ChatId,
    refs: readonly KeyId[],
  ): { preferred: ConnectionRuntimeKeyPreference; preferredIndex: number } | undefined {
    const preferred = this.preferredKeyByChat.get(chatId)
    if (!preferred || preferred.profileId !== profileId) return undefined
    const preferredIndex = refs.indexOf(preferred.ref)
    this.preferredKeyByChat.delete(chatId)
    return preferredIndex < 0 ? undefined : { preferred, preferredIndex }
  }
}

const tabKeyPreferences = new ConnectionRuntimeKeyPreferenceSession()

registerWorkspaceTabSessionParticipant({
  resetWorkspace: () => tabKeyPreferences.resetWorkspace(),
  deleteChat: (chatId) => tabKeyPreferences.deleteChat(chatId),
})

export function connectionKeyRefs(profile: ConnectionProfile): KeyId[] {
  return connectionDispatchKeyRefs(profile)
}

export function connectionRequiresKey(profile: ConnectionProfile): boolean {
  return profile.kind !== 'custom' && profile.kind !== 'llama-server'
}

export function captureConnectionRuntimeKeyPreferenceFromProof(
  proof: Pick<ConnectionDispatchProfileProof, 'profileId' | 'apiKeyRef' | 'apiKeyFallbackRefs'>,
  chatId: ChatId,
): CapturedConnectionRuntimeKeyPreference {
  const refs = [proof.apiKeyRef, ...proof.apiKeyFallbackRefs].filter(
    (keyId): keyId is KeyId => keyId !== null,
  )
  return tabKeyPreferences.capture(proof.profileId, chatId, refs)
}

export async function resolveConnectionRuntimeKeys(
  profile: ConnectionProfile,
  options: {
    chatId?: ChatId
    access?: ConnectionRuntimeKeyAccess
    authority?: WorkspaceWriteAuthority
  } = {},
): Promise<readonly ConnectionRuntimeKeyCandidate[]> {
  if (!options.access) {
    const records = await Promise.all(
      connectionKeyRefs(profile).map((ref) => getKey(ref, options.authority)),
    )
    return captureConnectionRuntimeKeysFromRecords(
      profile,
      records.filter((record): record is KeyRecord => record !== undefined),
      {
        ...(options.chatId ? { chatId: options.chatId } : {}),
        ...(options.authority ? { authority: options.authority } : {}),
      },
    ).candidates
  }
  return resolveConnectionRuntimeKeysWithAccess(profile, options.access, options.chatId)
}

export function captureConnectionRuntimeKeysFromRecords(
  profile: ConnectionProfile,
  records: readonly KeyRecord[],
  options: {
    chatId?: ChatId
    keyPreference?: CapturedConnectionRuntimeKeyPreference
    authority?: WorkspaceWriteAuthority
  } = {},
): CapturedConnectionRuntimeKeys {
  const byId = new Map(records.map((record) => [record.id, record]))
  const issues: ConnectionRuntimeKeyIssue[] = []
  const candidates: ConnectionRuntimeKeyCandidate[] = []

  for (const [index, ref] of connectionKeyRefs(profile).entries()) {
    const record = byId.get(ref)
    if (record) {
      const captured = captureKeyForDispatch(record)
      candidates.push(makeCandidate(ref, index, () => captured.resolve({}, options.authority)))
    } else {
      issues.push({ ref, index, kind: 'missing' })
    }
  }

  if (candidates.length > 0) {
    const ordered = options.keyPreference
      ? orderCandidatesByCapturedPreference(candidates, options.keyPreference)
      : options.chatId
        ? tabKeyPreferences.order(profile.id, options.chatId, candidates)
        : candidates
    return Object.freeze({
      candidates: Object.freeze(ordered),
    })
  }
  if (!connectionRequiresKey(profile)) {
    return Object.freeze({
      candidates: Object.freeze([makeCandidate(null, 0, () => Promise.resolve(''))]),
    })
  }
  throw new ConnectionRuntimeKeysUnavailableError(profile.id, issues)
}

function orderCandidatesByCapturedPreference(
  candidates: readonly ConnectionRuntimeKeyCandidate[],
  preference: CapturedConnectionRuntimeKeyPreference,
): readonly ConnectionRuntimeKeyCandidate[] {
  if (!preference.ref) return candidates
  const preferredIndex = candidates.findIndex((candidate) => candidate.ref === preference.ref)
  if (preferredIndex <= 0) return candidates
  const preferred = candidates[preferredIndex]
  return preferred
    ? Object.freeze([
        preferred,
        ...candidates.slice(0, preferredIndex),
        ...candidates.slice(preferredIndex + 1),
      ])
    : candidates
}

async function resolveConnectionRuntimeKeysWithAccess(
  profile: ConnectionProfile,
  access: ConnectionRuntimeKeyAccess,
  chatId?: ChatId,
): Promise<readonly ConnectionRuntimeKeyCandidate[]> {
  const issues: ConnectionRuntimeKeyIssue[] = []
  const candidates: ConnectionRuntimeKeyCandidate[] = []

  for (const [index, ref] of connectionKeyRefs(profile).entries()) {
    if (await access.exists(ref)) {
      candidates.push(makeCandidate(ref, index, () => access.resolve(ref)))
    } else {
      issues.push({ ref, index, kind: 'missing' })
    }
  }

  if (candidates.length > 0) {
    return Object.freeze(
      chatId ? tabKeyPreferences.order(profile.id, chatId, candidates) : candidates,
    )
  }
  if (!connectionRequiresKey(profile)) {
    return Object.freeze([makeCandidate(null, 0, () => Promise.resolve(''))])
  }
  throw new ConnectionRuntimeKeysUnavailableError(profile.id, issues)
}

export function recordAcceptedConnectionRuntimeKeyPreference(input: {
  chatId: ChatId
  profileId: ProfileId
  ref: KeyId
  index: number
}): void {
  if (input.index === 0) {
    tabKeyPreferences.deleteChat(input.chatId)
    return
  }
  tabKeyPreferences.accept(input.chatId, input.profileId, input.ref)
}

export async function primeConnectionRuntimeKeyCandidates(
  candidates: readonly ConnectionRuntimeKeyCandidate[] | undefined,
  signal?: AbortSignal,
): Promise<readonly ConnectionRuntimeKeyCandidate[] | undefined> {
  const primary = candidates?.[0]
  if (!primary) return candidates
  const apiKey = await raceWithAbortSignal(primary.resolve, signal)
  const primedPrimary = makeCandidate(primary.ref, primary.index, () => Promise.resolve(apiKey))
  return Object.freeze([primedPrimary, ...candidates.slice(1)])
}

function makeCandidate(
  ref: KeyId | null,
  index: number,
  resolve: () => Promise<string>,
): ConnectionRuntimeKeyCandidate {
  const candidate = { ref, index } as ConnectionRuntimeKeyCandidate
  Object.defineProperty(candidate, 'resolve', {
    configurable: false,
    enumerable: false,
    value: resolve,
    writable: false,
  })
  return Object.freeze(candidate)
}

export function __resetConnectionRuntimeForTests(): void {
  tabKeyPreferences.resetWorkspace()
}
