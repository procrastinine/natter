export interface CandidateResidentInvocation {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly candidateRunner: string
}

export function createCandidateResidentInvocation(options: {
  readonly evidenceRoot?: string
  readonly baselineId: string
  readonly candidateId: string
  readonly runnerKind?: 'checkpoint' | 'slice'
}): CandidateResidentInvocation

export function launchCandidateResidentVerification(options: {
  readonly evidenceRoot?: string
  readonly baselineId: string
  readonly candidateId: string
  readonly runnerKind?: 'checkpoint' | 'slice'
  readonly stdio?: 'inherit' | 'ignore'
}): Promise<{ readonly exitCode: number | null; readonly signal: NodeJS.Signals | null }>
