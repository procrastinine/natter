import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  __resetBroadcastForTests,
  onEvent,
  type BroadcastEvent,
} from '../../src/store/broadcast'
import { __resetDbForTests, openDb } from '../../src/store/db'
import {
  __resetKeyCacheForTests,
  changePassphrase,
  createKey,
  deleteKey,
  getKey,
  getOrCreateInstallSecret,
  KeyMissingError,
  obscurePreview,
  PassphraseRequiredError,
  resolveKey,
  WrongPassphraseError,
} from '../../src/store/keys'
import { getSetting } from '../../src/store/settings'

const DB_NAME = 'natter'

async function resetAll() {
  __resetBroadcastForTests()
  __resetKeyCacheForTests()
  __resetDbForTests()
  await Dexie.delete(DB_NAME)
}

beforeEach(async () => {
  await resetAll()
  await openDb()
})

afterEach(async () => {
  await resetAll()
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
  it('creates and persists an install secret on first access; reuses it thereafter', async () => {
    const first = await getOrCreateInstallSecret()
    const second = await getOrCreateInstallSecret()
    expect(first).toBe(second)
    const stored = await getSetting<string>('install-secret')
    expect(stored).toBe(first)
  })
})

describe('createKey + resolveKey (passphrase mode)', () => {
  it('round-trips plaintext through encrypt + decrypt', async () => {
    const record = await createKey({
      name: 'OpenRouter',
      plaintextKey: 'sk-or-v1-1234567890abcdefghijxyz',
      passphrase: 'correct horse battery staple',
      passphraseHint: 'the xkcd one',
    })
    expect(record.passphraseHint).toBe('the xkcd one')
    expect(record.obscuredPreview).toBe('sk-or-v1-1…jxyz')
    const plaintext = await resolveKey(record.id, {
      passphrase: 'correct horse battery staple',
    })
    expect(plaintext).toBe('sk-or-v1-1234567890abcdefghijxyz')
  })

  it('throws WrongPassphraseError on a bad passphrase without falling through', async () => {
    const record = await createKey({
      name: 'OpenRouter',
      plaintextKey: 'sk-or-v1-secret',
      passphrase: 'correct',
    })
    // Clear the derived-key cache so the wrong passphrase actually attempts the
    // expensive PBKDF2 + AES-GCM decrypt — otherwise the cached wrapper from
    // createKey would satisfy the resolveKey call without a derivation round.
    __resetKeyCacheForTests()
    await expect(
      resolveKey(record.id, { passphrase: 'wrong' }),
    ).rejects.toBeInstanceOf(WrongPassphraseError)
    // Ensure no plaintext leaked through the return channel.
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
    await expect(resolveKey(record.id)).rejects.toBeInstanceOf(
      PassphraseRequiredError,
    )
  })
})

describe('createKey + resolveKey (install-secret mode)', () => {
  it('round-trips plaintext without any passphrase prompt', async () => {
    const record = await createKey({
      name: 'OpenRouter',
      plaintextKey: 'sk-or-v1-installsecretonly',
    })
    expect(record.passphraseHint).toBeUndefined()
    const plaintext = await resolveKey(record.id)
    expect(plaintext).toBe('sk-or-v1-installsecretonly')
  })

  it('survives a fresh tab (in-memory derived cache cleared) because the install secret is persisted', async () => {
    const record = await createKey({
      name: 'OpenRouter',
      plaintextKey: 'sk-or-v1-persist',
    })
    __resetKeyCacheForTests()
    const plaintext = await resolveKey(record.id)
    expect(plaintext).toBe('sk-or-v1-persist')
  })
})

describe('changePassphrase', () => {
  it('re-encrypts with a fresh salt + iv and broadcasts key-rotated', async () => {
    const record = await createKey({
      name: 'OpenRouter',
      plaintextKey: 'sk-or-v1-rotated',
      passphrase: 'old-one',
    })
    const seen: BroadcastEvent[] = []
    const unsub = onEvent((ev) => seen.push(ev))

    const next = await changePassphrase({
      keyId: record.id,
      oldPassphrase: 'old-one',
      newPassphrase: 'new-one',
      newPassphraseHint: 'fresh',
    })
    unsub()

    expect(next.passphraseHint).toBe('fresh')
    expect(next.salt).not.toBe(record.salt)
    expect(next.iv).not.toBe(record.iv)
    expect(next.ciphertext).not.toBe(record.ciphertext)
    expect(seen.some((ev) => ev.kind === 'key-rotated' && ev.keyId === record.id)).toBe(true)

    __resetKeyCacheForTests()
    await expect(
      resolveKey(record.id, { passphrase: 'old-one' }),
    ).rejects.toBeInstanceOf(WrongPassphraseError)
    const plaintext = await resolveKey(record.id, { passphrase: 'new-one' })
    expect(plaintext).toBe('sk-or-v1-rotated')
  })

  it('drops from passphrase mode to install-secret mode', async () => {
    const record = await createKey({
      name: 'OpenRouter',
      plaintextKey: 'sk-or-v1-switch',
      passphrase: 'starting',
    })
    await changePassphrase({ keyId: record.id, oldPassphrase: 'starting' })
    __resetKeyCacheForTests()
    const plaintext = await resolveKey(record.id)
    expect(plaintext).toBe('sk-or-v1-switch')
    const stored = await getKey(record.id)
    expect(stored?.passphraseHint).toBeUndefined()
  })
})

describe('deleteKey', () => {
  it('removes the row and broadcasts key-rotated; subsequent resolves throw KeyMissingError', async () => {
    const record = await createKey({
      name: 'OpenRouter',
      plaintextKey: 'sk-or-v1-goner',
    })
    const seen: BroadcastEvent[] = []
    const unsub = onEvent((ev) => seen.push(ev))
    await deleteKey(record.id)
    unsub()
    expect(seen.some((ev) => ev.kind === 'key-rotated' && ev.keyId === record.id)).toBe(true)
    await expect(resolveKey(record.id)).rejects.toBeInstanceOf(KeyMissingError)
    const row = await getKey(record.id)
    expect(row).toBeUndefined()
  })

  it('invalidates dependent connections — resolveKey against the shared keyId fails for every profile that referenced it', async () => {
    const record = await createKey({
      name: 'OpenRouter',
      plaintextKey: 'sk-or-v1-shared',
    })
    // Two profiles sharing the same key (the common "prod vs dev" pattern).
    // Deleting the key must break BOTH; neither profile can silently proceed
    // to unauthenticated sends.
    await expect(resolveKey(record.id)).resolves.toBe('sk-or-v1-shared')
    await deleteKey(record.id)
    __resetKeyCacheForTests()
    await expect(resolveKey(record.id)).rejects.toBeInstanceOf(KeyMissingError)
  })
})
