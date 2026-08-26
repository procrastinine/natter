import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { ARCHITECTURE_AUDIT_MECHANISMS } from '../../scripts/architecture-inventory-closure-manifest.mjs'
import { PROTOCOL_CONTRACT_REPORT_IDS } from '../../scripts/protocol-contract-descriptor.mjs'
import { protocolContractGeneratorDigest } from '../../scripts/protocol-contract-fingerprint.mjs'
import {
  isCurrentProtocolContractFactBundle,
  isCurrentProtocolContractMutationProof,
  loadProtocolContractFactBundle,
  loadProtocolContractMutationProof,
} from '../helpers/protocol-contract-facts'

const ROOT = resolve(__dirname, '../..')
const BUNDLE_URL = pathToFileURL(resolve(ROOT, 'scripts/production-protocol-fact-bundle.mjs')).href
const AUDIT_URL = pathToFileURL(resolve(ROOT, 'scripts/audit-protocol-contracts.mjs')).href
const STAGE_MANIFEST_URL = pathToFileURL(resolve(ROOT, 'scripts/protocol-stage-inventory.mjs')).href
interface AuditedUnionSubject {
  readonly name: string
  readonly id: string
}

interface AuditedUnionFacts {
  readonly auditedUnionSubjects: readonly AuditedUnionSubject[]
}

interface ProtocolContractBundle {
  readonly schemaVersion: 3
  readonly snapshot: {
    readonly digest: string
    readonly generatorDigest: string
    readonly sourceFiles: number
  }
  readonly production: AuditedUnionFacts & {
    readonly protocols: Readonly<
      Record<
        'WorkspaceCommand' | 'WorkspaceQuery',
        {
          readonly variants: readonly string[]
          readonly constructorSites: readonly { readonly id: string }[]
        }
      >
    >
  }
  readonly unionDiscovery: {
    readonly sourceFiles: number
    readonly unions: readonly {
      readonly id: string
      readonly variants: readonly (string | number | boolean)[]
      readonly constructorSites: readonly { readonly id: string }[]
    }[]
  }
  readonly stages: AuditedUnionFacts & {
    readonly variants: Readonly<Record<'command' | 'query', readonly string[]>>
    readonly switches: readonly ProtocolStageSwitch[]
  }
  readonly configuration: AuditedUnionFacts & {
    readonly commandUnion: {
      readonly variants: readonly string[]
      readonly constructorSites: readonly { readonly id: string }[]
    }
  }
  readonly durable: AuditedUnionFacts & {
    readonly workspaceUnion: {
      readonly variants: readonly string[]
      readonly constructorSites: readonly { readonly id: string }[]
    }
    readonly configurationUnion: {
      readonly variants: readonly string[]
      readonly constructorSites: readonly { readonly id: string }[]
    }
  }
  readonly locality: AuditedUnionFacts & {
    readonly surfaceFacts: readonly {
      readonly id: string
      readonly variants: readonly string[]
      readonly constructorSites: readonly { readonly id: string }[]
    }[]
    readonly configurationUnion: {
      readonly variants: readonly string[]
      readonly constructorSites: readonly { readonly id: string }[]
    }
  }
  readonly auditCapabilities: readonly {
    readonly ownerId: string
    readonly roots: readonly AuditedUnionSubject[]
  }[]
}

interface ProtocolStageSwitch {
  readonly id: string
  readonly subject: 'command' | 'query'
  readonly kinds: readonly string[]
  readonly staticKinds: readonly string[]
  readonly coverage: string
}

interface ProtocolStageManifestEntry extends Readonly<Record<string, unknown>> {
  readonly id: string
  readonly subject: 'command' | 'query'
  readonly role: string
  readonly domain: string
  readonly reason: string
}

interface ProtocolContractReport {
  readonly schemaVersion: 1
  readonly ok: boolean
  readonly structurallyValid: boolean
  readonly inventoryComplete: boolean
  readonly manifestFresh: boolean
  readonly guaranteeClosed: boolean
  readonly runtimeProved: null
  readonly gaps: readonly unknown[]
  readonly snapshot: ProtocolContractBundle['snapshot']
  readonly reports: {
    readonly 'production-discriminated-unions': {
      readonly ok: boolean
      readonly discoveredCount: number
      readonly controlProtocolCount: number
      readonly gapCount: number
      readonly constructionGapCount: number
      readonly entries: readonly {
        readonly id: string
        readonly variants: readonly (string | number | boolean)[]
      }[]
      readonly violations: readonly string[]
    }
    readonly 'production-protocol': { readonly ok: boolean; readonly problems: readonly string[] }
    readonly 'protocol-stage-coverage': {
      readonly ok: boolean
      readonly switches: readonly ProtocolStageSwitch[]
      readonly problems: readonly string[]
    }
    readonly 'configuration-protocol': {
      readonly ok: boolean
      readonly problems: readonly string[]
    }
    readonly 'durable-command-pipeline': {
      readonly ok: boolean
      readonly problems: readonly string[]
    }
    readonly 'tab-cross-tab-locality': {
      readonly ok: boolean
      readonly surfaces: number
      readonly records: number
      readonly constructorSites: number
      readonly architectureGaps: number
      readonly recordGaps: number
      readonly siteGaps: number
      readonly problems: readonly string[]
    }
  }
}

interface ProtocolContractModules {
  readonly containsCompilerState: (value: unknown) => boolean
  readonly evaluate: (
    bundle: ProtocolContractBundle,
    options?: Readonly<Record<string, unknown>>,
  ) => ProtocolContractReport
  readonly evaluateStages: (
    manifest: readonly ProtocolStageManifestEntry[],
    facts: ProtocolContractBundle['stages'],
  ) => ProtocolContractReport['reports']['protocol-stage-coverage']
  readonly fileDigest: (root?: string) => string
  readonly stageManifest: readonly ProtocolStageManifestEntry[]
}

interface ProtocolContractMutationProof {
  readonly schemaVersion: 1
  readonly baselineSnapshot: ProtocolContractBundle['snapshot']
  readonly changedSnapshot: ProtocolContractBundle['snapshot']
  readonly construction: {
    readonly programCreations: number
    readonly unionDiscoveries: number
  }
  readonly changedFacts: {
    readonly workspaceCommandVariants: readonly string[]
    readonly configurationCommandVariants: readonly string[]
    readonly unionEntries: readonly {
      readonly id: string
      readonly variants: readonly (string | number | boolean)[]
    }[]
  }
  readonly changedReport: {
    readonly ok: boolean
    readonly productionProblems: readonly string[]
    readonly stageProblems: readonly string[]
    readonly configurationProblems: readonly string[]
    readonly durableProblems: readonly string[]
    readonly localityProblems: readonly string[]
  }
}

let modules: ProtocolContractModules
let bundle: ProtocolContractBundle
let report: ProtocolContractReport
let mutationProof: ProtocolContractMutationProof

beforeAll(async () => {
  const bundleModule = (await import(BUNDLE_URL)) as {
    productionProtocolFactBundleContainsCompilerState: ProtocolContractModules['containsCompilerState']
  }
  const auditModule = (await import(AUDIT_URL)) as {
    evaluateProtocolContractBundle: ProtocolContractModules['evaluate']
  }
  const stageModule = (await import(
    pathToFileURL(resolve(ROOT, 'scripts/audit-protocol-stages.mjs')).href
  )) as { evaluateProtocolStages: ProtocolContractModules['evaluateStages'] }
  const sourceModule = (await import(
    pathToFileURL(resolve(ROOT, 'scripts/production-typescript-source.mjs')).href
  )) as {
    productionTypeScriptFileDigest: ProtocolContractModules['fileDigest']
  }
  const manifestModule = (await import(STAGE_MANIFEST_URL)) as {
    PROTOCOL_STAGE_SWITCHES: ProtocolContractModules['stageManifest']
  }
  modules = {
    containsCompilerState: bundleModule.productionProtocolFactBundleContainsCompilerState,
    evaluate: auditModule.evaluateProtocolContractBundle,
    evaluateStages: stageModule.evaluateProtocolStages,
    fileDigest: sourceModule.productionTypeScriptFileDigest,
    stageManifest: manifestModule.PROTOCOL_STAGE_SWITCHES,
  }
  bundle = await loadProtocolContractFactBundle<ProtocolContractBundle>()
  mutationProof = await loadProtocolContractMutationProof<ProtocolContractMutationProof>()
  report = modules.evaluate(bundle)
}, 10_000)

describe('production protocol fact bundle', () => {
  it('keys generator facts to the exact reachable module closure and toolchain inputs', () => {
    const root = protocolFingerprintFixture()
    try {
      const baseline = protocolContractGeneratorDigest(root)
      writeFixtureFile(root, 'scripts/unrelated.mjs', 'export const unrelated = 2\n')
      writeFixtureFile(root, 'scripts/new-unrelated.mjs', 'export const other = 1\n')
      expect(protocolContractGeneratorDigest(root)).toBe(baseline)

      writeFixtureFile(root, 'scripts/generator.mjs', 'export const generated = 2\n')
      const reachableChange = protocolContractGeneratorDigest(root)
      expect(reachableChange).not.toBe(baseline)

      writeFixtureFile(root, 'tsconfig.json', '{"compilerOptions":{"strict":true}}\n')
      expect(protocolContractGeneratorDigest(root)).not.toBe(reachableChange)

      writeFixtureFile(
        root,
        'scripts/production-protocol-fact-bundle.mjs',
        "const target = './generator.mjs'\nvoid import(target)\n",
      )
      expect(() => protocolContractGeneratorDigest(root)).toThrow(
        'ProtocolContractGeneratorGraphInvalid:scripts/production-protocol-fact-bundle.mjs:2:opaque-module-reference:import()',
      )

      writeFixtureFile(
        root,
        'scripts/production-protocol-fact-bundle.mjs',
        "import './missing.mjs'\n",
      )
      expect(() => protocolContractGeneratorDigest(root)).toThrow(
        'unresolved-local-module:./missing.mjs',
      )

      writeFixtureFile(
        root,
        'scripts/production-protocol-fact-bundle.mjs',
        "import '../../outside.mjs'\n",
      )
      expect(() => protocolContractGeneratorDigest(root)).toThrow(
        'module-reference-outside-root:../../outside.mjs',
      )

      writeFixtureFile(root, 'scripts/production-protocol-fact-bundle.mjs', 'export const = 1\n')
      expect(() => protocolContractGeneratorDigest(root)).toThrow('parse-error')
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it('builds one source snapshot and keeps all six protocol views relationally identical', () => {
    expect(mutationProof.construction).toEqual({ programCreations: 1, unionDiscoveries: 1 })
    expect(report.ok).toBe(true)
    expect(report).toMatchObject({
      schemaVersion: 1,
      structurallyValid: true,
      inventoryComplete: true,
      manifestFresh: true,
      guaranteeClosed: false,
      runtimeProved: null,
    })
    expect(report.gaps).toHaveLength(2)
    expect(report.snapshot).toEqual(bundle.snapshot)
    expect(bundle.snapshot.digest).toBe(modules.fileDigest(ROOT))
    expect(
      isCurrentProtocolContractFactBundle(
        bundle,
        bundle.snapshot.digest,
        bundle.snapshot.generatorDigest,
      ),
    ).toBe(true)
    expect(
      isCurrentProtocolContractFactBundle(bundle, bundle.snapshot.digest, 'sha256:stale-generator'),
    ).toBe(false)
    expect(
      isCurrentProtocolContractMutationProof(
        mutationProof,
        bundle.snapshot.digest,
        bundle.snapshot.generatorDigest,
      ),
    ).toBe(true)
    const logicalReportIds = Object.values(PROTOCOL_CONTRACT_REPORT_IDS).sort()
    expect(Object.keys(report.reports).sort()).toEqual(logicalReportIds)
    expect(
      ARCHITECTURE_AUDIT_MECHANISMS.filter(
        (mechanism) => mechanism.stageId === 'protocol-contracts',
      )
        .map((mechanism) => mechanism.id)
        .sort(),
    ).toEqual(logicalReportIds)
    const sourceFactsByOwner = {
      [PROTOCOL_CONTRACT_REPORT_IDS.production]: bundle.production,
      [PROTOCOL_CONTRACT_REPORT_IDS.stages]: bundle.stages,
      [PROTOCOL_CONTRACT_REPORT_IDS.configuration]: bundle.configuration,
      [PROTOCOL_CONTRACT_REPORT_IDS.durable]: bundle.durable,
      [PROTOCOL_CONTRACT_REPORT_IDS.locality]: bundle.locality,
    }
    expect(bundle.auditCapabilities.map((capability) => capability.ownerId).sort()).toEqual(
      Object.keys(sourceFactsByOwner).sort(),
    )
    for (const capability of bundle.auditCapabilities) {
      expect(capability.roots).toEqual(
        sourceFactsByOwner[capability.ownerId as keyof typeof sourceFactsByOwner]
          .auditedUnionSubjects,
      )
    }
    expect(bundle.auditCapabilities.flatMap((capability) => capability.roots)).toHaveLength(24)
    expect(
      new Set(
        bundle.auditCapabilities.flatMap((capability) => capability.roots.map((root) => root.id)),
      ).size,
    ).toBe(17)
    expect(bundle.production.protocols.WorkspaceCommand.variants).toEqual(
      bundle.stages.variants.command,
    )
    const discoveredWorkspaceQuery = discoveredUnion(
      bundle,
      'src/store/workspace-protocol.ts#WorkspaceQuery|kind',
    )
    const discoveredWorkspaceCommand = discoveredUnion(
      bundle,
      'src/store/workspace-protocol.ts#WorkspaceCommand|kind',
    )
    const discoveredConfigurationCommand = discoveredUnion(
      bundle,
      'src/store/configuration-domain-contract.ts#ConfigurationDomainCommandUnion|kind',
    )
    expect(discoveredWorkspaceQuery.variants).toEqual(
      bundle.production.protocols.WorkspaceQuery.variants,
    )
    expect(discoveredWorkspaceCommand.variants).toEqual(
      bundle.production.protocols.WorkspaceCommand.variants,
    )
    expect(discoveredConfigurationCommand.variants).toEqual(
      bundle.configuration.commandUnion.variants,
    )
    expect(siteIds(discoveredWorkspaceQuery.constructorSites)).toEqual(
      siteIds(bundle.production.protocols.WorkspaceQuery.constructorSites),
    )
    expect(siteIds(discoveredWorkspaceCommand.constructorSites)).toEqual(
      siteIds(bundle.production.protocols.WorkspaceCommand.constructorSites),
    )
    expect(siteIds(discoveredConfigurationCommand.constructorSites)).toEqual(
      siteIds(bundle.configuration.commandUnion.constructorSites),
    )
    expect(bundle.production.protocols.WorkspaceCommand.variants).toEqual(
      bundle.durable.workspaceUnion.variants,
    )
    expect(bundle.production.protocols.WorkspaceQuery.variants).toEqual(
      bundle.stages.variants.query,
    )
    expect(bundle.configuration.commandUnion.variants).toEqual(
      bundle.durable.configurationUnion.variants,
    )
    expect(siteIds(bundle.production.protocols.WorkspaceCommand.constructorSites)).toEqual(
      siteIds(bundle.durable.workspaceUnion.constructorSites),
    )
    expect(siteIds(bundle.configuration.commandUnion.constructorSites)).toEqual(
      siteIds(bundle.durable.configurationUnion.constructorSites),
    )
    const localityWorkspaceQuery = localitySurface(bundle, 'workspace-query')
    const localityWorkspaceCommand = localitySurface(bundle, 'workspace-command')
    const localityConfigurationCommand = localitySurface(bundle, 'configuration-command')
    expect(localityWorkspaceQuery.variants).toEqual(
      bundle.production.protocols.WorkspaceQuery.variants,
    )
    expect(localityWorkspaceCommand.variants).toEqual(
      bundle.production.protocols.WorkspaceCommand.variants,
    )
    expect(localityConfigurationCommand.variants).toEqual(
      bundle.configuration.commandUnion.variants,
    )
    expect(siteIds(localityWorkspaceQuery.constructorSites)).toEqual(
      siteIds(bundle.production.protocols.WorkspaceQuery.constructorSites),
    )
    expect(siteIds(localityWorkspaceCommand.constructorSites)).toEqual(
      siteIds(bundle.production.protocols.WorkspaceCommand.constructorSites),
    )
    expect(siteIds(localityConfigurationCommand.constructorSites)).toEqual(
      siteIds(bundle.configuration.commandUnion.constructorSites),
    )
    expect(bundle.locality.configurationUnion.variants).toEqual(
      bundle.configuration.commandUnion.variants,
    )
    expect(siteIds(bundle.locality.configurationUnion.constructorSites)).toEqual(
      siteIds(bundle.configuration.commandUnion.constructorSites),
    )
    expect(bundle.snapshot.sourceFiles).toBe(485)
    expect(report.reports['tab-cross-tab-locality']).toMatchObject({
      ok: true,
      surfaces: 20,
      records: 345,
      constructorSites: 767,
      architectureGaps: 3,
      recordGaps: 150,
      siteGaps: 4,
      problems: [],
    })
    expect(report.reports['production-discriminated-unions']).toMatchObject({
      ok: true,
      discoveredCount: 472,
      controlProtocolCount: 221,
      gapCount: 179,
      constructionGapCount: 10,
      violations: [],
    })
  })

  it('retains only deeply immutable data and can cross a structured-clone boundary', () => {
    expect(modules.containsCompilerState(bundle)).toBe(false)
    expect(() => structuredClone(bundle)).not.toThrow()
    expect(() => assertDeeplyFrozen(bundle)).not.toThrow()
    const jsonRoundTrip = JSON.parse(JSON.stringify(bundle)) as ProtocolContractBundle
    expect(modules.evaluate(jsonRoundTrip)).toEqual(report)
  })

  it('keeps known gaps fatal in enforcement mode without laundering structural validity', () => {
    const enforced = modules.evaluate(bundle, { mode: 'enforce' })

    expect(enforced).toMatchObject({
      ok: false,
      structurallyValid: true,
      inventoryComplete: true,
      manifestFresh: true,
      guaranteeClosed: false,
      runtimeProved: null,
    })
    expect(enforced.gaps).toHaveLength(2)
    expect(enforced.reports['production-discriminated-unions'].ok).toBe(false)
    expect(enforced.reports['production-protocol'].ok).toBe(true)
    expect(enforced.reports['protocol-stage-coverage'].ok).toBe(true)
    expect(enforced.reports['configuration-protocol'].ok).toBe(true)
    expect(enforced.reports['durable-command-pipeline'].ok).toBe(true)
    expect(enforced.reports['tab-cross-tab-locality'].ok).toBe(false)
  })

  it('rejects omitted, stale, incomplete, and handwritten protocol-stage coverage', () => {
    const [firstManifest, ...remainingManifest] = modules.stageManifest
    const unclassifiedSwitch = bundle.stages.switches.find(
      (entry) => entry.id === firstManifest?.id,
    )
    const incompleteSwitch = bundle.stages.switches.find(
      (entry) => entry.id !== firstManifest?.id && entry.kinds.length > 1,
    )
    if (!firstManifest || !unclassifiedSwitch || !incompleteSwitch) {
      throw new Error('ProtocolStageMutationFixtureMissing')
    }
    const changedFacts = {
      ...bundle.stages,
      switches: bundle.stages.switches.map((entry) =>
        entry.id === incompleteSwitch.id ? { ...entry, kinds: entry.kinds.slice(1) } : entry,
      ),
    }
    const changedManifest = [
      ...remainingManifest,
      { ...firstManifest, id: 'src/injected.ts#stale|command|1', coverage: 'all' },
    ]

    const changed = modules.evaluateStages(changedManifest, changedFacts)

    expect(changed.ok).toBe(false)
    expect(changed.problems).toEqual(
      expect.arrayContaining([
        `unclassified protocol stage switch: ${unclassifiedSwitch.id}`,
        'stale protocol stage switch: src/injected.ts#stale|command|1',
        expect.stringContaining('variant coverage must be source-derived'),
        expect.stringContaining('typed input variant has no case'),
      ]),
    )
  })

  it('rejects every remaining protocol-stage manifest and typed-switch drift class', () => {
    const firstManifest = modules.stageManifest[0]
    const firstSwitch = bundle.stages.switches.find((entry) => entry.id === firstManifest?.id)
    if (!firstManifest || !firstSwitch || firstSwitch.kinds.length === 0) {
      throw new Error('ProtocolStageDriftFixtureMissing')
    }
    const oppositeSubject = firstManifest.subject === 'command' ? 'query' : 'command'
    const missingReason = Object.fromEntries(
      Object.entries(firstManifest).filter(([key]) => key !== 'reason'),
    ) as Partial<ProtocolStageManifestEntry>
    const rootSubject = firstSwitch.subject
    const rootKind = bundle.stages.variants[rootSubject][0]
    if (!rootKind) throw new Error('ProtocolStageRootKindFixtureMissing')
    const incompleteRootFacts = {
      ...bundle.stages,
      switches: bundle.stages.switches.map((entry) =>
        entry.subject === rootSubject
          ? { ...entry, staticKinds: entry.staticKinds.filter((kind) => kind !== rootKind) }
          : entry,
      ),
    }
    const cases = [
      {
        report: modules.evaluateStages(
          modules.stageManifest.map((entry) =>
            entry.id === firstManifest.id ? { ...entry, subject: oppositeSubject } : entry,
          ),
          bundle.stages,
        ),
        expected: `${firstManifest.id}: expected subject ${oppositeSubject}, found ${firstManifest.subject}`,
      },
      {
        report: modules.evaluateStages(modules.stageManifest, {
          ...bundle.stages,
          switches: bundle.stages.switches.map((entry) =>
            entry.id === firstSwitch.id
              ? { ...entry, kinds: [...entry.kinds, 'audit.unknown-kind'] }
              : entry,
          ),
        }),
        expected: `${firstSwitch.id}: unknown ${firstSwitch.subject} variant audit.unknown-kind`,
      },
      {
        report: modules.evaluateStages(modules.stageManifest, {
          ...bundle.stages,
          switches: bundle.stages.switches.map((entry) =>
            entry.id === firstSwitch.id
              ? { ...entry, staticKinds: [...entry.staticKinds, 'audit.unknown-static-kind'] }
              : entry,
          ),
        }),
        expected: `${firstSwitch.id}: static input has unknown ${firstSwitch.subject} variant audit.unknown-static-kind`,
      },
      {
        report: modules.evaluateStages(modules.stageManifest, incompleteRootFacts),
        expected: `${rootSubject}: no root-complete protocol stage is declared`,
      },
      {
        report: modules.evaluateStages(
          [missingReason, ...modules.stageManifest.slice(1)] as ProtocolStageManifestEntry[],
          bundle.stages,
        ),
        expected: `${firstManifest.id}: missing reason`,
      },
      {
        report: modules.evaluateStages([...modules.stageManifest, firstManifest], bundle.stages),
        expected: `manifest switch duplicated: ${firstManifest.id}`,
      },
      {
        report: modules.evaluateStages(modules.stageManifest, {
          ...bundle.stages,
          switches: [...bundle.stages.switches, firstSwitch],
        }),
        expected: `discovered switch duplicated: ${firstSwitch.id}`,
      },
    ]

    for (const scenario of cases) {
      expect(scenario.report.ok).toBe(false)
      expect(scenario.report.problems).toContain(scenario.expected)
    }
  })

  it('does not reuse a previous same-process snapshot after source facts change', () => {
    const originalAgain = modules.evaluate(bundle)

    expect(mutationProof.changedSnapshot.digest).not.toBe(bundle.snapshot.digest)
    expect(mutationProof.changedFacts.workspaceCommandVariants).toContain(
      'audit.injected-workspace-command',
    )
    expect(mutationProof.changedFacts.configurationCommandVariants).toContain(
      'audit.injected-configuration-command',
    )
    expect(mutationProof.changedReport.ok).toBe(false)
    expect(
      mutationProof.changedFacts.unionEntries.find(
        (entry) => entry.id === 'src/store/workspace-protocol.ts#WorkspaceCommand|kind',
      )?.variants,
    ).toContain('audit.injected-workspace-command')
    expect(
      mutationProof.changedFacts.unionEntries.find(
        (entry) =>
          entry.id ===
          'src/store/configuration-domain-contract.ts#ConfigurationDomainCommandUnion|kind',
      )?.variants,
    ).toContain('audit.injected-configuration-command')
    expect(mutationProof.changedReport.productionProblems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('WorkspaceCommand.audit.injected-workspace-command'),
      ]),
    )
    expect(mutationProof.changedReport.stageProblems).toEqual(
      expect.arrayContaining([expect.stringContaining('typed input variant has no case')]),
    )
    expect(mutationProof.changedReport.configurationProblems).toEqual(
      expect.arrayContaining([expect.stringContaining('audit.injected-configuration-command')]),
    )
    expect(mutationProof.changedReport.durableProblems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('audit.injected-workspace-command'),
        expect.stringContaining('audit.injected-configuration-command'),
      ]),
    )
    expect(mutationProof.changedReport.localityProblems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('audit.injected-workspace-command'),
        expect.stringContaining('audit.injected-configuration-command'),
      ]),
    )
    expect(originalAgain).toEqual(report)
  })

  it('rejects forged and semantically mismatched capability issuance in source', () => {
    expect(mutationProof.changedReport.productionProblems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('fixed-root capability has the wrong idle-admission policy'),
        expect.stringContaining('root admission capability forged outside its issuance owner'),
        expect.stringContaining('unregistered root admission capability invoked'),
      ]),
    )
  })
})

function assertDeeplyFrozen(root: unknown): void {
  const pending: { readonly path: string; readonly value: unknown }[] = [
    { path: 'bundle', value: root },
  ]
  const seen = new Set<object>()
  while (pending.length > 0) {
    const current = pending.pop()
    if (!current || current.value === null || typeof current.value !== 'object') continue
    if (seen.has(current.value)) continue
    seen.add(current.value)
    if (!Object.isFrozen(current.value)) {
      throw new Error(`ProtocolFactNotFrozen:${current.path}`)
    }
    for (const key of Reflect.ownKeys(current.value)) {
      if (Array.isArray(current.value) && key === 'length') continue
      if (typeof key !== 'string') throw new Error(`ProtocolFactSymbolKey:${current.path}`)
      const descriptor = Object.getOwnPropertyDescriptor(current.value, key)
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        throw new Error(`ProtocolFactDescriptorInvalid:${current.path}.${key}`)
      }
      pending.push({ path: `${current.path}.${key}`, value: descriptor.value })
    }
  }
}

function siteIds(sites: readonly { readonly id: string }[]): readonly string[] {
  return sites.map((site) => site.id).sort()
}

function protocolFingerprintFixture(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'natter-protocol-fingerprint-'))
  const files = {
    '.node-version': '26\n',
    'node_modules/typescript/package.json': '{"version":"7.0.2"}\n',
    'package.json': '{"name":"fixture"}\n',
    'pnpm-lock.yaml': 'lockfileVersion: 9\n',
    'scripts/audit-protocol-contracts.mjs':
      "import './production-protocol-fact-bundle.mjs'\nexport const audit = 1\n",
    'scripts/generator.mjs': 'export const generated = 1\n',
    'scripts/production-protocol-fact-bundle.mjs': "import './generator.mjs'\n",
    'scripts/unrelated.mjs': 'export const unrelated = 1\n',
    'tsconfig.json': '{"compilerOptions":{}}\n',
  }
  for (const [path, source] of Object.entries(files)) writeFixtureFile(root, path, source)
  return root
}

function writeFixtureFile(root: string, path: string, source: string): void {
  const absolute = resolve(root, path)
  mkdirSync(resolve(absolute, '..'), { recursive: true })
  writeFileSync(absolute, source)
}

function localitySurface(bundle: ProtocolContractBundle, id: string) {
  const surface = bundle.locality.surfaceFacts.find((candidate) => candidate.id === id)
  if (!surface) throw new Error(`ProtocolLocalitySurfaceMissing:${id}`)
  return surface
}

function discoveredUnion(bundle: ProtocolContractBundle, id: string) {
  const union = bundle.unionDiscovery.unions.find((candidate) => candidate.id === id)
  if (!union) throw new Error(`ProtocolUnionMissing:${id}`)
  return union
}
