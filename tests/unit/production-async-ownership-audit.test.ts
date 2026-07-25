import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { evaluateProductionAsyncOwnership } from '../../scripts/audit-production-async-ownership.mjs'
import {
  buildProductionAsyncOwnershipInventory,
  inventoryAsyncOwnershipInSource,
} from '../../scripts/production-async-ownership-inventory.mjs'
import { validateReviewedCandidateDispositions } from '../../scripts/reviewed-candidate-dispositions.mjs'

const repoRoot = resolve(__dirname, '../..')
let currentInventory: ReturnType<typeof buildProductionAsyncOwnershipInventory> | null = null
let currentReports: {
  readonly inventory: ReturnType<typeof evaluateProductionAsyncOwnership>
  readonly enforce: ReturnType<typeof evaluateProductionAsyncOwnership>
} | null = null

beforeAll(() => {
  currentInventory = buildProductionAsyncOwnershipInventory(repoRoot)
  currentReports = {
    inventory: evaluateProductionAsyncOwnership(currentInventory, 'inventory'),
    enforce: evaluateProductionAsyncOwnership(currentInventory, 'enforce'),
  }
})

afterAll(() => {
  currentInventory = null
  currentReports = null
})

describe('production async ownership audit', () => {
  it('inventories every async function and keeps detached failure ownership explicit', () => {
    const inventory = requiredInventory()

    expect(inventory.functions.length).toBeGreaterThan(0)
    expect(inventory.counts.awaitSites).toBeGreaterThan(0)
    expect(inventory.counts.functions).toBe(inventory.functions.length)
    expect(inventory.counts.detachedSites).toBe(inventory.detached.length)
    expect(inventory.counts.unprovedDetachedFailures).toBe(inventory.syntacticGaps.length)
    expect(inventory.counts.reviewedArchitectureGaps).toBe(inventory.gaps.length)
    expect(inventory.dispositionCounts).toEqual({
      proved: 24,
      'intentional-bounded-lifetime': 0,
      'architecture-gap': 0,
    })
    expect(inventory.reviews).toHaveLength(inventory.syntacticGaps.length)
    expect(inventory.reviewProblems).toEqual([])
    expect(inventory.disposition).toContain(
      'reviewed detached-failure syntactic candidate queue only',
    )
    expect(new Set(inventory.functions.map((entry) => entry.id)).size).toBe(
      inventory.functions.length,
    )
  })

  it('rejects stale evidence and candidate-line laundering in the reviewed dispositions', () => {
    const inventory = requiredInventory()
    const candidates = inventory.detached.filter((site) => site.failureOwnership === 'unproved')
    const stale = inventory.reviews.map((review, index) =>
      index === 0 ? { ...review, siteText: `${review.siteText} stale` } : review,
    )
    const staleResult = validateReviewedCandidateDispositions({
      candidates,
      reviews: stale,
      root: repoRoot,
      auditName: 'AsyncOwnershipProbe',
      proofRoles: new Set([
        'error-owner',
        'non-rejecting-construction',
        'non-rejecting-transform',
        'non-throwing-finalizer',
      ]),
    })
    expect(staleResult.problems).toContain(
      `AsyncOwnershipProbeReviewSiteLocatorStale:${inventory.reviews[0]?.siteId}`,
    )

    const proof = inventory.reviews.find((review) => review.disposition === 'proved')
    const candidate = candidates.find((site) => site.id === proof?.siteId)
    expect(proof).toBeDefined()
    expect(candidate).toBeDefined()
    if (!proof || !candidate) throw new Error('AsyncOwnershipReviewFixtureMissing')
    const laundered = inventory.reviews.map((review) =>
      review !== proof
        ? review
        : {
            siteId: review.siteId,
            siteText: review.siteText,
            disposition: 'proved',
            evidence: [
              {
                path: candidate.path,
                line: candidate.line,
                text: review.siteText,
                role: 'error-owner',
              },
            ],
            identityFlow: 'The detached call line is falsely relabeled as its own rejection owner.',
            rationale: review.rationale,
          },
    )
    const launderingResult = validateReviewedCandidateDispositions({
      candidates,
      reviews: laundered,
      root: repoRoot,
      auditName: 'AsyncOwnershipProbe',
      proofRoles: new Set([
        'error-owner',
        'non-rejecting-construction',
        'non-rejecting-transform',
        'non-throwing-finalizer',
      ]),
    })
    expect(launderingResult.problems).toContain(
      `AsyncOwnershipProbeReviewTerminalEvidenceAliasesCandidate:${proof.siteId}`,
    )
  })

  it('distinguishes propagation, local catch/finally, cancellation, and unowned detachment', () => {
    const inventory = inventoryAsyncOwnershipInSource(
      'src/store/probe.ts',
      `export async function owned(signal: AbortSignal) {
        try {
          for (const value of [1]) await use(value, signal)
        } catch (error) {
          recover(error)
        } finally {
          release()
        }
      }
      void owned(new AbortController().signal)
      void owned(new AbortController().signal).catch(report)
      items.forEach(async (item) => consume(item))`,
      { domain: 'workspace', layer: 'application' },
    )

    expect(inventory.functions).toHaveLength(2)
    expect(inventory.functions[0]).toMatchObject({
      owner: 'owned',
      errorStrategy: 'local-catch-and-finally',
      cancellationAware: true,
      awaitInLoopCount: 1,
    })
    expect(inventory.detached.map((site) => site.failureOwnership)).toEqual([
      'unproved',
      'syntactic-handler',
      'unproved',
    ])
  })

  it('keeps detached-work identities stable when unrelated source lines move', () => {
    const source = `async function work() { await Promise.resolve() }
      void work()`
    const shifted = `

      ${source}`
    const classification = { domain: 'workspace', layer: 'application' }

    expect(
      inventoryAsyncOwnershipInSource('src/store/probe.ts', shifted, classification).detached.map(
        (site) => site.id,
      ),
    ).toEqual(
      inventoryAsyncOwnershipInSource('src/store/probe.ts', source, classification).detached.map(
        (site) => site.id,
      ),
    )
  })

  it('keeps inventory and enforce modes green after detached gaps close', () => {
    const reports = requiredReports()
    const { enforce, inventory } = reports

    expect(inventory.ok).toBe(true)
    expect(inventory.structurallyValid).toBe(true)
    expect(inventory.gapCount).toBe(0)
    expect(enforce.ok).toBe(true)
    expect(enforce.problems).toEqual([])
  })
})

function requiredInventory(): ReturnType<typeof buildProductionAsyncOwnershipInventory> {
  if (!currentInventory) throw new Error('ProductionAsyncOwnershipInventoryMissing')
  return currentInventory
}

function requiredReports(): NonNullable<typeof currentReports> {
  if (!currentReports) throw new Error('ProductionAsyncOwnershipReportsMissing')
  return currentReports
}
