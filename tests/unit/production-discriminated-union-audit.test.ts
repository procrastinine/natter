import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { beforeAll, describe, expect, it } from 'vitest'
import { loadProtocolContractFactBundle } from '../helpers/protocol-contract-facts'

const ROOT = resolve(__dirname, '../..')
const AUDIT_URL = pathToFileURL(
  resolve(ROOT, 'scripts/audit-production-discriminated-unions.mjs'),
).href
const INVENTORY_URL = pathToFileURL(
  resolve(ROOT, 'scripts/production-discriminated-union-inventory.mjs'),
).href

const DISCOVERY_URL = pathToFileURL(
  resolve(ROOT, 'scripts/discover-production-discriminated-unions.mjs'),
).href

type Literal = string | number | boolean

interface RoleOverride {
  readonly id: string
  readonly role: string
}

interface ControlExclusion {
  readonly id: string
  readonly rationale: string
}

interface CanonicalFamily {
  readonly derivedId: string
  readonly rootId: string
}

interface AuditCapabilityRoot {
  readonly name: string
  readonly id: string
}

interface AuditCapability {
  readonly ownerId: string
  readonly roots: readonly AuditCapabilityRoot[]
}

interface CompositionReview {
  readonly id: string
  readonly rationale: string
}

interface SemanticManifest {
  readonly roleOverrides: readonly RoleOverride[]
  readonly controlExclusions: readonly ControlExclusion[]
  readonly canonicalFamilies: readonly CanonicalFamily[]
  readonly constructionCompositionReviews: readonly CompositionReview[]
}

interface DiscoveredUnion {
  readonly id: string
  readonly path: string
  readonly type: string
  readonly property: string
  readonly variants: readonly Literal[]
  readonly declarationKind: string
  readonly aliasReferences: readonly string[]
  readonly constructorSites: readonly unknown[]
  readonly primary?: boolean
  readonly role?: string
  readonly canonicalRoots?: readonly string[]
  readonly coverage?: { readonly status: string }
  readonly [field: string]: unknown
}

interface UnionGap {
  readonly id: string
  readonly rationale: string
}

interface UnionReport {
  readonly ok: boolean
  readonly sourceFiles: number
  readonly discoveredCount: number
  readonly classifiedCount: number
  readonly controlProtocolCount: number
  readonly auditCapabilityCount: number
  readonly dedicatedAuditRootCount: number
  readonly gapCount: number
  readonly constructionGapCount: number
  readonly roleCounts: Readonly<Record<string, number>>
  readonly constructionCounts: Readonly<Record<string, number>>
  readonly declarationKindCounts: Readonly<Record<string, number>>
  readonly coverageCounts: Readonly<Record<string, number>>
  readonly gaps: readonly UnionGap[]
  readonly constructionGaps: readonly UnionGap[]
  readonly entries: readonly DiscoveredUnion[]
  readonly auditCapabilities: readonly AuditCapability[]
  readonly limitations: readonly string[]
  readonly violations: readonly string[]
}

interface UnionAuditModule {
  buildProductionDiscriminatedUnionInventory(options?: {
    readonly discovered?: {
      readonly sourceFiles: number
      readonly unions: readonly DiscoveredUnion[]
    }
    readonly auditCapabilities?: readonly AuditCapability[]
  }): UnionReport
  validateProductionDiscriminatedUnionInventory(input: {
    readonly schemaVersion: number
    readonly semanticManifest: SemanticManifest
    readonly discovered: {
      readonly sourceFiles: number
      readonly unions: readonly DiscoveredUnion[]
    }
    readonly moduleInventory: unknown
    readonly auditCapabilities: readonly AuditCapability[]
    readonly initialViolations?: readonly string[]
  }): UnionReport
  inferUnionRole(union: DiscoveredUnion, primaryIds: ReadonlySet<string>): string | null
}

interface UnionInventoryModule {
  readonly UNION_INVENTORY_SCHEMA_VERSION: number
  readonly PRODUCTION_DISCRIMINATED_UNION_SEMANTICS: SemanticManifest
}

let audit: UnionAuditModule
let inventory: UnionInventoryModule
let baseline: UnionReport
let moduleInventory: unknown
let sourceFacts: Readonly<
  Record<string, { readonly auditedUnionSubjects: readonly AuditCapabilityRoot[] }>
>

beforeAll(async () => {
  const [loadedAudit, loadedInventory, bundle] = await Promise.all([
    import(AUDIT_URL) as Promise<unknown>,
    import(INVENTORY_URL) as Promise<unknown>,
    loadProtocolContractFactBundle<{
      readonly unionDiscovery: {
        readonly sourceFiles: number
        readonly unions: readonly DiscoveredUnion[]
      }
      readonly auditCapabilities: readonly AuditCapability[]
      readonly production: { readonly auditedUnionSubjects: readonly AuditCapabilityRoot[] }
      readonly stages: { readonly auditedUnionSubjects: readonly AuditCapabilityRoot[] }
      readonly configuration: { readonly auditedUnionSubjects: readonly AuditCapabilityRoot[] }
      readonly durable: { readonly auditedUnionSubjects: readonly AuditCapabilityRoot[] }
      readonly locality: { readonly auditedUnionSubjects: readonly AuditCapabilityRoot[] }
    }>(),
  ])
  audit = loadedAudit as UnionAuditModule
  inventory = loadedInventory as UnionInventoryModule
  moduleInventory = JSON.parse(
    readFileSync(resolve(ROOT, 'scripts/production-module-inventory.json'), 'utf8'),
  ) as unknown
  sourceFacts = {
    'production-protocol': bundle.production,
    'protocol-stage-coverage': bundle.stages,
    'configuration-protocol': bundle.configuration,
    'durable-command-pipeline': bundle.durable,
    'tab-cross-tab-locality': bundle.locality,
  }
  baseline = audit.buildProductionDiscriminatedUnionInventory({
    discovered: bundle.unionDiscovery,
    auditCapabilities: bundle.auditCapabilities,
  })
}, 30_000)

describe('production discriminated-union meta-audit', () => {
  it('derives every current union and leaves every unproved control protocol visible', () => {
    expect(baseline.ok).toBe(true)
    expect(baseline.violations).toEqual([])
    expect(baseline.discoveredCount).toBeGreaterThan(200)
    expect(baseline.classifiedCount).toBe(baseline.discoveredCount)
    expect(sum(baseline.roleCounts)).toBe(baseline.discoveredCount)
    expect(sum(baseline.declarationKindCounts)).toBe(baseline.discoveredCount)
    expect(sum(baseline.coverageCounts)).toBe(baseline.discoveredCount)
    expect(sum(baseline.constructionCounts)).toBe(baseline.discoveredCount)
    expect(baseline.auditCapabilityCount).toBe(baseline.auditCapabilities.length)
    expect(baseline.dedicatedAuditRootCount).toBe(baseline.coverageCounts.dedicated)
    expect(baseline.gapCount).toBe(baseline.gaps.length)
    expect(baseline.constructionGapCount).toBe(baseline.constructionGaps.length)
    expect(baseline.gaps.map((gap) => gap.id)).toContain(
      'src/store/browser-workspace-database-control.ts#BrowserWorkspaceCompactionAttempt|kind',
    )
    expect(baseline.constructionGaps.map((gap) => gap.id)).toEqual(
      expect.arrayContaining([
        'src/store/attempt-controller.ts#AttemptRecord|kind',
        'src/store/configuration-controller.ts#ConfigurationFrameRetention|kind',
        'src/store/conversation-controller.ts#ConversationOperationClaim|steering',
        'src/store/conversation-controller.ts#SelectingConversationOperationClaim|selectionDelivery',
        'src/store/storage-retention-state.ts#StorageRetentionStateRowFor|phase',
        'src/store/workspace-protocol.ts#ConfigurationCatalogPage|kind',
      ]),
    )
    expect(baseline.limitations).toEqual(
      expect.arrayContaining([
        expect.stringContaining('semantic judgments'),
        expect.stringContaining('never count as typed constructor evidence'),
        expect.stringContaining('separate architecture-audit gate'),
      ]),
    )
    expect(capability('configuration-protocol').roots).toEqual(
      expect.arrayContaining([
        {
          name: 'command',
          id: 'src/store/configuration-domain-contract.ts#ConfigurationDomainCommandUnion|kind',
        },
        {
          name: 'result',
          id: 'src/store/configuration-domain-contract.ts#ConfigurationDomainResultUnion|kind',
        },
      ]),
    )
    expect(
      baseline.auditCapabilities.filter((candidate) =>
        candidate.roots.some(
          (root) => root.id === 'src/store/workspace-protocol.ts#WorkspaceQuery|kind',
        ),
      ),
    ).toHaveLength(3)
  })

  it('derives composite aliases by matching discriminant property, never by an ambiguous type edge', () => {
    expect(entry('src/store/repository.ts#StreamLeaseByAttempt|custody').canonicalRoots).toEqual([
      'src/store/repository.ts#StreamLeaseCustody|custody',
    ])
    expect(entry('src/store/repository.ts#StreamLeaseByAttempt|phase').canonicalRoots).toEqual([
      'src/store/repository.ts#StreamLeaseProgress|phase',
    ])
    expect(
      entry('src/store/conversation-controller.ts#ConversationCurrentSurfaceBinding|surface')
        .coverage?.status,
    ).toBe('gap')
  })

  it('selects semantic and tuple primaries and classifies versioned protocols generically', () => {
    expect(entry('src/core/effective-endpoint-routing.ts#PrefillPlan|availability').primary).toBe(
      true,
    )
    expect(entry('src/core/api-choice.ts#ResponsesReasoningContract|originDialect').primary).toBe(
      true,
    )
    expect(entry('src/store/stream-journal-codec.ts#StreamJournalValueToken|0').primary).toBe(true)
    expect(entry('src/core/generation-stream-events.ts#CanonicalStreamEventV2|lane').role).toBe(
      'event',
    )
    expect(entry('src/store/attempt-controller.ts#AttemptRecord|kind').role).toBe('state')
  })

  it('rejects stale, duplicate, and mechanically copied semantic overrides', () => {
    const first = inventory.PRODUCTION_DISCRIMINATED_UNION_SEMANTICS.roleOverrides[0]
    if (!first) throw new Error('UnionRoleOverrideFixtureMissing')
    const report = validate({
      roleOverrides: [
        ...inventory.PRODUCTION_DISCRIMINATED_UNION_SEMANTICS.roleOverrides,
        first,
        {
          id: 'src/store/retired.ts#RetiredState|kind',
          role: 'state',
          path: 'src/store/retired.ts',
        } as RoleOverride,
      ],
    })

    expect(report.ok).toBe(false)
    expect(report.violations).toEqual(
      expect.arrayContaining([
        `role overrides: duplicate ${first.id}`,
        'role overrides: stale src/store/retired.ts#RetiredState|kind',
        'role overrides:src/store/retired.ts#RetiredState|kind: mechanical field path must be source-derived',
      ]),
    )
  })

  it('rejects semantic exceptions that hide an audited control root or invent incompatible lineage', () => {
    const semantics = inventory.PRODUCTION_DISCRIMINATED_UNION_SEMANTICS
    const report = validate({
      controlExclusions: [
        ...semantics.controlExclusions,
        {
          id: 'src/store/workspace-protocol.ts#WorkspaceCommand|kind',
          rationale: 'Pretend this audited command protocol is data.',
        },
      ],
      canonicalFamilies: [
        ...semantics.canonicalFamilies,
        {
          derivedId: 'src/store/workspace-protocol.ts#ConfigurationCatalogPage|kind',
          rootId: 'src/store/workspace-protocol.ts#WorkspaceQuery|kind',
        },
      ],
    })

    expect(report.ok).toBe(false)
    expect(report.violations).toEqual(
      expect.arrayContaining([
        'src/store/workspace-protocol.ts#WorkspaceCommand|kind: non-control union cannot claim dedicated coverage',
        expect.stringContaining(
          'canonical family: src/store/workspace-protocol.ts#ConfigurationCatalogPage|kind variant',
        ),
      ]),
    )
  })

  it('rejects reversed, cyclic, or unresolved canonical lineage', () => {
    const semantics = inventory.PRODUCTION_DISCRIMINATED_UNION_SEMANTICS
    const [family] = semantics.canonicalFamilies
    if (!family) throw new Error('UnionCanonicalFamilyFixtureMissing')
    const report = validate({
      canonicalFamilies: [
        ...semantics.canonicalFamilies,
        { derivedId: family.rootId, rootId: family.derivedId },
        {
          derivedId: 'src/store/workspace-protocol.ts#ConfigurationCatalogPage|kind',
          rootId: 'src/store/retired.ts#RetiredState|kind',
        },
      ],
    })

    expect(report.ok).toBe(false)
    expect(report.violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining('canonical family cycle:'),
        `canonical family: missing root src/store/retired.ts#RetiredState|kind`,
        `canonical family: root is also a member ${family.rootId}`,
      ]),
    )
  })

  it('rejects stale, non-control, and derived capability claims', () => {
    const report = validate(
      {},
      baseline.auditCapabilities.map((candidate) =>
        candidate.ownerId === 'tab-cross-tab-locality'
          ? {
              ...candidate,
              roots: [
                ...candidate.roots,
                {
                  name: 'derived',
                  id: 'src/store/browser-repo.ts#BrowserInlineQuery|kind',
                },
                {
                  name: 'non-control',
                  id: 'src/core/types.ts#ReasoningDetail|type',
                },
                {
                  name: 'stale',
                  id: 'src/store/retired.ts#RetiredState|kind',
                },
              ],
            }
          : candidate,
      ),
    )

    expect(report.ok).toBe(false)
    expect(report.violations).toEqual(
      expect.arrayContaining([
        'src/store/browser-repo.ts#BrowserInlineQuery|kind: derived union cannot claim separate dedicated coverage',
        'src/core/types.ts#ReasoningDetail|type: non-control union cannot claim dedicated coverage',
        'src/store/retired.ts#RetiredState|kind: audit capability names a stale union root',
      ]),
    )
  })

  it('rejects malformed capability records without granting partial coverage', () => {
    const first = baseline.auditCapabilities[0]
    if (!first) throw new Error('UnionAuditCapabilityFixtureMissing')
    const report = validate({}, [
      ...baseline.auditCapabilities,
      {
        ownerId: first.ownerId,
        roots: [
          { name: 'duplicate', id: first.roots[0]?.id ?? '' },
          { name: 'duplicate', id: first.roots[0]?.id ?? '' },
        ],
      },
    ])

    expect(report.ok).toBe(false)
    expect(report.violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`duplicate ownerId ${first.ownerId}`),
        expect.stringContaining('duplicate name duplicate'),
        expect.stringContaining(`duplicate id ${first.roots[0]?.id}`),
      ]),
    )
  })

  it('turns removal of the last source-owned capability into an explicit coverage gap', () => {
    const targetId =
      'src/store/configuration-domain-contract.ts#ConfigurationDomainResultUnion|kind'
    const report = validate(
      {},
      baseline.auditCapabilities.map((candidate) => ({
        ...candidate,
        roots: candidate.roots.filter((root) => root.id !== targetId),
      })),
    )

    expect(report.ok).toBe(true)
    expect(report.gaps.map((gap) => gap.id)).toContain(targetId)
    expect(report.entries.find((candidate) => candidate.id === targetId)?.coverage?.status).toBe(
      'gap',
    )
  })

  it('derives every capability from the exact union facts its owner consumed', () => {
    expect(baseline.auditCapabilities.map((candidate) => candidate.ownerId)).toEqual(
      Object.keys(sourceFacts).sort(),
    )
    for (const capability of baseline.auditCapabilities) {
      expect(capability.roots).toEqual(sourceFacts[capability.ownerId]?.auditedUnionSubjects)
    }
  })

  it('rejects invented and empty typed capability owners without granting coverage', () => {
    const targetId = 'src/store/workspace-protocol.ts#ConfigurationCatalogPage|kind'
    const report = validate({}, [
      ...baseline.auditCapabilities,
      { ownerId: 'invented-audit', roots: [{ name: 'invented', id: targetId }] },
      { ownerId: '', roots: [] },
    ])

    expect(report.ok).toBe(false)
    expect(report.violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining('unknown ownerId invented-audit'),
        expect.stringContaining('ownerId must be a nonempty string'),
        expect.stringContaining('roots must not be empty'),
      ]),
    )
    expect(report.entries.find((candidate) => candidate.id === targetId)?.coverage?.status).toBe(
      baseline.entries.find((candidate) => candidate.id === targetId)?.coverage?.status,
    )
  })

  it('keeps missing constructor evidence explicit and rejects composition-review laundering', () => {
    const semantics = inventory.PRODUCTION_DISCRIMINATED_UNION_SEMANTICS
    const targetId = 'src/store/workspace-protocol.ts#WorkspaceCommand|kind'
    const report = validate({
      constructionCompositionReviews: [
        ...semantics.constructionCompositionReviews,
        { id: targetId, rationale: 'Pretend typed command constructors are composition only.' },
      ],
    })

    expect(report.ok).toBe(false)
    expect(report.violations).toContain(
      `${targetId}: composition review does not describe a constructor-free control root`,
    )
  })

  it('fails closed when source-derived role inference has no semantic answer', () => {
    const unknown: DiscoveredUnion = {
      id: 'src/store/example.ts#Mystery|kind',
      path: 'src/store/example.ts',
      type: 'Mystery',
      property: 'kind',
      variants: ['a', 'b'],
      declarationKind: 'declared-union',
      aliasReferences: [],
      constructorSites: [],
    }

    expect(audit.inferUnionRole(unknown, new Set([unknown.id]))).toBeNull()
  })

  it('rejects the old mechanical schema instead of silently accepting stale rows', () => {
    const report = audit.validateProductionDiscriminatedUnionInventory({
      schemaVersion: 1,
      semanticManifest: {
        ...inventory.PRODUCTION_DISCRIMINATED_UNION_SEMANTICS,
        dedicatedAuditLinks: [],
        roleOverrides: [
          {
            id: 'src/core/types.ts#ReasoningDetail|type',
            role: 'data',
            variants: ['reasoning.text', 'reasoning.encrypted'],
          } as RoleOverride,
        ],
      } as unknown as SemanticManifest,
      discovered: { sourceFiles: baseline.sourceFiles, unions: baseline.entries },
      moduleInventory,
      auditCapabilities: baseline.auditCapabilities,
    })

    expect(report.ok).toBe(false)
    expect(report.violations).toEqual(
      expect.arrayContaining([
        'schema version: expected 2, found 1',
        'semantic manifest: unsupported key dedicatedAuditLinks',
        'role overrides:src/core/types.ts#ReasoningDetail|type: mechanical field variants must be source-derived',
      ]),
    )
  })
})

function validate(
  overrides: Partial<SemanticManifest>,
  auditCapabilities: readonly AuditCapability[] = baseline.auditCapabilities,
): UnionReport {
  return audit.validateProductionDiscriminatedUnionInventory({
    schemaVersion: inventory.UNION_INVENTORY_SCHEMA_VERSION,
    semanticManifest: {
      ...inventory.PRODUCTION_DISCRIMINATED_UNION_SEMANTICS,
      ...overrides,
    },
    discovered: { sourceFiles: baseline.sourceFiles, unions: baseline.entries },
    moduleInventory,
    auditCapabilities,
  })
}

function capability(ownerId: string): AuditCapability {
  const found = baseline.auditCapabilities.find((candidate) => candidate.ownerId === ownerId)
  if (!found) throw new Error(`UnionAuditCapabilityMissing:${ownerId}`)
  return found
}

function entry(id: string): DiscoveredUnion {
  const found = baseline.entries.find((candidate) => candidate.id === id)
  if (!found) throw new Error(`UnionAuditEntryMissing:${id}`)
  return found
}

function sum(counts: Readonly<Record<string, number>>): number {
  return Object.values(counts).reduce((total, count) => total + count, 0)
}

describe('constructor discovery work', () => {
  it('resolves semantic object types only for candidate discriminants while preserving ambiguous owners', async () => {
    const path = resolve(ROOT, 'src/discovery-counterexample.ts')
    const text = `
      export type First = { kind: 'shared'; first: number } | { kind: 'first' }
      export type Second = { kind: 'shared'; second: string } | { kind: 'second' }
      function first(): First { return { kind: 'shared', first: 1 } }
      function second(): Second { return { kind: 'shared', second: 'two' } }
      const unknown = { kind: 'unregistered' }
      ${Array.from({ length: 1000 }, (_, i) => `const irrelevant${i} = { value: ${i} }`).join('\n')}
    `
    const options: ts.CompilerOptions = { noLib: true, types: [] }
    const host = ts.createCompilerHost(options)
    host.getSourceFile = (fileName, languageVersion) =>
      fileName === path ? ts.createSourceFile(path, text, languageVersion, true) : undefined
    const program = ts.createProgram({ rootNames: [path], options, host })
    const checker = program.getTypeChecker()
    const objectQueries: string[] = []
    const contextQueries: string[] = []
    const observedChecker: ts.TypeChecker = {
      ...checker,
      getTypeAtLocation(node) {
        if (ts.isObjectLiteralExpression(node)) objectQueries.push(node.getText())
        return checker.getTypeAtLocation(node)
      },
      getContextualType(node) {
        contextQueries.push(node.getText())
        return checker.getContextualType(node)
      },
    }
    const discovery = (await import(DISCOVERY_URL)) as {
      discoverProductionDiscriminatedUnions(
        root: string,
        options: { program: ts.Program },
      ): {
        unions: Array<{
          type: string
          constructorSites: Array<{ owner: string; confidence: string }>
        }>
      }
    }
    const report = discovery.discoverProductionDiscriminatedUnions(ROOT, {
      program: { ...program, getTypeChecker: () => observedChecker },
    })
    expect(report.unions.map(({ type, constructorSites }) => ({ type, constructorSites }))).toEqual(
      [
        {
          type: 'First',
          constructorSites: [
            expect.objectContaining({ owner: 'first', confidence: 'type-assignable' }),
          ],
        },
        {
          type: 'Second',
          constructorSites: [
            expect.objectContaining({ owner: 'second', confidence: 'type-assignable' }),
          ],
        },
      ],
    )
    expect(objectQueries).toEqual([
      "{ kind: 'shared', first: 1 }",
      "{ kind: 'shared', second: 'two' }",
    ])
    expect(contextQueries).toEqual(objectQueries)
  })

  it('scopes constructor work without changing ambiguity, fallback or site identity', async () => {
    const path = resolve(ROOT, 'src/discovery-scope-counterexample.ts')
    const text = `
      export type First = { kind: 'shared'; first: number } | { kind: 'first'; value: number }
      export type Second = { kind: 'shared'; second: string } | { kind: 'second'; value: string }
      function first(): First { return { kind: 'shared', first: 1 } }
      function second(): Second { return { kind: 'shared', second: 'two' } }
      function ambiguous() { return { kind: 'shared' } }
      function uniqueFallback() { return { kind: 'first' } }
      function excluded(): Second { return { kind: 'second', value: 'two' } }
      export type Unrelated = { phase: 'queued'; state: 'ready' } | { phase: 'complete'; state: 'done' }
      export type UnrelatedAlias = Unrelated
      function unrelated(): Unrelated { return { phase: 'queued', state: 'ready' } }
    `
    const options: ts.CompilerOptions = { noLib: true, types: [] }
    const host = ts.createCompilerHost(options)
    host.getSourceFile = (fileName, languageVersion) =>
      fileName === path ? ts.createSourceFile(path, text, languageVersion, true) : undefined
    const program = ts.createProgram({ rootNames: [path], options, host })
    const checker = program.getTypeChecker()
    const objectQueries: string[] = []
    const contextQueries: string[] = []
    const propertyQueries: string[] = []
    const declarationQueries: string[] = []
    const observedChecker: ts.TypeChecker = {
      ...checker,
      getTypeFromTypeNode(node) {
        declarationQueries.push(node.getText())
        return checker.getTypeFromTypeNode(node)
      },
      getTypeOfSymbolAtLocation(symbol, node) {
        propertyQueries.push(symbol.name)
        return checker.getTypeOfSymbolAtLocation(symbol, node)
      },
      getTypeAtLocation(node) {
        if (ts.isObjectLiteralExpression(node)) objectQueries.push(node.getText())
        return checker.getTypeAtLocation(node)
      },
      getContextualType(node) {
        contextQueries.push(node.getText())
        return checker.getContextualType(node)
      },
    }
    const discovery = (await import(DISCOVERY_URL)) as {
      discoverProductionDiscriminatedUnions(
        root: string,
        options: { program: ts.Program; unionIds?: string[] },
      ): {
        sourceFiles: number
        discriminatedUnions: number
        unions: Array<{
          id: string
          type: string
          constructorSites: Array<{ owner: string; confidence: string }>
        }>
      }
    }
    const full = discovery.discoverProductionDiscriminatedUnions(ROOT, { program })
    const firstId = 'src/discovery-scope-counterexample.ts#First|kind'
    const scopedProgram = { ...program, getTypeChecker: () => observedChecker }
    const scoped = discovery.discoverProductionDiscriminatedUnions(ROOT, {
      program: scopedProgram,
      unionIds: [firstId],
    })
    expect(scoped).toEqual({
      ...full,
      discriminatedUnions: 1,
      unions: full.unions.filter(({ id }) => id === firstId),
    })
    expect(scoped.unions[0]?.constructorSites).toEqual([
      expect.objectContaining({ owner: 'first', confidence: 'type-assignable' }),
      expect.objectContaining({ owner: 'uniqueFallback', confidence: 'unique-literal' }),
    ])
    expect(objectQueries).toEqual([
      "{ kind: 'shared', first: 1 }",
      "{ kind: 'shared', second: 'two' }",
      "{ kind: 'shared' }",
      "{ kind: 'first' }",
    ])
    expect(contextQueries).toEqual(objectQueries)
    expect(new Set(propertyQueries)).toEqual(new Set(['kind']))
    expect(declarationQueries).toHaveLength(4)
    propertyQueries.length = 0
    declarationQueries.length = 0
    objectQueries.length = 0
    contextQueries.length = 0
    expect(
      discovery.discoverProductionDiscriminatedUnions(ROOT, {
        program: scopedProgram,
        unionIds: [],
      }),
    ).toEqual({ sourceFiles: full.sourceFiles, discriminatedUnions: 0, unions: [] })
    expect(objectQueries).toEqual([])
    expect(contextQueries).toEqual([])
    expect(propertyQueries).toEqual([])
    expect(declarationQueries).toEqual([])
  })
})
