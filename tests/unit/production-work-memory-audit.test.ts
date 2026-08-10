import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

interface WorkMemoryReport {
  ok: boolean
  structurallyValid: boolean
  sourceFiles: number
  maximumTraversalDepth: number
  counts: Record<string, number>
  domainCounts: Record<string, number>
  layerCounts: Record<string, number>
  sites: Array<{
    id: string
    ownerId: string
    path: string
    domain: string
    layer: string
    category: string
    kind: string
    localSignals: Array<{ id: string; category: string }>
    evidence: string[]
  }>
  functions: Array<{
    id: string
    siteCounts: Record<string, number>
    maximumTraversalDepth: number
    riskIds: string[]
    evidence: string[]
  }>
  evidenceLinks: Array<{ id: string; ownerId: string; siteIds?: string[]; proof: string }>
  requiredDomainWork: Array<{
    id: string
    siteIds: string[]
    minimumWork: string
    boundingStrategy: string
    allowsFixedTranscriptMaximum: boolean
  }>
  decisionCounts: Record<string, number>
  riskKindCounts: Record<string, number>
  riskStatusCounts: Record<string, number>
  gaps: Array<{
    id: string
    siteId: string
    ownerId: string
    riskKind: string
    necessity: string
    status: string
    rationale: string
    replacementDirection: string | null
  }>
  limitations: Array<{ id: string; statement: string }>
  acceptanceCriteria: Array<{
    id: string
    requirement: string
    automatedCheck: string
    closureCondition: string
  }>
  closureStatus: {
    ready: boolean
    riskCandidates: number
    explicitlyDecidedRiskCandidates: number
    unreviewedRiskCandidates: number
    activeGaps: number
    unsupportedAcceptedDecisions: number
  }
  problems: string[]
}

const repoRoot = resolve(__dirname, '../..')
const auditUrl = pathToFileURL(resolve(repoRoot, 'scripts/audit-production-work-memory.mjs')).href
const inventoryUrl = pathToFileURL(
  resolve(repoRoot, 'scripts/production-work-memory-inventory.mjs'),
).href
const productionModuleInventory: unknown = JSON.parse(
  readFileSync(resolve(repoRoot, 'scripts/production-module-inventory.json'), 'utf8'),
)
const temporaryDirectories: string[] = []
const evaluateProductionWorkMemory = (
  (await import(auditUrl)) as {
    evaluateProductionWorkMemory: (
      config: {
        root: string
        sourceRoot: string
        inventory: unknown
        moduleInventory: unknown
      },
      mode: 'inventory' | 'enforce',
    ) => WorkMemoryReport
  }
).evaluateProductionWorkMemory
const defaultInventory: unknown = await import(inventoryUrl)
const cachedReport = evaluateProductionWorkMemory(
  {
    root: repoRoot,
    sourceRoot: resolve(repoRoot, 'src'),
    inventory: defaultInventory,
    moduleInventory: productionModuleInventory,
  },
  'inventory',
)

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('production work and memory audit', () => {
  it('maps every discovered production work site and function to the exact module domain/layer', () => {
    const report = fullReport()

    expect(report.structurallyValid).toBe(true)
    expect(report.ok).toBe(true)
    expect(report.problems).toEqual([])
    expect(report.sourceFiles).toBeGreaterThan(400)
    expect(report.counts.inventoryRecords).toBe(report.sites.length)
    expect(report.counts.exactFunctions).toBe(report.functions.length)
    expect(report.counts.explicitLoops).toBeGreaterThan(1_000)
    expect(report.counts.collectionPasses).toBeGreaterThan(2_000)
    expect(report.maximumTraversalDepth).toBeGreaterThanOrEqual(2)
    expect(
      report.sites.every(
        (site) =>
          site.id.length > 0 &&
          site.ownerId.length > 0 &&
          site.domain.length > 0 &&
          site.layer.length > 0,
      ),
    ).toBe(true)
    expect(
      report.functions.every(
        (owner) =>
          owner.id.length > 0 &&
          owner.maximumTraversalDepth >= 0 &&
          Object.values(owner.siteCounts).every((count) => count > 0),
      ),
    ).toBe(true)
    expect(Object.keys(report.domainCounts).length).toBeGreaterThan(10)
    expect(Object.keys(report.layerCounts).length).toBeGreaterThan(10)
  })

  it('keeps proof links exact, limitations explicit, and required work free of a transcript cap', () => {
    const report = fullReport()

    expect(report.evidenceLinks.length).toBeGreaterThanOrEqual(10)
    expect(report.evidenceLinks.every((link) => link.proof.length > 40)).toBe(true)
    expect(report.limitations.map((entry) => entry.id)).toEqual([
      'syntax-is-not-runtime-cost-proof',
      'library-and-native-work-remain-opaque',
      'local-bound-signals-are-not-proof',
      'dynamic-dispatch-and-recursion-need-call-graph-proof',
      'allocation-size-is-data-dependent',
      'literal-allocation-scope-is-risk-shaped',
      'computed-method-and-element-access-is-opaque',
      'method-registry-has-no-receiver-type-proof',
      'inventory-records-can-overlap-one-syntax-node',
      'production-source-boundary-excludes-emitted-runtime',
    ])
    expect(report.requiredDomainWork.map((entry) => entry.id)).toEqual([
      'branch-tree-search-complete-topology',
      'expanded-tree-visible-preview-text',
      'transcript-destination-first-then-geometric-fill',
    ])
    expect(
      report.requiredDomainWork.every(
        (entry) =>
          entry.siteIds.length > 0 &&
          entry.minimumWork.length > 0 &&
          entry.boundingStrategy.length > 0 &&
          entry.allowsFixedTranscriptMaximum === false,
      ),
    ).toBe(true)
    expect(report.decisionCounts['required-domain-work']).toBeGreaterThan(0)
    expect(report.decisionCounts['likely-accidental']).toBeGreaterThan(0)
    expect(report.riskStatusCounts.gap).toBe(report.gaps.length)
    expect(report.acceptanceCriteria.map((entry) => entry.id)).toEqual([
      'accepted-risk-has-exact-support',
      'every-risk-candidate-explicitly-disposed',
      'exact-production-source-classification-parity',
      'local-bounds-never-substitute-for-proof',
      'no-fixed-transcript-or-message-maximum',
      'opaque-native-peak-memory-measured',
      'scanner-limitations-remain-explicit',
      'zero-active-performance-memory-gaps',
    ])
    expect(report.closureStatus.ready).toBe(false)
    expect(report.closureStatus.unreviewedRiskCandidates).toBeGreaterThan(0)
    expect(report.closureStatus.unsupportedAcceptedDecisions).toBe(0)
    expect(
      report.gaps.every(
        (gap) =>
          gap.status === 'gap' &&
          gap.rationale.length > 0 &&
          (gap.necessity !== 'likely-accidental' || Boolean(gap.replacementDirection)),
      ),
    ).toBe(true)
  })

  it('emits a deterministic summary for an unchanged exact source inventory', () => {
    const fixture = writeFixture()
    const first = JSON.stringify(evaluateFixture(fixture, 'inventory'))
    const second = JSON.stringify(evaluateFixture(fixture, 'inventory'))

    expect(second).toBe(first)
  })

  it('discovers nested, serial, fanout, materialization, clone, retention, and yield signals in a fixture', () => {
    const fixture = writeFixture()
    const report = evaluateFixture(fixture, 'inventory')

    expect(report.ok).toBe(true)
    expect(report.problems).toEqual([])
    expect(report.sourceFiles).toBe(1)
    expect(report.maximumTraversalDepth).toBeGreaterThanOrEqual(2)
    expect(report.counts.awaitsInTraversal).toBeGreaterThan(0)
    expect(report.counts.promiseFanout).toBeGreaterThan(0)
    expect(report.counts.materializations).toBeGreaterThan(0)
    expect(report.counts.wholeClones).toBeGreaterThan(0)
    expect(report.counts.allocations).toBeGreaterThan(0)
    expect(report.counts.signals).toBeGreaterThan(0)
    expect(report.riskKindCounts['dynamic-promise-fanout']).toBe(1)
    expect(typeof report.riskKindCounts['nested-traversal']).toBe('number')
    expect(typeof report.riskKindCounts['serial-await-in-traversal']).toBe('number')
    expect(typeof report.riskKindCounts['whole-materialization']).toBe('number')
    expect(report.sites.every((site) => site.domain === 'fixture')).toBe(true)
    expect(report.sites.every((site) => site.layer === 'application')).toBe(true)
    expect(report.sites.some((site) => site.kind === 'argument-spread')).toBe(true)
    expect(report.sites.some((site) => site.kind === 'binding-rest')).toBe(true)
    expect(report.sites.some((site) => site.kind === 'yield-star')).toBe(true)
    expect(report.sites.some((site) => site.kind === 'constructor-input:Set')).toBe(true)
    expect(report.sites.some((site) => site.kind === 'Object.assign')).toBe(true)
    expect(report.sites.some((site) => site.kind === 'method:bulkGet')).toBe(true)
    expect(report.sites.some((site) => site.kind === 'method:bulkPut')).toBe(true)
    expect(report.sites.some((site) => site.kind === 'boundary:bulkPut')).toBe(true)
    expect(report.sites.some((site) => site.kind === 'boundary:postMessage')).toBe(true)
    expect(
      report.sites.some((site) =>
        site.localSignals.some((signal) => signal.category === 'cooperative-yield'),
      ),
    ).toBe(true)

    const enforced = evaluateFixture(fixture, 'enforce')
    expect(enforced.ok).toBe(false)
    expect(enforced.structurallyValid).toBe(true)
  })
})

function fullReport(): WorkMemoryReport {
  return cachedReport
}

function writeFixture() {
  const root = mkdtempSync(`${tmpdir()}/natter-work-memory-audit-`)
  temporaryDirectories.push(root)
  mkdirSync(resolve(root, 'src'))
  writeFileSync(
    resolve(root, 'src/sample.ts'),
    `const retained = new Map<string, unknown>()
declare const table: {
  toArray(): Promise<Array<{ text: string; load(): Promise<void> }>>
  bulkGet(keys: string[]): Promise<Array<{ text: string } | undefined>>
  bulkPut(values: Array<{ text: string; load(): Promise<void> }>): Promise<void>
}
declare function yieldToEventLoop(): Promise<void>
declare function consume(...values: unknown[]): void
declare const port: { postMessage(value: unknown): void }

export function* delegate(values: Iterable<unknown>) {
  yield* values
}

export async function inspect(rows: Array<{ items: Array<{ text: string; load(): Promise<void> }> }>, limit: number) {
  let document = ''
  for (const row of rows) {
    for (const item of row.items) {
      document += item.text
      await item.load()
      retained.set(item.text, item)
    }
  }
  const values = await table.toArray()
  const copied = new Set(values)
  const bulk = await table.bulkGet([...copied].map((value) => value.text))
  await table.bulkPut(values)
  consume(...bulk)
  const [{ text: firstText, ...firstRest }] = values
  const assigned = Object.assign({}, firstRest)
  port.postMessage(assigned)
  const clones = values.map((value) => structuredClone(value))
  await Promise.all(values.map((value) => value.load()))
  for (const page of rows.slice(0, limit)) {
    retained.set(String(page.items.length), page)
    await yieldToEventLoop()
  }
  return { document, clones, assigned, firstText }
}
`,
  )
  return {
    root,
    moduleInventory: {
      schemaVersion: 1,
      classifications: [
        {
          domain: 'fixture',
          layer: 'application',
          responsibility: 'fixture',
          paths: ['src/sample.ts'],
        },
      ],
      ingress: [],
    },
    inventory: {
      WORK_MEMORY_EVIDENCE_LINKS: [],
      WORK_MEMORY_RISK_DECISIONS: [],
      REQUIRED_DOMAIN_WORK: [],
      WORK_MEMORY_ACCEPTANCE_CRITERIA: [
        {
          id: 'fixture-closure',
          requirement: 'Fixture risks remain visible.',
          automatedCheck: 'The scanner emits exact sites.',
          closureCondition: 'The fixture is not used as a closure snapshot.',
        },
      ],
      WORK_MEMORY_LIMITATIONS: [
        {
          id: 'fixture-limitation',
          statement: 'Fixture syntax does not prove runtime cardinality.',
        },
      ],
    },
  }
}

function evaluateFixture(fixture: ReturnType<typeof writeFixture>, mode: 'inventory' | 'enforce') {
  return evaluateProductionWorkMemory(
    {
      root: fixture.root,
      sourceRoot: resolve(fixture.root, 'src'),
      inventory: fixture.inventory,
      moduleInventory: fixture.moduleInventory,
    },
    mode,
  )
}
