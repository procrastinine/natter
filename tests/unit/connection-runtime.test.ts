import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionProfile, KeyId } from '../../src/core/types'
import {
  __resetConnectionRuntimeForTests,
  CONNECTION_RUNTIME_KEY_PREFERENCE_LIMIT,
  ConnectionRuntimeKeyPreferenceSession,
  ConnectionRuntimeKeysUnavailableError,
  connectionKeyRefs,
  connectionRequiresKey,
  primeConnectionRuntimeKeyCandidates,
  recordAcceptedConnectionRuntimeKeyPreference,
  resolveConnectionRuntimeKeys,
} from '../../src/store/connection-runtime'
import { PassphraseRequiredError, WrongPassphraseError } from '../../src/store/keys'
import {
  deleteChatFromWorkspaceTabSession,
  reconcileWorkspaceTabSessionStorage,
} from '../../src/store/workspace-tab-session'

function profile(
  apiKeyRef: KeyId,
  apiKeyFallbackRefs: KeyId[] = [],
  kind: ConnectionProfile['kind'] = 'openrouter',
): ConnectionProfile {
  return {
    id: 'profile-a',
    name: 'Connection',
    kind,
    baseUrl: 'https://example.test/v1',
    apiKeyRef,
    apiKeyFallbackRefs,
    defaultHeaders: {},
    appTitle: 'natter',
    appUrl: '',
    supportsEndpointsApi: true,
    supportsGenerationApi: true,
    supportsPrivacyScrape: true,
    createdAt: 1,
    updatedAt: 1,
  }
}

function keyAccess(
  existing: readonly KeyId[],
  resolve: (ref: KeyId) => Promise<string> = async (ref) => `secret-for-${ref}`,
) {
  return {
    exists: vi.fn(async (ref: KeyId) => existing.includes(ref)),
    resolve: vi.fn(resolve),
  }
}

beforeEach(() => {
  __resetConnectionRuntimeForTests()
})

describe('connection runtime keys', () => {
  it('keeps primary-first order and deduplicates references without decrypting eagerly', async () => {
    const connection = profile('primary', ['fallback-a', 'primary', 'fallback-b', 'fallback-a'])
    const access = keyAccess(['primary', 'fallback-a', 'fallback-b'])

    expect(connectionKeyRefs(connection)).toEqual(['primary', 'fallback-a', 'fallback-b'])
    const candidates = await resolveConnectionRuntimeKeys(connection, { access })

    expect(access.exists.mock.calls.map(([ref]) => ref)).toEqual([
      'primary',
      'fallback-a',
      'fallback-b',
    ])
    expect(access.resolve).not.toHaveBeenCalled()
    expect(candidates.map(({ ref, index }) => ({ ref, index }))).toEqual([
      { ref: 'primary', index: 0 },
      { ref: 'fallback-a', index: 1 },
      { ref: 'fallback-b', index: 2 },
    ])

    await expect(candidates[1]?.resolve()).resolves.toBe('secret-for-fallback-a')
    expect(access.resolve).toHaveBeenCalledOnce()
    expect(access.resolve).toHaveBeenCalledWith('fallback-a')
  })

  it('skips missing records while preserving configured chain indices', async () => {
    const connection = profile('missing-primary', ['available-fallback', 'missing-fallback'])
    const access = keyAccess(['available-fallback'])

    const candidates = await resolveConnectionRuntimeKeys(connection, { access })

    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.ref).toBe('available-fallback')
    expect(candidates[0]?.index).toBe(1)
    await expect(candidates[0]?.resolve()).resolves.toBe('secret-for-available-fallback')
  })

  it('reports configured missing references when no required key is available', async () => {
    const connection = profile('missing-primary', ['missing-fallback'])
    const access = keyAccess([])

    const error = await resolveConnectionRuntimeKeys(connection, { access }).catch(
      (caught: unknown) => caught,
    )

    expect(error).toBeInstanceOf(ConnectionRuntimeKeysUnavailableError)
    expect(error).toMatchObject({
      profileId: 'profile-a',
      issues: [
        { ref: 'missing-primary', index: 0, kind: 'missing' },
        { ref: 'missing-fallback', index: 1, kind: 'missing' },
      ],
    })
    expect(String(error)).toBe(
      'ConnectionRuntimeKeysUnavailableError: ConnectionRuntimeKeysUnavailable:profile-a:missing=2',
    )
  })

  it.each([
    ['passphrase-required', (ref: KeyId) => new PassphraseRequiredError(ref)],
    ['wrong-passphrase', (ref: KeyId) => new WrongPassphraseError(ref)],
  ])('fails fast when an attempted key is %s', async (_label, makeError) => {
    const access = keyAccess(['primary', 'fallback'], async (ref) => {
      if (ref === 'primary') throw makeError(ref)
      return 'fallback-secret'
    })
    const candidates = await resolveConnectionRuntimeKeys(profile('primary', ['fallback']), {
      access,
    })

    await expect(candidates[0]?.resolve()).rejects.toBeInstanceOf(makeError('primary').constructor)
    expect(access.resolve).toHaveBeenCalledOnce()
    expect(access.resolve).not.toHaveBeenCalledWith('fallback')
  })

  it('keeps resolver functions and plaintext out of ordinary serialization', async () => {
    const secret = 'sk-or-v1-do-not-serialize'
    const access = keyAccess(['primary'], async () => secret)
    const [candidate] = await resolveConnectionRuntimeKeys(profile('primary'), { access })

    expect(Object.keys(candidate ?? {})).toEqual(['ref', 'index'])
    expect(JSON.stringify(candidate)).toBe('{"ref":"primary","index":0}')
    expect(JSON.stringify([candidate])).not.toContain(secret)
    await expect(candidate?.resolve()).resolves.toBe(secret)
    expect(JSON.stringify(candidate)).not.toContain(secret)
  })

  it('freezes only the primary plaintext in an opaque candidate and leaves fallbacks lazy', async () => {
    const secret = 'sk-primary-closure-only'
    const access = keyAccess(['primary', 'fallback'], async (ref) =>
      ref === 'primary' ? secret : 'fallback-secret',
    )
    const candidates = await resolveConnectionRuntimeKeys(profile('primary', ['fallback']), {
      access,
    })

    const primed = await primeConnectionRuntimeKeyCandidates(candidates)

    expect(access.resolve.mock.calls.map(([ref]) => ref)).toEqual(['primary'])
    expect(primed?.map(({ ref, index }) => ({ ref, index }))).toEqual([
      { ref: 'primary', index: 0 },
      { ref: 'fallback', index: 1 },
    ])
    expect(Object.keys(primed?.[0] ?? {})).toEqual(['ref', 'index'])
    expect(JSON.stringify(primed)).not.toContain(secret)
    await expect(primed?.[0]?.resolve()).resolves.toBe(secret)
    expect(access.resolve).toHaveBeenCalledOnce()
    await expect(primed?.[1]?.resolve()).resolves.toBe('fallback-secret')
    expect(access.resolve.mock.calls.map(([ref]) => ref)).toEqual(['primary', 'fallback'])
  })

  it.each([
    'custom',
    'llama-server',
  ] as const)('preserves empty authentication for key-optional %s profiles', async (kind) => {
    const access = keyAccess([])
    const connection = profile('missing-optional-key', [], kind)

    expect(connectionRequiresKey(connection)).toBe(false)
    const [candidate] = await resolveConnectionRuntimeKeys(connection, { access })

    expect(candidate?.ref).toBeNull()
    expect(candidate?.index).toBe(0)
    await expect(candidate?.resolve()).resolves.toBe('')
  })

  it('prefers an explicitly accepted key for only that chat and profile', async () => {
    const access = keyAccess(['primary', 'fallback'])
    const connection = profile('primary', ['fallback'])
    await resolveConnectionRuntimeKeys(connection, { chatId: 'chat-a', access })
    recordAcceptedConnectionRuntimeKeyPreference({
      chatId: 'chat-a',
      profileId: connection.id,
      ref: 'fallback',
      index: 1,
    })

    const next = await resolveConnectionRuntimeKeys(connection, { chatId: 'chat-a', access })
    expect(next.map(({ ref, index }) => ({ ref, index }))).toEqual([
      { ref: 'fallback', index: 1 },
      { ref: 'primary', index: 0 },
    ])
    expect(
      (await resolveConnectionRuntimeKeys(connection, { chatId: 'chat-b', access })).map(
        ({ ref }) => ref,
      ),
    ).toEqual(['primary', 'fallback'])
    expect(
      (
        await resolveConnectionRuntimeKeys(
          { ...connection, id: 'profile-b' },
          { chatId: 'chat-a', access },
        )
      ).map(({ ref }) => ref),
    ).toEqual(['primary', 'fallback'])
  })

  it('clears accepted-key preference with its chat and workspace tab session', async () => {
    const access = keyAccess(['primary', 'fallback'])
    const connection = profile('primary', ['fallback'])
    recordAcceptedConnectionRuntimeKeyPreference({
      chatId: 'chat-a',
      profileId: connection.id,
      ref: 'fallback',
      index: 1,
    })

    deleteChatFromWorkspaceTabSession('chat-a')
    expect(
      (await resolveConnectionRuntimeKeys(connection, { chatId: 'chat-a', access })).map(
        ({ ref }) => ref,
      ),
    ).toEqual(['primary', 'fallback'])

    recordAcceptedConnectionRuntimeKeyPreference({
      chatId: 'chat-a',
      profileId: connection.id,
      ref: 'fallback',
      index: 1,
    })
    reconcileWorkspaceTabSessionStorage({
      workspaceId: `connection-runtime-${crypto.randomUUID()}`,
      replacementEpoch: 1,
    })
    expect(
      (await resolveConnectionRuntimeKeys(connection, { chatId: 'chat-a', access })).map(
        ({ ref }) => ref,
      ),
    ).toEqual(['primary', 'fallback'])
  })

  it('does not publish the tab preference before durable selected-key work settles', async () => {
    let releaseDurableNote: (() => void) | undefined
    const durableNote = new Promise<void>((resolve) => {
      releaseDurableNote = resolve
    })
    const access = keyAccess(['primary', 'fallback'])
    const connection = profile('primary', ['fallback'])

    const accepting = (async () => {
      await durableNote
      recordAcceptedConnectionRuntimeKeyPreference({
        chatId: 'chat-a',
        profileId: connection.id,
        ref: 'fallback',
        index: 1,
      })
    })()
    expect(
      (await resolveConnectionRuntimeKeys(connection, { chatId: 'chat-a', access })).map(
        ({ ref }) => ref,
      ),
    ).toEqual(['primary', 'fallback'])

    releaseDurableNote?.()
    await accepting
    expect(
      (await resolveConnectionRuntimeKeys(connection, { chatId: 'chat-a', access })).map(
        ({ ref }) => ref,
      ),
    ).toEqual(['fallback', 'primary'])
  })

  it('keeps preferences isolated between tab-session owners', async () => {
    const access = keyAccess(['primary', 'fallback'])
    const candidates = await resolveConnectionRuntimeKeys(profile('primary', ['fallback']), {
      access,
    })
    const tabA = new ConnectionRuntimeKeyPreferenceSession(2)
    const tabB = new ConnectionRuntimeKeyPreferenceSession(2)
    tabA.accept('chat-a', 'profile-a', 'fallback')

    expect(tabA.order('profile-a', 'chat-a', candidates).map(({ ref }) => ref)).toEqual([
      'fallback',
      'primary',
    ])
    expect(tabB.order('profile-a', 'chat-a', candidates).map(({ ref }) => ref)).toEqual([
      'primary',
      'fallback',
    ])
  })

  it('retains only a bounded least-recently-used set with constant-time chat eviction', async () => {
    const session = new ConnectionRuntimeKeyPreferenceSession()
    for (let index = 0; index < CONNECTION_RUNTIME_KEY_PREFERENCE_LIMIT + 32; index += 1) {
      session.accept(`chat-${index}`, 'profile-a', 'fallback')
    }
    expect(session.retainedChatCount).toBe(CONNECTION_RUNTIME_KEY_PREFERENCE_LIMIT)

    const access = keyAccess(['primary', 'fallback'])
    const candidates = await resolveConnectionRuntimeKeys(profile('primary', ['fallback']), {
      access,
    })
    expect(session.order('profile-a', 'chat-0', candidates).map(({ ref }) => ref)).toEqual([
      'primary',
      'fallback',
    ])
    expect(
      session
        .order('profile-a', `chat-${CONNECTION_RUNTIME_KEY_PREFERENCE_LIMIT + 31}`, candidates)
        .map(({ ref }) => ref),
    ).toEqual(['fallback', 'primary'])
  })

  it('drops a preference whose key no longer belongs to the captured candidate chain', async () => {
    const session = new ConnectionRuntimeKeyPreferenceSession(2)
    const access = keyAccess(['primary'])
    const candidates = await resolveConnectionRuntimeKeys(profile('primary'), { access })
    session.accept('chat-a', 'profile-a', 'removed-fallback')

    expect(session.order('profile-a', 'chat-a', candidates)).toEqual(candidates)
    expect(session.retainedChatCount).toBe(0)
  })

  it('retains a configured fallback preference while an earlier key is temporarily unavailable', async () => {
    const session = new ConnectionRuntimeKeyPreferenceSession(2)
    session.accept('chat-a', 'profile-a', 'fallback')
    const missingPrimary = await resolveConnectionRuntimeKeys(
      profile('missing-primary', ['fallback']),
      { access: keyAccess(['fallback']) },
    )

    expect(session.order('profile-a', 'chat-a', missingPrimary).map(({ ref }) => ref)).toEqual([
      'fallback',
    ])
    expect(session.retainedChatCount).toBe(1)

    const restoredPrimary = await resolveConnectionRuntimeKeys(profile('primary', ['fallback']), {
      access: keyAccess(['primary', 'fallback']),
    })
    expect(session.order('profile-a', 'chat-a', restoredPrimary).map(({ ref }) => ref)).toEqual([
      'fallback',
      'primary',
    ])
  })
})
