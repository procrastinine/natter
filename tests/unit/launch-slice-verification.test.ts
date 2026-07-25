import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCandidateResidentInvocation } from '../../scripts/launch-slice-verification.mjs'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true })
})

describe('verification slice launcher', () => {
  it('only locates the sealed candidate runner and passes the external evidence root explicitly', () => {
    const evidenceRoot = mkdtempSync(resolve(tmpdir(), 'natter-slice-launcher-'))
    roots.push(evidenceRoot)
    const candidateId = 'candidate-0123456789abcdef'
    const candidateDirectory = resolve(
      evidenceRoot,
      'test-results/verification-slice/candidates',
      candidateId,
    )
    const runner = resolve(candidateDirectory, 'workspace/scripts/run-slice-verification.mjs')
    mkdirSync(resolve(runner, '..'), { recursive: true })
    writeFileSync(
      resolve(candidateDirectory, 'candidate.json'),
      `${JSON.stringify({ id: candidateId, kind: 'materialized-verification-candidate' })}\n`,
    )
    writeFileSync(runner, 'process.exitCode = 0\n')

    const invocation = createCandidateResidentInvocation({
      evidenceRoot,
      baselineId: 'slice-baseline',
      candidateId,
    })

    expect(invocation.candidateRunner).toBe(runner)
    expect(invocation.cwd).toBe(resolve(candidateDirectory, 'workspace'))
    expect(invocation.args).toEqual([
      runner,
      '--candidate-resident',
      '--evidence-root',
      evidenceRoot,
      '--baseline',
      'slice-baseline',
      '--candidate',
      candidateId,
    ])
  })

  it('selects the checkpoint runner without changing the sealed candidate invocation contract', () => {
    const evidenceRoot = mkdtempSync(resolve(tmpdir(), 'natter-checkpoint-launcher-'))
    roots.push(evidenceRoot)
    const candidateId = 'candidate-fedcba9876543210'
    const candidateDirectory = resolve(
      evidenceRoot,
      'test-results/verification-slice/candidates',
      candidateId,
    )
    const runner = resolve(candidateDirectory, 'workspace/scripts/run-checkpoint-verification.mjs')
    mkdirSync(resolve(runner, '..'), { recursive: true })
    writeFileSync(
      resolve(candidateDirectory, 'candidate.json'),
      `${JSON.stringify({ id: candidateId, kind: 'materialized-verification-candidate' })}\n`,
    )
    writeFileSync(runner, 'process.exitCode = 0\n')

    const invocation = createCandidateResidentInvocation({
      evidenceRoot,
      baselineId: 'slice-baseline',
      candidateId,
      runnerKind: 'checkpoint',
    })

    expect(invocation.candidateRunner).toBe(runner)
    expect(invocation.args[0]).toBe(runner)
  })
})
