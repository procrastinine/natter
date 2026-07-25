import type { Writable } from 'node:stream'

export interface VerificationProcessRuntime {
  readonly nodeExecutablePath: string
  readonly pnpmExecutablePath: string
}

export interface VerificationProcessExecution {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly diagnostics: readonly string[]
  readonly stdoutPath: string | null
  readonly stderrPath: string | null
}

export function createVerificationRuntimeInvocation(
  argv: readonly string[],
  runtime?: VerificationProcessRuntime | null,
): Readonly<{ command: string; args: readonly string[] }>

export function verificationChildEnvironment(options: {
  readonly kind: string
  readonly root: string
  readonly runId: string
  readonly baseEnv: Readonly<NodeJS.ProcessEnv>
}): NodeJS.ProcessEnv

export function executeFileBackedVerificationProcess(options: {
  readonly id: string
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly environment: Readonly<NodeJS.ProcessEnv>
  readonly artifactRoot: string
  readonly runDirectory: string
  readonly diagnosticPrefix?: string
  readonly forwardOutput?: boolean
  readonly outputDestinations?: { readonly stdout: Writable; readonly stderr: Writable }
}): Promise<VerificationProcessExecution>
