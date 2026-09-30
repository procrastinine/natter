import type {
  VerificationAssurance,
  VerificationExecution,
  VerificationPolicy,
  VerificationStage,
  VerificationStatus,
} from './run-verification.mjs'

export function verificationStage(
  id: string,
  label: string,
  policy: VerificationPolicy,
  argv: readonly string[],
  options?: Omit<Partial<VerificationStage>, 'id' | 'label' | 'policy' | 'argv'>,
): VerificationStage
export function verificationStageAssurance(stage: VerificationStage): VerificationAssurance
export function verificationStageStatus(
  stage: VerificationStage,
  execution: VerificationExecution,
): Exclude<VerificationStatus, 'planned'>
export function resolveVerificationStagePrerequisites(
  selected: readonly VerificationStage[],
  catalog: readonly VerificationStage[],
  inputPaths?: ReadonlySet<string> | null,
): readonly VerificationStage[]
export function verificationPrerequisiteDiagnostics(
  stage: VerificationStage,
  results: readonly { readonly id: string; readonly stageId?: string; readonly status: string }[],
): readonly string[]

export function verificationStageBlocks(result: { readonly policy: VerificationPolicy; readonly status: string }): boolean

export interface VerificationStageReference {
  readonly path: 'scripts/run-verification.mjs'
  readonly stage: {
    readonly id: string
    readonly policy: VerificationPolicy
    readonly kind: NonNullable<VerificationStage['kind']>
    readonly browserProjects?: readonly string[]
  }
}
export function verificationStageReference(id: string, expected: Omit<VerificationStageReference['stage'], 'id'>): VerificationStageReference
export function verificationStageReferenceProblems(reference: VerificationStageReference, stages: readonly VerificationStage[]): string[]
