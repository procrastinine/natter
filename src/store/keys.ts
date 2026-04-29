// Key vault. See `plan/02-data-model.md §2.6` and `plan/09-privacy.md §9.3`.
//
// Keys are AES-GCM-256 encrypted with a PBKDF2-derived wrapper key. Two modes:
//
// - **Passphrase**: the wrapper key comes from PBKDF2(passphrase, salt, 200k, SHA-256).
//   The passphrase is never persisted. Derived wrapper keys live in a per-tab
//   in-memory cache so the user only types the passphrase once per tab.
// - **Install secret**: the wrapper key comes from PBKDF2(installSecret, salt, ...).
//   The install secret is a random 32-byte value stored in the `settings` table
//   under `install-secret`. This gives encryption-at-rest without a passphrase,
//   but an attacker with IDB read access can decrypt. Trade-off documented in
//   §9.3.1.
//
// `resolveKey(keyId)` decrypts a stored KeyRecord and hands back plaintext for a
// single use (never written back to storage). Wrong-passphrase attempts throw
// `WrongPassphraseError` — they MUST NOT fall through to an unauthenticated
// request (§13.2.5 test).

import type { KeyId, KeyRecord } from '../core/types'
import { newId } from '../lib/ulid'
import { onEvent, postEvent } from './broadcast'
import { getDb } from './db'
import { getSetting, setSetting } from './settings'

const INSTALL_SECRET_SETTING_KEY = 'install-secret'
const KDF_ITERATIONS = 200_000
const AES_LENGTH_BITS = 256

// Cache of per-key derived wrapper CryptoKey objects. Session-scoped (per tab,
// per process). Cleared on `key-rotated` broadcast. Never persisted.
const derivedKeyCache = new Map<KeyId, CryptoKey>()

let broadcastHookAttached = false

function ensureBroadcastHook(): void {
  if (broadcastHookAttached) return
  broadcastHookAttached = true
  onEvent((event) => {
    if (event.kind === 'key-rotated') derivedKeyCache.delete(event.keyId)
  })
}

export class WrongPassphraseError extends Error {
  readonly keyId: KeyId
  constructor(keyId: KeyId) {
    super(`WrongPassphrase:${keyId}`)
    this.name = 'WrongPassphraseError'
    this.keyId = keyId
  }
}

export class PassphraseRequiredError extends Error {
  readonly keyId: KeyId
  constructor(keyId: KeyId) {
    super(`PassphraseRequired:${keyId}`)
    this.name = 'PassphraseRequiredError'
    this.keyId = keyId
  }
}

export class KeyMissingError extends Error {
  readonly keyId: KeyId
  constructor(keyId: KeyId) {
    super(`KeyMissing:${keyId}`)
    this.name = 'KeyMissingError'
    this.keyId = keyId
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}

function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length)
  crypto.getRandomValues(out)
  return out
}

// Gets the per-install random secret used when no passphrase is set. Creates
// it on first call and persists in `settings['install-secret']`. See §9.3.1.
export async function getOrCreateInstallSecret(): Promise<string> {
  const existing = await getSetting<string>(INSTALL_SECRET_SETTING_KEY)
  if (existing) return existing
  const fresh = bytesToBase64(randomBytes(32))
  await setSetting(INSTALL_SECRET_SETTING_KEY, fresh)
  return fresh
}

async function deriveWrapperKey(passphraseOrSecret: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphraseOrSecret),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations: KDF_ITERATIONS,
      hash: 'SHA-256',
    },
    material,
    { name: 'AES-GCM', length: AES_LENGTH_BITS },
    false,
    ['encrypt', 'decrypt'],
  )
}

// Produce the obscured preview shown in the UI: "sk-or-v1-...edc7". Keeps
// enough prefix to identify the provider and the last four characters so the
// user can confirm which key is active, without rendering the full secret.
export function obscurePreview(plaintext: string): string {
  const trimmed = plaintext.trim()
  if (trimmed.length <= 8) return '••••'
  const prefix = trimmed.slice(0, 10)
  const tail = trimmed.slice(-4)
  return `${prefix}…${tail}`
}

interface CreateKeyInput {
  name: string
  plaintextKey: string
  passphrase?: string
  passphraseHint?: string
  id?: KeyId
  now?: number
}

// Encrypts `plaintextKey` and persists a KeyRecord. When `passphrase` is
// omitted, the install secret is used as the wrapper-key source. Returns the
// stored record (ciphertext + metadata) — plaintext stays in memory only.
export async function createKey(input: CreateKeyInput): Promise<KeyRecord> {
  ensureBroadcastHook()
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const wrapperSecret = input.passphrase ?? (await getOrCreateInstallSecret())
  const wrapperKey = await deriveWrapperKey(wrapperSecret, salt)
  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    wrapperKey,
    new TextEncoder().encode(input.plaintextKey),
  )
  const now = input.now ?? Date.now()
  const record: KeyRecord = {
    id: input.id ?? newId(),
    name: input.name,
    ciphertext: bytesToBase64(new Uint8Array(ciphertextBuffer)),
    iv: bytesToBase64(iv),
    salt: bytesToBase64(salt),
    algorithm: 'AES-GCM-256',
    kdf: { name: 'PBKDF2', iterations: KDF_ITERATIONS, hash: 'SHA-256' },
    obscuredPreview: obscurePreview(input.plaintextKey),
    createdAt: now,
  }
  // Mode discriminator: `passphraseHint` present ↔ passphrase-protected. When
  // the user supplied a passphrase without a hint, set it to an empty
  // string so the invariant holds (§9.3.1).
  if (input.passphrase !== undefined) {
    record.passphraseHint = input.passphraseHint ?? ''
  }
  derivedKeyCache.set(record.id, wrapperKey)
  await getDb().keys.put(record)
  return record
}

export async function getKey(keyId: KeyId): Promise<KeyRecord | undefined> {
  return getDb().keys.get(keyId)
}

interface ResolveKeyOptions {
  passphrase?: string
}

// Returns the plaintext API key. Never cached on disk; the caller hands it to
// fetch() and drops the reference. For install-secret keys, no passphrase
// prompt is needed. For passphrase keys, `opts.passphrase` is required on the
// FIRST decrypt per tab; subsequent calls reuse the in-memory derived wrapper.
export async function resolveKey(keyId: KeyId, opts: ResolveKeyOptions = {}): Promise<string> {
  ensureBroadcastHook()
  const record = await getKey(keyId)
  if (!record) throw new KeyMissingError(keyId)
  const wrapperKey = await resolveWrapperKey(record, opts)
  const plaintextBuffer = await decryptWith(record, wrapperKey, keyId)
  derivedKeyCache.set(keyId, wrapperKey)
  await touchLastUsedAt(keyId)
  return new TextDecoder().decode(plaintextBuffer)
}

export async function resolveKeyIfPresent(
  keyId: KeyId,
  opts: ResolveKeyOptions = {},
): Promise<string | null> {
  const record = await getKey(keyId)
  if (!record) return null
  return resolveKey(keyId, opts)
}

async function resolveWrapperKey(record: KeyRecord, opts: ResolveKeyOptions): Promise<CryptoKey> {
  const cached = derivedKeyCache.get(record.id)
  if (cached) return cached
  const salt = base64ToBytes(record.salt)
  if (record.passphraseHint !== undefined) {
    if (opts.passphrase === undefined) throw new PassphraseRequiredError(record.id)
    return deriveWrapperKey(opts.passphrase, salt)
  }
  const installSecret = await getOrCreateInstallSecret()
  return deriveWrapperKey(installSecret, salt)
}

async function decryptWith(
  record: KeyRecord,
  wrapperKey: CryptoKey,
  keyId: KeyId,
): Promise<ArrayBuffer> {
  try {
    return await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(record.iv) as BufferSource },
      wrapperKey,
      base64ToBytes(record.ciphertext) as BufferSource,
    )
  } catch {
    throw new WrongPassphraseError(keyId)
  }
}

async function touchLastUsedAt(keyId: KeyId, now = Date.now()): Promise<void> {
  const db = getDb()
  const row = await db.keys.get(keyId)
  if (!row) return
  await db.keys.put({ ...row, lastUsedAt: now })
}

interface ChangePassphraseInput {
  keyId: KeyId
  oldPassphrase?: string
  newPassphrase?: string
  newPassphraseHint?: string
  now?: number
}

// Re-encrypts the key under a new passphrase (or switches to/from
// install-secret mode). Unlock the old ciphertext first; derive a fresh salt;
// re-encrypt; write back; broadcast `key-rotated` so other tabs drop cached
// wrappers per §9.3.4.
export async function changePassphrase(input: ChangePassphraseInput): Promise<KeyRecord> {
  ensureBroadcastHook()
  const plaintext = await resolveKey(input.keyId, {
    ...(input.oldPassphrase !== undefined ? { passphrase: input.oldPassphrase } : {}),
  })
  const existing = await getKey(input.keyId)
  if (!existing) throw new KeyMissingError(input.keyId)
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const wrapperSecret = input.newPassphrase ?? (await getOrCreateInstallSecret())
  const wrapperKey = await deriveWrapperKey(wrapperSecret, salt)
  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    wrapperKey,
    new TextEncoder().encode(plaintext),
  )
  const next: KeyRecord = {
    ...existing,
    ciphertext: bytesToBase64(new Uint8Array(ciphertextBuffer)),
    iv: bytesToBase64(iv),
    salt: bytesToBase64(salt),
  }
  if (input.newPassphrase !== undefined) {
    next.passphraseHint = input.newPassphraseHint ?? existing.passphraseHint ?? ''
  } else {
    delete next.passphraseHint
  }
  await getDb().keys.put(next)
  derivedKeyCache.set(input.keyId, wrapperKey)
  postEvent({ kind: 'key-rotated', keyId: input.keyId })
  return next
}

// Delete a key. Broadcasts `key-rotated` because listeners' required action is
// the same as passphrase rotation: drop cached wrappers and re-read on next
// use (the next `resolveKey` call will throw `KeyMissingError`). See §9.3.5.
export async function deleteKey(keyId: KeyId): Promise<void> {
  ensureBroadcastHook()
  derivedKeyCache.delete(keyId)
  await getDb().keys.delete(keyId)
  postEvent({ kind: 'key-rotated', keyId })
}

export function __resetKeyCacheForTests(): void {
  derivedKeyCache.clear()
  broadcastHookAttached = false
}
