export type VerificationProofKind =
  | 'static'
  | 'unit'
  | 'integration'
  | 'browser'
  | 'performance'
  | 'stress'
  | 'live'

export type VerificationProofExecution =
  | { readonly runner: 'node'; readonly argv: readonly string[] }
  | { readonly runner: 'vitest'; readonly files: readonly string[] }
  | {
      readonly runner: 'playwright'
      readonly project: 'chromium' | 'chromium-large-workspace' | 'chromium-send-performance'
      readonly files: readonly string[]
    }

export interface VerificationProof {
  readonly id: string
  readonly kind: VerificationProofKind
  readonly execution: VerificationProofExecution
}

export interface VerificationObligation {
  readonly id: string
  readonly status: 'covered' | 'open'
  readonly impactModules: readonly string[]
  readonly proofIds: readonly string[]
}

export const VERIFICATION_OBLIGATION_SCHEMA_VERSION: number
export const VERIFICATION_PROOFS: readonly VerificationProof[]
export const VERIFICATION_OBLIGATIONS: readonly VerificationObligation[]
export function verificationGlobalInputPaths(options?: {
  readonly root?: string
  readonly allPaths?: Iterable<string>
}): readonly string[]
export const VERIFICATION_EXPLICIT_MODULE_EDGES: readonly {
  importer: string
  dependency: string
  rationale: string
}[]
export const VERIFICATION_OPAQUE_MODULE_REFERENCE_DISPOSITIONS: readonly {
  path: string
  code: 'opaque-module-reference'
  expectedCount: number
  rationale: string
}[]
