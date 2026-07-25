import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  acquireVerificationProcessLease,
  releaseVerificationProcessLease,
} from '../../scripts/verification-process-lease.mjs'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('verification process lease', () => {
  it('rejects a live owner and releases only its branded capability', () => {
    const root = fixtureRoot()
    const path = resolve(root, 'execution.lease')
    const lease = acquireVerificationProcessLease({ path, purpose: 'candidate-execution' })

    expect(() => acquireVerificationProcessLease({ path, purpose: 'candidate-execution' })).toThrow(
      'VerificationProcessLeaseActive:candidate-execution',
    )
    expect(() => releaseVerificationProcessLease({ path })).toThrow(
      'VerificationProcessLeaseCapabilityRequired',
    )
    releaseVerificationProcessLease(lease)
    const next = acquireVerificationProcessLease({ path, purpose: 'candidate-execution' })
    releaseVerificationProcessLease(next)
  })

  it('atomically reclaims a malformed or dead process owner without a timer', () => {
    const root = fixtureRoot()
    const path = resolve(root, 'execution.lease')
    mkdirSync(path)
    writeFileSync(
      resolve(path, 'owner.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        purpose: 'candidate-execution',
        pid: 2_000_000_000,
        processStartToken: 'dead',
        nonce: 'a'.repeat(32),
      })}\n`,
    )

    const lease = acquireVerificationProcessLease({ path, purpose: 'candidate-execution' })
    releaseVerificationProcessLease(lease)

    mkdirSync(path)
    writeFileSync(resolve(path, 'owner.json'), '{}\n')
    const recovered = acquireVerificationProcessLease({ path, purpose: 'candidate-execution' })
    releaseVerificationProcessLease(recovered)

    mkdirSync(`${path}.claim-2000000000-dead-aaaaaaaaaaaaaaaa`)
    const debrisRecovered = acquireVerificationProcessLease({
      path,
      purpose: 'candidate-execution',
    })
    releaseVerificationProcessLease(debrisRecovered)
    expect(readdirSync(root).filter((name) => name.includes('.claim-'))).toEqual([])
  })
})

function fixtureRoot(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'natter-verification-lease-'))
  roots.push(root)
  return root
}
