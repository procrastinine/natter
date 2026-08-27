import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const ROOT = resolve(__dirname, '../..')
const AUDIT_URL = pathToFileURL(resolve(ROOT, 'scripts/audit-scroll-continuity.mjs')).href
const INVENTORY_URL = pathToFileURL(resolve(ROOT, 'scripts/scroll-continuity-inventory.mjs')).href
interface ScrollContinuityReport {
  ok: boolean
  structurallyValid: boolean
  discoveredWriterCount: number
  writerCount: number
  heightProducerCount: number
  heightProducerProofCount: number
  transitionCount: number
  proofCount: number
  gapCount: number
  acceptanceCount: number
  gaps: Array<{ id: string; path: string; rationale: string }>
  problems: string[]
}
let evaluateScrollContinuity: (
  root: string,
  inventory: unknown,
  mode: 'inventory' | 'enforce',
) => ScrollContinuityReport
let defaultInventory: unknown

beforeAll(async () => {
  evaluateScrollContinuity = (
    (await import(AUDIT_URL)) as {
      evaluateScrollContinuity: typeof evaluateScrollContinuity
    }
  ).evaluateScrollContinuity
  defaultInventory = await import(INVENTORY_URL)
})

describe('scroll continuity architecture audit', () => {
  it('exhaustively classifies every production geometry writer and closes every proof matrix', async () => {
    const result = await runAudit('inventory')

    expect(result.status).toBe(0)
    expect(result.report).toMatchObject({
      ok: true,
      structurallyValid: true,
      discoveredWriterCount: 14,
      writerCount: 14,
      heightProducerCount: 17,
      heightProducerProofCount: 17,
      transitionCount: 15,
      proofCount: 17,
      gapCount: 0,
      acceptanceCount: 8,
      problems: [],
    })
    expect(result.report.gaps).toEqual([])
  })

  it('keeps a missing height-producer ownership proof blocking in enforce mode', async () => {
    const inventory = writeInventory(`
import * as base from ${JSON.stringify(INVENTORY_URL)}
export const SCROLL_WRITER_CLASSIFICATIONS = base.SCROLL_WRITER_CLASSIFICATIONS
export const TRANSCRIPT_HEIGHT_PRODUCERS = base.TRANSCRIPT_HEIGHT_PRODUCERS
export const SCROLL_HEIGHT_PRODUCER_PROOF_MATRIX = base.SCROLL_HEIGHT_PRODUCER_PROOF_MATRIX.slice(1)
export const SCROLL_SEMANTIC_TRANSITIONS = base.SCROLL_SEMANTIC_TRANSITIONS
export const SCROLL_EXISTING_PROOFS = base.SCROLL_EXISTING_PROOFS
export const SCROLL_CONTINUITY_GAPS = base.SCROLL_CONTINUITY_GAPS
export const SCROLL_CONTINUITY_ACCEPTANCE = base.SCROLL_CONTINUITY_ACCEPTANCE
`)
    const result = await runAudit('enforce', inventory)

    expect(result.status).toBe(1)
    expect(result.report.structurallyValid).toBe(false)
    expect(result.report.ok).toBe(false)
    expect(result.report.problems).toContain(
      'height-producer-proofs: canonical producer order or coverage changed',
    )
  })

  it('fails when a geometry writer loses ownership or proof vocabulary becomes invented', async () => {
    const inventory = writeInventory(`
import * as base from ${JSON.stringify(INVENTORY_URL)}
export const SCROLL_WRITER_CLASSIFICATIONS = base.SCROLL_WRITER_CLASSIFICATIONS.filter(
  (entry) => entry.id !== 'transcript-instant-position',
)
export const TRANSCRIPT_HEIGHT_PRODUCERS = base.TRANSCRIPT_HEIGHT_PRODUCERS
export const SCROLL_HEIGHT_PRODUCER_PROOF_MATRIX = base.SCROLL_HEIGHT_PRODUCER_PROOF_MATRIX
export const SCROLL_SEMANTIC_TRANSITIONS = base.SCROLL_SEMANTIC_TRANSITIONS
export const SCROLL_EXISTING_PROOFS = base.SCROLL_EXISTING_PROOFS
export const SCROLL_CONTINUITY_GAPS = base.SCROLL_CONTINUITY_GAPS
export const SCROLL_CONTINUITY_ACCEPTANCE = base.SCROLL_CONTINUITY_ACCEPTANCE.map((entry) =>
  entry.id === 'no-automatic-discontinuity'
    ? { ...entry, proofKinds: ['browser', 'geometry-by-hope'] }
    : entry,
)
`)
    const result = await runAudit('inventory', inventory)

    expect(result.status).toBe(1)
    expect(result.report.problems).toEqual(
      expect.arrayContaining([
        'writers: missing id: transcript-instant-position',
        'writers: canonical order changed',
        'acceptance:no-automatic-discontinuity: invalid proof kind: geometry-by-hope',
        expect.stringContaining('writers: unclassified scrollTop at src/ui/chat/ScrollRegion.tsx:'),
      ]),
    )
  })
})

async function runAudit(mode: 'inventory' | 'enforce', inventory?: string) {
  const inventoryModule: unknown = inventory
    ? await import(/* @vite-ignore */ inventory)
    : defaultInventory
  const report = evaluateScrollContinuity(ROOT, inventoryModule, mode)
  return {
    status: report.ok ? 0 : 1,
    report,
  }
}

function writeInventory(source: string) {
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
}
