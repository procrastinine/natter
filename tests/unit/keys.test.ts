import Dexie from 'dexie'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetBroadcastForTests, subscribeWorkspaceChanges } from '../../src/store/broadcast'
import { __resetBrowserRepositoryForTests } from '../../src/store/browser-repo'
import {
  openBrowserWorkspace,
  shutdownBrowserWorkspace,
} from '../../src/store/browser-workspace-lifecycle'
import { __resetDbForTests } from '../../src/store/db'
import { exportWorkspaceBackup, restoreWorkspaceBackup } from '../../src/store/import-export'
import {
  __resetKeyCacheForTests,
  changePassphrase,
  createKey,
  deleteKey,
  getKey,
  getOrCreateInstallSecret,
  KeyMissingError,
  obscurePreview,
  observeKeyMaterialWorkspaceEffect,
  PassphraseRequiredError,
  resolveKey,
  resolveKeyForDispatch,
  WrongPassphraseError,
} from '../../src/store/keys'
import { withNamedLock } from '../../src/store/locks'
import { getSetting } from '../../src/store/settings'
import { reduceWorkspaceChange } from '../../src/store/workspace-effect-hub'
import type { WorkspaceChange, WorkspaceDependency } from '../../src/store/workspace-protocol'
import { __resetWorkspaceRepositoryForTests } from '../../src/store/workspace-repository'
import { createConfigurationProfile } from '../helpers/configuration'

const DB_NAME = 'natter'

let emptyWorkspaceBackup: Awaited<ReturnType<typeof exportWorkspaceBackup>>

beforeAll(async () => {
  ;(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
  __resetWorkspaceRepositoryForTests()
  __resetBrowserRepositoryForTests()
  __resetBroadcastForTests()
  __resetKeyCacheForTests()
  __resetDbForTests()
  await Dexie.delete(DB_NAME)
  await openBrowserWorkspace()
  emptyWorkspaceBackup = await exportWorkspaceBackup()
})

beforeEach(async () => {
  vi.restoreAllMocks()
  await restoreWorkspaceBackup(emptyWorkspaceBackup, { now: 1 })
})

afterAll(async () => {
  await shutdownBrowserWorkspace()
  __resetKeyCacheForTests()
})

describe('obscurePreview', () => {
  it('keeps the provider prefix and last four characters', () => {
    expect(obscurePreview('sk-or-v1-abcdefghijklmnopedc7')).toBe('sk-or-v1-a…edc7')
  })

  it('collapses short strings to a bullet string', () => {
    expect(obscurePreview('sk-short')).toBe('••••')
  })
})

describe('install-secret', () => {
  it('creates one persisted secret through the configuration command and reuses it', async () => {
    const changes: WorkspaceChange[] = []
    const unsubscribe = subscribeWorkspaceChanges((change) => changes.push(change))

    const first = await getOrCreateInstallSecret()
    const second = await getOrCreateInstallSecret()
    unsubscribe()

    expect(second).toBe(first)
    expect(await getSetting<string>('install-secret')).toBe(first)
    expect(changedDependencies(changes)).toEqual([{ kind: 'setting', keys: ['install-secret'] }])
  })

  it('atomically initializes concurrent encryptors and decrypts both after a tab restart', async () => {
    let announceLockHeld: (() => void) | undefined
    const lockHeld = new Promise<void>((resolve) => {
      announceLockHeld = resolve
    })
    let releaseLock: (() => void) | undefined
    const lockRelease = new Promise<void>((resolve) => {
      releaseLock = resolve
    })
    const lockTask = withNamedLock('setting:install-secret', async () => {
      announceLockHeld?.()
      await lockRelease
    })
    await lockHeld

    const originalGetRandomValues = crypto.getRandomValues.bind(crypto)
    let candidateCount = 0
    let announceCandidatesGenerated: (() => void) | undefined
    const candidatesGenerated = new Promise<void>((resolve) => {
      announceCandidatesGenerated = resolve
    })
    const randomSpy = vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
      if (array instanceof Uint8Array && array.byteLength === 32) {
        candidateCount += 1
        array.fill(candidateCount)
        if (candidateCount === 2) announceCandidatesGenerated?.()
        return array
      }
      return originalGetRandomValues(array)
    })

    try {
      const firstKey = createKey({
        id: 'concurrent-install-key-1',
        name: 'Concurrent one',
        plaintextKey: 'sk-or-v1-concurrent-one',
      })
      const secondKey = createKey({
        id: 'concurrent-install-key-2',
        name: 'Concurrent two',
        plaintextKey: 'sk-or-v1-concurrent-two',
      })

      await candidatesGenerated
      releaseLock?.()
      await lockTask
      const [firstRecord, secondRecord] = await Promise.all([firstKey, secondKey])
      expect(candidateCount).toBe(2)
      expect(await getSetting<string>('install-secret')).toBe(await getOrCreateInstallSecret())

      await shutdownBrowserWorkspace()
      await openBrowserWorkspace()
      await expect(resolveKeyForDispatch(firstRecord.id)).resolves.toBe('sk-or-v1-concurrent-one')
      await expect(resolveKeyForDispatch(secondRecord.id)).resolves.toBe('sk-or-v1-concurrent-two')
    } finally {
      releaseLock?.()
      await lockTask
      randomSpy.mockRestore()
    }
  })
})

describe('passphrase encryption and tab-local wrapper cache', () => {
  it('round-trips plaintext and publishes recency without publishing key material', async () => {
    const record = await createKey({
      name: 'OpenRouter',
      plaintextKey: 'sk-or-v1-1234567890abcdefghijxyz',
      passphrase: 'correct horse battery staple',
      passphraseHint: 'the xkcd one',
    })
    const changes: WorkspaceChange[] = []
    const unsubscribe = subscribeWorkspaceChanges((change) => changes.push(change))

    const plaintext = await resolveKey(record.id, {
      passphrase: 'correct horse battery staple',
    })
    unsubscribe()

    expect(record.passphraseHint).toBe('the xkcd one')
    expect(record.obscuredPreview).toBe('sk-or-v1-1…jxyz')
    expect(plaintext).toBe('sk-or-v1-1234567890abcdefghijxyz')
    expect(changedDependencies(changes)).toEqual([
      { kind: 'key', keyIds: [record.id], facets: ['usage'] },
    ])
    expect(JSON.stringify(changes)).not.toContain(plaintext)
    await expect(resolveKeyForDispatch(record.id)).resolves.toBe(plaintext)
  })

  it('throws WrongPassphraseError on a bad passphrase without returning plaintext', async () => {
    const record = await createKey({
      name: 'OpenRouter',
      plaintextKey: 'sk-or-v1-secret',
      passphrase: 'correct',
    })
    __resetKeyCacheForTests()

    await expect(resolveKey(record.id, { passphrase: 'wrong' })).rejects.toBeInstanceOf(
      WrongPassphraseError,
    )
    await expect(
      resolveKey(record.id, { passphrase: 'wrong' }).catch(() => 'error-caught'),
    ).resolves.toBe('error-caught')
  })

  it('requires a passphrase on the first decrypt after the derived key is dropped', async () => {
    const record = await createKey({
      name: 'OpenRouter',
      plaintextKey: 'sk-or-v1-secret',
      passphrase: 'pp',
    })
    __resetKeyCacheForTests()

    await expect(resolveKeyForDispatch(record.id)).rejects.toBeInstanceOf(PassphraseRequiredError)
  })

  it('uses exact compact key deltas to preserve unrelated wrappers and drop changed material', async () => {
    const first = await createKey({
      name: 'First',
      plaintextKey: 'sk-or-v1-first',
      passphrase: 'first-passphrase',
    })
    const second = await createKey({
      name: 'Second',
      plaintextKey: 'sk-or-v1-second',
      passphrase: 'second-passphrase',
    })

    observeRemoteKeyMaterialChange(
      compactCommit([{ kind: 'key', keyIds: [first.id], facets: ['usage'] }]),
    )
    observeRemoteKeyMaterialChange(
      compactCommit([{ kind: 'key', keyIds: [second.id], facets: ['request-material'] }]),
    )
    await expect(resolveKeyForDispatch(first.id)).resolves.toBe('sk-or-v1-first')

    observeRemoteKeyMaterialChange(
      compactCommit([{ kind: 'key', keyIds: [first.id], facets: ['request-material'] }]),
    )
    await expect(resolveKeyForDispatch(first.id)).rejects.toBeInstanceOf(PassphraseRequiredError)
  })

  it('drops every wrapper on workspace replacement and on a broad remote invalidation', async () => {
    const record = await createKey({
      name: 'OpenRouter',
      plaintextKey: 'sk-or-v1-secret',
      passphrase: 'correct',
    })

    observeRemoteKeyMaterialChange({
      kind: 'invalidate',
      workspaceId: 'workspace-a',
      replacementEpoch: 1,
      dependencies: 'all',
    })
    await expect(resolveKeyForDispatch(record.id)).rejects.toBeInstanceOf(PassphraseRequiredError)

    await expect(resolveKeyForDispatch(record.id, { passphrase: 'correct' })).resolves.toBe(
      'sk-or-v1-secret',
    )
    observeRemoteKeyMaterialChange({
      kind: 'replace',
      workspaceId: 'workspace-b',
      replacementEpoch: 2,
    })
    await expect(resolveKeyForDispatch(record.id)).rejects.toBeInstanceOf(PassphraseRequiredError)
  })

  it('drops passphrase wrappers when the tab workspace runtime restarts', async () => {
    const record = await createKey({
      name: 'OpenRouter',
      plaintextKey: 'sk-or-v1-tab-cache',
      passphrase: 'tab-passphrase',
    })
    await expect(resolveKeyForDispatch(record.id)).resolves.toBe('sk-or-v1-tab-cache')

    await shutdownBrowserWorkspace()
    await openBrowserWorkspace()

    await expect(resolveKeyForDispatch(record.id)).rejects.toBeInstanceOf(PassphraseRequiredError)
  })
})

describe('install-secret encryption and dispatch recency', () => {
  it('round-trips plaintext without any passphrase prompt', async () => {
    const record = await createKey({
      name: 'OpenRouter',
      plaintextKey: 'sk-or-v1-installsecretonly',
    })

    expect(record.passphraseHint).toBeUndefined()
    await expect(resolveKey(record.id)).resolves.toBe('sk-or-v1-installsecretonly')
  })

  it('survives a fresh tab because only the install secret is persisted', async () => {
    const record = await createKey({
      name: 'OpenRouter',
      plaintextKey: 'sk-or-v1-persist',
    })

    await shutdownBrowserWorkspace()
    await openBrowserWorkspace()

    await expect(resolveKeyForDispatch(record.id)).resolves.toBe('sk-or-v1-persist')
  })

  it('keeps dispatch decryption recency-free because accepted fallback order is tab-session-owned', async () => {
    const record = await createKey({
      name: 'Fallback',
      plaintextKey: 'sk-or-v1-lazy-fallback',
    })

    await expect(resolveKeyForDispatch(record.id)).resolves.toBe('sk-or-v1-lazy-fallback')
    expect((await getKey(record.id))?.lastUsedAt).toBeUndefined()

    await expect(resolveKey(record.id)).resolves.toBe('sk-or-v1-lazy-fallback')
    expect((await getKey(record.id))?.lastUsedAt).toEqual(expect.any(Number))
  })
})

describe('changePassphrase', () => {
  it('re-encrypts with fresh material and publishes one compact material invalidation', async () => {
    const record = await createKey({
      name: 'OpenRouter',
      plaintextKey: 'sk-or-v1-rotated',
      passphrase: 'old-one',
    })
    const changes: WorkspaceChange[] = []
    const unsubscribe = subscribeWorkspaceChanges((change) => changes.push(change))

    const next = await changePassphrase({
      keyId: record.id,
      oldPassphrase: 'old-one',
      newPassphrase: 'new-one',
      newPassphraseHint: 'fresh',
    })
    unsubscribe()

    expect(next.passphraseHint).toBe('fresh')
    expect(next.materialRevision).toBe((record.materialRevision ?? 0) + 1)
    expect(next.salt).not.toBe(record.salt)
    expect(next.iv).not.toBe(record.iv)
    expect(next.ciphertext).not.toBe(record.ciphertext)
    expect(changedDependencies(changes)).toEqual([
      {
        kind: 'key',
        keyIds: [record.id],
        facets: ['request-material', 'selected-detail', 'usage'],
      },
    ])
    expect(JSON.stringify(changes)).not.toContain(record.ciphertext)
    expect(JSON.stringify(changes)).not.toContain(next.ciphertext)

    __resetKeyCacheForTests()
    await expect(
      resolveKeyForDispatch(record.id, { passphrase: 'old-one' }),
    ).rejects.toBeInstanceOf(WrongPassphraseError)
    await expect(resolveKeyForDispatch(record.id, { passphrase: 'new-one' })).resolves.toBe(
      'sk-or-v1-rotated',
    )
  })

  it('drops from passphrase mode to install-secret mode', async () => {
    const record = await createKey({
      name: 'OpenRouter',
      plaintextKey: 'sk-or-v1-switch',
      passphrase: 'starting',
    })

    await changePassphrase({ keyId: record.id, oldPassphrase: 'starting' })
    __resetKeyCacheForTests()

    await expect(resolveKeyForDispatch(record.id)).resolves.toBe('sk-or-v1-switch')
    expect((await getKey(record.id))?.passphraseHint).toBeUndefined()
  })
})

describe('deleteKey', () => {
  it('removes the row, publishes exact compact invalidations, and makes every resolve fail', async () => {
    const record = await createKey({
      name: 'OpenRouter',
      plaintextKey: 'sk-or-v1-goner',
    })
    await createConfigurationProfile({
      id: 'profile-a',
      name: 'Profile A',
      kind: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKeyRef: record.id,
      now: 1,
    })
    await createConfigurationProfile({
      id: 'profile-b',
      name: 'Profile B',
      kind: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKeyRef: record.id,
      now: 2,
    })
    const changes: WorkspaceChange[] = []
    const unsubscribe = subscribeWorkspaceChanges((change) => changes.push(change))

    await deleteKey(record.id)
    unsubscribe()

    expect(changedDependencies(changes)).toEqual([
      {
        kind: 'key',
        keyIds: [record.id],
        facets: ['membership', 'request-material', 'selected-detail', 'usage'],
      },
    ])
    await expect(resolveKeyForDispatch(record.id)).rejects.toBeInstanceOf(KeyMissingError)
    expect(await getKey(record.id)).toBeUndefined()
  })

  it('is idempotent and does not publish a second commit for an already-missing key', async () => {
    const record = await createKey({
      name: 'OpenRouter',
      plaintextKey: 'sk-or-v1-shared',
    })
    await deleteKey(record.id)
    const changes: WorkspaceChange[] = []
    const unsubscribe = subscribeWorkspaceChanges((change) => changes.push(change))

    await deleteKey(record.id)
    unsubscribe()

    expect(changes).toEqual([])
    await expect(resolveKeyForDispatch(record.id)).rejects.toBeInstanceOf(KeyMissingError)
  })
})

function compactCommit(invalidations: readonly WorkspaceDependency[]): WorkspaceChange {
  return {
    kind: 'commit',
    stamp: {
      workspaceId: 'remote-workspace',
      replacementEpoch: 1,
      commitId: 'remote-commit',
    },
    delta: { facts: [], invalidations },
  }
}

function observeRemoteKeyMaterialChange(change: WorkspaceChange): void {
  observeKeyMaterialWorkspaceEffect(reduceWorkspaceChange(change, 'remote'))
}

function changedDependencies(changes: readonly WorkspaceChange[]): WorkspaceDependency[] {
  return changes.flatMap((change) => {
    if (change.kind === 'replace') return [{ kind: 'workspace' } satisfies WorkspaceDependency]
    if (change.kind === 'invalidate') {
      return change.dependencies === 'all'
        ? [{ kind: 'workspace' } satisfies WorkspaceDependency]
        : [...change.dependencies]
    }
    return [...change.delta.invalidations]
  })
}
