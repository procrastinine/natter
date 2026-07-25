import { beforeAll, describe, expect, it } from 'vitest'
import {
  auditInteractionCapabilities,
  type InteractionCapabilityAuditResult,
} from '../../scripts/audit-interaction-capabilities.mjs'
import {
  buildInteractionCapabilityInventory,
  type InteractionCapabilityInventory,
  type InteractionCapabilitySite,
  type InteractionOutcomeGraph,
  inspectInteractionCallbackGraphFixtures,
  inspectInteractionGraphAlgorithmFixture,
  inspectPresentationRunFixtures,
  inspectTotalPromiseConstructionBoundaryFixtures,
  interactionOutcomeGraphDigest,
  inventoryInteractionSitesInSource,
} from '../../scripts/interaction-capability-inventory.mjs'

let cachedInventoryResult: ReturnType<typeof runAudit> | undefined

describe('production interaction capability audit', () => {
  beforeAll(() => {
    cachedInventoryResult = runAudit('inventory')
  }, 60_000)

  it('closes one reviewed classification disposition over the exact source baseline', () => {
    const result = inventoryResult()
    const { counts, inventory } = result.report

    expect(result.status).toBe(0)
    expect(result.report).toMatchObject({
      ok: true,
      structurallyValid: true,
      classificationClosed: true,
      behavioralOutcomesClosed: false,
      counts: {
        reviewedClassifications: counts.sites,
        derivedClassifications: 0,
        inheritedAggregateGateSites: 0,
        structuralFallbackIdentitySites: 0,
        classificationGapSites: 0,
        gapSites: 0,
      },
      classificationGapReasons: {},
      problems: [],
    })
    expect(counts.sites).toBe(inventory.reviewBaseline.exactSiteCount)
    expect(counts.sources).toBe(inventory.reviewBaseline.sourceCount)
    expect(inventory.sourceParity).toMatchObject({
      baseSiteCount: inventory.reviewBaseline.exactSiteCount,
      discoveredSiteCount: inventory.reviewBaseline.exactSiteCount,
      missingSourceMetadata: [],
      extraSourceMetadata: [],
      exactSiteIdSha256: inventory.reviewBaseline.exactSiteIdSha256,
      sourceFactSha256: inventory.reviewBaseline.sourceFactSha256,
      presentationDefinitionSha256: inventory.reviewBaseline.presentationDefinitionSha256,
    })

    const exactIds = new Set<string>()
    const usedRules = new Set<string>()
    const usedExceptions = new Set<string>()
    for (const site of inventory.sites) {
      expect(exactIds.has(site.id), site.id).toBe(false)
      exactIds.add(site.id)
      expect(site.reviewDisposition.exactLocator).toBe(site.id)
      expect(site.reviewDisposition.ruleIds).toHaveLength(1)
      const ruleId = site.reviewDisposition.ruleIds[0]
      expect(ruleId).toBeDefined()
      if (ruleId === undefined) throw new Error(`InteractionCapabilityRuleMissing:${site.id}`)
      usedRules.add(ruleId)
      if (site.reviewDisposition.exceptionId) usedExceptions.add(site.reviewDisposition.exceptionId)
      expect(['reviewed-rule', 'reviewed-exception']).toContain(site.classificationDisposition)
      expect(site.semanticIdentity.value).not.toBe('')
      expect(site.architecturalCluster).not.toBe('unclassified')
      expect(site.scope).not.toBe('unknown')
      expect(site.effects).not.toContain('unknown')
      expect(site.requiredCapabilities).not.toContain('unknown')
      expect(site.classificationGaps).toEqual([])
      expect(site.gates.inherited).toEqual([])
    }
    expect(exactIds.size).toBe(counts.sites)
    expect(usedRules).toEqual(new Set(inventory.classificationRules.map((rule) => rule.id)))
    expect(usedExceptions).toEqual(
      new Set(inventory.classificationExceptions.map((exception) => exception.id)),
    )
  })

  it('separates local presentation, projection reads, durable commands, and browser effects', () => {
    const { inventory } = inventoryResult().report
    const newChat = requireSite(
      inventory,
      (site) => site.semanticIdentity.value === 'new-chat.onClick',
    )
    const send = requireSite(inventory, (site) =>
      site.source.calledSymbols.includes('conversationActions.sendNewChatWhenCapabilitySettles'),
    )
    const branchNewTab = requireSite(
      inventory,
      (site) =>
        site.path === 'src/ui/chat/BranchControls.tsx' &&
        site.event === 'onKeyDown' &&
        site.element === 'input',
    )
    const localInsertIntent = requireSite(
      inventory,
      (site) => site.reviewDisposition.exceptionId === 'message-list-open-insert',
    )
    const privacyWrite = requireSite(
      inventory,
      (site) =>
        site.path === 'src/ui/settings/PrivacySection.tsx' &&
        site.source.calledSymbols.includes('configurationApplication.patchChatSettings'),
    )
    const recoveryCopy = requireSite(
      inventory,
      (site) =>
        site.path === 'src/app/WorkspaceBootstrap.tsx' &&
        site.source.calledSymbols.includes('navigator.clipboard.writeText'),
    )

    expect(newChat).toMatchObject({
      scope: 'tab-local',
      gates: { inherited: [] },
    })
    expect(newChat.effects).toEqual(expect.arrayContaining(['navigation', 'visual']))
    expect(newChat.requiredCapabilities).toEqual(
      expect.arrayContaining(['tab-navigation', 'tab-presentation']),
    )
    expect(newChat.requiredCapabilities).not.toContain('durable-write')

    expect(send).toMatchObject({
      scope: 'mixed-tab-and-durable',
    })
    expect(send.requiredCapabilities).toEqual(
      expect.arrayContaining(['durable-write', 'generation-attempt']),
    )
    expect(branchNewTab).toMatchObject({
      scope: 'browser-external',
      effects: ['browser-io', 'navigation', 'query', 'visual'],
    })
    expect(branchNewTab.requiredCapabilities).toEqual(
      expect.arrayContaining([
        'browser-io',
        'conversation-projection',
        'repository-read',
        'tab-navigation',
      ]),
    )
    expect(branchNewTab.requiredCapabilities).not.toContain('durable-write')
    expect(localInsertIntent).toMatchObject({
      classificationDisposition: 'reviewed-exception',
      scope: 'tab-local',
      effects: ['visual'],
      requiredCapabilities: ['tab-presentation'],
      errorOwnership: { reviewDisposition: 'reviewed-static-owner' },
    })
    expect(privacyWrite).toMatchObject({
      scope: 'mixed-tab-and-durable',
    })
    expect(privacyWrite.requiredCapabilities).toEqual(
      expect.arrayContaining(['configuration-projection', 'durable-write']),
    )
    expect(recoveryCopy).toMatchObject({
      scope: 'browser-external',
      effects: ['browser-io', 'visual'],
    })
    expect(recoveryCopy.requiredCapabilities).toEqual(
      expect.arrayContaining(['bootstrap-control', 'browser-io', 'tab-presentation']),
    )
  })

  it('makes scanner limits, closure criteria, global-gate prohibition, and local gates explicit', () => {
    const { counts, inventory } = inventoryResult().report

    expect(inventory.scannerLimitations.map((entry) => entry.id)).toEqual([
      'recognized-source-scope',
      'bounded-local-resolution',
      'static-effect-inference',
      'gate-visibility',
      'async-return-visibility',
      'behavioral-outcome-separation',
    ])
    expect(inventory.classificationClosureCriteria.map((entry) => entry.id)).toEqual([
      'exact-source-baseline',
      'one-disposition-per-site',
      'complete-facets',
      'global-gate-separated',
      'outcomes-remain-separate',
    ])
    expect(inventory.taxonomies.knownGates).toEqual([])
    expect(inventory.taxonomies.forbiddenGates).toEqual([
      expect.objectContaining({
        id: 'aggregate-workspace-running-shell-inert',
        kind: 'forbidden-inherited-global',
        expectedOccurrences: 0,
      }),
    ])
    expect(counts.inheritedAggregateGateSites).toBe(0)
    expect(counts.localGateSites).toBeGreaterThan(0)
    const locallyGated = requireSite(inventory, (site) => site.gates.local.length > 0)
    expect(locallyGated.gates.inherited).toEqual([])
    expect(locallyGated.requiredCapabilities).toContain('tab-presentation')
  })

  it('keeps behavioral outcomes and unresolved async ownership as separate non-proof queues', () => {
    const inventoryMode = inventoryResult()
    const enforced = runAudit('enforce', inventoryMode.report.inventory)
    const { counts, inventory } = inventoryMode.report

    const exactSites = inventory.sites.filter(
      (site) => site.outcomeEvidence.status === 'claimed-exact-proof',
    )
    const gapSites = inventory.sites.filter((site) => site.outcomeEvidence.status === 'gap')
    const lifecycleSites = inventory.sites.filter(
      (site) => site.lifecycleEvidence.status === 'claimed-source-contract',
    )

    expect(inventoryMode.report.classificationClosed).toBe(true)
    expect(inventoryMode.report.behavioralOutcomesClosed).toBe(false)
    expect(exactSites).toHaveLength(counts.exactOutcomeProofSites)
    expect(gapSites).toHaveLength(counts.behavioralOutcomeGapSites)
    expect(exactSites.length + gapSites.length).toBe(counts.sites)
    expect(lifecycleSites).toHaveLength(counts.sourceContractLifecycleSites)
    expect(new Set(inventory.behavioralOutcomeQueue.map((entry) => entry.siteId))).toEqual(
      new Set(gapSites.map((site) => site.id)),
    )
    expect(inventory.architectureGapQueue).toHaveLength(counts.unresolvedAsyncErrorOwnerSites)
    expect(inventoryMode.report.architectureGapReasons).toEqual({
      'async-error-owner-not-proven': counts.unresolvedAsyncErrorOwnerSites,
    })
    expect(
      gapSites.every(
        (site) => site.outcomeEvidence.proofs.length === 0 && site.outcomeGaps.length > 0,
      ),
    ).toBe(true)
    for (const site of exactSites) {
      expect(site.outcomeEvidence.proofs).toHaveLength(1)
      const proof = site.outcomeEvidence.proofs[0]
      const graphOutcome = inventory.outcomeGraph.outcomes.find(
        (candidate) => candidate.siteId === site.id,
      )
      expect(proof).toEqual({
        id: `generated-outcome:${site.id}`,
        contractId: graphOutcome?.contractId,
        terminalRootIds: graphOutcome?.terminalRootIds,
        carrierRootIds: graphOutcome?.carrierRootIds,
        settlementRootIds: graphOutcome?.settlementRootIds,
        deliveryPath: graphOutcome?.deliveryPath,
        graphDigest: inventory.outcomeGraph.digest,
      })
    }

    expect(enforced.status).toBe(1)
    expect(enforced.report).toMatchObject({
      ok: false,
      structurallyValid: true,
      classificationClosed: true,
      behavioralOutcomesClosed: false,
      problems: [],
    })
  })

  it('rejects classification drift, missing exact sites, invented proof, and a resurrected global gate', () => {
    const inventory = structuredClone(
      inventoryResult().report.inventory,
    ) as Mutable<InteractionCapabilityInventory>
    const sourceContractSite = inventory.sites.find(
      (site) => site.lifecycleEvidence.status === 'claimed-source-contract',
    )
    if (!sourceContractSite) throw new Error('ExpectedInteractionSourceContractMissing')
    const exactSite = inventory.sites.find(
      (site) => site.outcomeEvidence.status === 'claimed-exact-proof',
    )
    const exactProof = exactSite?.outcomeEvidence.proofs[0]
    if (!exactSite || !exactProof) throw new Error('ExpectedExactInteractionOutcomeProofMissing')
    const firstSite = requireIndex(inventory.sites, 0, 'ExpectedFirstInteractionSiteMissing')
    const thirdSite = requireIndex(inventory.sites, 2, 'ExpectedThirdInteractionSiteMissing')
    firstSite.reviewDisposition.ruleIds = []
    exactProof.id = 'invented-outcome-proof'
    thirdSite.gates.inherited.push('aggregate-workspace-running-shell-inert')
    inventory.sourceParity.sourceFactSha256 = 'invented'
    sourceContractSite.lifecycleEvidence.status = 'none'
    inventory.sites.pop()
    const result = runAudit('inventory', inventory)

    expect(result.status).toBe(1)
    expect(result.report.problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('recorded rule does not match source rule'),
        expect.stringContaining('generated exact proof does not match its callback graph outcome'),
        expect.stringContaining('inherited forbidden Shell gate'),
        expect.stringContaining('total ownership and lifecycle status diverge'),
        expect.stringContaining('recorded='),
        'source-parity: source-fact digest=invented; reviewed=' +
          result.report.inventory.reviewBaseline.sourceFactSha256,
      ]),
    )
  })

  it('derives the total presentation contract, aliases, effects, and configuration demand links from source', () => {
    const { counts, inventory } = inventoryResult().report
    const contract = inventory.sourceContracts

    expect(contract).toMatchObject({
      contractId: 'presentation-total-v1',
      problems: [],
    })
    expect(new Set(contract.definitions.map((entry) => entry.id)).size).toBe(
      contract.definitions.length,
    )
    expect(new Set(contract.definitions.map((entry) => entry.capabilityId)).size).toBe(
      contract.definitions.length,
    )
    expect(new Set(contract.definitions.map((entry) => entry.lifetime))).toEqual(
      new Set(['presenter', 'workspace-tab']),
    )
    expect(contract.definitions).toContainEqual(
      expect.objectContaining({
        capabilityId: 'conversation.mutate',
        lifetime: 'workspace-tab',
      }),
    )
    const capabilityIds = new Set(contract.definitions.map((entry) => entry.capabilityId))
    const hookIds = new Set(contract.hooks.map((entry) => entry.id))
    const invocationIds = new Set(contract.invocations.map((entry) => entry.id))
    const siteIds = new Set(inventory.sites.map((site) => site.id))
    for (const hook of contract.hooks) {
      expect(hook.capabilityIds.every((id) => capabilityIds.has(id))).toBe(true)
      expect(hook.invocationIds.every((id) => invocationIds.has(id))).toBe(true)
    }
    for (const alias of contract.aliases) {
      expect(alias.capabilityIds.every((id) => capabilityIds.has(id))).toBe(true)
      expect(alias.hookIds.every((id) => hookIds.has(id))).toBe(true)
      expect(alias.invocationIds.every((id) => invocationIds.has(id))).toBe(true)
    }
    for (const invocation of contract.invocations) {
      expect(invocation.capabilityIds.every((id) => capabilityIds.has(id))).toBe(true)
      expect(invocation.hookIds.every((id) => hookIds.has(id))).toBe(true)
      expect(invocation.siteIds.every((id) => siteIds.has(id))).toBe(true)
    }
    expect(contract.invocations.filter((entry) => entry.surface === 'react-effect')).toHaveLength(1)
    expect(contract.invocations.filter((entry) => entry.surface === 'unowned-non-gesture')).toEqual(
      [],
    )
    const linkedInteractionSites = new Set(contract.invocations.flatMap((entry) => entry.siteIds))
    expect(
      inventory.sites
        .filter((site) => site.lifecycleEvidence.status === 'claimed-source-contract')
        .every((site) => linkedInteractionSites.has(site.id)),
    ).toBe(true)
    expect(
      new Set(contract.configurationDemands.map((entry) => `${entry.id}:${entry.property}`)).size,
    ).toBe(contract.configurationDemands.length)
    expect(
      contract.configurationDemands.every((entry) => entry.siteIds.every((id) => siteIds.has(id))),
    ).toBe(true)
    expect(counts.sourceContractLifecycleSites).toBeGreaterThan(0)
    expect(contract.directStarts).toHaveLength(1)
    expect(contract.directControllerStarts).toHaveLength(1)
  })

  it('rejects invalid or semantically swapped presentation lifetimes from derived source facts', () => {
    const invalid = structuredClone(
      inventoryResult().report.inventory,
    ) as Mutable<InteractionCapabilityInventory>
    const invalidDefinition = requireIndex(
      invalid.sourceContracts.definitions,
      0,
      'ExpectedInteractionDefinitionMissing',
    )
    invalidDefinition.lifetime = 'invalid' as never

    const invalidResult = runAudit('inventory', invalid)

    expect(invalidResult.status).toBe(1)
    expect(invalidResult.report.problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('lifetime must be presenter or workspace-tab'),
        expect.stringContaining('recorded presentation-definition digest='),
      ]),
    )

    const swapped = structuredClone(
      inventoryResult().report.inventory,
    ) as Mutable<InteractionCapabilityInventory>
    const swappedDefinition = requireIndex(
      swapped.sourceContracts.definitions,
      0,
      'ExpectedInteractionDefinitionMissing',
    )
    swappedDefinition.lifetime =
      swappedDefinition.lifetime === 'presenter' ? 'workspace-tab' : 'presenter'

    const swappedResult = runAudit('inventory', swapped)

    expect(swappedResult.status).toBe(1)
    expect(swappedResult.report.problems).toEqual(
      expect.arrayContaining([expect.stringContaining('recorded presentation-definition digest=')]),
    )
  })

  it('rejects duplicate capabilities, broken alias parity, orphan runs, and downgraded total ownership', () => {
    const inventory = structuredClone(
      inventoryResult().report.inventory,
    ) as Mutable<InteractionCapabilityInventory>
    const claimed = inventory.sites.find(
      (site) => site.lifecycleEvidence.status === 'claimed-source-contract',
    )
    if (!claimed) throw new Error('ExpectedInteractionSourceContractMissing')
    const firstDefinition = requireIndex(
      inventory.sourceContracts.definitions,
      0,
      'ExpectedFirstInteractionDefinitionMissing',
    )
    const secondDefinition = requireIndex(
      inventory.sourceContracts.definitions,
      1,
      'ExpectedSecondInteractionDefinitionMissing',
    )
    const firstAlias = requireIndex(
      inventory.sourceContracts.aliases,
      0,
      'ExpectedFirstInteractionAliasMissing',
    )
    secondDefinition.capabilityId = firstDefinition.capabilityId
    firstAlias.invocationIds = []
    const effect = inventory.sourceContracts.invocations.find(
      (invocation) => invocation.surface === 'react-effect',
    )
    if (!effect) throw new Error('ExpectedPresentationEffectInvocationMissing')
    effect.backgroundOwner = null
    effect.surface = 'unowned-non-gesture'
    claimed.source.presentationInteraction.totalOwnership = false

    const result = runAudit('inventory', inventory)

    expect(result.status).toBe(1)
    expect(result.report.problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('missing or duplicate capability id'),
        expect.stringContaining('reverse invocation ownership is missing'),
        expect.stringContaining('neither an exact gesture nor a proved effect owner'),
        expect.stringContaining('total ownership and lifecycle status diverge'),
      ]),
    )
  })

  it('fails closed on async, detached, opaque, duplicate, and invalid commit fixtures', () => {
    const results = inspectPresentationRunFixtures({
      'commit.ts': `
export async function importedAsync(): Promise<void> {}
`,
      'entry.ts': `
import { importedAsync as renamed } from './commit'
declare function run(input: { action: () => unknown; commit?: () => undefined }): void
const sync = (): undefined => undefined
const firstAlias = renamed
const secondAlias: () => undefined = firstAlias as never
function detached(): undefined {
  void renamed()
  return undefined
}
run({ action: sync, commit: sync })
run({ action: sync, commit: renamed })
run({ action: sync, commit: secondAlias })
run({ action: sync, commit: detached })
run({ ...{ action: sync }, commit: sync })
run({ action: sync, get commit() { return sync } })
run({ action: sync, commit: sync, commit: renamed })
run({ action: sync, commit: () => 1 })
`,
    }).map(({ line: _line, ...result }) => result)

    expect(results).toEqual([
      {
        actionResolved: true,
        asyncCommit: false,
        unresolvedCommit: false,
        opaqueSpread: false,
        duplicateInput: false,
      },
      {
        actionResolved: true,
        asyncCommit: true,
        unresolvedCommit: false,
        opaqueSpread: false,
        duplicateInput: false,
      },
      {
        actionResolved: true,
        asyncCommit: true,
        unresolvedCommit: false,
        opaqueSpread: false,
        duplicateInput: false,
      },
      {
        actionResolved: true,
        asyncCommit: true,
        unresolvedCommit: false,
        opaqueSpread: false,
        duplicateInput: false,
      },
      {
        actionResolved: false,
        asyncCommit: false,
        unresolvedCommit: false,
        opaqueSpread: true,
        duplicateInput: false,
      },
      {
        actionResolved: true,
        asyncCommit: false,
        unresolvedCommit: true,
        opaqueSpread: false,
        duplicateInput: false,
      },
      {
        actionResolved: true,
        asyncCommit: false,
        unresolvedCommit: true,
        opaqueSpread: false,
        duplicateInput: true,
      },
      {
        actionResolved: true,
        asyncCommit: false,
        unresolvedCommit: true,
        opaqueSpread: false,
        duplicateInput: false,
      },
    ])
  })

  it('derives callback delivery from invocation rather than callback mentions or conditional presence', () => {
    const graph = inspectInteractionCallbackGraphFixtures({
      'entry.tsx': `
type Callback = () => void
function Mention({ onSave }: { onSave: Callback }) {
  return <button data-role="mention" onClick={() => void onSave}>Mention</button>
}
function Conditional({ enabled, onSave }: { enabled: boolean; onSave: Callback }) {
  return <button data-role="conditional" onClick={enabled ? onSave : undefined}>Conditional</button>
}
function Alias({ onSave }: { onSave: Callback }) {
  const forwarded = onSave
  return <button data-role="alias" onClick={forwarded}>Alias</button>
}
export function Entry({ save }: { save: Callback }) {
  return <><Mention onSave={save} /><Conditional enabled onSave={save} /><Alias onSave={save} /></>
}
`,
    })

    expect(outcomeFor(graph, 'button', 'onClick', 'Mention').gapReasons).toContain(
      'outcome-settlement-missing',
    )
    expect(outcomeFor(graph, 'button', 'onClick', 'Conditional').gapReasons).toContain(
      'conditional-callback-delivery',
    )
    expect(outcomeFor(graph, 'button', 'onClick', 'Alias').gapReasons).toEqual([])
  })

  it('separates optional callback absence from present-branch settlement', () => {
    const graph = inspectInteractionCallbackGraphFixtures({
      'entry.tsx': `
type SyncAction = () => void
type AsyncAction = () => Promise<void>
const conversationActions = { mutate: async () => undefined }
function Observer({ onIntent }: { onIntent?: SyncAction }) {
  return <div onPointerEnter={onIntent}>Observe</div>
}
function AsyncObserver({ onIntent }: { onIntent?: AsyncAction }) {
  return <section onPointerEnter={onIntent}>Observe async</section>
}
function CommandPointer({ enabled }: { enabled: boolean }) {
  return <aside onPointerDown={enabled ? () => void conversationActions.mutate() : undefined}>Mutate</aside>
}
function Gated({ enabled, onAct }: { enabled: boolean; onAct: SyncAction }) {
  return <button disabled={!enabled} onClick={enabled ? onAct : undefined}>Gated</button>
}
function AsyncGated({ enabled, onAct }: { enabled: boolean; onAct: AsyncAction }) {
  return <input disabled={!enabled} onChange={enabled ? onAct : undefined} />
}
function Link({ enabled, onAct }: { enabled: boolean; onAct: SyncAction }) {
  return <a href={enabled ? '/next' : undefined} aria-disabled={!enabled || undefined} onClick={enabled ? onAct : undefined}>Link</a>
}
function Ungated({ enabled, onAct }: { enabled: boolean; onAct: SyncAction }) {
  return <span onClick={enabled ? onAct : undefined}>Ungated</span>
}
export function Entry({ sync, asyncAction }: { sync: SyncAction; asyncAction: AsyncAction }) {
  return <><Observer onIntent={sync} /><AsyncObserver onIntent={asyncAction} /><CommandPointer enabled /><Gated enabled onAct={sync} /><AsyncGated enabled onAct={asyncAction} /><Link enabled onAct={sync} /><Ungated enabled onAct={sync} /></>
}
`,
    })

    expect(outcomeFor(graph, 'div', 'onPointerEnter', 'Observer').gapReasons).toEqual([])
    expect(outcomeFor(graph, 'section', 'onPointerEnter', 'AsyncObserver').gapReasons).toEqual([
      'async-error-owner-not-proven',
      'outcome-settlement-missing',
    ])
    expect(outcomeFor(graph, 'aside', 'onPointerDown', 'CommandPointer').gapReasons).toContain(
      'conditional-callback-delivery',
    )
    expect(outcomeFor(graph, 'button', 'onClick', 'Gated').gapReasons).toEqual([])
    expect(outcomeFor(graph, 'input', 'onChange', 'AsyncGated').gapReasons).toEqual([
      'async-error-owner-not-proven',
      'outcome-settlement-missing',
    ])
    expect(outcomeFor(graph, 'a', 'onClick', 'Link').gapReasons).toEqual([])
    expect(outcomeFor(graph, 'span', 'onClick', 'Ungated').gapReasons).toContain(
      'conditional-callback-delivery',
    )
  })

  it('propagates higher-order callback settlement without accepting detached rejection', () => {
    const graph = inspectInteractionCallbackGraphFixtures({
      'entry.tsx': `
type AsyncAction = () => Promise<void>
async function settle(action: AsyncAction): Promise<void> {
  try { await action() } catch {}
}
function Catching({ onAct }: { onAct: AsyncAction }) {
  return <button onClick={() => void settle(() => onAct())}>Catching</button>
}
function Detached({ onAct }: { onAct: AsyncAction }) {
  const forward = (action: AsyncAction) => action()
  return <input onChange={() => void forward(() => onAct())} />
}
function DirectCatch({ onAct }: { onAct: AsyncAction }) {
  return <select onChange={async () => { try { await onAct() } catch {} }} />
}
function Rethrow({ onAct }: { onAct: AsyncAction }) {
  return <textarea onChange={async () => { try { await onAct() } catch (error) { throw error } }} />
}
function CatchChain({ onAct }: { onAct: AsyncAction }) {
  return <form onSubmit={() => { void onAct().catch(() => undefined) }} />
}
function ThenPair({ onAct }: { onAct: AsyncAction }) {
  return <details onToggle={() => { void onAct().then(() => undefined, () => undefined) }} />
}
function ThenOneSided({ onAct }: { onAct: AsyncAction }) {
  return <video onPlay={() => { void onAct().then(() => undefined) }} />
}
export function Entry({ act }: { act: AsyncAction }) {
  return <><Catching onAct={act} /><Detached onAct={act} /><DirectCatch onAct={act} /><Rethrow onAct={act} /><CatchChain onAct={act} /><ThenPair onAct={act} /><ThenOneSided onAct={act} /></>
}
`,
    })

    expect(outcomeFor(graph, 'button', 'onClick', 'Catching').gapReasons).toEqual([])
    expect(outcomeFor(graph, 'input', 'onChange', 'Detached').gapReasons).toContain(
      'async-error-owner-not-proven',
    )
    expect(outcomeFor(graph, 'select', 'onChange', 'DirectCatch').gapReasons).toEqual([])
    expect(outcomeFor(graph, 'textarea', 'onChange', 'Rethrow').gapReasons).toContain(
      'async-error-owner-not-proven',
    )
    expect(outcomeFor(graph, 'form', 'onSubmit', 'CatchChain').gapReasons).toEqual([])
    expect(outcomeFor(graph, 'details', 'onToggle', 'ThenPair').gapReasons).toEqual([])
    expect(outcomeFor(graph, 'video', 'onPlay', 'ThenOneSided').gapReasons).toContain(
      'async-error-owner-not-proven',
    )
  })

  it('accepts only nominal total settlements through aliases, unions, and overloads', () => {
    const graph = inspectInteractionCallbackGraphFixtures({
      'alias.ts': `
export type { TotalPresentationInteractionPromise as AliasTotal } from '../store/presentation-interaction-controller'
`,
      'entry.tsx': `
import type {
  PresentationInteractionOutcome,
  TotalPresentationInteractionPromise,
} from '../store/presentation-interaction-controller'
import type { AliasTotal } from './alias'

type Ordinary = Promise<PresentationInteractionOutcome<void>>
type MutableTotal = { -readonly [Key in keyof TotalPresentationInteractionPromise<void>]: TotalPresentationInteractionPromise<void>[Key] }
type OptionalTotal = Promise<PresentationInteractionOutcome<void>> & Partial<TotalPresentationInteractionPromise<void>>
declare const otherBrand: unique symbol
type DifferentBrand = Promise<PresentationInteractionOutcome<void>> & { readonly [otherBrand]: true }
interface SafeOverload {
  (): void
  (event: unknown): TotalPresentationInteractionPromise<void>
}
interface UnsafeOverload {
  (): TotalPresentationInteractionPromise<void>
  (event: unknown): Ordinary
}

declare const direct: () => TotalPresentationInteractionPromise<void>
declare const total: TotalPresentationInteractionPromise<void>
declare const aliased: AliasTotal<void>
declare const safeUnion: TotalPresentationInteractionPromise<void> | void
declare const unsafeUnion: TotalPresentationInteractionPromise<void> | Ordinary
declare const ordinary: Ordinary
declare const mutable: MutableTotal
declare const optional: OptionalTotal
declare const different: DifferentBrand
declare const safeOverload: SafeOverload
declare const unsafeOverload: UnsafeOverload

function Direct() { return <button onClick={direct}>Direct</button> }
function Returned() { return <input onChange={() => total} /> }
function Aliased() { return <select onChange={() => aliased} /> }
function SafeUnionHandler() { return <textarea onChange={() => safeUnion} /> }
function SafeOverloadHandler() { return <form onSubmit={safeOverload} /> }
function OrdinaryHandler() { return <details onToggle={() => ordinary} /> }
function UnsafeUnionHandler() { return <video onPlay={() => unsafeUnion} /> }
function UnsafeOverloadHandler() { return <audio onPlay={unsafeOverload} /> }
function MutableBrandHandler() { return <aside onClick={() => mutable}>Mutable</aside> }
function OptionalBrandHandler() { return <section onClick={() => optional}>Optional</section> }
function DifferentBrandHandler() { return <article onClick={() => different}>Different</article> }

export function Entry() {
  return <><Direct /><Returned /><Aliased /><SafeUnionHandler /><SafeOverloadHandler /><OrdinaryHandler /><UnsafeUnionHandler /><UnsafeOverloadHandler /><MutableBrandHandler /><OptionalBrandHandler /><DifferentBrandHandler /></>
}
`,
    })

    for (const [element, event, component] of [
      ['button', 'onClick', 'Direct'],
      ['input', 'onChange', 'Returned'],
      ['select', 'onChange', 'Aliased'],
      ['textarea', 'onChange', 'SafeUnionHandler'],
      ['form', 'onSubmit', 'SafeOverloadHandler'],
    ] as const) {
      expect(outcomeFor(graph, element, event, component).gapReasons).toEqual([])
    }
    const unsafeOutcomes = Object.fromEntries(
      (
        [
          ['details', 'onToggle', 'OrdinaryHandler'],
          ['video', 'onPlay', 'UnsafeUnionHandler'],
          ['audio', 'onPlay', 'UnsafeOverloadHandler'],
          ['aside', 'onClick', 'MutableBrandHandler'],
          ['section', 'onClick', 'OptionalBrandHandler'],
          ['article', 'onClick', 'DifferentBrandHandler'],
        ] as const
      ).map(([element, event, component]) => [
        component,
        outcomeFor(graph, element, event, component).gapReasons,
      ]),
    )
    expect(unsafeOutcomes).toEqual({
      OrdinaryHandler: ['async-error-owner-not-proven', 'outcome-settlement-missing'],
      UnsafeUnionHandler: ['async-error-owner-not-proven', 'outcome-settlement-missing'],
      UnsafeOverloadHandler: ['async-error-owner-not-proven', 'outcome-settlement-missing'],
      MutableBrandHandler: ['async-error-owner-not-proven', 'outcome-settlement-missing'],
      OptionalBrandHandler: ['async-error-owner-not-proven', 'outcome-settlement-missing'],
      DifferentBrandHandler: ['async-error-owner-not-proven', 'outcome-settlement-missing'],
    })
  })

  it('confines total-promise construction to the resolve-only controller boundary', () => {
    expect(inspectTotalPromiseConstructionBoundaryFixtures()).toEqual([])

    const problems = inspectTotalPromiseConstructionBoundaryFixtures({
      'consumer.ts': `
import type { TotalPresentationInteractionPromise } from '../store/presentation-interaction-controller'
const illegal = Promise.resolve(undefined as never) as TotalPresentationInteractionPromise<void>
void illegal
`,
    })

    expect(problems).toEqual(
      expect.arrayContaining([
        'total-promise-construction: sites=3; expected=2',
        expect.stringContaining('controller boundary required'),
      ]),
    )
  })

  it('keeps renamed carriers and ordered spreads exact and demand-driven', () => {
    const graph = inspectInteractionCallbackGraphFixtures({
      'entry.tsx': `
type Callback = () => void
function Child({ activate }: { activate: Callback }) {
  return <button data-role="renamed" onClick={activate}>Renamed</button>
}
function EntryRenamed({ onSave }: { onSave: Callback }) { return <Child activate={onSave} /> }
function Overridden(props: { onClick: Callback }) {
  const local = () => undefined
  return <button data-role="overridden" {...props} onClick={local}>Overridden</button>
}
function Forwarded(props: { onClick: Callback }) {
  const local = () => undefined
  return <button data-role="forwarded" onClick={local} {...props}>Forwarded</button>
}
export function Entry({ save }: { save: Callback }) {
  return <><EntryRenamed onSave={save} /><Overridden onClick={save} /><Forwarded onClick={save} /></>
}
`,
    })

    expect(outcomeFor(graph, 'EntryRenamed', 'onSave').gapReasons).toEqual([])
    expect(outcomeFor(graph, 'Overridden', 'onClick').gapReasons).toContain(
      'callback-terminal-missing',
    )
    expect(outcomeFor(graph, 'Forwarded', 'onClick').gapReasons).toEqual([])
    expect(graph.counts.callbackSlots).toBeLessThan(12)
  })

  it('keeps duplicate component names separate and rejects a callback cycle without a carrier', () => {
    const graph = inspectInteractionCallbackGraphFixtures({
      'entry.tsx': `
type Callback = () => void
function First({ onSave }: { onSave: Callback }) {
  function Item({ act }: { act: Callback }) { return <button onClick={act}>First</button> }
  return <Item act={onSave} />
}
function Second({ onSave }: { onSave: Callback }) {
  function Item({ act }: { act: Callback }) { return <span>{String(Boolean(act))}</span> }
  return <Item act={onSave} />
}
function Left({ onAct }: { onAct: Callback }) { return <Right onAct={onAct} /> }
function Right({ onAct }: { onAct: Callback }) { return <Left onAct={onAct} /> }
export function Entry({ save }: { save: Callback }) {
  return <><First onSave={save} /><Second onSave={save} /><Left onAct={save} /></>
}
`,
    })

    expect(outcomeFor(graph, 'First', 'onSave').gapReasons).toEqual([])
    expect(outcomeFor(graph, 'Second', 'onSave').gapReasons).toContain('callback-terminal-missing')
    expect(outcomeFor(graph, 'Left', 'onAct', 'Entry').gapReasons).toContain(
      'callback-cycle-without-terminal',
    )
    expect(
      graph.vertices.filter(
        (vertex) => vertex.kind === 'callback-slot' && vertex.component === 'Item',
      ),
    ).toHaveLength(2)
  })

  it('canonicalizes equivalent graph collection order and keeps traversal work linear', () => {
    const graph = inspectInteractionCallbackGraphFixtures({
      'entry.tsx': `
function Child({ onAct }: { onAct: () => void }) { return <button onClick={onAct}>Act</button> }
export function Entry({ save }: { save: () => void }) { return <Child onAct={save} /> }
`,
    })
    const reordered = {
      ...graph,
      vertices: [...graph.vertices].reverse(),
      edges: [...graph.edges].reverse(),
      terminals: [...graph.terminals].reverse(),
      components: [...graph.components].reverse(),
      outcomes: [...graph.outcomes].reverse(),
    }

    expect(interactionOutcomeGraphDigest(reordered)).toBe(graph.digest)
    const large = inspectInteractionGraphAlgorithmFixture(4_096)
    expect(large.work).toEqual({
      vertexDiscoveryVisits: large.counts.vertices,
      edgeDiscoveryVisits: large.counts.edges,
      sccVertexVisits: large.counts.vertices,
      sccEdgeVisits: large.counts.edges,
      terminalPropagationEdgeVisits: large.counts.condensedEdges,
    })
    expect(large.terminalRootIds).toEqual(['fixture:4095'])
    expect(large.gapReasons).toContain('outcome-settlement-missing')
  })

  it('keeps exact interaction identities stable across unrelated line shifts', () => {
    const source = `
export function Example() {
  const act = () => undefined
  return <button data-role="example" onClick={act}>Go</button>
}
`
    const shifted = `\n\n${source}`

    const original = inventoryInteractionSitesInSource('src/ui/Example.tsx', source)
    const afterShift = inventoryInteractionSitesInSource('src/ui/Example.tsx', shifted)

    expect(original.map((site) => site.id)).toEqual(afterShift.map((site) => site.id))
    expect(original.map((site) => site.line)).not.toEqual(afterShift.map((site) => site.line))
  })
})

function inventoryResult() {
  cachedInventoryResult ??= runAudit('inventory')
  return cachedInventoryResult
}

function requireSite(
  inventory: InteractionCapabilityInventory,
  predicate: (site: InteractionCapabilitySite) => boolean,
) {
  const site = inventory.sites.find(predicate)
  if (!site) throw new Error('ExpectedInteractionCapabilitySiteMissing')
  return site
}

function requireIndex<Value>(values: readonly Value[], index: number, error: string): Value {
  const value = values[index]
  if (value === undefined) throw new Error(error)
  return value
}

function outcomeFor(
  graph: InteractionOutcomeGraph,
  element: string,
  event: string,
  component?: string,
) {
  const sites = graph.vertices.filter(
    (vertex) =>
      vertex.kind === 'interaction-site' &&
      vertex.element === element &&
      vertex.event === event &&
      (!component || vertex.component === component),
  )
  const site = sites[0]
  if (!site) {
    throw new Error(`ExpectedInteractionGraphSiteMissing:${component ?? '*'}:${element}.${event}`)
  }
  const outcome = graph.outcomes.find((candidate) => candidate.siteId === site.id)
  if (!outcome) throw new Error(`ExpectedInteractionGraphOutcomeMissing:${site.id}`)
  return outcome
}

function runAudit(
  mode: 'inventory' | 'enforce',
  inventory = buildInteractionCapabilityInventory(),
) {
  const audited = auditInteractionCapabilities({ inventory })
  const ok =
    audited.structurallyValid &&
    (mode === 'inventory' || (audited.classificationClosed && audited.behavioralOutcomesClosed))
  return {
    status: ok ? 0 : 1,
    report: { ...audited, ok } satisfies InteractionCapabilityAuditResult & {
      readonly ok: boolean
    },
  }
}

type Mutable<Value> = Value extends (...args: never[]) => unknown
  ? Value
  : Value extends readonly (infer Entry)[]
    ? Mutable<Entry>[]
    : Value extends object
      ? { -readonly [Key in keyof Value]: Mutable<Value[Key]> }
      : Value
