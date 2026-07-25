// Keys are AES-GCM-256 encrypted with a PBKDF2-derived wrapper key. Two modes:
//
// - **Passphrase**: the wrapper key comes from PBKDF2(passphrase, salt, 200k, SHA-256).
//   The passphrase is never persisted. Derived wrapper keys live in a per-tab
//   in-memory cache so the user only types the passphrase once per tab.
// - **Install secret**: the wrapper key comes from PBKDF2(installSecret, salt, ...).
//   The install secret is a random 32-byte value stored in the `settings` table
//   under `install-secret`. This gives encryption-at-rest without a passphrase,
//   but an attacker with IDB read access can decrypt.
//
// `resolveKey(keyId)` decrypts a stored KeyRecord and hands back plaintext for a
// single use (never written back to storage). Wrong-passphrase attempts throw
// `WrongPassphraseError` and must not fall through to an unauthenticated request.

import {
  type KeyDispatchProof,
  keyDispatchProof,
  keyDispatchProofsEqual,
} from '../core/key-dispatch-proof'
import type { KeyId, KeyRecord } from '../core/types'
import { newId } from '../lib/ulid'
import { executeConfigurationCommand } from './configuration-command-client'
import type { CreateKeyInput, PreparedEncryptedKey } from './key-preparation-contract'
import type { WorkspaceEffect } from './workspace-effect-hub'
import type { WorkspaceReadAuthority, WorkspaceWriteAuthority } from './workspace-protocol'
import { workspaceDependenciesOverlap } from './workspace-protocol'
import { getWorkspaceRepository } from './workspace-repository'
import { runWorkspaceAction, runWorkspaceRead } from './workspace-runtime'

const KDF_ITERATIONS = 200_000
const AES_LENGTH_BITS = 256
const DERIVED_KEY_CACHE_LIMIT = 64

// Cache of per-key derived wrapper CryptoKey objects. Session-scoped (per tab,
// per process). Cleared on exact key-material changes. Never persisted.
interface CachedDerivedKey {
  readonly proof: Readonly<KeyDispatchProof>
  readonly wrapperKey: CryptoKey
}

const derivedKeyCache = new Map<KeyId, CachedDerivedKey>()

export function resetKeyMaterialWorkspaceCache(): void {
  derivedKeyCache.clear()
}

export function observeKeyMaterialWorkspaceEffect(effect: WorkspaceEffect): void {
  if (effect.kind === 'replace') {
    derivedKeyCache.clear()
    return
  }
  const dependencies = effect.impact
  if (
    !workspaceDependenciesOverlap([{ kind: 'key', facets: ['request-material'] }], dependencies)
  ) {
    return
  }
  if (dependencies === 'all') {
    derivedKeyCache.clear()
    return
  }
  for (const dependency of dependencies) {
    if (dependency.kind === 'workspace') {
      derivedKeyCache.clear()
      return
    }
    if (
      dependency.kind !== 'key' ||
      (dependency.facets !== undefined && !dependency.facets.includes('request-material'))
    ) {
      continue
    }
    if (!dependency.keyIds) {
      derivedKeyCache.clear()
      return
    }
    for (const keyId of dependency.keyIds) derivedKeyCache.delete(keyId)
  }
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
export async function getOrCreateInstallSecret(
  authority?: WorkspaceWriteAuthority,
): Promise<string> {
  const initialize = async (permit: WorkspaceWriteAuthority) => {
    const fresh = bytesToBase64(randomBytes(32))
    const result = await executeConfigurationCommand(
      { kind: 'install-secret.ensure', fresh, now: Date.now() },
      permit,
    )
    if (result.kind !== 'workspace-setting-saved' || typeof result.value !== 'string') {
      throw new Error('InstallSecretInitializationFailed')
    }
    return result.value
  }
  return authority ? initialize(authority) : runWorkspaceAction('configuration', initialize)
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

export type { CreateKeyInput, PreparedEncryptedKey } from './key-preparation-contract'

export async function prepareEncryptedKey(
  input: CreateKeyInput,
  authority?: WorkspaceWriteAuthority,
): Promise<PreparedEncryptedKey> {
  const prepare = async (permit: WorkspaceWriteAuthority): Promise<PreparedEncryptedKey> => {
    const salt = randomBytes(16)
    const iv = randomBytes(12)
    const wrapperSecret = input.passphrase ?? (await getOrCreateInstallSecret(permit))
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
      materialRevision: input.materialRevision ?? 0,
      createdAt: now,
    }
    if (input.passphrase !== undefined) record.passphraseHint = input.passphraseHint ?? ''
    return Object.freeze({
      record,
      retainWrapperKey: () => cacheDerivedKey(keyDispatchProof(record), wrapperKey),
    })
  }
  return authority ? prepare(authority) : runWorkspaceAction('configuration', prepare)
}

// Encrypts `plaintextKey` and persists a KeyRecord. When `passphrase` is
// omitted, the install secret is used as the wrapper-key source. Returns the
// stored record (ciphertext + metadata) — plaintext stays in memory only.
export async function createKey(
  input: CreateKeyInput,
  authority?: WorkspaceWriteAuthority,
): Promise<KeyRecord> {
  const create = async (permit: WorkspaceWriteAuthority) => {
    const now = input.now ?? Date.now()
    const existing =
      input.id && input.materialRevision === undefined ? await getKey(input.id, permit) : undefined
    const prepared = await prepareEncryptedKey(
      {
        ...input,
        materialRevision:
          input.materialRevision ?? (existing ? (existing.materialRevision ?? 0) + 1 : 0),
        now,
      },
      permit,
    )
    const result = await executeConfigurationCommand(
      {
        kind: 'key.put',
        key: prepared.record,
        expectedMaterialRevision: existing?.materialRevision ?? null,
        now,
      },
      permit,
    )
    if (result.kind === 'conflict') throw new Error(`KeyChanged:${prepared.record.id}`)
    if (result.kind !== 'key-saved' || !result.key) {
      throw new Error(`KeyCreateFailed:${prepared.record.id}`)
    }
    prepared.retainWrapperKey()
    return result.key
  }
  return authority ? create(authority) : runWorkspaceAction('configuration', create)
}

export async function getKey(
  keyId: KeyId,
  authority?: WorkspaceReadAuthority,
): Promise<KeyRecord | undefined> {
  const read = (permit: WorkspaceReadAuthority) =>
    getWorkspaceRepository()
      .query(permit, { kind: 'key.get', keyId })
      .then((envelope) => envelope.value)
  return authority ? read(authority) : runWorkspaceRead('repository-query', read)
}

export interface ResolveKeyOptions {
  passphrase?: string
}

export interface CapturedKeyForDispatch {
  readonly proof: Readonly<KeyDispatchProof>
  readonly resolve: (
    opts?: ResolveKeyOptions,
    authority?: WorkspaceWriteAuthority,
  ) => Promise<string>
}

export function captureKeyForDispatch(record: KeyRecord): CapturedKeyForDispatch {
  return captureKeyProofForDispatch(keyDispatchProof(record))
}

export function captureKeyProofForDispatch(
  proof: Readonly<KeyDispatchProof>,
): CapturedKeyForDispatch {
  const capturedProof = Object.freeze({
    ...proof,
    kdf: Object.freeze({ ...proof.kdf }),
  })
  const captured = {} as CapturedKeyForDispatch
  Object.defineProperty(captured, 'proof', {
    configurable: false,
    enumerable: false,
    value: capturedProof,
    writable: false,
  })
  Object.defineProperty(captured, 'resolve', {
    configurable: false,
    enumerable: false,
    value: (opts: ResolveKeyOptions = {}, authority?: WorkspaceWriteAuthority) =>
      resolveCapturedKeyForDispatch(capturedProof, opts, authority),
    writable: false,
  })
  return Object.freeze(captured)
}

async function resolveCapturedKeyForDispatch(
  proof: KeyDispatchProof,
  opts: ResolveKeyOptions = {},
  authority?: WorkspaceWriteAuthority,
): Promise<string> {
  const resolve = (permit: WorkspaceWriteAuthority) =>
    resolveCapturedKeyForDispatchWithAuthority(proof, opts, permit)
  return authority ? resolve(authority) : runWorkspaceAction('configuration', resolve)
}

export async function resolveCapturedKeyProofForUse(
  proof: Readonly<KeyDispatchProof>,
  opts: ResolveKeyOptions = {},
  authority?: WorkspaceWriteAuthority,
): Promise<string> {
  const resolve = async (permit: WorkspaceWriteAuthority) => {
    const plaintext = await resolveCapturedKeyForDispatchWithAuthority(proof, opts, permit)
    await touchLastUsedAt(proof.keyId, Date.now(), permit)
    return plaintext
  }
  return authority ? resolve(authority) : runWorkspaceAction('configuration', resolve)
}

// Returns the plaintext API key. Never cached on disk; the caller hands it to
// fetch() and drops the reference. For install-secret keys, no passphrase
// prompt is needed. For passphrase keys, `opts.passphrase` is required on the
// FIRST decrypt per tab; subsequent calls reuse the in-memory derived wrapper.
export async function resolveKey(
  keyId: KeyId,
  opts: ResolveKeyOptions = {},
  authority?: WorkspaceWriteAuthority,
): Promise<string> {
  const resolve = async (permit: WorkspaceWriteAuthority) => {
    const plaintext = await resolveKeyForDispatchWithAuthority(keyId, opts, permit)
    await touchLastUsedAt(keyId, Date.now(), permit)
    return plaintext
  }
  return authority ? resolve(authority) : runWorkspaceAction('configuration', resolve)
}

export async function resolveKeyForDispatch(
  keyId: KeyId,
  opts: ResolveKeyOptions = {},
  authority?: WorkspaceWriteAuthority,
): Promise<string> {
  const resolve = (permit: WorkspaceWriteAuthority) =>
    resolveKeyForDispatchWithAuthority(keyId, opts, permit)
  return authority ? resolve(authority) : runWorkspaceAction('configuration', resolve)
}

async function resolveKeyForDispatchWithAuthority(
  keyId: KeyId,
  opts: ResolveKeyOptions,
  authority: WorkspaceWriteAuthority,
): Promise<string> {
  const record = await getKey(keyId, authority)
  if (!record) throw new KeyMissingError(keyId)
  return resolveCapturedKeyForDispatchWithAuthority(keyDispatchProof(record), opts, authority)
}

async function resolveCapturedKeyForDispatchWithAuthority(
  proof: KeyDispatchProof,
  opts: ResolveKeyOptions,
  authority: WorkspaceWriteAuthority,
): Promise<string> {
  const wrapperKey = await resolveWrapperKey(proof, opts, authority)
  const plaintextBuffer = await decryptWith(proof, wrapperKey)
  cacheDerivedKey(proof, wrapperKey)
  return new TextDecoder().decode(plaintextBuffer)
}

async function resolveWrapperKey(
  proof: KeyDispatchProof,
  opts: ResolveKeyOptions,
  authority: WorkspaceWriteAuthority,
): Promise<CryptoKey> {
  const cached = derivedKeyCache.get(proof.keyId)
  if (cached && keyDispatchProofsEqual(cached.proof, proof)) {
    derivedKeyCache.delete(proof.keyId)
    derivedKeyCache.set(proof.keyId, cached)
    return cached.wrapperKey
  }
  if (cached) derivedKeyCache.delete(proof.keyId)
  const salt = base64ToBytes(proof.salt)
  if (proof.passphraseProtected) {
    if (opts.passphrase === undefined) throw new PassphraseRequiredError(proof.keyId)
    return deriveWrapperKey(opts.passphrase, salt)
  }
  const installSecret = await getOrCreateInstallSecret(authority)
  return deriveWrapperKey(installSecret, salt)
}

async function decryptWith(proof: KeyDispatchProof, wrapperKey: CryptoKey): Promise<ArrayBuffer> {
  try {
    return await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(proof.iv) as BufferSource },
      wrapperKey,
      base64ToBytes(proof.ciphertext) as BufferSource,
    )
  } catch {
    throw new WrongPassphraseError(proof.keyId)
  }
}

function cacheDerivedKey(proof: KeyDispatchProof, wrapperKey: CryptoKey): void {
  derivedKeyCache.delete(proof.keyId)
  derivedKeyCache.set(proof.keyId, { proof, wrapperKey })
  while (derivedKeyCache.size > DERIVED_KEY_CACHE_LIMIT) {
    const oldestKeyId = derivedKeyCache.keys().next().value
    if (oldestKeyId === undefined) break
    derivedKeyCache.delete(oldestKeyId)
  }
}

async function touchLastUsedAt(
  keyId: KeyId,
  now: number,
  authority: WorkspaceWriteAuthority,
): Promise<void> {
  await executeConfigurationCommand({ kind: 'key.touch', keyId, now }, authority)
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
// re-encrypt; write back; publish an exact material-change delta so other tabs
// drop cached wrappers per §9.3.4.
export async function changePassphrase(
  input: ChangePassphraseInput,
  authority?: WorkspaceWriteAuthority,
): Promise<KeyRecord> {
  const change = async (permit: WorkspaceWriteAuthority) => {
    const existing = await getKey(input.keyId, permit)
    if (!existing) throw new KeyMissingError(input.keyId)
    const existingProof = keyDispatchProof(existing)
    const oldWrapperKey = await resolveWrapperKey(
      existingProof,
      {
        ...(input.oldPassphrase === undefined ? {} : { passphrase: input.oldPassphrase }),
      },
      permit,
    )
    const plaintextBuffer = await decryptWith(existingProof, oldWrapperKey)
    const salt = randomBytes(16)
    const iv = randomBytes(12)
    const wrapperSecret = input.newPassphrase ?? (await getOrCreateInstallSecret(permit))
    const wrapperKey = await deriveWrapperKey(wrapperSecret, salt)
    const ciphertextBuffer = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      wrapperKey,
      plaintextBuffer,
    )
    const now = input.now ?? Date.now()
    const next: KeyRecord = {
      ...existing,
      ciphertext: bytesToBase64(new Uint8Array(ciphertextBuffer)),
      iv: bytesToBase64(iv),
      salt: bytesToBase64(salt),
      materialRevision: (existing.materialRevision ?? 0) + 1,
      lastUsedAt: Math.max(existing.lastUsedAt ?? 0, now),
    }
    if (input.newPassphrase !== undefined) {
      next.passphraseHint = input.newPassphraseHint ?? existing.passphraseHint ?? ''
    } else {
      delete next.passphraseHint
    }
    const result = await executeConfigurationCommand(
      {
        kind: 'key.material-replace',
        key: next,
        expectedMaterialRevision: existing.materialRevision ?? 0,
        now,
      },
      permit,
    )
    if (result.kind === 'missing') throw new KeyMissingError(input.keyId)
    if (result.kind === 'conflict') throw new Error(`KeyChanged:${input.keyId}`)
    if (!result.key) throw new Error(`KeyReplaceFailed:${input.keyId}`)
    cacheDerivedKey(keyDispatchProof(result.key), wrapperKey)
    return result.key
  }
  return authority ? change(authority) : runWorkspaceAction('configuration', change)
}

// Delete a key. The exact deletion delta drops cached wrappers; the next
// `resolveKey` call throws `KeyMissingError`. See §9.3.5.
export async function deleteKey(keyId: KeyId, authority?: WorkspaceWriteAuthority): Promise<void> {
  const remove = async (permit: WorkspaceWriteAuthority) => {
    const result = await executeConfigurationCommand(
      { kind: 'key.delete', keyId, now: Date.now() },
      permit,
    )
    if (result.kind === 'key-saved') derivedKeyCache.delete(keyId)
  }
  await (authority ? remove(authority) : runWorkspaceAction('configuration', remove))
}

export function __resetKeyCacheForTests(): void {
  resetKeyMaterialWorkspaceCache()
}
