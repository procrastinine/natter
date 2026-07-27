import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  __resetWorkspaceEffectHubForTests,
  publishPreparedWorkspaceEffect,
  reduceWorkspaceChange,
  subscribeWorkspaceEffects,
  WORKSPACE_EFFECT_RECOVERY_OWNED,
} from '../../src/store/workspace-effect-hub'
import type {
  WorkspaceChange,
  WorkspaceDeltaFact,
  WorkspaceDependency,
} from '../../src/store/workspace-protocol'
import { loadProtocolContractFactBundle } from '../helpers/protocol-contract-facts'

const ROOT = resolve(__dirname, '../..')
const AUDIT_URL = pathToFileURL(resolve(ROOT, 'scripts/audit-tab-cross-tab-locality.mjs')).href
const INVENTORY_URL = pathToFileURL(
  resolve(ROOT, 'scripts/tab-cross-tab-locality-inventory.mjs'),
).href
const KNOWN_INITIATING_OWNER_PATH_GAPS = [
  'initiating-owner paths: missing src/store/attachment-catalog-projection.ts',
  'initiating-owner paths: missing src/store/attachment-reference-edges.ts',
  'initiating-owner paths: missing src/store/chat-row-transition.ts',
  'initiating-owner paths: missing src/store/child-list-projection.ts',
] as const

interface LocalityRecord {
  readonly status: string
  readonly forbiddenRemoteSteering: readonly string[]
  readonly [field: string]: unknown
}

interface LocalityInventory {
  readonly WORKSPACE_QUERY_LOCALITY: Readonly<Record<string, LocalityRecord>>
  readonly WORKSPACE_COMMAND_LOCALITY: Readonly<Record<string, LocalityRecord>> & {
    readonly 'chat.touch-viewed': LocalityRecord
  }
  readonly ROUTE_ACTION_LOCALITY: Readonly<Record<string, LocalityRecord>>
  readonly OWNER_PATH_CLASSIFICATIONS: Readonly<Record<string, readonly string[]>> & {
    readonly 'tab-local': readonly string[]
  }
  readonly PUBLICATION_CONSUMER_FILES: Readonly<Record<string, string>>
  readonly REMOTE_LOCALITY_BROWSER_OUTCOME_MATRIX: readonly {
    readonly id: string
    readonly consumers: readonly string[]
    readonly journeys: readonly {
      readonly path: string
      readonly locator: string
      readonly targetMayDisappear: boolean
      readonly outcomes: readonly string[]
    }[]
  }[]
  readonly [exportName: string]: unknown
}

interface LocalityReport {
  readonly ok: boolean
  readonly structurallyValid: boolean
  readonly surfaces: number
  readonly records: number
  readonly constructorSites: number
  readonly unconstructedOrUnadmittedSites: number
  readonly ownerClassifiedSites: number
  readonly ownerSiteGaps: number
  readonly rootAdmissionSites: number
  readonly unadmittedRoots: number
  readonly childReservationSites: number
  readonly unreservedChildren: number
  readonly configurationConstructorGaps: number
  readonly publicationConsumers: number
  readonly publicationConsumerSelectors: number
  readonly publicationAddressingInputs: number
  readonly publicationAddressingPairs: number
  readonly publicationAddressedPairs: number
  readonly publicationUnaddressedPairs: number
  readonly publicationProducers: number
  readonly rawPublicationSources: number
  readonly remoteBrowserOutcomeFamilies: number
  readonly remoteBrowserOutcomeConsumers: number
  readonly architectureGaps: number
  readonly recordGaps: number
  readonly siteGaps: number
  readonly scannerLimitations: number
  readonly acceptanceCriteria: number
  readonly acceptanceSatisfied: number
  readonly acceptanceOpen: number
  readonly surfaceCounts: Readonly<Record<string, number>>
  readonly limitations: readonly string[]
  readonly problems: readonly string[]
  readonly publicationConsumerSelectorRecords?: readonly PublicationConsumerSelector[]
  readonly publicationAddressingRecords?: readonly PublicationAddressingRecord[]
}

interface PublicationConsumerSelector {
  readonly owner: string
  readonly sources: readonly ('local' | 'remote')[]
  readonly factKinds: readonly WorkspaceDeltaFact['kind'][]
  readonly residualKinds: readonly WorkspaceDependency['kind'][]
  readonly impactKinds: readonly WorkspaceDependency['kind'][]
  readonly replacements: boolean
}

interface PublicationAddressingRecord {
  readonly consumer: string
  readonly input: string
  readonly addressed: boolean
}

interface LocalityAuditModule {
  evaluateTabCrossTabLocality(
    inventory: unknown,
    mode: 'inventory' | 'enforce',
    detail?: boolean,
    sourceFacts?: unknown,
  ): LocalityReport
}

let canonicalInventory: LocalityInventory
let auditModule: LocalityAuditModule
let localitySourceFacts: unknown

beforeAll(async () => {
  const [loadedAudit, loadedInventory, bundle] = await Promise.all([
    import(AUDIT_URL) as Promise<unknown>,
    import(INVENTORY_URL) as Promise<unknown>,
    loadProtocolContractFactBundle<{ readonly locality: unknown }>(),
  ])
  auditModule = loadedAudit as LocalityAuditModule
  localitySourceFacts = bundle.locality
  canonicalInventory = loadedInventory as LocalityInventory
}, 30_000)

function evaluateTabCrossTabLocality(
  inventory: unknown,
  mode: 'inventory' | 'enforce',
  detail = false,
): LocalityReport {
  return auditModule.evaluateTabCrossTabLocality(inventory, mode, detail, localitySourceFacts)
}

describe('tab and cross-tab locality audit', () => {
  it('exhaustively inventories protocol, navigation, stream, publication, and runtime locality', () => {
    const report = evaluateTabCrossTabLocality(canonicalInventory, 'inventory')

    expect(report).toMatchObject({
      ok: false,
      structurallyValid: false,
      surfaces: 20,
      records: 343,
      constructorSites: 748,
      unconstructedOrUnadmittedSites: 4,
      ownerClassifiedSites: 742,
      ownerSiteGaps: 6,
      rootAdmissionSites: 110,
      unadmittedRoots: 0,
      childReservationSites: 3,
      unreservedChildren: 4,
      configurationConstructorGaps: 0,
      publicationConsumers: 18,
      publicationConsumerSelectors: 18,
      publicationAddressingInputs: 32,
      publicationAddressingPairs: 576,
      publicationAddressedPairs: 110,
      publicationUnaddressedPairs: 466,
      publicationProducers: 4,
      rawPublicationSources: 1,
      remoteBrowserOutcomeFamilies: 6,
      remoteBrowserOutcomeConsumers: 18,
      architectureGaps: 3,
      recordGaps: 149,
      siteGaps: 10,
      scannerLimitations: 9,
      acceptanceCriteria: 13,
      acceptanceSatisfied: 5,
      acceptanceOpen: 8,
      problems: KNOWN_INITIATING_OWNER_PATH_GAPS,
    })
    expect(report.surfaceCounts).toMatchObject({
      'workspace-query': 66,
      'workspace-command': 65,
      'configuration-command': 44,
      'workspace-root': 15,
      'workspace-child': 7,
      'generation-intent': 6,
      'conversation-selection-delivery': 2,
      'conversation-route-delivery': 2,
      'route-action': 11,
      'stream-lease-operation': 22,
      'attempt-controller-operation': 32,
      'workspace-change': 3,
      'workspace-delta-fact': 9,
      'workspace-dependency': 23,
      'runtime-resource': 17,
    })
    expect(report.limitations).toEqual(
      expect.arrayContaining([
        expect.stringContaining('not necessarily the human interaction'),
        expect.stringContaining('browser-native navigation'),
        expect.stringContaining('absence of consumer-side steering'),
      ]),
    )
  })

  it('executes the generated remote publication addressing matrix through the public hub', () => {
    const report = evaluateTabCrossTabLocality(canonicalInventory, 'inventory', true)
    const selectors = report.publicationConsumerSelectorRecords ?? []
    const expectedRecords = report.publicationAddressingRecords ?? []
    const received: string[] = []
    __resetWorkspaceEffectHubForTests()
    const unsubscribes = selectors.map((selector) =>
      subscribeWorkspaceEffects({
        ...selector,
        apply: () => received.push(selector.owner),
        recover: () => WORKSPACE_EFFECT_RECOVERY_OWNED,
      }),
    )

    try {
      const inputs = [
        ...workspaceFactInputs().map((fact) => ({
          id: `fact:${fact.kind}`,
          change: remoteCommit([fact], []),
        })),
        ...workspaceDependencyInputs().map((dependency) => ({
          id: `dependency:${dependency.kind}`,
          change: remoteInvalidation(dependency),
        })),
      ]
      let deliveries = 0
      for (const input of inputs) {
        received.length = 0
        publishPreparedWorkspaceEffect(reduceWorkspaceChange(input.change, 'remote'))
        const expected = expectedRecords
          .filter((record) => record.input === input.id && record.addressed)
          .map((record) => record.consumer)
          .sort()
        expect([...received].sort(), input.id).toEqual(expected)
        expect(new Set(received).size, `${input.id}: duplicate delivery`).toBe(received.length)
        deliveries += received.length
      }
      expect(inputs).toHaveLength(32)
      expect(deliveries).toBe(110)

      received.length = 0
      publishPreparedWorkspaceEffect(
        reduceWorkspaceChange(
          remoteCommit(
            [
              {
                ...WORKSPACE_FACT_INPUTS['message-revision'],
                changed: { structure: false, body: false },
              },
            ],
            [],
          ),
          'remote',
        ),
      )
      const expectedHeaderOnlyRevision = expectedRecords
        .filter((record) => record.input === 'fact:message-revision' && record.addressed)
        .map((record) => record.consumer)
        .sort()
      expect([...received].sort(), 'fact:message-revision:body=false').toEqual(
        expectedHeaderOnlyRevision,
      )
    } finally {
      for (const unsubscribe of unsubscribes) unsubscribe()
      __resetWorkspaceEffectHubForTests()
    }
  })

  it('makes every unresolved locality guarantee fatal in enforcement mode', () => {
    const report = evaluateTabCrossTabLocality(canonicalInventory, 'enforce')

    expect(report.structurallyValid).toBe(false)
    expect(report.ok).toBe(false)
    expect(report.architectureGaps).toBe(3)
    expect(report.recordGaps).toBe(149)
    expect(report.siteGaps).toBe(10)
    expect(report.problems).toEqual(KNOWN_INITIATING_OWNER_PATH_GAPS)
  })

  it('rejects stale variants, partial classifications, owner drift, and hidden consumers', () => {
    const inventory = {
      ...canonicalInventory,
      WORKSPACE_QUERY_LOCALITY: omit(canonicalInventory.WORKSPACE_QUERY_LOCALITY, 'chat.get'),
      WORKSPACE_COMMAND_LOCALITY: {
        ...canonicalInventory.WORKSPACE_COMMAND_LOCALITY,
        'chat.touch-viewed': {
          ...canonicalInventory.WORKSPACE_COMMAND_LOCALITY['chat.touch-viewed'],
          status: 'claimed',
          forbiddenRemoteSteering: ['route'],
        },
      },
      ROUTE_ACTION_LOCALITY: omit(canonicalInventory.ROUTE_ACTION_LOCALITY, 'navigate'),
      OWNER_PATH_CLASSIFICATIONS: {
        ...canonicalInventory.OWNER_PATH_CLASSIFICATIONS,
        'tab-local': canonicalInventory.OWNER_PATH_CLASSIFICATIONS['tab-local'].filter(
          (path) => path !== 'src/store/chats.ts',
        ),
      },
      PUBLICATION_CONSUMER_FILES: omit(
        canonicalInventory.PUBLICATION_CONSUMER_FILES,
        'src/store/attempt-workspace.ts',
      ),
    }
    const report = evaluateTabCrossTabLocality(inventory, 'inventory')

    expect(report.structurallyValid).toBe(false)
    expect(report.problems).toEqual(
      expect.arrayContaining([
        'workspace-query variants: missing chat.get',
        'workspace-command chat.touch-viewed: invalid status claimed',
        'workspace-command chat.touch-viewed: forbiddenRemoteSteering must cover route,cursor,draft,selection',
        'route-action variants: missing navigate',
        'initiating-owner paths: missing src/store/chats.ts',
        'workspace publication consumer files: missing src/store/attempt-workspace.ts',
      ]),
    )
  })

  it('rejects incomplete real-browser consumer coverage and stale journey locators', () => {
    const [conversation, ...rest] = canonicalInventory.REMOTE_LOCALITY_BROWSER_OUTCOME_MATRIX
    if (!conversation) throw new Error('RemoteLocalityConversationOutcomeMissing')
    const [conversationJourney] = conversation.journeys
    if (!conversationJourney) throw new Error('RemoteLocalityConversationJourneyMissing')
    const inventory = {
      ...canonicalInventory,
      REMOTE_LOCALITY_BROWSER_OUTCOME_MATRIX: [
        {
          ...conversation,
          consumers: [],
          journeys: [
            {
              ...conversationJourney,
              locator: "test('missing remote locality journey'",
            },
          ],
        },
        ...rest,
      ],
    }

    const report = evaluateTabCrossTabLocality(inventory, 'inventory')

    expect(report.structurallyValid).toBe(false)
    expect(report.problems).toEqual(
      expect.arrayContaining([
        'remote locality browser outcome conversation: missing consumers',
        expect.stringContaining(
          'remote locality browser outcome conversation journey 0: locator occurs 0',
        ),
        expect.stringContaining('remote locality browser outcome consumers: missing'),
      ]),
    )
  })
})

function omit<T extends Readonly<Record<string, unknown>>>(value: T, key: string) {
  return Object.fromEntries(Object.entries(value).filter(([entryKey]) => entryKey !== key))
}

const WORKSPACE_FACT_INPUTS: {
  [Kind in WorkspaceDeltaFact['kind']]: Extract<WorkspaceDeltaFact, { kind: Kind }>
} = {
  'chat-deleted': { kind: 'chat-deleted', chatId: 'chat-a' },
  'conversation-created': { kind: 'conversation-created', chatId: 'chat-a' },
  'sidebar-row-changed': { kind: 'sidebar-row-changed', chatId: 'chat-a' },
  'sidebar-row-deleted': { kind: 'sidebar-row-deleted', chatId: 'chat-a' },
  'attachment-row-changed': {
    kind: 'attachment-row-changed',
    attachmentId: 'attachment-a',
  },
  'attachment-row-deleted': {
    kind: 'attachment-row-deleted',
    attachmentId: 'attachment-a',
  },
  'attempt-target-committed': {
    kind: 'attempt-target-committed',
    streamId: 'stream-a',
    chatId: 'chat-a',
    messageId: 'message-a',
    attemptKind: 'generation',
    admissionSequence: 1,
    leaseRevision: 1,
    bodyVersion: 1,
  },
  'attempt-stop-requested': {
    kind: 'attempt-stop-requested',
    streamId: 'stream-a',
    chatId: 'chat-a',
    messageId: 'message-a',
    attemptKind: 'generation',
    admissionSequence: 1,
    controlRevision: 1,
    requestId: 'request-a',
    requestedBy: 'tab-a',
    requestedAt: 1,
    reason: 'user',
  },
  'message-revision': {
    kind: 'message-revision',
    chatId: 'chat-a',
    structuralVersion: 1,
    header: { id: 'message-a' } as Extract<
      WorkspaceDeltaFact,
      { kind: 'message-revision' }
    >['header'],
    changed: { structure: false, body: true },
  },
}

const WORKSPACE_DEPENDENCY_INPUTS: {
  [Kind in WorkspaceDependency['kind']]: Extract<WorkspaceDependency, { kind: Kind }>
} = {
  workspace: { kind: 'workspace' },
  chat: { kind: 'chat', chatIds: ['chat-a'] },
  sidebar: { kind: 'sidebar', chatIds: ['chat-a'] },
  'message-header': { kind: 'message-header', chatId: 'chat-a', messageIds: ['message-a'] },
  'message-body': { kind: 'message-body', chatId: 'chat-a', messageIds: ['message-a'] },
  'message-preview': { kind: 'message-preview', chatId: 'chat-a', messageIds: ['message-a'] },
  'child-slot': { kind: 'child-slot', chatId: 'chat-a', parentIds: [null] },
  draft: { kind: 'draft', chatIds: ['chat-a'] },
  attachment: { kind: 'attachment', attachmentIds: ['attachment-a'] },
  'attachment-job': {
    kind: 'attachment-job',
    attachmentIds: ['attachment-a'],
    jobIds: ['job-a'],
  },
  profile: { kind: 'profile', profileIds: ['profile-a'] },
  preset: { kind: 'preset', presetIds: ['preset-a'] },
  'prompt-preset': { kind: 'prompt-preset', presetIds: ['prompt-preset-a'] },
  'text-template': { kind: 'text-template', templateIds: ['template-a'] },
  folder: { kind: 'folder', folderIds: ['folder-a'] },
  tag: { kind: 'tag', tagIds: ['tag-a'] },
  key: { kind: 'key', keyIds: ['key-a'] },
  setting: { kind: 'setting', keys: ['setting-a'] },
  'stream-lease': { kind: 'stream-lease', chatId: 'chat-a', streamIds: ['stream-a'] },
  'stream-chunks': { kind: 'stream-chunks', chatId: 'chat-a', streamIds: ['stream-a'] },
  'model-resolution': { kind: 'model-resolution', targetKeys: ['target-a'] },
  'discovery-cache': { kind: 'discovery-cache', cacheKinds: ['models'] },
  'storage-maintenance': { kind: 'storage-maintenance', tasks: ['compact-workspace'] },
}

function workspaceFactInputs(): WorkspaceDeltaFact[] {
  return Object.values(WORKSPACE_FACT_INPUTS)
}

function workspaceDependencyInputs(): WorkspaceDependency[] {
  return Object.values(WORKSPACE_DEPENDENCY_INPUTS)
}

function remoteCommit(
  facts: readonly WorkspaceDeltaFact[],
  invalidations: readonly WorkspaceDependency[],
): WorkspaceChange {
  return {
    kind: 'commit',
    stamp: { workspaceId: 'workspace-a', replacementEpoch: 1, commitId: 'commit-a' },
    delta: { facts, invalidations },
  }
}

function remoteInvalidation(dependency: WorkspaceDependency): WorkspaceChange {
  return {
    kind: 'invalidate',
    workspaceId: 'workspace-a',
    replacementEpoch: 1,
    dependencies: [dependency],
  }
}
