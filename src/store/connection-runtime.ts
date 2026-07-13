import type { ChatId, ConnectionProfile, KeyId, ProfileId } from '../core/types'
import { onEvent } from './broadcast'
import { getKey, markKeyUsed, resolveKeyForDispatch } from './keys'

export interface ConnectionRuntimeKeyCandidate {
  readonly ref: KeyId | null
  readonly index: number
  readonly resolve: () => Promise<string>
  readonly markUsed: () => Promise<void>
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
  markUsed: (ref: KeyId) => Promise<void>
}

const defaultKeyAccess: ConnectionRuntimeKeyAccess = {
  exists: async (ref) => (await getKey(ref)) !== undefined,
  resolve: resolveKeyForDispatch,
  markUsed: markKeyUsed,
}

const preferredKeyByChat = new Map<ChatId, { profileId: ProfileId; ref: KeyId }>()
let unsubscribe: (() => void) | null = null

function ensureWorkspaceListener(): void {
  if (unsubscribe) return
  unsubscribe = onEvent((event) => {
    if (event.kind === 'workspace-invalidated' || event.kind === 'workspace-replaced') {
      preferredKeyByChat.clear()
    }
  })
}

export function connectionKeyRefs(profile: ConnectionProfile): KeyId[] {
  const refs = [profile.apiKeyRef, ...(profile.apiKeyFallbackRefs ?? [])]
  return [...new Set(refs)]
}

export function connectionRequiresKey(profile: ConnectionProfile): boolean {
  return profile.kind !== 'custom' && profile.kind !== 'llama-server'
}

export async function resolveConnectionRuntimeKeys(
  profile: ConnectionProfile,
  options: { chatId?: ChatId; access?: ConnectionRuntimeKeyAccess } = {},
): Promise<readonly ConnectionRuntimeKeyCandidate[]> {
  ensureWorkspaceListener()
  const access = options.access ?? defaultKeyAccess
  const issues: ConnectionRuntimeKeyIssue[] = []
  const candidates: ConnectionRuntimeKeyCandidate[] = []

  for (const [index, ref] of connectionKeyRefs(profile).entries()) {
    if (await access.exists(ref)) {
      candidates.push(
        makeCandidate(
          ref,
          index,
          () => access.resolve(ref),
          async () => {
            if (options.chatId) {
              preferredKeyByChat.set(options.chatId, { profileId: profile.id, ref })
            }
            await access.markUsed(ref)
          },
        ),
      )
    } else {
      issues.push({ ref, index, kind: 'missing' })
    }
  }

  if (candidates.length > 0) {
    const preferred = options.chatId ? preferredKeyByChat.get(options.chatId) : undefined
    if (preferred?.profileId === profile.id) {
      const preferredIndex = candidates.findIndex((candidate) => candidate.ref === preferred.ref)
      if (preferredIndex > 0) {
        const [candidate] = candidates.splice(preferredIndex, 1)
        if (candidate) candidates.unshift(candidate)
      } else if (preferredIndex === -1 && options.chatId) {
        preferredKeyByChat.delete(options.chatId)
      }
    }
    return Object.freeze(candidates)
  }
  if (!connectionRequiresKey(profile)) {
    return Object.freeze([
      makeCandidate(
        null,
        0,
        () => Promise.resolve(''),
        () => Promise.resolve(),
      ),
    ])
  }
  throw new ConnectionRuntimeKeysUnavailableError(profile.id, issues)
}

function makeCandidate(
  ref: KeyId | null,
  index: number,
  resolve: () => Promise<string>,
  markUsed: () => Promise<void>,
): ConnectionRuntimeKeyCandidate {
  const candidate = { ref, index } as ConnectionRuntimeKeyCandidate
  Object.defineProperty(candidate, 'resolve', {
    configurable: false,
    enumerable: false,
    value: resolve,
    writable: false,
  })
  Object.defineProperty(candidate, 'markUsed', {
    configurable: false,
    enumerable: false,
    value: markUsed,
    writable: false,
  })
  return Object.freeze(candidate)
}

export function __resetConnectionRuntimeForTests(): void {
  preferredKeyByChat.clear()
  unsubscribe?.()
  unsubscribe = null
}
