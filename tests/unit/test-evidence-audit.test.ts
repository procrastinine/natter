import { describe, expect, it } from 'vitest'
import {
  auditTestEvidence,
  type TestEvidenceFile,
  type TestEvidenceInventory,
  type TestGuaranteeClaim,
} from '../../scripts/audit-test-evidence.mjs'
import { buildTestEvidenceInventory } from '../../scripts/test-evidence-inventory.mjs'
import {
  ALLOWED_DEV_BUILT_DIVERGENCES,
  DECLARED_TEST_DOMAINS,
  TEST_GUARANTEE_CLAIMS,
} from '../../scripts/test-evidence-manifest.mjs'

const BASE_INVENTORY = buildTestEvidenceInventory()

describe('test evidence architecture audit', () => {
  it('inventories every current suite without laundering reachability into behavioral proof', () => {
    const report = auditTestEvidence({ inventory: BASE_INVENTORY })

    expect(report.problems).toEqual([])
    expect(report.counts.files).toBeGreaterThan(report.counts.suites)
    expect(report.counts.suites).toBeGreaterThan(0)
    expect(report.counts.testDefinitions).toBeGreaterThan(report.counts.suites)
    expect(report.inventory.files.every((file) => file.execution.length > 0)).toBe(true)
    expect(report.inventory.files.map((file) => file.path)).not.toContain(
      'tests/unit/plan-audit.test.ts',
    )
    expect(report.parity.assertions.every((assertion) => assertion.satisfied)).toBe(true)
    expect(report.divergences.discoveredRuntimeGateCount).toBe(3)
    expect(report.divergences.allowedCount).toBe(3)
    expect(report.inventory.interactionEvidence.siteCount).toBeGreaterThan(500)
    expect(report.inventory.interactionEvidence.perSiteOutcomeProofCount).toBe(0)
    expect(
      report.inventory.files
        .filter((file) => ['suite', 'embedded-suite'].includes(file.role))
        .every((file) => file.domains.length > 0 && file.proofKinds.length > 0),
    ).toBe(true)
  })

  it('keeps the observed architecture failures explicit instead of treating nearby tests as proof', () => {
    const report = auditTestEvidence({ inventory: BASE_INVENTORY })
    const gaps = new Map(report.gaps.map((gap) => [gap.id, gap.status]))

    expect(gaps).toEqual(
      new Map([
        ['destination-frame-complete-window-budget', 'partial'],
        ['pending-generation-capability-preserves-first-submit-intent', 'partial'],
        ['physical-storage-compaction-retries-without-blocking-peer-work', 'partial'],
        ['remote-change-never-steers-tab-local-route-or-cursor', 'partial'],
        ['every-presentation-interaction-site-has-outcome-proof', 'gap'],
      ]),
    )
  })

  it('rejects an unowned suite even when the filesystem scan still discovers it', () => {
    const inventory = mutableInventory(BASE_INVENTORY)
    const targetIndex = inventory.files.findIndex(
      (file) => file.path === 'tests/unit/active-path.test.ts',
    )
    expect(targetIndex).toBeGreaterThanOrEqual(0)
    const target = inventory.files[targetIndex]
    if (!target) throw new Error('TestEvidenceMutationTargetMissing')
    inventory.files[targetIndex] = { ...target, domains: [] }

    const report = auditTestEvidence({ inventory })

    expect(report.problems).toContain(
      'files:tests/unit/active-path.test.ts: no production domain owner or explicit feature-domain declaration',
    )
  })

  it('rejects stale evidence locators instead of accepting a claim by filename', () => {
    const claims = mutableClaims(TEST_GUARANTEE_CLAIMS)
    const target = claims.find(
      (claim) => claim.id === 'verification-runs-independent-stages-after-failure',
    )
    if (!target) throw new Error('TestEvidenceClaimMutationTargetMissing')
    target.evidence = [
      {
        path: 'tests/unit/verification-runner.test.ts',
        locator: 'this assertion does not exist',
      },
    ]

    const report = auditTestEvidence({ inventory: BASE_INVENTORY, claims })

    expect(report.problems).toContain(
      'claims:verification-runs-independent-stages-after-failure: stale locator in tests/unit/verification-runner.test.ts: this assertion does not exist',
    )
  })

  it('keeps the dev and built artifact guarantee closed with exact required proof', () => {
    const target = TEST_GUARANTEE_CLAIMS.find(
      (claim) => claim.id === 'dev-and-built-artifact-exercise-equivalent-application-paths',
    )
    if (!target) throw new Error('KnownGapMutationTargetMissing')
    expect(target.status).toBe('covered')
    expect(target.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'tests/e2e/dev-preview-parity.spec.ts' }),
        expect.objectContaining({ path: 'playwright.config.ts' }),
        expect.objectContaining({ path: 'scripts/run-verification.mjs' }),
      ]),
    )

    const report = auditTestEvidence({ inventory: BASE_INVENTORY })

    expect(report.problems).toEqual([])
    expect(report.gaps.some((gap) => gap.id === target.id)).toBe(false)
  })

  it('rejects closing an interrogated guarantee without current proof', () => {
    const claims = mutableClaims(TEST_GUARANTEE_CLAIMS)
    const target = claims.find(
      (claim) => claim.id === 'dev-and-built-artifact-exercise-equivalent-application-paths',
    )
    if (!target) throw new Error('KnownGapMutationTargetMissing')
    target.status = 'covered'
    delete target.evidence
    delete target.touchedBy

    const report = auditTestEvidence({ inventory: BASE_INVENTORY, claims })

    expect(report.problems).toContain(
      'claims:dev-and-built-artifact-exercise-equivalent-application-paths: covered claim needs exact evidence',
    )
  })

  it('rejects stale domain declarations and focused tests', () => {
    const inventory = mutableInventory(BASE_INVENTORY)
    const file = inventory.files.find((candidate) => candidate.path === 'tests/e2e/abort.spec.ts')
    if (!file) throw new Error('FocusedTestMutationTargetMissing')
    const first = file.definitions.tests[0]
    if (!first) throw new Error('FocusedDefinitionMutationTargetMissing')
    file.definitions.tests[0] = { ...first, status: 'only' }
    const declaredDomains = {
      ...DECLARED_TEST_DOMAINS,
      'tests/e2e/removed.spec.ts': ['conversation'],
    }

    const report = auditTestEvidence({ inventory, declaredDomains })

    expect(report.problems).toContain(
      'declared-domains: stale test path: tests/e2e/removed.spec.ts',
    )
    expect(report.problems).toContain('files:tests/e2e/abort.spec.ts:21: focused test is forbidden')
  })

  it('rejects an unclassified dev-only application gate', () => {
    const allowedDivergences = ALLOWED_DEV_BUILT_DIVERGENCES.filter(
      (entry) => entry.id !== 'privacy-proxy-runtime-default',
    )

    const report = auditTestEvidence({
      inventory: BASE_INVENTORY,
      allowedDivergences,
    })

    expect(report.problems).toContain(
      'dev-built-divergence: unclassified gate: src/core/global-settings.ts#import.meta.env.DEV',
    )
  })
})

function mutableInventory(inventory: TestEvidenceInventory): MutableTestEvidenceInventory {
  return structuredClone(inventory) as MutableTestEvidenceInventory
}

type MutableTestEvidenceInventory = Omit<TestEvidenceInventory, 'files'> & {
  files: MutableTestEvidenceFile[]
}

type MutableTestEvidenceFile = Omit<TestEvidenceFile, 'definitions' | 'domains'> & {
  domains: string[]
  definitions: {
    describes: Array<TestEvidenceFile['definitions']['describes'][number]>
    tests: Array<TestEvidenceFile['definitions']['tests'][number]>
  }
}

type MutableTestGuaranteeClaim = Omit<TestGuaranteeClaim, 'evidence' | 'touchedBy'> & {
  evidence?: Array<{ path: string; locator: string }>
  touchedBy?: Array<{ path: string; locator: string }>
}

function mutableClaims(claims: readonly TestGuaranteeClaim[]): MutableTestGuaranteeClaim[] {
  return structuredClone(claims) as MutableTestGuaranteeClaim[]
}
