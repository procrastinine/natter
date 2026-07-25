import type {
  MaterializedVerificationCandidate,
  VerificationCandidateRuntime,
} from './verification-candidate-workspace.mjs'

export interface VerificationCandidateExecutionContext {
  readonly candidate: MaterializedVerificationCandidate
  readonly runtime: VerificationCandidateRuntime
  readonly environment: Readonly<NodeJS.ProcessEnv>
}

export function executeMaterializedVerificationCandidate<T>(
  options: {
    readonly candidate: MaterializedVerificationCandidate
    readonly evidenceRoot: string
    readonly residentRoot: string
    readonly runId: string
    readonly purpose: string
    readonly baseEnv?: Readonly<NodeJS.ProcessEnv>
  },
  operation: (context: VerificationCandidateExecutionContext) => Promise<T>,
): Promise<T>

export function createVerificationCandidateEnvironment(
  candidate: MaterializedVerificationCandidate,
  runId: string,
  baseEnv?: Readonly<NodeJS.ProcessEnv>,
  runtime?: Pick<VerificationCandidateRuntime, 'nodeExecutablePath' | 'pnpmExecutablePath'> | null,
): Readonly<NodeJS.ProcessEnv>
