import type { Buffer } from 'node:buffer'
import type { VerificationSnapshot } from './verification-impact-plan.mjs'

export interface VerificationComparisonManifest {
  readonly id: string
  readonly comparison: { readonly kind: 'git-commit'; readonly oid: string }
}

export interface CommittedVerificationComparison {
  readonly schemaVersion: 1
  readonly kind: 'git-object-comparison'
  readonly waveId: string
  readonly commitOid: string
  readonly treeOid: string
  readonly snapshotSchemaVersion: 2
  readonly sourceStats: {
    readonly treeEntryCount: number
    readonly selectedFileCount: number
    readonly uniqueBlobCount: number
    readonly selectedBytes: number
    readonly gitProcessCount: 4
  }
  readonly snapshot: VerificationSnapshot
  readonly digest: string
}

export interface GitComparisonCapture {
  readonly schemaVersion: 1
  readonly commitOid: string
  readonly treeOid: string
  readonly treeListing: EncodedBytes
  readonly blobBatch: EncodedBytes
  readonly requestedObjectIds: readonly string[]
  readonly gitProcessCount: 4
}

interface EncodedBytes {
  readonly encoding: 'base64'
  readonly byteLength: number
  readonly sha256: string
  readonly data: string
}

interface GitProcessResult {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly error: string | null
  readonly stdout: Buffer
  readonly stderr: Buffer
}

export function materializeCommittedVerificationComparison(options?: {
  readonly root?: string
  readonly manifest?: VerificationComparisonManifest
  readonly runGit?: (
    root: string,
    args: readonly string[],
    input: Buffer | null,
  ) => Promise<GitProcessResult>
}): Promise<CommittedVerificationComparison>
export function buildCommittedVerificationComparison(options: {
  readonly manifest?: VerificationComparisonManifest
  readonly capture: GitComparisonCapture
}): CommittedVerificationComparison
export function restoreCommittedVerificationComparison(
  value: unknown,
  manifest?: VerificationComparisonManifest,
): CommittedVerificationComparison
export function assertCommittedVerificationComparison(
  value: unknown,
): CommittedVerificationComparison
