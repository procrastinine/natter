import type { VitestProjectFiles } from './vitest-projects.mjs'
import type { VerificationStage } from './run-verification.mjs'
import type {
  LocalModuleGraphDiagnostic,
  LocalModuleFileSource,
} from './local-module-graph.mjs'
import type {
  VerificationObligation,
  VerificationProof,
} from './verification-obligation-manifest.mjs'

export function verificationSnapshotInputPaths(options: {
  readonly source: LocalModuleFileSource
  readonly globalInputs?: readonly string[]
  readonly stages?: readonly VerificationStage[]
}): string[]

export interface VerificationSymbolSnapshot {
  readonly id: string
  readonly kind: string
  readonly name: string
  readonly sha256: string
}

export type VerificationUnitExecution =
  | {
      readonly status: 'owned'
      readonly providerInputs: Readonly<Record<string, string>>
      readonly projects: readonly VitestProjectFiles[]
    }
  | {
      readonly status: 'unavailable'
      readonly providerInputs: Readonly<Record<string, string>>
      readonly mismatchedPaths: readonly string[]
    }

export interface VerificationSnapshot {
  readonly schemaVersion: 4
  readonly unitExecution: VerificationUnitExecution
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
  readonly stages: readonly VerificationStage[]
  readonly impactedStageIds: readonly string[]
  readonly schemaVersion: 2
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
  stages?: readonly VerificationStage[]
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

export function validateOpaqueModuleDispositions(
  diagnostics: readonly LocalModuleGraphDiagnostic[],
  dispositions: readonly { path: string; code: string; expectedCount: number; rationale: string }[],
  files: Readonly<Record<string, unknown>>,
): string[]
