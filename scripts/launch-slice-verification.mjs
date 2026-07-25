import { spawn } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(import.meta.dirname, '..')

export function createCandidateResidentInvocation(options) {
  const evidenceRoot = resolve(options.evidenceRoot ?? ROOT)
  const candidateId = assertCandidateId(options.candidateId)
  const baselineId = assertBaselineId(options.baselineId)
  const candidateDirectory = resolve(
    evidenceRoot,
    'test-results/verification-slice/candidates',
    candidateId,
  )
  const envelope = JSON.parse(readFileSync(resolve(candidateDirectory, 'candidate.json'), 'utf8'))
  if (envelope?.id !== candidateId || envelope?.kind !== 'materialized-verification-candidate') {
    throw new Error('VerificationCandidateLauncherEnvelopeInvalid')
  }
  const runnerName =
    options.runnerKind === 'checkpoint'
      ? 'run-checkpoint-verification.mjs'
      : 'run-slice-verification.mjs'
  const runner = resolve(candidateDirectory, 'workspace/scripts', runnerName)
  const metadata = lstatSync(runner, { throwIfNoEntry: false })
  if (!metadata?.isFile() || metadata.isSymbolicLink()) {
    throw new Error('VerificationCandidateResidentRunnerMissing')
  }
  return Object.freeze({
    command: process.execPath,
    args: Object.freeze([
      runner,
      '--candidate-resident',
      '--evidence-root',
      evidenceRoot,
      '--baseline',
      baselineId,
      '--candidate',
      candidateId,
    ]),
    cwd: resolve(candidateDirectory, 'workspace'),
    candidateRunner: runner,
  })
}

export async function launchCandidateResidentVerification(options) {
  const invocation = createCandidateResidentInvocation(options)
  const child = spawn(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env: process.env,
    shell: false,
    stdio: options.stdio ?? 'inherit',
  })
  const completion = await new Promise((resolveCompletion, reject) => {
    child.once('error', reject)
    child.once('close', (exitCode, signal) => resolveCompletion({ exitCode, signal }))
  })
  return Object.freeze(completion)
}

function parseArgs(argv) {
  let baselineId = null
  let candidateId = null
  let evidenceRoot = ROOT
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') continue
    if (arg === '--baseline') {
      baselineId = argv[index + 1] ?? null
      index += 1
    } else if (arg === '--candidate') {
      candidateId = argv[index + 1] ?? null
      index += 1
    } else if (arg === '--evidence-root') {
      evidenceRoot = argv[index + 1] ?? ''
      index += 1
    } else {
      throw new Error(`VerificationSliceArgumentForbidden:${arg}`)
    }
  }
  return { baselineId, candidateId, evidenceRoot }
}

function assertCandidateId(value) {
  if (!/^candidate-[a-f0-9]{16}$/u.test(value ?? '')) {
    throw new Error('VerificationCandidateIdRequired')
  }
  return value
}

function assertBaselineId(value) {
  if (!/^slice-[A-Za-z0-9-]+$/u.test(value ?? '')) {
    throw new Error('VerificationBaselineRequiredDirtyWorktree')
  }
  return value
}

async function main() {
  const completion = await launchCandidateResidentVerification(parseArgs(process.argv.slice(2)))
  if (completion.signal) process.kill(process.pid, completion.signal)
  process.exitCode = completion.exitCode ?? 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
