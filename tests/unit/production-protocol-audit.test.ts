import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { loadProtocolContractFactBundle } from '../helpers/protocol-contract-facts'

const ROOT = resolve(__dirname, '../..')
const AUDIT_URL = pathToFileURL(resolve(ROOT, 'scripts/audit-production-protocol.mjs')).href

interface ConstructorSite {
  readonly id: string
  readonly path: string
  readonly line: number
  readonly column: number
  readonly offset: number
  readonly variant: string
  readonly confidence: string
  readonly role: string
}

interface ProtocolFacts {
  readonly sourceFiles: number
  readonly protocols: Readonly<
    Record<
      'WorkspaceQuery' | 'WorkspaceCommand',
      {
        readonly id: string
        readonly variants: readonly string[]
        readonly constructorSites: readonly ConstructorSite[]
      }
    >
  >
  readonly rootKinds: readonly string[]
  readonly exclusiveRootKinds: readonly string[]
  readonly replacementDispositions: readonly string[]
  readonly rootReplacementDispositions: Readonly<Record<string, string>>
  readonly rootAdmissionFunctions: number
  readonly rootAdmissionDefinitions: readonly RootAdmissionDefinition[]
  readonly rootAdmissions: readonly RootAdmissionSite[]
  readonly rootCapabilityEscapes: readonly RootCapabilityEscape[]
  readonly rootCapabilityProblems: readonly string[]
}

interface RootAdmissionDefinition {
  readonly name: string
  readonly path: string
  readonly source: 'argument' | 'fixed'
  readonly kindArgument: number | null
  readonly allowedKinds: readonly string[]
}

interface RootCapabilityEscape {
  readonly path: string
  readonly line: number
  readonly admission: string
}

interface RootAdmissionSite {
  readonly path: string
  readonly line: number
  readonly column: number
  readonly offset: number
  readonly owner: string
  readonly ownerOffset: number
  readonly admission: string
  readonly kinds: readonly string[] | null
}

interface ProtocolReport {
  readonly ok: boolean
  readonly sourceFiles: number
  readonly protocols: Readonly<
    Record<
      'WorkspaceQuery' | 'WorkspaceCommand',
      {
        readonly variants: readonly string[]
        readonly constructorSites: readonly ConstructorSite[]
        readonly ingressSites: number
        readonly dependencyProbeSites: number
        readonly unclassifiedSites: number
        readonly missingIngress: readonly string[]
      }
    >
  >
  readonly roots: {
    readonly variants: number
    readonly exclusiveVariants: number
    readonly admissionFunctions: number
    readonly admissionDefinitions: readonly RootAdmissionDefinition[]
    readonly finiteAdmissions: number
    readonly unboundedAdmissions: number
    readonly capabilityEscapes: number
    readonly admissions: readonly RootAdmissionSite[]
  }
  readonly problems: readonly string[]
}

interface ProtocolAuditModule {
  evaluateProductionProtocol(facts?: ProtocolFacts): ProtocolReport
}

let audit: ProtocolAuditModule
let facts: ProtocolFacts

beforeAll(async () => {
  audit = (await import(AUDIT_URL)) as ProtocolAuditModule
  facts = (await loadProtocolContractFactBundle<{ readonly production: ProtocolFacts }>())
    .production
}, 30_000)

describe('production workspace protocol audit', () => {
  it('derives executable protocol ingress, probes, and root ownership from typed source', () => {
    const report = audit.evaluateProductionProtocol(facts)

    expect(report).toMatchObject({
      ok: true,
      sourceFiles: 473,
      roots: {
        variants: 15,
        exclusiveVariants: 2,
        admissionFunctions: 6,
        finiteAdmissions: 110,
        unboundedAdmissions: 0,
        capabilityEscapes: 0,
      },
      problems: [],
    })
    expect(report.protocols.WorkspaceQuery).toMatchObject({
      ingressSites: 99,
      dependencyProbeSites: 5,
      unclassifiedSites: 0,
      missingIngress: [],
    })
    expect(report.protocols.WorkspaceCommand).toMatchObject({
      ingressSites: 74,
      dependencyProbeSites: 0,
      unclassifiedSites: 0,
      missingIngress: [],
    })
    expect(report.protocols.WorkspaceQuery.variants).toHaveLength(66)
    expect(report.protocols.WorkspaceCommand.variants).toHaveLength(65)
    expect(
      report.roots.admissions.some(
        (site) =>
          site.admission === 'runWorkspaceActionAtFence' &&
          site.kinds?.includes('conversation-generation'),
      ),
    ).toBe(true)
    expect(report.roots.admissionDefinitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'launchImportExportWorkspaceRuntimeReplacementNow',
          source: 'fixed',
          allowedKinds: ['import-export'],
        }),
        expect.objectContaining({
          name: 'tryLaunchMaintenanceWorkspaceRuntimeReplacementIfIdle',
          source: 'fixed',
          allowedKinds: ['maintenance'],
        }),
      ]),
    )
    expect(report.roots.admissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'src/store/browser-workspace-replacement-runner.ts',
          admission: 'launchImportExportWorkspaceRuntimeReplacementNow',
          kinds: ['import-export'],
        }),
        expect.objectContaining({
          path: 'src/store/browser-workspace-replacement-runner.ts',
          admission: 'tryLaunchMaintenanceWorkspaceRuntimeReplacementIfIdle',
          kinds: ['maintenance'],
        }),
      ]),
    )
  })

  it('does not let dependency-only constructors establish executable reachability', () => {
    const probeVariant = facts.protocols.WorkspaceQuery.constructorSites.find(
      (site) => site.role === 'dependency-probe',
    )?.variant
    if (!probeVariant) throw new Error('WorkspaceQueryDependencyProbeFixtureMissing')
    const changed = replaceProtocolSites(facts, 'WorkspaceQuery', (sites) =>
      sites.map((site) =>
        site.variant === probeVariant && site.role === 'ingress'
          ? { ...site, role: 'dependency-probe' }
          : site,
      ),
    )

    const report = audit.evaluateProductionProtocol(changed)

    expect(report.ok).toBe(false)
    expect(report.problems).toContain(
      `WorkspaceQuery.${probeVariant}: no typed production ingress (2 dependency probes only)`,
    )
  })

  it('rejects a constructor that is merely coincident with the protocol shape', () => {
    const [first] = facts.protocols.WorkspaceCommand.constructorSites
    if (!first) throw new Error('WorkspaceCommandConstructorFixtureMissing')
    const changed = replaceProtocolSites(facts, 'WorkspaceCommand', (sites) =>
      sites.map((site) => (site.id === first.id ? { ...site, role: 'unclassified' } : site)),
    )

    const report = audit.evaluateProductionProtocol(changed)

    expect(report.ok).toBe(false)
    expect(report.protocols.WorkspaceCommand.unclassifiedSites).toBe(1)
    expect(report.problems).toContain(
      `WorkspaceCommand.${first.variant}: constructor has no typed role: ${first.id}`,
    )
  })

  it('rejects missing and invalid replacement dispositions', () => {
    const dispositions = Object.fromEntries(
      Object.entries(facts.rootReplacementDispositions).filter(
        ([kind]) => kind !== 'repository-query',
      ),
    )
    dispositions['chat-metadata'] = 'invented'
    const report = audit.evaluateProductionProtocol({
      ...facts,
      rootReplacementDispositions: dispositions,
    })

    expect(report.ok).toBe(false)
    expect(report.problems).toEqual(
      expect.arrayContaining([
        'workspace root replacement keys: missing repository-query',
        'chat-metadata: invalid workspace replacement disposition invented',
      ]),
    )
  })

  it('rejects an unadmitted exclusive root', () => {
    const report = audit.evaluateProductionProtocol({
      ...facts,
      rootAdmissions: facts.rootAdmissions.filter((site) => !site.kinds?.includes('chat-fork')),
    })

    expect(report.ok).toBe(false)
    expect(report.problems).toEqual(
      expect.arrayContaining([
        'chat-fork: no typed production root admission',
        'chat-fork: exclusive root needs exactly one production admission owner, found 0',
      ]),
    )
  })

  it('rejects a second owner for an exclusive root', () => {
    const original = exactRootSite('chat-fork')
    const report = audit.evaluateProductionProtocol({
      ...facts,
      rootAdmissions: [
        ...facts.rootAdmissions,
        {
          ...original,
          path: 'src/store/injected-owner.ts',
          owner: 'injectedOwner',
          ownerOffset: 1,
          offset: 1,
        },
      ],
    })

    expect(report.ok).toBe(false)
    expect(report.problems).toContain(
      'chat-fork: exclusive root needs exactly one production admission owner, found 2',
    )
  })

  it('rejects a broad capability that can admit an exclusive root', () => {
    const original = exactRootSite('conversation-generation')
    const report = audit.evaluateProductionProtocol({
      ...facts,
      rootAdmissions: facts.rootAdmissions.map((site) =>
        site === original
          ? { ...site, kinds: ['conversation-generation', 'repository-query'] }
          : site,
      ),
    })

    expect(report.ok).toBe(false)
    expect(report.problems).toContain(
      `${original.path}:${original.line}: exclusive root conversation-generation shares an admission capability`,
    )
  })

  it('rejects an admission whose kind cannot be statically bounded', () => {
    const [first] = facts.rootAdmissions
    if (!first) throw new Error('WorkspaceRootAdmissionFixtureMissing')
    const report = audit.evaluateProductionProtocol({
      ...facts,
      rootAdmissions: facts.rootAdmissions.map((site) =>
        site === first ? { ...site, kinds: null } : site,
      ),
    })

    expect(report.ok).toBe(false)
    expect(report.roots.unboundedAdmissions).toBe(1)
    expect(report.problems).toContain(
      `${first.path}:${first.line}: root admission is not a finite static kind set`,
    )
  })

  it('rejects a typed root admission capability that escapes direct invocation', () => {
    const report = audit.evaluateProductionProtocol({
      ...facts,
      rootCapabilityEscapes: [
        {
          path: 'src/store/injected-alias.ts',
          line: 1,
          admission: 'runWorkspaceAction',
        },
      ],
    })

    expect(report.ok).toBe(false)
    expect(report.roots.capabilityEscapes).toBe(1)
    expect(report.problems).toContain(
      'src/store/injected-alias.ts:1: root admission capability escapes direct invocation: runWorkspaceAction',
    )
  })
})

function replaceProtocolSites(
  source: ProtocolFacts,
  name: 'WorkspaceQuery' | 'WorkspaceCommand',
  transform: (sites: readonly ConstructorSite[]) => readonly ConstructorSite[],
): ProtocolFacts {
  return {
    ...source,
    protocols: {
      ...source.protocols,
      [name]: {
        ...source.protocols[name],
        constructorSites: transform(source.protocols[name].constructorSites),
      },
    },
  }
}

function exactRootSite(kind: string): RootAdmissionSite {
  const matches = facts.rootAdmissions.filter((site) => site.kinds?.includes(kind))
  if (matches.length !== 1) throw new Error(`WorkspaceRootAdmissionFixtureInvalid:${kind}`)
  return matches[0] as RootAdmissionSite
}
