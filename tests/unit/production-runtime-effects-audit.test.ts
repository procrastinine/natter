import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { evaluateProductionRuntimeEffects } from '../../scripts/audit-production-runtime-effects.mjs'
import {
  buildProductionRuntimeEffectInventory,
  inventoryRuntimeEffectsInSource,
} from '../../scripts/production-runtime-effects-inventory.mjs'
import { validateReviewedCandidateDispositions } from '../../scripts/reviewed-candidate-dispositions.mjs'

const repoRoot = resolve(__dirname, '../..')
let currentInventory: ReturnType<typeof buildProductionRuntimeEffectInventory> | null = null
let currentReports: {
  readonly inventory: ReturnType<typeof evaluateProductionRuntimeEffects>
  readonly enforce: ReturnType<typeof evaluateProductionRuntimeEffects>
} | null = null

beforeAll(() => {
  currentInventory = buildProductionRuntimeEffectInventory(repoRoot)
  currentReports = {
    inventory: evaluateProductionRuntimeEffects(currentInventory, 'inventory'),
    enforce: evaluateProductionRuntimeEffects(currentInventory, 'enforce'),
  }
})

afterAll(() => {
  currentInventory = null
  currentReports = null
})

describe('production runtime effects audit', () => {
  it('classifies every discovered site and keeps unproved releases explicit', () => {
    const inventory = requiredInventory()

    expect(inventory.sites.length).toBeGreaterThan(0)
    expect(inventory.counts.sites).toBe(inventory.sites.length)
    expect(new Set(inventory.sites.map((site) => site.id)).size).toBe(inventory.sites.length)
    expect(
      inventory.sites.every(
        (site) =>
          site.domain.length > 0 &&
          site.layer.length > 0 &&
          site.capability.length > 0 &&
          site.locality.length > 0 &&
          site.owner.length > 0,
      ),
    ).toBe(true)
    expect(inventory.counts.missingReleaseEvidence).toBe(inventory.syntacticGaps.length)
    expect(inventory.counts.reviewedArchitectureGaps).toBe(inventory.gaps.length)
    expect(inventory.dispositionCounts).toEqual({
      proved: 31,
      'intentional-bounded-lifetime': 12,
      'architecture-gap': 0,
    })
    expect(inventory.reviews).toHaveLength(inventory.syntacticGaps.length)
    expect(inventory.reviewProblems).toEqual([])
    expect(inventory.disposition).toContain('reviewed no-release syntactic candidate queue only')
  })

  it('rejects stale evidence and candidate-line laundering in the reviewed dispositions', () => {
    const inventory = requiredInventory()
    const candidates = inventory.sites.filter(
      (site) => site.requiresRelease && site.releaseEvidence === 'missing',
    )
    const stale = inventory.reviews.map((review, index) =>
      index === 0 ? { ...review, siteText: `${review.siteText} stale` } : review,
    )
    const staleResult = validateReviewedCandidateDispositions({
      candidates,
      reviews: stale,
      root: repoRoot,
      auditName: 'RuntimeEffectProbe',
      proofRoles: new Set(['terminal-release', 'cancellation-release', 'release-implementation']),
    })
    expect(staleResult.problems).toContain(
      `RuntimeEffectProbeReviewSiteLocatorStale:${inventory.reviews[0]?.siteId}`,
    )

    const proof = inventory.reviews.find((review) => review.disposition === 'proved')
    const candidate = candidates.find((site) => site.id === proof?.siteId)
    expect(proof).toBeDefined()
    expect(candidate).toBeDefined()
    if (!proof || !candidate) throw new Error('RuntimeEffectReviewFixtureMissing')
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
                role: 'terminal-release',
              },
            ],
            identityFlow: 'The acquisition line is falsely relabeled as its own terminal release.',
            rationale: review.rationale,
          },
    )
    const launderingResult = validateReviewedCandidateDispositions({
      candidates,
      reviews: laundered,
      root: repoRoot,
      auditName: 'RuntimeEffectProbe',
      proofRoles: new Set(['terminal-release', 'cancellation-release', 'release-implementation']),
    })
    expect(launderingResult.problems).toContain(
      `RuntimeEffectProbeReviewTerminalEvidenceAliasesCandidate:${proof.siteId}`,
    )
  })

  it('discovers new effect syntax instead of relying on a hand-picked file list', () => {
    const sites = inventoryRuntimeEffectsInSource(
      'src/store/probe.ts',
      `export function probe() {
        const channel = new BroadcastChannel('probe')
        addEventListener('visibilitychange', probe)
        setInterval(probe, 100)
        return () => {
          removeEventListener('visibilitychange', probe)
          channel.close()
          clearInterval(1)
        }
      }`,
      { domain: 'workspace', layer: 'lifecycle-runtime' },
    )

    expect(sites.map((site) => `${site.effectKind}:${site.action}`)).toEqual([
      'broadcast-channel:acquire',
      'event-listener:acquire',
      'interval:acquire',
      'event-listener:release',
      'closeable-resource:release',
      'interval:release',
    ])
  })

  it('keeps site identities stable when unrelated source lines move', () => {
    const source = `export function probe() {
      const controller = new AbortController()
      return controller.signal
    }`
    const shifted = `

      ${source}`
    const classification = { domain: 'workspace', layer: 'application' }

    expect(
      inventoryRuntimeEffectsInSource('src/store/probe.ts', shifted, classification).map(
        (site) => site.id,
      ),
    ).toEqual(
      inventoryRuntimeEffectsInSource('src/store/probe.ts', source, classification).map(
        (site) => site.id,
      ),
    )
  })

  it('keeps inventory and enforce modes green when every ownership candidate is closed', () => {
    const { enforce, inventory } = requiredReports()

    expect(inventory.ok).toBe(true)
    expect(inventory.structurallyValid).toBe(true)
    expect(inventory.gapCount).toBe(0)
    expect(enforce.ok).toBe(true)
    expect(enforce.problems).toEqual([])
  })
})

function requiredInventory(): ReturnType<typeof buildProductionRuntimeEffectInventory> {
  if (!currentInventory) throw new Error('ProductionRuntimeEffectsInventoryMissing')
  return currentInventory
}

function requiredReports(): NonNullable<typeof currentReports> {
  if (!currentReports) throw new Error('ProductionRuntimeEffectsReportsMissing')
  return currentReports
}
