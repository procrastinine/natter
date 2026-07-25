import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runCheckpointVerification } from '../../scripts/run-checkpoint-verification.mjs'
import { CHECKPOINT_REQUIRED_STAGE_IDS, runVerification } from '../../scripts/run-verification.mjs'
import type { VerificationCandidateExecutionContext } from '../../scripts/verification-candidate-execution.mjs'
import type { MaterializedVerificationCandidate } from '../../scripts/verification-candidate-workspace.mjs'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true })))
})

describe('checkpoint verification runner', () => {
  it('uses one candidate execution lifecycle and persists an unchanged passing candidate', async () => {
    const root = await temporaryRoot()
    const candidate = fakeCandidate(root)
    const executions: string[] = []
    let requiredStageIds: readonly string[] | undefined
    const result = await runCheckpointVerification({
      baselineId: 'slice-baseline',
      evidenceRoot: root,
      candidate,
      readBaseline: () => fakeBaseline(),
      executeCandidate: async (options, operation) => {
        executions.push(options.runId)
        return operation(fakeExecutionContext(candidate))
      },
      assertCandidateUnchanged: (value) => value,
      runVerification: (options) => {
        requiredStageIds = options.requiredStageIds
        return runVerification({
          ...options,
          stages: [],
          requiredStageIds: [],
          forwardOutput: false,
        })
      },
    })

    expect(executions).toEqual([`checkpoint-${candidate.id}`])
    expect(requiredStageIds).toEqual(CHECKPOINT_REQUIRED_STAGE_IDS)
    expect(result.exitCode).toBe(0)
    expect(result.summary).toMatchObject({ candidateUnchanged: true, outcome: 'passed' })
    const canonical: unknown = JSON.parse(
      await readFile(resolve(root, 'test-results/verification-summary.json'), 'utf8'),
    )
    expect(canonical).toMatchObject({
      outcome: 'passed',
      provenance: { candidateId: candidate.id },
    })
  })

  it('makes final candidate mutation canonical red before checkpoint authority is written', async () => {
    const root = await temporaryRoot()
    const candidate = fakeCandidate(root)
    const result = await runCheckpointVerification({
      baselineId: 'slice-baseline',
      evidenceRoot: root,
      candidate,
      readBaseline: () => fakeBaseline(),
      executeCandidate: async (_options, operation) => operation(fakeExecutionContext(candidate)),
      assertCandidateUnchanged: () => {
        throw new Error('CandidateMutated')
      },
      runVerification: (options) =>
        runVerification({
          ...options,
          stages: [],
          requiredStageIds: [],
          forwardOutput: false,
        }),
    })

    expect(result.exitCode).toBe(1)
    expect(result.summary).toMatchObject({
      candidateUnchanged: false,
      outcome: 'failed',
      validationError: 'Error:CandidateMutated',
    })
    const canonical: unknown = JSON.parse(
      await readFile(resolve(root, 'test-results/verification-summary.json'), 'utf8'),
    )
    expect(canonical).toMatchObject({
      outcome: 'failed',
      infrastructureDiagnostics: ['VerificationFinalValidationFailed:Error:CandidateMutated'],
    })
  })
})

async function temporaryRoot() {
  const root = await mkdtemp(resolve(tmpdir(), 'natter-checkpoint-runner-'))
  roots.push(root)
  await mkdir(resolve(root, 'workspace'), { recursive: true })
  return root
}

function fakeCandidate(root: string) {
  const id = 'candidate-0123456789abcdef'
  return {
    id,
    digest: 'candidate-digest',
    runtimeRoot: resolve(root, 'workspace'),
    snapshot: { digest: 'snapshot-digest' },
    dependency: { imageId: 'dependency-image', imageDigest: 'dependency-digest' },
    dependencyImage: {
      recipe: { runtime: { nodeVersion: 'v26.1.0', pnpmVersion: '11.10.0' } },
    },
    compilerCohort: { digest: 'compiler-digest' },
  } as unknown as MaterializedVerificationCandidate
}

function fakeBaseline() {
  return {
    digest: 'baseline-digest',
    comparison: {
      commitOid: 'commit-oid',
      treeOid: 'tree-oid',
      digest: 'comparison-digest',
    },
  }
}

function fakeExecutionContext(
  candidate: MaterializedVerificationCandidate,
): VerificationCandidateExecutionContext {
  return {
    candidate,
    runtime: {
      nodeExecutablePath: '/runtime/node',
      pnpmExecutablePath: '/runtime/pnpm.mjs',
      compilerCliEntryPath: '/runtime/tsc.mjs',
      nativeExecutablePath: '/runtime/native',
    },
    environment: {
      CI: '1',
      E2E_FAKE_PROVIDER_PORT: '32001',
      E2E_PORT: '32000',
      TZ: 'UTC',
    },
  }
}
