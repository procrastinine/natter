import type { KeyId, KeyRecord } from '../core/types'

export interface CreateKeyInput {
  name: string
  plaintextKey: string
  passphrase?: string
  passphraseHint?: string
  id?: KeyId
  materialRevision?: number
  now?: number
}

export interface PreparedEncryptedKey {
  readonly record: KeyRecord
  retainWrapperKey(): void
}
