import type { KeyId, KeyRecord } from './types'

export interface KeyDispatchProof {
  readonly keyId: KeyId
  readonly ciphertext: string
  readonly iv: string
  readonly salt: string
  readonly algorithm: KeyRecord['algorithm']
  readonly kdf: Readonly<KeyRecord['kdf']>
  readonly passphraseProtected: boolean
}

export interface KeyDispatchRevision {
  readonly keyId: KeyId
  readonly materialRevision: number | null
}

export function keyDispatchRevisions(
  keyIds: readonly KeyId[],
  records: readonly (KeyRecord | undefined)[],
): readonly KeyDispatchRevision[] {
  return Object.freeze(
    keyIds.map((keyId, index) => {
      const record = records[index]
      return Object.freeze({
        keyId,
        materialRevision: record?.id === keyId ? (record.materialRevision ?? 0) : null,
      })
    }),
  )
}

export function keyDispatchProof(record: KeyRecord): Readonly<KeyDispatchProof> {
  return Object.freeze({
    keyId: record.id,
    ciphertext: record.ciphertext,
    iv: record.iv,
    salt: record.salt,
    algorithm: record.algorithm,
    kdf: Object.freeze({ ...record.kdf }),
    passphraseProtected: record.passphraseHint !== undefined,
  })
}

export function keyDispatchProofsEqual(left: KeyDispatchProof, right: KeyDispatchProof): boolean {
  return (
    left.keyId === right.keyId &&
    left.ciphertext === right.ciphertext &&
    left.iv === right.iv &&
    left.salt === right.salt &&
    left.passphraseProtected === right.passphraseProtected
  )
}
