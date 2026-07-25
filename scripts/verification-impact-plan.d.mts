import type {
  LocalModuleGraphDiagnostic,
  LocalModuleFileSource,
} from './local-module-graph.mjs'
import type {
  VerificationObligation,
  VerificationProof,
} from './verification-obligation-manifest.mjs'

export interface VerificationSymbolSnapshot {
  readonly id: string
  readonly kind: string
  readonly name: string
  readonly sha256: string
}

export interface VerificationSnapshot {
  readonly schemaVersion: 2
  readonly obligationSchemaVersion: number
  readonly files: Readonly<
    Record<
      string,
      {
        readonly sha256: string
        readonly executable: boolean
        readonly symbols: readonly VerificationSymbolSnapshot[]
      }
    >
  >
  readonly dependencies: Readonly<Record<string, readonly string[]>>
  readonly graphDiagnostics: readonly LocalModuleGraphDiagnostic[]
  readonly digest: string
}


export interface VerificationImpact {
  readonly addedPaths: readonly string[]
  readonly modifiedPaths: readonly string[]
  readonly deletedPaths: readonly string[]
  readonly changedPaths: readonly string[]
  readonly changedSymbols: readonly {
    id: string
    path: string
    change: 'added' | 'modified' | 'deleted'
  }[]
}

export interface SliceVerificationPlan {
  readonly schemaVersion: 1
  readonly baseDigest: string
  readonly currentDigest: string
  readonly impact: VerificationImpact
  readonly affectedPaths: readonly string[]
  readonly impactedDomains: readonly string[]
  readonly impactedObligations: readonly string[]
  readonly impactedGuarantees: readonly { id: string; status: string }[]
  readonly openGuarantees: readonly { id: string; status: string }[]
  readonly unregisteredAffectedTests: readonly string[]
  readonly tasks: {
    readonly node: readonly { id: string; argv: readonly string[] }[]
    readonly vitest: readonly string[]
    readonly playwright: readonly {
      project: string
      files: readonly string[]
    }[]
  }
  readonly structuralBlockers: readonly string[]
  readonly executable: boolean
  readonly closable: boolean
  readonly planDigest: string
}

export function buildVerificationSnapshot(options?: {
  root?: string
  globalInputs?: readonly string[]
  explicitEdges?: readonly { importer: string; dependency: string; rationale: string }[]
  source?: LocalModuleFileSource
  parseSourceFile?: (path: string, source: string) => import('typescript').SourceFile
}): VerificationSnapshot
export function diffVerificationSnapshots(
  base: VerificationSnapshot,
  current: VerificationSnapshot,
): VerificationImpact
export function planSliceVerification(options: {
  root?: string
  base: VerificationSnapshot
  current: VerificationSnapshot
  obligations?: readonly VerificationObligation[]
  proofs?: readonly VerificationProof[]
  globalInputs?: readonly string[]
  moduleInventory?: unknown
  opaqueDispositions?: readonly {
    path: string
    code: 'opaque-module-reference'
    expectedCount: number
    rationale: string
  }[]
}): SliceVerificationPlan
export function validateVerificationManifest(options?: {
  root?: string
  current: VerificationSnapshot
  obligations?: readonly VerificationObligation[]
  proofs?: readonly VerificationProof[]
}): readonly string[]
export function assertSafeProofExecution(proof: VerificationProof): void
