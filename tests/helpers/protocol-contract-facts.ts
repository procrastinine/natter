import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { productionTypeScriptFileDigest } from '../../scripts/production-typescript-source.mjs'
import { protocolContractGeneratorDigest } from '../../scripts/protocol-contract-fingerprint.mjs'

const ROOT = resolve(__dirname, '../..')
const FACTS_PATH = resolve(ROOT, 'test-results/protocol-contract-facts.json')
const MUTATION_PATH = resolve(ROOT, 'test-results/protocol-contract-mutation-proof.json')
const PREREQUISITE =
  'node scripts/audit-protocol-contracts.mjs --mode inventory --facts-output test-results/protocol-contract-facts.json --mutation-output test-results/protocol-contract-mutation-proof.json'
let cachedBundle: Promise<unknown> | undefined
let cachedMutationProof: Promise<unknown> | undefined

export function loadProtocolContractFactBundle<T>(): Promise<T> {
  cachedBundle ??= loadCurrentArtifact(FACTS_PATH, isCurrentProtocolContractFactBundle)
  return cachedBundle as Promise<T>
}

export function loadProtocolContractMutationProof<T>(): Promise<T> {
  cachedMutationProof ??= loadCurrentArtifact(MUTATION_PATH, isCurrentProtocolContractMutationProof)
  return cachedMutationProof as Promise<T>
}

async function loadCurrentArtifact(
  path: string,
  isCurrent: (value: unknown, digest: string, generatorDigest: string) => boolean,
): Promise<unknown> {
  const digest = productionTypeScriptFileDigest(ROOT)
  const generatorDigest = protocolContractGeneratorDigest(ROOT)
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (isCurrent(parsed, digest, generatorDigest))
      return freezeProtocolContractFactArtifact(parsed)
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
      throw new Error(`ProtocolContractFactArtifactInvalid:${path}; run: ${PREREQUISITE}`, {
        cause: error,
      })
    }
  }
  throw new Error(`ProtocolContractFactArtifactMissingOrStale:${path}; run: ${PREREQUISITE}`)
}

function freezeProtocolContractFactArtifact(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) freezeProtocolContractFactArtifact(child)
  return Object.freeze(value)
}

export function isCurrentProtocolContractFactBundle(
  value: unknown,
  digest: string,
  generatorDigest: string,
): boolean {
  if (value === null || typeof value !== 'object') return false
  const record = value as Readonly<Record<string, unknown>>
  if (record.schemaVersion !== 3) return false
  const snapshot = record.snapshot
  return (
    snapshot !== null &&
    typeof snapshot === 'object' &&
    (snapshot as Readonly<Record<string, unknown>>).digest === digest &&
    (snapshot as Readonly<Record<string, unknown>>).generatorDigest === generatorDigest
  )
}

export function isCurrentProtocolContractMutationProof(
  value: unknown,
  digest: string,
  generatorDigest: string,
): boolean {
  if (value === null || typeof value !== 'object') return false
  const record = value as Readonly<Record<string, unknown>>
  if (record.schemaVersion !== 1) return false
  const snapshot = record.baselineSnapshot
  return (
    snapshot !== null &&
    typeof snapshot === 'object' &&
    (snapshot as Readonly<Record<string, unknown>>).digest === digest &&
    (snapshot as Readonly<Record<string, unknown>>).generatorDigest === generatorDigest
  )
}
