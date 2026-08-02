import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { loadProtocolContractFactBundle } from '../helpers/protocol-contract-facts'

const ROOT = resolve(__dirname, '../..')
const AUDIT_URL = pathToFileURL(resolve(ROOT, 'scripts/audit-durable-command-pipeline.mjs')).href
const INVENTORY_URL = pathToFileURL(
  resolve(ROOT, 'scripts/durable-command-pipeline-inventory.mjs'),
).href
const TYPESCRIPT_SOURCE_URL = pathToFileURL(
  resolve(ROOT, 'scripts/production-typescript-source.mjs'),
).href

interface PipelineStage {
  readonly status: string
  readonly proof?: string | readonly string[]
  readonly reason?: string
}

type PipelineRecord = Readonly<Record<string, PipelineStage>>

interface DurableCommandPipelineInventory {
  readonly WORKSPACE_COMMAND_PIPELINES: Readonly<Record<string, PipelineRecord>>
  readonly CONFIGURATION_COMMAND_PIPELINES: Readonly<Record<string, PipelineRecord>>
  readonly MANUAL_WRITE_MARKER_OWNER_COUNTS: Readonly<Record<string, number>>
  readonly DIRECT_COMMAND_TRANSACTION_OWNER_COUNTS: Readonly<Record<string, number>>
  readonly WRITE_DETECTION_ARCHITECTURE: Readonly<Record<string, unknown>>
  readonly REQUIRED_PIPELINE_STAGES: readonly string[]
}

interface DurableCommandPipelineReport {
  readonly ok: boolean
  readonly structurallyValid: boolean
  readonly workspaceCommands: number
  readonly workspaceConstructorSites: number
  readonly configurationCommands: number
  readonly configurationConstructorSites: number
  readonly configurationConstructorGaps: number
  readonly pipelineRecords: number
  readonly requiredStages: number
  readonly stageCells: number
  readonly gapCells: number
  readonly observedCells: number
  readonly manualMarkerOwners: number
  readonly manualMarkerCalls: number
  readonly directTransactionOwners: number
  readonly directTransactionCalls: number
  readonly semanticCapabilityCommands: number
  readonly finiteClassifiedBoundCells: number
  readonly stagedClassifiedBoundCells: number
  readonly carriedBoundCells: number
  readonly carriedBounds: readonly {
    readonly scope: string
    readonly variant: string
    readonly kind: 'carried'
    readonly findingId: string
    readonly owner: string
  }[]
  readonly gapStageCounts: Readonly<Record<string, number>>
  readonly physicalTables: string[]
  readonly limitations: string[]
  readonly problems: string[]
}

let canonicalInventory: DurableCommandPipelineInventory
let sourceFacts: unknown
let evaluateDurableCommandPipeline: (
  inventory: DurableCommandPipelineInventory,
  mode: 'inventory' | 'enforce',
  options?: Readonly<Record<string, unknown>>,
  facts?: unknown,
) => DurableCommandPipelineReport
let buildDurableCommandPipelineSourceFacts: (options?: Readonly<Record<string, unknown>>) => unknown

function withForegroundCommandFootprintBounds(gaps: readonly string[]): readonly string[] {
  const facts = sourceFacts as {
    readonly b16BoundsClassification: {
      readonly classifications: Readonly<
        Record<string, { readonly kind: string; readonly proof: string }>
      >
    }
  }
  const commandFootprintVariants = new Set(
    Object.entries(facts.b16BoundsClassification.classifications)
      .filter(
        ([, classification]) =>
          classification.kind === 'finite' &&
          classification.proof === 'foreground-storage:command-footprint-atomic-pages',
      )
      .map(([variant]) => variant),
  )
  const expected = new Set(gaps)
  for (const gap of gaps) {
    const separator = gap.lastIndexOf(':')
    const variant = gap.slice(0, separator)
    const stage = gap.slice(separator + 1)
    if (
      commandFootprintVariants.has(variant) &&
      (stage === 'physicalWrites' || stage === 'receiptDelta' || stage === 'tables')
    ) {
      expected.add(`${variant}:bounds`)
    }
  }
  return [...expected].sort()
}

beforeAll(async () => {
  const audit = (await import(AUDIT_URL)) as {
    evaluateDurableCommandPipeline: typeof evaluateDurableCommandPipeline
    buildDurableCommandPipelineSourceFacts: typeof buildDurableCommandPipelineSourceFacts
  }
  canonicalInventory = (await import(INVENTORY_URL)) as DurableCommandPipelineInventory
  evaluateDurableCommandPipeline = audit.evaluateDurableCommandPipeline
  buildDurableCommandPipelineSourceFacts = audit.buildDurableCommandPipelineSourceFacts
  sourceFacts = (await loadProtocolContractFactBundle<{ readonly durable: unknown }>()).durable
}, 30_000)

describe('durable command commit pipeline audit', () => {
  it('inventories every command and every required pipeline stage without hiding gaps', () => {
    const result = runAudit('inventory')

    expect(result.status).toBe(0)
    expect(result.report).toMatchObject({
      ok: true,
      structurallyValid: true,
      workspaceCommands: 65,
      workspaceConstructorSites: 75,
      configurationCommands: 44,
      configurationConstructorSites: 47,
      configurationConstructorGaps: 0,
      pipelineRecords: 109,
      requiredStages: 15,
      stageCells: 1635,
      gapCells: 0,
      observedCells: 1635,
      manualMarkerOwners: 0,
      manualMarkerCalls: 0,
      directTransactionOwners: 2,
      directTransactionCalls: 3,
      semanticCapabilityCommands: 109,
      finiteClassifiedBoundCells: 39,
      stagedClassifiedBoundCells: 0,
      carriedBoundCells: 0,
      problems: [],
    })
    expect(result.report.gapStageCounts).toMatchObject({
      tables: 0,
      physicalWrites: 0,
      receiptDelta: 0,
      idempotence: 0,
      bounds: 0,
    })
    expect(result.report.physicalTables).toHaveLength(45)
    expect(result.report.limitations).toEqual(
      expect.arrayContaining([
        expect.stringContaining('finite bounds prove command-lifetime request and row cardinality'),
        expect.stringContaining('All 39 formerly open bounds use command-footprint pages'),
        expect.stringContaining('Zero pipeline gaps is B2.2 source closure'),
      ]),
    )
  })

  it('passes enforcement only after every command has a finite active-database bound', () => {
    const result = runAudit('enforce')

    expect(result.status).toBe(0)
    expect(result.report.structurallyValid).toBe(true)
    expect(result.report.ok).toBe(true)
    expect(result.report.gapCells).toBe(0)
  })

  it('classifies all remaining bounds without a foreground workspace-copy owner', () => {
    const facts = sourceFacts as {
      readonly b16BoundsClassification: {
        readonly finiteVariants: readonly string[]
        readonly stagedVariants: readonly string[]
        readonly carriedVariants: readonly string[]
        readonly classifications: Readonly<
          Record<
            string,
            | { readonly kind: 'finite'; readonly proof: string }
            | {
                readonly kind: 'staged'
                readonly findingId: string
                readonly owner: string
                readonly proof: string
              }
          >
        >
      }
      readonly semanticCapabilities: Readonly<
        Record<
          string,
          {
            readonly boundsProved: boolean
            readonly boundsClassification?: { readonly kind: string; readonly proof: string }
            readonly boundsDisposition?: {
              readonly kind: string
              readonly findingId: string
              readonly owner: string
            }
          }
        >
      >
    }
    const classification = facts.b16BoundsClassification

    expect(classification.finiteVariants).toEqual([
      'attachment.bundle.write',
      'attachment.bytes.delete',
      'attachment.delete-if-unreferenced',
      'attachment.delete-many',
      'attachment.reap',
      'attachment.ref.add',
      'attachment.ref.detach',
      'attachment.ref.relink',
      'attachment.ref.set-visibility',
      'attempt.finalize',
      'attempt.prepare',
      'chat.calibration.clear-all',
      'chat.calibration.clear-family',
      'chat.delete-archived',
      'chat.discard-empty-drafts',
      'chat.empty-archive',
      'chat.fork',
      'chat.set-tags-from-names',
      'connection.delete',
      'draft.put',
      'folder.delete',
      'folder.ensure-and-move-chats',
      'generated-output.localization-claim',
      'generated-output.localization-complete',
      'generated-output.localization-fail',
      'generated-output.localization-retry',
      'generated-output.video-expand',
      'interchange.import-chat',
      'interchange.import-chat-preset',
      'interchange.import-connection-profile',
      'maintenance.prune-empty-draft-chats',
      'maintenance.reconcile-attachment-integrity',
      'message.delete',
      'message.edit-body',
      'message.import',
      'message.restore-structure',
      'prompt-preset.delete',
      'prompt-preset.overwrite-and-pin',
      'text-template.delete',
    ])
    expect(classification.stagedVariants).toEqual([])
    expect(classification.carriedVariants).toEqual([])
    expect(
      Object.values(classification.classifications).filter(({ kind }) => kind === 'finite'),
    ).toHaveLength(39)
    expect(
      Object.values(classification.classifications).filter(({ kind }) => kind === 'staged'),
    ).toHaveLength(0)
    for (const variant of classification.finiteVariants) {
      expect(facts.semanticCapabilities[variant]).toMatchObject({
        boundsProved: true,
        boundsClassification: classification.classifications[variant],
      })
      expect(facts.semanticCapabilities[variant]?.boundsDisposition).toBeUndefined()
    }
    for (const variant of classification.stagedVariants) {
      expect(facts.semanticCapabilities[variant]).toMatchObject({
        boundsProved: true,
        boundsClassification: classification.classifications[variant],
      })
      expect(facts.semanticCapabilities[variant]?.boundsDisposition).toBeUndefined()
    }

    const report = runAudit('enforce').report
    expect(report.stagedClassifiedBoundCells).toBe(0)
    expect(report.carriedBounds).toEqual([])
  })

  it('reopens a bound when either finite proof family is removed', () => {
    const facts = sourceFacts as {
      readonly semanticCapabilities: Readonly<Record<string, Readonly<Record<string, unknown>>>>
    }
    const withoutFiniteProof = evaluateDurableCommandPipeline(
      canonicalInventory,
      'inventory',
      { detail: true },
      {
        ...(sourceFacts as object),
        semanticCapabilities: {
          ...facts.semanticCapabilities,
          'message.edit-body': {
            ...facts.semanticCapabilities['message.edit-body'],
            boundsProved: false,
          },
        },
      },
    ) as DurableCommandPipelineReport & {
      readonly gaps: readonly { readonly variant: string; readonly stage: string }[]
    }
    const withoutCommandFootprintProof = evaluateDurableCommandPipeline(
      canonicalInventory,
      'inventory',
      { detail: true },
      {
        ...(sourceFacts as object),
        semanticCapabilities: {
          ...facts.semanticCapabilities,
          'connection.delete': {
            ...facts.semanticCapabilities['connection.delete'],
            boundsProved: false,
            boundsClassification: undefined,
          },
        },
      },
    ) as DurableCommandPipelineReport & {
      readonly gaps: readonly { readonly variant: string; readonly stage: string }[]
    }

    expect(withoutFiniteProof.gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ variant: 'message.edit-body', stage: 'bounds' }),
      ]),
    )
    expect(withoutCommandFootprintProof.gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ variant: 'connection.delete', stage: 'bounds' }),
      ]),
    )
  })

  it('derives one foreground storage-locality owner with no workspace-copy fallback', () => {
    const facts = sourceFacts as {
      readonly foregroundStorageLocalityFamily: {
        readonly wholeCollectionReadSites: readonly string[]
        readonly reviewedWholeCollectionReadSites: readonly string[]
        readonly commonKernel: Readonly<Record<string, boolean>>
        readonly consumed: boolean
      }
    }

    expect(Object.values(facts.foregroundStorageLocalityFamily.commonKernel).every(Boolean)).toBe(
      true,
    )
    expect(facts.foregroundStorageLocalityFamily.consumed).toBe(true)
    expect(facts.foregroundStorageLocalityFamily.wholeCollectionReadSites).toEqual(
      facts.foregroundStorageLocalityFamily.reviewedWholeCollectionReadSites,
    )
    expect(existsSync(resolve(ROOT, 'src/store/browser-staged-fanout-command.ts'))).toBe(false)
    expect(existsSync(resolve(ROOT, 'src/store/browser-workspace-staged-fanout.ts'))).toBe(false)
  })

  it('rejects an ordinary command or maintenance path that regains overflow admission', async () => {
    const repoSource = readFileSync(resolve(ROOT, 'src/store/browser-repo.ts'), 'utf8')
    const maintenanceSource = readFileSync(
      resolve(ROOT, 'src/store/storage-maintenance-runtime.ts'),
      'utf8',
    )
    const { createProductionTypeScriptProgram } = (await import(TYPESCRIPT_SOURCE_URL)) as {
      createProductionTypeScriptProgram(
        root: string,
        options: { sourceTextOverrides: Readonly<Record<string, string>> },
      ): unknown
    }
    expect(repoSource).toContain('this.executeDirectCommand(permit, command)')
    expect(maintenanceSource).toContain(
      'value: (await getWorkspaceRepository().execute(permit, command)).value',
    )

    const mutated = buildDurableCommandPipelineSourceFacts({
      program: createProductionTypeScriptProgram(ROOT, {
        sourceTextOverrides: {
          'src/store/browser-repo.ts': repoSource.replace(
            'this.executeDirectCommand(permit, command)',
            'this.tryExecuteCommandWithinFanoutBudget(permit, command, BROWSER_COMMAND_DIRECT_FANOUT_BUDGET)',
          ),
          'src/store/storage-maintenance-runtime.ts': maintenanceSource.replace(
            'value: (await getWorkspaceRepository().execute(permit, command)).value',
            'value: (await tryExecuteBrowserWorkspaceCommandWithinFanoutBudget(permit, command)).value',
          ),
        },
      }),
    }) as {
      readonly foregroundStorageLocalityFamily: {
        readonly commonKernel: Readonly<Record<string, boolean>>
        readonly consumed: boolean
      }
      readonly sourceArchitectureProblems: readonly string[]
    }

    expect(mutated.foregroundStorageLocalityFamily.commonKernel.oneDirectRepositoryIngress).toBe(
      false,
    )
    expect(
      mutated.foregroundStorageLocalityFamily.commonKernel.maintenanceUsesSameRepositoryIngress,
    ).toBe(false)
    expect(
      mutated.foregroundStorageLocalityFamily.commonKernel.budgetCannotRejectProductionIntent,
    ).toBe(false)
    expect(mutated.foregroundStorageLocalityFamily.consumed).toBe(false)
    expect(mutated.sourceArchitectureProblems).toEqual(
      expect.arrayContaining([
        'foreground storage locality missing oneDirectRepositoryIngress',
        'foreground storage locality missing maintenanceUsesSameRepositoryIngress',
        'foreground storage locality missing budgetCannotRejectProductionIntent',
      ]),
    )
  }, 30_000)

  it('rejects a new unreviewed whole-collection read in an ordinary repository route', async () => {
    const repoSource = readFileSync(resolve(ROOT, 'src/store/browser-repo.ts'), 'utf8')
    const { createProductionTypeScriptProgram } = (await import(TYPESCRIPT_SOURCE_URL)) as {
      createProductionTypeScriptProgram(
        root: string,
        options: { sourceTextOverrides: Readonly<Record<string, string>> },
      ): unknown
    }
    const mutatedSource = repoSource.replace(
      '    assertWorkspaceExecutionPermit(permit)\n    return (await this.executeDirectCommand(permit, command)).commit',
      `    assertWorkspaceExecutionPermit(permit)
    void this.session.runOperation((database) => database.chats.toArray())
    const rawStore = indexedDB.open('unreviewed').result.transaction('chats').objectStore('chats')
    void rawStore.getAll()
    void rawStore.openCursor()
    return (await this.executeDirectCommand(permit, command)).commit`,
    )
    expect(mutatedSource).not.toBe(repoSource)

    const mutated = buildDurableCommandPipelineSourceFacts({
      program: createProductionTypeScriptProgram(ROOT, {
        sourceTextOverrides: { 'src/store/browser-repo.ts': mutatedSource },
      }),
    }) as {
      readonly foregroundStorageLocalityFamily: {
        readonly wholeCollectionReadSites: readonly string[]
        readonly commonKernel: Readonly<Record<string, boolean>>
        readonly consumed: boolean
      }
      readonly sourceArchitectureProblems: readonly string[]
    }

    expect(mutated.foregroundStorageLocalityFamily.wholeCollectionReadSites).toContain(
      'src/store/browser-repo.ts#execute:toArray',
    )
    expect(mutated.foregroundStorageLocalityFamily.wholeCollectionReadSites).toContain(
      'src/store/browser-repo.ts#execute:getAll',
    )
    expect(mutated.foregroundStorageLocalityFamily.wholeCollectionReadSites).toContain(
      'src/store/browser-repo.ts#execute:openCursor',
    )
    expect(
      mutated.foregroundStorageLocalityFamily.commonKernel.exactReviewedWholeCollectionReads,
    ).toBe(false)
    expect(mutated.foregroundStorageLocalityFamily.consumed).toBe(false)
    expect(mutated.sourceArchitectureProblems).toContain(
      'foreground storage locality missing exactReviewedWholeCollectionReads',
    )
  }, 30_000)

  it('does not credit a declared capability until its exact command route consumes it', () => {
    const facts = sourceFacts as {
      readonly semanticCapabilities: Readonly<Record<string, Readonly<Record<string, unknown>>>>
    }
    const result = evaluateDurableCommandPipeline(
      canonicalInventory,
      'inventory',
      {},
      {
        ...(sourceFacts as object),
        semanticCapabilities: {
          ...facts.semanticCapabilities,
          'chat.touch-viewed': {
            ...facts.semanticCapabilities['chat.touch-viewed'],
            consumed: false,
          },
        },
      },
    )

    expect(result.gapCells).toBe(runAudit('inventory').report.gapCells + 9)
    expect(result.semanticCapabilityCommands).toBe(109)
  })

  it('derives the scope family from its live union and executable command routes', () => {
    const facts = sourceFacts as {
      readonly commandLifetimeReceipt: {
        readonly commonKernel: Readonly<Record<string, boolean>>
      }
      readonly scopeDerivedMutationFamily: {
        readonly declaredVariants: readonly string[]
        readonly routedVariants: readonly string[]
        readonly routesByVariant: Readonly<
          Record<
            string,
            { readonly consumed: boolean; readonly legacyTerminals: readonly string[] }
          >
        >
        readonly commonKernel: Readonly<Record<string, boolean>>
        readonly fixedReceiptFamily: {
          readonly variants: readonly string[]
          readonly messageVariants: readonly string[]
          readonly attemptVariants: readonly string[]
          readonly materializeVariants: readonly string[]
          readonly replayVariants: readonly string[]
          readonly commonKernel: Readonly<Record<string, unknown>>
          readonly commandLifetimeReceipt: {
            readonly commonKernel: Readonly<Record<string, boolean>>
          }
          readonly presentationOnly: {
            readonly variants: readonly string[]
            readonly commonKernel: Readonly<Record<string, boolean>>
          }
          readonly materializeTemporary: {
            readonly variant: 'chat.materialize-temporary'
            readonly commonKernel: Readonly<Record<string, boolean>>
          }
          readonly attemptDispatch: {
            readonly variant: 'attempt.dispatch'
            readonly commonKernel: Readonly<Record<string, boolean>>
          }
          readonly attemptPrepare: {
            readonly variant: 'attempt.prepare'
            readonly commonKernel: Readonly<Record<string, boolean>>
            readonly replayCommonKernel: Readonly<Record<string, boolean>>
          }
          readonly attemptFinalize: {
            readonly variant: 'attempt.finalize'
            readonly commonKernel: Readonly<Record<string, boolean>>
          }
          readonly draftPut: {
            readonly variant: 'draft.put'
            readonly commonKernel: Readonly<Record<string, boolean>>
          }
          readonly attachmentBytesDelete: {
            readonly variant: 'attachment.bytes.delete'
            readonly commonKernel: Readonly<Record<string, boolean>>
          }
          readonly attachmentBundleWrite: {
            readonly variant: 'attachment.bundle.write'
            readonly commonKernel: Readonly<Record<string, boolean>>
          }
          readonly attachmentDeleteIfUnreferenced: {
            readonly variant: 'attachment.delete-if-unreferenced'
            readonly commonKernel: Readonly<Record<string, boolean>>
          }
          readonly attachmentDeleteMany: {
            readonly variant: 'attachment.delete-many'
            readonly commonKernel: Readonly<Record<string, boolean>>
          }
          readonly attachmentReap: {
            readonly variant: 'attachment.reap'
            readonly commonKernel: Readonly<Record<string, boolean>>
          }
          readonly attachmentReference: {
            readonly variants: readonly string[]
            readonly commonKernel: Readonly<Record<string, boolean>>
          }
          readonly messageCommandExact: {
            readonly variants: readonly string[]
            readonly commonKernel: Readonly<Record<string, boolean>>
          }
        }
        readonly capabilities: Readonly<
          Record<
            string,
            {
              readonly physicalWritesProved: boolean
              readonly exactPhysicalWritesProved: boolean
              readonly exactEffectsProved: boolean
              readonly tablesProved: boolean
              readonly boundsProved: boolean
              readonly idempotenceProved: boolean
            }
          >
        >
      }
      readonly semanticCapabilities: Readonly<Record<string, Readonly<Record<string, unknown>>>>
    }
    const family = facts.scopeDerivedMutationFamily

    expect(Object.values(facts.commandLifetimeReceipt.commonKernel).every(Boolean)).toBe(true)
    expect(family.fixedReceiptFamily.commandLifetimeReceipt).toEqual(facts.commandLifetimeReceipt)
    expect(family.declaredVariants).toHaveLength(27)
    expect(family.routedVariants).toEqual(family.declaredVariants)
    expect(Object.values(family.routesByVariant).every((route) => route.consumed)).toBe(true)
    expect(
      Object.values(family.routesByVariant).every((route) => route.legacyTerminals.length === 0),
    ).toBe(true)
    expect(Object.values(family.commonKernel).every(Boolean)).toBe(true)
    expect(family.fixedReceiptFamily.variants).toHaveLength(8)
    expect(family.fixedReceiptFamily.messageVariants).toHaveLength(4)
    expect(family.fixedReceiptFamily.attemptVariants).toHaveLength(3)
    expect(family.fixedReceiptFamily.materializeVariants).toHaveLength(1)
    expect(family.fixedReceiptFamily.replayVariants).toHaveLength(5)
    expect(family.fixedReceiptFamily.presentationOnly.variants).toEqual(
      family.fixedReceiptFamily.messageVariants,
    )
    expect(
      Object.values(family.fixedReceiptFamily.presentationOnly.commonKernel).every(Boolean),
    ).toBe(true)
    expect(family.fixedReceiptFamily.materializeTemporary.variant).toBe(
      'chat.materialize-temporary',
    )
    expect(
      Object.values(family.fixedReceiptFamily.materializeTemporary.commonKernel).every(Boolean),
    ).toBe(true)
    expect(family.fixedReceiptFamily.attemptDispatch.variant).toBe('attempt.dispatch')
    expect(
      Object.values(family.fixedReceiptFamily.attemptDispatch.commonKernel).every(Boolean),
    ).toBe(true)
    expect(family.fixedReceiptFamily.attemptPrepare.variant).toBe('attempt.prepare')
    expect(
      Object.values(family.fixedReceiptFamily.attemptPrepare.commonKernel).every(Boolean),
    ).toBe(true)
    expect(
      Object.values(family.fixedReceiptFamily.attemptPrepare.replayCommonKernel).every(Boolean),
    ).toBe(true)
    expect(family.fixedReceiptFamily.attemptFinalize.variant).toBe('attempt.finalize')
    expect(
      Object.values(family.fixedReceiptFamily.attemptFinalize.commonKernel).every(Boolean),
    ).toBe(true)
    expect(family.fixedReceiptFamily.draftPut.variant).toBe('draft.put')
    expect(Object.values(family.fixedReceiptFamily.draftPut.commonKernel).every(Boolean)).toBe(true)
    expect(family.fixedReceiptFamily.attachmentBytesDelete.variant).toBe('attachment.bytes.delete')
    expect(
      Object.values(family.fixedReceiptFamily.attachmentBytesDelete.commonKernel).every(Boolean),
    ).toBe(true)
    expect(family.fixedReceiptFamily.attachmentBundleWrite.variant).toBe('attachment.bundle.write')
    expect(
      Object.values(family.fixedReceiptFamily.attachmentBundleWrite.commonKernel).every(Boolean),
    ).toBe(true)
    expect(family.fixedReceiptFamily.attachmentDeleteIfUnreferenced.variant).toBe(
      'attachment.delete-if-unreferenced',
    )
    expect(
      Object.values(family.fixedReceiptFamily.attachmentDeleteIfUnreferenced.commonKernel).every(
        Boolean,
      ),
    ).toBe(true)
    expect(family.fixedReceiptFamily.attachmentDeleteMany.variant).toBe('attachment.delete-many')
    expect(
      Object.values(family.fixedReceiptFamily.attachmentDeleteMany.commonKernel).every(Boolean),
    ).toBe(true)
    expect(family.fixedReceiptFamily.attachmentReap.variant).toBe('attachment.reap')
    expect(
      Object.values(family.fixedReceiptFamily.attachmentReap.commonKernel).every(Boolean),
    ).toBe(true)
    expect(family.fixedReceiptFamily.attachmentReference.variants).toEqual([
      'attachment.ref.add',
      'attachment.ref.detach',
      'attachment.ref.relink',
      'attachment.ref.set-visibility',
    ])
    expect(
      Object.values(family.fixedReceiptFamily.attachmentReference.commonKernel).every(Boolean),
    ).toBe(true)
    for (const variant of family.fixedReceiptFamily.attachmentReference.variants) {
      expect(family.capabilities[variant]).toMatchObject({
        exactEffectsProved: true,
        tablesProved: true,
        boundsProved: false,
        idempotenceProved: true,
      })
    }
    expect(family.fixedReceiptFamily.messageCommandExact.variants).toEqual([
      'message.delete',
      'message.edit-body',
      'message.import',
      'message.restore-structure',
    ])
    expect(
      Object.values(family.fixedReceiptFamily.messageCommandExact.commonKernel).every(Boolean),
    ).toBe(true)
    for (const variant of family.fixedReceiptFamily.messageCommandExact.variants) {
      expect(family.capabilities[variant]).toMatchObject({
        exactEffectsProved: true,
        tablesProved: true,
        boundsProved: false,
        idempotenceProved: true,
      })
    }
    expect(
      Object.entries(family.fixedReceiptFamily.commonKernel)
        .filter(([name]) => name !== 'constructorFacts')
        .every(([, value]) => value === true),
    ).toBe(true)
    expect(
      family.fixedReceiptFamily.variants.every(
        (variant) => family.capabilities[variant]?.exactEffectsProved === true,
      ),
    ).toBe(true)
    expect(
      family.fixedReceiptFamily.replayVariants.every(
        (variant) => family.capabilities[variant]?.idempotenceProved === true,
      ),
    ).toBe(true)
    expect(
      family.fixedReceiptFamily.messageVariants.every(
        (variant) =>
          family.capabilities[variant]?.tablesProved === true &&
          family.capabilities[variant].boundsProved === true,
      ),
    ).toBe(true)
    expect(family.capabilities['attempt.dispatch']).toMatchObject({
      tablesProved: true,
      boundsProved: true,
      idempotenceProved: true,
    })
    expect(family.capabilities['attempt.prepare']).toMatchObject({
      tablesProved: true,
      boundsProved: false,
      idempotenceProved: true,
    })
    expect(family.capabilities['attempt.finalize']).toMatchObject({
      tablesProved: true,
      boundsProved: false,
      idempotenceProved: true,
    })
    expect(family.capabilities['chat.materialize-temporary']).toMatchObject({
      tablesProved: true,
      boundsProved: true,
      idempotenceProved: true,
    })
    expect(family.capabilities['draft.put']).toMatchObject({
      exactEffectsProved: true,
      tablesProved: true,
      boundsProved: false,
      idempotenceProved: true,
    })
    expect(family.capabilities['attachment.bytes.delete']).toMatchObject({
      exactEffectsProved: true,
      tablesProved: true,
      boundsProved: false,
      idempotenceProved: true,
    })
    expect(family.capabilities['attachment.bundle.write']).toMatchObject({
      exactEffectsProved: true,
      tablesProved: true,
      boundsProved: false,
      idempotenceProved: true,
    })
    expect(family.capabilities['attachment.delete-if-unreferenced']).toMatchObject({
      exactEffectsProved: true,
      tablesProved: true,
      boundsProved: false,
      idempotenceProved: true,
    })
    expect(family.capabilities['attachment.delete-many']).toMatchObject({
      exactEffectsProved: true,
      tablesProved: true,
      boundsProved: false,
      idempotenceProved: true,
    })
    expect(family.capabilities['attachment.reap']).toMatchObject({
      exactEffectsProved: true,
      tablesProved: true,
      boundsProved: false,
      idempotenceProved: true,
    })
    expect(Object.values(family.capabilities)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          physicalWritesProved: true,
          exactPhysicalWritesProved: true,
          exactEffectsProved: false,
          tablesProved: false,
          boundsProved: false,
          idempotenceProved: false,
        }),
      ]),
    )
    expect(runAudit('inventory').report.gapStageCounts).toMatchObject({
      physicalWrites: 0,
      receiptDelta: 0,
      idempotence: 0,
    })

    const semanticCapabilities = { ...facts.semanticCapabilities }
    for (const variant of family.declaredVariants) {
      semanticCapabilities[variant] = {
        ...semanticCapabilities[variant],
        physicalWritesProved: false,
        exactPhysicalWritesProved: false,
      }
    }
    const reopened = evaluateDurableCommandPipeline(
      canonicalInventory,
      'inventory',
      {},
      { ...(sourceFacts as object), semanticCapabilities },
    )
    expect(reopened.gapCells).toBe(
      runAudit('inventory').report.gapCells + family.declaredVariants.length,
    )
    expect(reopened.gapStageCounts.physicalWrites).toBe(
      (runAudit('inventory').report.gapStageCounts.physicalWrites ?? 0) +
        family.declaredVariants.length,
    )

    const withoutFixedReceipt = { ...facts.semanticCapabilities }
    for (const variant of family.fixedReceiptFamily.variants) {
      withoutFixedReceipt[variant] = {
        ...withoutFixedReceipt[variant],
        exactEffectsProved: false,
        idempotenceProved: false,
      }
    }
    const receiptReopened = evaluateDurableCommandPipeline(
      canonicalInventory,
      'inventory',
      {},
      { ...(sourceFacts as object), semanticCapabilities: withoutFixedReceipt },
    )
    expect(receiptReopened.gapCells).toBe(
      runAudit('inventory').report.gapCells + family.fixedReceiptFamily.variants.length * 2,
    )
    expect(receiptReopened.gapStageCounts.receiptDelta).toBe(
      (runAudit('inventory').report.gapStageCounts.receiptDelta ?? 0) +
        family.fixedReceiptFamily.variants.length,
    )
    expect(receiptReopened.gapStageCounts.idempotence).toBe(
      (runAudit('inventory').report.gapStageCounts.idempotence ?? 0) +
        family.fixedReceiptFamily.variants.length,
    )
  })

  it('reopens only the attachment-reference cells owned by each omitted source guarantee', async () => {
    const baseline = evaluateDurableCommandPipeline(
      canonicalInventory,
      'inventory',
      { detail: true },
      sourceFacts,
    ) as DurableCommandPipelineReport & {
      readonly gaps: readonly {
        readonly scope: string
        readonly variant: string
        readonly stage: string
      }[]
    }
    const browserRepoPath = resolve(ROOT, 'src/store/browser-repo.ts')
    const browserRepoSource = readFileSync(browserRepoPath, 'utf8')
    const mutationRuntimePath = resolve(ROOT, 'src/store/browser-mutation-runtime.ts')
    const mutationRuntimeSource = readFileSync(mutationRuntimePath, 'utf8')
    const attachmentReferencePath = resolve(ROOT, 'src/store/attachment-reference-edges.ts')
    const attachmentReferenceSource = readFileSync(attachmentReferencePath, 'utf8')
    const mutationPlanPath = resolve(ROOT, 'src/store/browser-mutation-plan.ts')
    const mutationPlanSource = readFileSync(mutationPlanPath, 'utf8')
    const { createProductionTypeScriptProgram } = (await import(TYPESCRIPT_SOURCE_URL)) as {
      createProductionTypeScriptProgram(
        root?: string,
        options?: {
          readonly sourceTextOverrides?: Readonly<Record<string, string>>
        },
      ): unknown
    }
    const replaceOwnerSource = (
      source: string,
      startToken: string,
      endToken: string,
      target: string,
      replacement: string,
    ): string => {
      const start = source.indexOf(startToken)
      const end = source.indexOf(endToken, start)
      expect(start).toBeGreaterThanOrEqual(0)
      expect(end).toBeGreaterThan(start)
      const owner = source.slice(start, end)
      expect(owner).toContain(target)
      return source.slice(0, start) + owner.replace(target, replacement) + source.slice(end)
    }
    const baselineKeys = new Set(
      baseline.gaps.map(({ scope, variant, stage }) => `${scope}:${variant}:${stage}`),
    )
    const reopenedFrom = (
      sourceTextOverrides: Readonly<Record<string, string>>,
    ): {
      readonly common: Readonly<Record<string, boolean>>
      readonly reopened: readonly string[]
      readonly gapCells: number
    } => {
      const facts = buildDurableCommandPipelineSourceFacts({
        program: createProductionTypeScriptProgram(ROOT, { sourceTextOverrides }),
      }) as {
        readonly scopeDerivedMutationFamily: {
          readonly fixedReceiptFamily: {
            readonly attachmentReference: {
              readonly commonKernel: Readonly<Record<string, boolean>>
            }
          }
        }
      }
      const result = evaluateDurableCommandPipeline(
        canonicalInventory,
        'inventory',
        { detail: true },
        facts,
      ) as DurableCommandPipelineReport & {
        readonly gaps: readonly {
          readonly scope: string
          readonly variant: string
          readonly stage: string
        }[]
      }
      return {
        common:
          facts.scopeDerivedMutationFamily.fixedReceiptFamily.attachmentReference.commonKernel,
        reopened: result.gaps
          .filter(({ scope, variant, stage }) => !baselineKeys.has(`${scope}:${variant}:${stage}`))
          .map(({ variant, stage }) => `${variant}:${stage}`)
          .sort(),
        gapCells: result.gapCells,
      }
    }
    const attachmentReceiptGaps = [
      'attachment.ref.add:receiptDelta',
      'attachment.ref.detach:receiptDelta',
      'attachment.ref.relink:receiptDelta',
      'attachment.ref.set-visibility:receiptDelta',
    ]
    const attachmentTableGaps = [
      'attachment.ref.add:tables',
      'attachment.ref.detach:tables',
      'attachment.ref.relink:tables',
      'attachment.ref.set-visibility:tables',
    ]
    const cases = [
      {
        name: 'single transaction owner',
        overrides: {
          'src/store/browser-repo.ts': replaceOwnerSource(
            browserRepoSource,
            'private async addAttachmentReference(',
            'private async setAttachmentReferenceVisibility(',
            'applyAttachmentReferenceOwnerMutations(',
            'applyAttachmentReferenceMutations(',
          ),
        },
        common: 'oneTransactionOwner',
        reopened: [...attachmentReceiptGaps, ...attachmentTableGaps].sort(),
      },
      {
        name: 'header-only message transition',
        overrides: {
          'src/store/browser-mutation-runtime.ts': replaceOwnerSource(
            mutationRuntimeSource,
            'replaceMessageAttachmentRefs: async (messageId, attachmentRefs) => {',
            'patchMessageStructure: async',
            "putPhysicalStorageRow(tx, 'messages', next, existing)",
            "putPhysicalStorageRow(tx, 'messages', existing, next)",
          ),
        },
        common: 'headerOnlyMessageTransition',
        reopened: [...attachmentReceiptGaps, ...attachmentTableGaps].sort(),
      },
      {
        name: 'exact attachment transition',
        overrides: {
          'src/store/attachment-reference-edges.ts': replaceOwnerSource(
            attachmentReferenceSource,
            'export async function applyAttachmentReferenceOwnerTransitions(',
            'async function applyAttachmentReferenceDeltas(',
            'const deltasReceipt = await applyAttachmentReferenceDeltas(',
            'const attachmentDeltasReceipt = await applyAttachmentReferenceDeltas(',
          ),
        },
        common: 'exactAttachmentTransition',
        reopened: attachmentReceiptGaps,
      },
      {
        name: 'typed replay policies',
        overrides: {
          'src/store/browser-mutation-plan.ts': replaceOwnerSource(
            mutationPlanSource,
            "case 'attachment.ref.relink':",
            "case 'attempt.finalize':",
            "replayReason: 'non-replayable'",
            "replayReason: 'unfenced-relative-update'",
          ),
        },
        common: 'typedReplayPolicies',
        reopened: [
          'attachment.ref.add:idempotence',
          'attachment.ref.detach:idempotence',
          'attachment.ref.relink:idempotence',
          'attachment.ref.set-visibility:idempotence',
        ],
      },
    ] as const

    for (const scenario of cases) {
      const result = reopenedFrom(scenario.overrides)
      const expected = withForegroundCommandFootprintBounds(scenario.reopened)
      expect(result.common[scenario.common], scenario.name).toBe(false)
      expect(result.reopened, scenario.name).toEqual(expected)
      expect(result.gapCells, scenario.name).toBe(baseline.gapCells + expected.length)
    }
  }, 180_000)

  it('reopens only the draft cells owned by each omitted source guarantee', async () => {
    const baseline = evaluateDurableCommandPipeline(
      canonicalInventory,
      'inventory',
      { detail: true },
      sourceFacts,
    ) as DurableCommandPipelineReport & {
      readonly gaps: readonly {
        readonly scope: string
        readonly variant: string
        readonly stage: string
      }[]
    }
    const browserRepoPath = resolve(ROOT, 'src/store/browser-repo.ts')
    const browserRepoSource = readFileSync(browserRepoPath, 'utf8')
    const mutationRuntimePath = resolve(ROOT, 'src/store/browser-mutation-runtime.ts')
    const mutationRuntimeSource = readFileSync(mutationRuntimePath, 'utf8')
    const attachmentReferencePath = resolve(ROOT, 'src/store/attachment-reference-edges.ts')
    const attachmentReferenceSource = readFileSync(attachmentReferencePath, 'utf8')
    const attachmentsPath = resolve(ROOT, 'src/store/attachments.ts')
    const attachmentsSource = readFileSync(attachmentsPath, 'utf8')
    const mutationPlanPath = resolve(ROOT, 'src/store/browser-mutation-plan.ts')
    const mutationPlanSource = readFileSync(mutationPlanPath, 'utf8')
    const { createProductionTypeScriptProgram } = (await import(TYPESCRIPT_SOURCE_URL)) as {
      createProductionTypeScriptProgram(
        root?: string,
        options?: {
          readonly sourceTextOverrides?: Readonly<Record<string, string>>
        },
      ): unknown
    }
    const replaceOwnerSource = (
      source: string,
      startToken: string,
      endToken: string,
      target: string,
      replacement: string,
    ): string => {
      const start = source.indexOf(startToken)
      const end = source.indexOf(endToken, start)
      expect(start).toBeGreaterThanOrEqual(0)
      expect(end).toBeGreaterThan(start)
      const owner = source.slice(start, end)
      expect(owner).toContain(target)
      return source.slice(0, start) + owner.replace(target, replacement) + source.slice(end)
    }
    const baselineKeys = new Set(
      baseline.gaps.map(({ scope, variant, stage }) => `${scope}:${variant}:${stage}`),
    )
    const reopenedFrom = (
      sourceTextOverrides: Readonly<Record<string, string>>,
    ): {
      readonly common: Readonly<Record<string, boolean>>
      readonly reopened: readonly string[]
      readonly gapCells: number
    } => {
      const facts = buildDurableCommandPipelineSourceFacts({
        program: createProductionTypeScriptProgram(ROOT, { sourceTextOverrides }),
      }) as {
        readonly scopeDerivedMutationFamily: {
          readonly fixedReceiptFamily: {
            readonly draftPut: {
              readonly commonKernel: Readonly<Record<string, boolean>>
            }
          }
        }
      }
      const result = evaluateDurableCommandPipeline(
        canonicalInventory,
        'inventory',
        { detail: true },
        facts,
      ) as DurableCommandPipelineReport & {
        readonly gaps: readonly {
          readonly scope: string
          readonly variant: string
          readonly stage: string
        }[]
      }
      return {
        common: facts.scopeDerivedMutationFamily.fixedReceiptFamily.draftPut.commonKernel,
        reopened: result.gaps
          .filter(({ scope, variant, stage }) => !baselineKeys.has(`${scope}:${variant}:${stage}`))
          .map(({ variant, stage }) => `${variant}:${stage}`)
          .sort(),
        gapCells: result.gapCells,
      }
    }
    const cases = [
      {
        name: 'preflight exact read',
        overrides: {
          'src/store/browser-repo.ts': replaceOwnerSource(
            browserRepoSource,
            'async function readDraftPutPlan(',
            'async function attachmentOwnerMessageHeader(',
            "operation: 'get',",
            "operation: 'query',",
          ),
        },
        common: 'typedCommandLifetimePreflight',
        reopened: ['draft.put:receiptDelta', 'draft.put:tables'],
      },
      {
        name: 'attachment resource plan',
        overrides: {
          'src/store/browser-repo.ts': replaceOwnerSource(
            browserRepoSource,
            'private async putDraftRow(',
            'private async claimGeneratedOutputLocalization(',
            "attachmentOwnerScopes({ kind: 'draft', chatId: input.draft.chatId }, attachmentIds)",
            "attachmentOwnerScopes({ kind: 'draft', chatId: input.draft.chatId }, [])",
          ),
        },
        common: 'exactResourcePlan',
        reopened: ['draft.put:receiptDelta', 'draft.put:tables'],
      },
      {
        name: 'durable draft writer',
        overrides: {
          'src/store/browser-mutation-runtime.ts': replaceOwnerSource(
            mutationRuntimeSource,
            'putDraft: async (draft, draftOptions) => {',
            'const mutationOperations: BrowserMutationOperations',
            'await putDraftByteOwner(tx, normalized, existing)',
            'await Promise.resolve()',
          ),
        },
        common: 'constructivePhysicalAccess',
        reopened: ['draft.put:receiptDelta', 'draft.put:tables'],
      },
      {
        name: 'attachment dependency receipt',
        overrides: {
          'src/store/attachment-reference-edges.ts': replaceOwnerSource(
            attachmentReferenceSource,
            'function attachmentReferenceTransitionReceipt(',
            'async function requireAttachmentTargets(',
            `dependencies:
        mutationAttachmentIds.length > 0
          ? [{ kind: 'attachment', attachmentIds: mutationAttachmentIds }]
          : [],`,
            'dependencies: [],',
          ),
        },
        common: 'constructiveExactReceipt',
        reopened: [
          'attachment.ref.add:receiptDelta',
          'attachment.ref.detach:receiptDelta',
          'attachment.ref.relink:receiptDelta',
          'attachment.ref.set-visibility:receiptDelta',
          'draft.put:receiptDelta',
        ],
      },
      {
        name: 'application submission iteration',
        overrides: {
          'src/store/attachments.ts': replaceOwnerSource(
            attachmentsSource,
            'export async function putWorkspaceDraft(',
            'function metadataAndOptionalBlob(',
            `const commit = await runWorkspaceAction('attachment', (permit) =>
    getWorkspaceRepository().execute(permit, {
      kind: 'draft.put',
      input: { draft, expectedUpdatedAt },
    }),
  )
  return commit.value`,
            `const commits = []
  for (let submission = 0; submission < 2; submission += 1) {
    const commit = await runWorkspaceAction('attachment', (permit) =>
      getWorkspaceRepository().execute(permit, {
        kind: 'draft.put',
        input: { draft, expectedUpdatedAt },
      }),
    )
    commits.push(commit)
  }
  return commits[0].value`,
          ),
        },
        common: 'oneApplicationSubmission',
        reopened: ['draft.put:bounds', 'draft.put:idempotence'],
      },
      {
        name: 'typed replay policy',
        overrides: {
          'src/store/browser-mutation-plan.ts': replaceOwnerSource(
            mutationPlanSource,
            "case 'draft.put':",
            "case 'attempt.finalize':",
            "replayReason: 'unfenced-relative-update'",
            "replayReason: 'non-replayable'",
          ),
        },
        common: 'typedReplayPolicy',
        reopened: ['draft.put:idempotence'],
      },
    ] as const

    for (const scenario of cases) {
      const result = reopenedFrom(scenario.overrides)
      const expected = withForegroundCommandFootprintBounds(scenario.reopened)
      expect(result.common[scenario.common], scenario.name).toBe(false)
      expect(result.reopened, scenario.name).toEqual(expected)
      expect(result.gapCells, scenario.name).toBe(baseline.gapCells + expected.length)
    }
  }, 180_000)

  it('reopens only the attachment-byte cells owned by each omitted source guarantee', async () => {
    const baseline = evaluateDurableCommandPipeline(
      canonicalInventory,
      'inventory',
      { detail: true },
      sourceFacts,
    ) as DurableCommandPipelineReport & {
      readonly gaps: readonly {
        readonly scope: string
        readonly variant: string
        readonly stage: string
      }[]
    }
    const browserRepoPath = resolve(ROOT, 'src/store/browser-repo.ts')
    const browserRepoSource = readFileSync(browserRepoPath, 'utf8')
    const mutationRuntimePath = resolve(ROOT, 'src/store/browser-mutation-runtime.ts')
    const mutationRuntimeSource = readFileSync(mutationRuntimePath, 'utf8')
    const attachmentsPath = resolve(ROOT, 'src/store/attachments.ts')
    const attachmentsSource = readFileSync(attachmentsPath, 'utf8')
    const mutationPlanPath = resolve(ROOT, 'src/store/browser-mutation-plan.ts')
    const mutationPlanSource = readFileSync(mutationPlanPath, 'utf8')
    const { createProductionTypeScriptProgram } = (await import(TYPESCRIPT_SOURCE_URL)) as {
      createProductionTypeScriptProgram(
        root?: string,
        options?: {
          readonly sourceTextOverrides?: Readonly<Record<string, string>>
        },
      ): unknown
    }
    const replaceOwnerSource = (
      source: string,
      startToken: string,
      endToken: string,
      target: string,
      replacement: string,
    ): string => {
      const start = source.indexOf(startToken)
      const end = source.indexOf(endToken, start)
      expect(start).toBeGreaterThanOrEqual(0)
      expect(end).toBeGreaterThan(start)
      const owner = source.slice(start, end)
      expect(owner).toContain(target)
      return source.slice(0, start) + owner.replace(target, replacement) + source.slice(end)
    }
    const baselineKeys = new Set(
      baseline.gaps.map(({ scope, variant, stage }) => `${scope}:${variant}:${stage}`),
    )
    const reopenedFrom = (
      sourceTextOverrides: Readonly<Record<string, string>>,
    ): {
      readonly common: Readonly<Record<string, boolean>>
      readonly reopened: readonly string[]
      readonly gapCells: number
    } => {
      const facts = buildDurableCommandPipelineSourceFacts({
        program: createProductionTypeScriptProgram(ROOT, { sourceTextOverrides }),
      }) as {
        readonly scopeDerivedMutationFamily: {
          readonly fixedReceiptFamily: {
            readonly attachmentBytesDelete: {
              readonly commonKernel: Readonly<Record<string, boolean>>
            }
          }
        }
      }
      const result = evaluateDurableCommandPipeline(
        canonicalInventory,
        'inventory',
        { detail: true },
        facts,
      ) as DurableCommandPipelineReport & {
        readonly gaps: readonly {
          readonly scope: string
          readonly variant: string
          readonly stage: string
        }[]
      }
      return {
        common:
          facts.scopeDerivedMutationFamily.fixedReceiptFamily.attachmentBytesDelete.commonKernel,
        reopened: result.gaps
          .filter(({ scope, variant, stage }) => !baselineKeys.has(`${scope}:${variant}:${stage}`))
          .map(({ variant, stage }) => `${variant}:${stage}`)
          .sort(),
        gapCells: result.gapCells,
      }
    }
    const cases = [
      {
        name: 'narrow payload transaction profile',
        overrides: {
          'src/store/browser-mutation-plan.ts': replaceOwnerSource(
            mutationPlanSource,
            'export function planMutationSemanticOperation(',
            'function scopeDerivedMutationReceiptPolicy(',
            `: command.kind === 'attachment.bytes.delete' || command.kind === 'attachment.bundle.write'
          ? 'attachment-payload'`,
            `: command.kind === 'attachment.bundle.write'
          ? 'attachment-payload'`,
          ),
        },
        common: 'narrowTransactionProfile',
        reopened: ['attachment.bytes.delete:receiptDelta', 'attachment.bytes.delete:tables'],
      },
      {
        name: 'shared typed transition',
        overrides: {
          'src/store/browser-repo.ts': replaceOwnerSource(
            browserRepoSource,
            'private async deleteAttachmentBytes(',
            'private async deleteAttachmentIfUnreferenced(',
            '(ctx) => ctx.deleteAttachmentBytes(input.attachmentId, input.reason, input.now),',
            '(ctx) => ctx.getAttachment(input.attachmentId),',
          ),
        },
        common: 'oneSemanticRoute',
        reopened: ['attachment.bytes.delete:receiptDelta', 'attachment.bytes.delete:tables'],
      },
      {
        name: 'catalog effect receipt',
        overrides: {
          'src/store/browser-mutation-runtime.ts': replaceOwnerSource(
            mutationRuntimeSource,
            'const deleteAttachmentBytesForHeader = async (',
            'const ctx: MutationContext = {',
            'absorbSemanticOperationReceiptFragment(tx, catalogReceipt.fragment)',
            'void catalogReceipt.fragment',
          ),
        },
        common: 'exactEffectReceipt',
        reopened: ['attachment.bytes.delete:receiptDelta', 'attachment.delete-many:receiptDelta'],
      },
      {
        name: 'application submission iteration',
        overrides: {
          'src/store/attachments.ts': replaceOwnerSource(
            attachmentsSource,
            'export async function deleteReferencedAttachmentBytes(',
            'export async function restoreMissingAttachment(',
            `const commit = await runWorkspaceAction('attachment', (permit) =>
    getWorkspaceRepository().execute(permit, {
      kind: 'attachment.bytes.delete',
      input: { attachmentId, reason, now },
    }),
  )
  return commit.value`,
            `const commits = []
  for (let submission = 0; submission < 2; submission += 1) {
    const commit = await runWorkspaceAction('attachment', (permit) =>
      getWorkspaceRepository().execute(permit, {
        kind: 'attachment.bytes.delete',
        input: { attachmentId, reason, now },
      }),
    )
    commits.push(commit)
  }
  return commits[0].value`,
          ),
        },
        common: 'oneApplicationSubmission',
        reopened: ['attachment.bytes.delete:idempotence'],
      },
      {
        name: 'typed replay policy',
        overrides: {
          'src/store/browser-mutation-plan.ts': replaceOwnerSource(
            mutationPlanSource,
            "case 'attachment.bytes.delete':",
            "case 'attempt.finalize':",
            "replayReason: 'unfenced-relative-update'",
            "replayReason: 'non-replayable'",
          ),
        },
        common: 'typedReplayPolicy',
        reopened: ['attachment.bytes.delete:idempotence'],
      },
    ] as const

    for (const scenario of cases) {
      const result = reopenedFrom(scenario.overrides)
      const expected = withForegroundCommandFootprintBounds(scenario.reopened)
      expect(result.common[scenario.common], scenario.name).toBe(false)
      expect(result.reopened, scenario.name).toEqual(expected)
      expect(result.gapCells, scenario.name).toBe(baseline.gapCells + expected.length)
    }
  }, 240_000)

  it('reopens only the attachment-bundle cells owned by each omitted source guarantee', async () => {
    const baseline = evaluateDurableCommandPipeline(
      canonicalInventory,
      'inventory',
      { detail: true },
      sourceFacts,
    ) as DurableCommandPipelineReport & {
      readonly gaps: readonly {
        readonly scope: string
        readonly variant: string
        readonly stage: string
      }[]
    }
    const browserRepoSource = readFileSync(resolve(ROOT, 'src/store/browser-repo.ts'), 'utf8')
    const mutationRuntimeSource = readFileSync(
      resolve(ROOT, 'src/store/browser-mutation-runtime.ts'),
      'utf8',
    )
    const attachmentsSource = readFileSync(resolve(ROOT, 'src/store/attachments.ts'), 'utf8')
    const mutationPlanSource = readFileSync(
      resolve(ROOT, 'src/store/browser-mutation-plan.ts'),
      'utf8',
    )
    const { createProductionTypeScriptProgram } = (await import(TYPESCRIPT_SOURCE_URL)) as {
      createProductionTypeScriptProgram(
        root?: string,
        options?: {
          readonly sourceTextOverrides?: Readonly<Record<string, string>>
        },
      ): unknown
    }
    const replaceOwnerSource = (
      source: string,
      startToken: string,
      endToken: string,
      target: string,
      replacement: string,
    ): string => {
      const start = source.indexOf(startToken)
      const end = source.indexOf(endToken, start)
      expect(start).toBeGreaterThanOrEqual(0)
      expect(end).toBeGreaterThan(start)
      const owner = source.slice(start, end)
      expect(owner).toContain(target)
      return source.slice(0, start) + owner.replace(target, replacement) + source.slice(end)
    }
    const baselineKeys = new Set(
      baseline.gaps.map(({ scope, variant, stage }) => `${scope}:${variant}:${stage}`),
    )
    const reopenedFrom = (
      sourceTextOverrides: Readonly<Record<string, string>>,
    ): {
      readonly common: Readonly<Record<string, boolean>>
      readonly reopened: readonly string[]
      readonly gapCells: number
    } => {
      const facts = buildDurableCommandPipelineSourceFacts({
        program: createProductionTypeScriptProgram(ROOT, { sourceTextOverrides }),
      }) as {
        readonly scopeDerivedMutationFamily: {
          readonly fixedReceiptFamily: {
            readonly attachmentBundleWrite: {
              readonly commonKernel: Readonly<Record<string, boolean>>
            }
          }
        }
      }
      const result = evaluateDurableCommandPipeline(
        canonicalInventory,
        'inventory',
        { detail: true },
        facts,
      ) as DurableCommandPipelineReport & {
        readonly gaps: readonly {
          readonly scope: string
          readonly variant: string
          readonly stage: string
        }[]
      }
      return {
        common:
          facts.scopeDerivedMutationFamily.fixedReceiptFamily.attachmentBundleWrite.commonKernel,
        reopened: result.gaps
          .filter(({ scope, variant, stage }) => !baselineKeys.has(`${scope}:${variant}:${stage}`))
          .map(({ variant, stage }) => `${variant}:${stage}`)
          .sort(),
        gapCells: result.gapCells,
      }
    }
    const cases = [
      {
        name: 'narrow payload transaction profile',
        overrides: {
          'src/store/browser-mutation-plan.ts': replaceOwnerSource(
            mutationPlanSource,
            'export function planMutationSemanticOperation(',
            'function scopeDerivedMutationReceiptPolicy(',
            `: command.kind === 'attachment.bytes.delete' || command.kind === 'attachment.bundle.write'
          ? 'attachment-payload'`,
            `: command.kind === 'attachment.bytes.delete'
          ? 'attachment-payload'`,
          ),
        },
        common: 'narrowTransactionProfile',
        reopened: ['attachment.bundle.write:receiptDelta', 'attachment.bundle.write:tables'],
      },
      {
        name: 'shared typed transition',
        overrides: {
          'src/store/browser-repo.ts': replaceOwnerSource(
            browserRepoSource,
            'private async writeAttachmentBundle(',
            'private async addAttachmentReference(',
            '(ctx) => ctx.writeAttachmentBundle(bundle, mode),',
            '(ctx) => ctx.getAttachment(bundle.attachment.id),',
          ),
        },
        common: 'oneSemanticRoute',
        reopened: ['attachment.bundle.write:receiptDelta', 'attachment.bundle.write:tables'],
      },
      {
        name: 'exact batched sidecar read',
        overrides: {
          'src/store/browser-mutation-runtime.ts': replaceOwnerSource(
            mutationRuntimeSource,
            'writeAttachmentBundle: async (',
            'putAttachment: async (attachment) => {',
            'rowCount: deleted.jobs,',
            'rowCount: 0,',
          ),
        },
        common: 'exactPhysicalReads',
        reopened: ['attachment.bundle.write:receiptDelta', 'attachment.bundle.write:tables'],
      },
      {
        name: 'catalog effect receipt',
        overrides: {
          'src/store/browser-mutation-runtime.ts': replaceOwnerSource(
            mutationRuntimeSource,
            'writeAttachmentBundle: async (',
            'putAttachment: async (attachment) => {',
            'absorbSemanticOperationReceiptFragment(tx, catalogReceipt.fragment)',
            'void catalogReceipt.fragment',
          ),
        },
        common: 'exactEffectReceipt',
        reopened: ['attachment.bundle.write:receiptDelta'],
      },
      {
        name: 'application submission iteration',
        overrides: {
          'src/store/attachments.ts': replaceOwnerSource(
            attachmentsSource,
            'async function writeAttachmentBundle(',
            'function remoteAttachment(',
            `return runWorkspaceAction('attachment', (permit) =>
    getWorkspaceRepository()
      .execute(permit, { kind: 'attachment.bundle.write', input: { bundle, mode } })
      .then((commit) => commit.value),
  )`,
            `let result
  for (let submission = 0; submission < 2; submission += 1) {
    result = await runWorkspaceAction('attachment', (permit) =>
      getWorkspaceRepository()
        .execute(permit, { kind: 'attachment.bundle.write', input: { bundle, mode } })
        .then((commit) => commit.value),
    )
  }
  return result`,
          ),
        },
        common: 'oneApplicationSubmission',
        reopened: ['attachment.bundle.write:idempotence'],
      },
      {
        name: 'typed replay policy',
        overrides: {
          'src/store/browser-mutation-plan.ts': replaceOwnerSource(
            mutationPlanSource,
            "case 'attachment.bundle.write':",
            "case 'attempt.finalize':",
            "replayReason: 'unfenced-relative-update'",
            "replayReason: 'non-replayable'",
          ),
        },
        common: 'typedReplayPolicy',
        reopened: ['attachment.bundle.write:idempotence'],
      },
    ] as const

    for (const scenario of cases) {
      const result = reopenedFrom(scenario.overrides)
      const expected = withForegroundCommandFootprintBounds(scenario.reopened)
      expect(result.common[scenario.common], scenario.name).toBe(false)
      expect(result.reopened, scenario.name).toEqual(expected)
      expect(result.gapCells, scenario.name).toBe(baseline.gapCells + expected.length)
    }
  }, 240_000)

  it('reopens only the unreferenced-attachment deletion cells owned by each omitted guarantee', async () => {
    const baseline = evaluateDurableCommandPipeline(
      canonicalInventory,
      'inventory',
      { detail: true },
      sourceFacts,
    ) as DurableCommandPipelineReport & {
      readonly gaps: readonly {
        readonly scope: string
        readonly variant: string
        readonly stage: string
      }[]
    }
    const browserRepoSource = readFileSync(resolve(ROOT, 'src/store/browser-repo.ts'), 'utf8')
    const mutationRuntimeSource = readFileSync(
      resolve(ROOT, 'src/store/browser-mutation-runtime.ts'),
      'utf8',
    )
    const attachmentCatalogSource = readFileSync(
      resolve(ROOT, 'src/store/attachment-catalog-projection.ts'),
      'utf8',
    )
    const attachmentsSource = readFileSync(resolve(ROOT, 'src/store/attachments.ts'), 'utf8')
    const mutationPlanSource = readFileSync(
      resolve(ROOT, 'src/store/browser-mutation-plan.ts'),
      'utf8',
    )
    const { createProductionTypeScriptProgram } = (await import(TYPESCRIPT_SOURCE_URL)) as {
      createProductionTypeScriptProgram(
        root?: string,
        options?: {
          readonly sourceTextOverrides?: Readonly<Record<string, string>>
        },
      ): unknown
    }
    const replaceOwnerSource = (
      source: string,
      startToken: string,
      endToken: string,
      target: string,
      replacement: string,
    ): string => {
      const start = source.indexOf(startToken)
      const end = source.indexOf(endToken, start)
      expect(start).toBeGreaterThanOrEqual(0)
      expect(end).toBeGreaterThan(start)
      const owner = source.slice(start, end)
      expect(owner).toContain(target)
      return source.slice(0, start) + owner.replace(target, replacement) + source.slice(end)
    }
    const baselineKeys = new Set(
      baseline.gaps.map(({ scope, variant, stage }) => `${scope}:${variant}:${stage}`),
    )
    const reopenedFrom = (
      sourceTextOverrides: Readonly<Record<string, string>>,
    ): {
      readonly common: Readonly<Record<string, boolean>>
      readonly reopened: readonly string[]
      readonly gapCells: number
    } => {
      const facts = buildDurableCommandPipelineSourceFacts({
        program: createProductionTypeScriptProgram(ROOT, { sourceTextOverrides }),
      }) as {
        readonly scopeDerivedMutationFamily: {
          readonly fixedReceiptFamily: {
            readonly attachmentDeleteIfUnreferenced: {
              readonly commonKernel: Readonly<Record<string, boolean>>
            }
          }
        }
      }
      const result = evaluateDurableCommandPipeline(
        canonicalInventory,
        'inventory',
        { detail: true },
        facts,
      ) as DurableCommandPipelineReport & {
        readonly gaps: readonly {
          readonly scope: string
          readonly variant: string
          readonly stage: string
        }[]
      }
      return {
        common:
          facts.scopeDerivedMutationFamily.fixedReceiptFamily.attachmentDeleteIfUnreferenced
            .commonKernel,
        reopened: result.gaps
          .filter(({ scope, variant, stage }) => !baselineKeys.has(`${scope}:${variant}:${stage}`))
          .map(({ variant, stage }) => `${variant}:${stage}`)
          .sort(),
        gapCells: result.gapCells,
      }
    }
    const cases = [
      {
        name: 'typed transaction-local route',
        overrides: {
          'src/store/browser-repo.ts': replaceOwnerSource(
            browserRepoSource,
            'private async deleteAttachmentIfUnreferenced(',
            'private async deleteManyAttachments(',
            '(ctx) => ctx.deleteAttachmentIfUnreferenced(attachmentId),',
            '(ctx) => ctx.getAttachment(attachmentId),',
          ),
        },
        common: 'oneSemanticRoute',
        reopened: [
          'attachment.delete-if-unreferenced:receiptDelta',
          'attachment.delete-if-unreferenced:tables',
        ],
      },
      {
        name: 'exact reference-edge transaction profile',
        overrides: {
          'src/store/browser-mutation-plan.ts': mutationPlanSource.replace(
            `command.kind === 'attachment.bytes.delete' || command.kind === 'attachment.bundle.write'`,
            `command.kind === 'attachment.bytes.delete' ||
        command.kind === 'attachment.bundle.write' ||
        command.kind === 'attachment.delete-if-unreferenced'`,
          ),
        },
        common: 'exactAttachmentTransactionProfile',
        reopened: [
          'attachment.delete-if-unreferenced:receiptDelta',
          'attachment.delete-if-unreferenced:tables',
        ],
      },
      {
        name: 'complete payload read receipt',
        overrides: {
          'src/store/browser-mutation-runtime.ts': replaceOwnerSource(
            mutationRuntimeSource,
            'const deleteAttachmentOwnerBundle = async (',
            'const ctx: MutationContext = {',
            'rowCount: deleted.blobs,',
            'rowCount: 0,',
          ),
        },
        common: 'exactPhysicalReads',
        reopened: [
          'attachment.delete-if-unreferenced:receiptDelta',
          'attachment.delete-if-unreferenced:tables',
        ],
      },
      {
        name: 'shared complete payload deletion',
        overrides: {
          'src/store/browser-mutation-runtime.ts': replaceOwnerSource(
            mutationRuntimeSource,
            'const deleteAttachmentOwnerBundle = async (',
            'const ctx: MutationContext = {',
            'deleteAttachmentByteOwnerBundle(tx, attachmentId, existing)',
            'deleteAttachmentBlobRows(tx, attachmentId, existing)',
          ),
        },
        common: 'oneBatchedPhysicalTransition',
        reopened: [
          'attachment.delete-if-unreferenced:receiptDelta',
          'attachment.delete-if-unreferenced:tables',
        ],
      },
      {
        name: 'catalog deletion receipt operation',
        overrides: {
          'src/store/attachment-catalog-projection.ts': replaceOwnerSource(
            attachmentCatalogSource,
            'export async function deleteAttachmentCatalogProjection(',
            'export async function applyAttachmentCatalogReferenceDeltas(',
            "'delete',",
            "'write',",
          ),
        },
        common: 'exactEffectReceipt',
        reopened: [
          'attachment.delete-if-unreferenced:receiptDelta',
          'attachment.delete-many:receiptDelta',
          'attachment.reap:receiptDelta',
        ],
      },
      {
        name: 'application submission iteration',
        overrides: {
          'src/store/attachments.ts': replaceOwnerSource(
            attachmentsSource,
            'export async function deleteUnreferencedAttachment(',
            'export async function countLiveRefs(',
            `const commit = await runWorkspaceAction('attachment', (permit) =>
    getWorkspaceRepository().execute(permit, {
      kind: 'attachment.delete-if-unreferenced',
      attachmentId,
    }),
  )
  return commit.value`,
            `let commit
  for (let submission = 0; submission < 2; submission += 1) {
    commit = await runWorkspaceAction('attachment', (permit) =>
      getWorkspaceRepository().execute(permit, {
        kind: 'attachment.delete-if-unreferenced',
        attachmentId,
      }),
    )
  }
  return commit.value`,
          ),
        },
        common: 'oneApplicationSubmission',
        reopened: ['attachment.delete-if-unreferenced:idempotence'],
      },
      {
        name: 'typed replay policy',
        overrides: {
          'src/store/browser-mutation-plan.ts': replaceOwnerSource(
            mutationPlanSource,
            "case 'attachment.delete-if-unreferenced':",
            "case 'attachment.delete-many':",
            "replayReason: 'unfenced-relative-update'",
            "replayReason: 'non-replayable'",
          ),
        },
        common: 'typedReplayPolicy',
        reopened: ['attachment.delete-if-unreferenced:idempotence'],
      },
    ] as const

    for (const scenario of cases) {
      const result = reopenedFrom(scenario.overrides)
      const expected = withForegroundCommandFootprintBounds(scenario.reopened)
      expect(result.common[scenario.common], scenario.name).toBe(false)
      expect(result.reopened, scenario.name).toEqual(expected)
      expect(result.gapCells, scenario.name).toBe(baseline.gapCells + expected.length)
    }
  }, 300_000)

  it('reopens only the delete-many cells owned by each omitted guarantee', async () => {
    const baseline = evaluateDurableCommandPipeline(
      canonicalInventory,
      'inventory',
      { detail: true },
      sourceFacts,
    ) as DurableCommandPipelineReport & {
      readonly gaps: readonly {
        readonly scope: string
        readonly variant: string
        readonly stage: string
      }[]
    }
    const browserRepoSource = readFileSync(resolve(ROOT, 'src/store/browser-repo.ts'), 'utf8')
    const mutationRuntimeSource = readFileSync(
      resolve(ROOT, 'src/store/browser-mutation-runtime.ts'),
      'utf8',
    )
    const attachmentBulkDeleteSource = readFileSync(
      resolve(ROOT, 'src/store/attachment-bulk-delete.ts'),
      'utf8',
    )
    const mutationPlanSource = readFileSync(
      resolve(ROOT, 'src/store/browser-mutation-plan.ts'),
      'utf8',
    )
    const { createProductionTypeScriptProgram } = (await import(TYPESCRIPT_SOURCE_URL)) as {
      createProductionTypeScriptProgram(
        root?: string,
        options?: {
          readonly sourceTextOverrides?: Readonly<Record<string, string>>
        },
      ): unknown
    }
    const replaceOwnerSource = (
      source: string,
      startToken: string,
      endToken: string,
      target: string,
      replacement: string,
    ): string => {
      const start = source.indexOf(startToken)
      const end = source.indexOf(endToken, start)
      expect(start).toBeGreaterThanOrEqual(0)
      expect(end).toBeGreaterThan(start)
      const owner = source.slice(start, end)
      expect(owner).toContain(target)
      return source.slice(0, start) + owner.replace(target, replacement) + source.slice(end)
    }
    const baselineKeys = new Set(
      baseline.gaps.map(({ scope, variant, stage }) => `${scope}:${variant}:${stage}`),
    )
    const reopenedFrom = (
      sourceTextOverrides: Readonly<Record<string, string>>,
    ): {
      readonly common: Readonly<Record<string, boolean>>
      readonly reopened: readonly string[]
      readonly gapCells: number
    } => {
      const facts = buildDurableCommandPipelineSourceFacts({
        program: createProductionTypeScriptProgram(ROOT, { sourceTextOverrides }),
      }) as {
        readonly scopeDerivedMutationFamily: {
          readonly fixedReceiptFamily: {
            readonly attachmentDeleteMany: {
              readonly commonKernel: Readonly<Record<string, boolean>>
            }
          }
        }
      }
      const result = evaluateDurableCommandPipeline(
        canonicalInventory,
        'inventory',
        { detail: true },
        facts,
      ) as DurableCommandPipelineReport & {
        readonly gaps: readonly {
          readonly scope: string
          readonly variant: string
          readonly stage: string
        }[]
      }
      return {
        common:
          facts.scopeDerivedMutationFamily.fixedReceiptFamily.attachmentDeleteMany.commonKernel,
        reopened: result.gaps
          .filter(({ scope, variant, stage }) => !baselineKeys.has(`${scope}:${variant}:${stage}`))
          .map(({ variant, stage }) => `${variant}:${stage}`)
          .sort(),
        gapCells: result.gapCells,
      }
    }
    const cases = [
      {
        name: 'typed transaction-local disposition',
        overrides: {
          'src/store/browser-repo.ts': replaceOwnerSource(
            browserRepoSource,
            'private async deleteManyAttachments(',
            'private async reapAttachments(',
            'ctx.deleteAttachmentForStorage(',
            'ctx.deleteAttachmentBytes(',
          ),
        },
        common: 'oneSemanticRoute',
        reopened: ['attachment.delete-many:receiptDelta', 'attachment.delete-many:tables'],
      },
      {
        name: 'bounded reference-presence receipt',
        overrides: {
          'src/store/browser-mutation-runtime.ts': replaceOwnerSource(
            mutationRuntimeSource,
            'const readAttachmentDispositionState = async (',
            'const requireConsistentAttachmentDispositionState = (',
            'rowCount: firstReference ? 1 : 0,',
            'rowCount: 0,',
          ),
        },
        common: 'exactPhysicalReads',
        reopened: [
          'attachment.delete-if-unreferenced:receiptDelta',
          'attachment.delete-if-unreferenced:tables',
          'attachment.delete-many:receiptDelta',
          'attachment.delete-many:tables',
        ],
      },
      {
        name: 'pre-read catalog receipt reuse',
        overrides: {
          'src/store/browser-mutation-runtime.ts': replaceOwnerSource(
            mutationRuntimeSource,
            'deleteAttachmentForStorage: async (attachmentId, reason, deletionNow) => {',
            'putAttachment: async (attachment) => {',
            'deletionNow,\n            current.catalogRow,',
            'deletionNow,\n            undefined,',
          ),
        },
        common: 'exactEffectReceipt',
        reopened: ['attachment.delete-many:receiptDelta'],
      },
      {
        name: 'non-overlapping application slices',
        overrides: {
          'src/store/attachment-bulk-delete.ts': replaceOwnerSource(
            attachmentBulkDeleteSource,
            'export async function executeAttachmentBulkDelete(',
            'function normalizeSearch(',
            '.slice(index, index + BULK_DELETE_COMMAND_SIZE)',
            '.slice(0, BULK_DELETE_COMMAND_SIZE)',
          ),
        },
        common: 'oneApplicationSubmission',
        reopened: ['attachment.delete-many:idempotence'],
      },
      {
        name: 'typed non-replayable policy',
        overrides: {
          'src/store/browser-mutation-plan.ts': replaceOwnerSource(
            mutationPlanSource,
            "case 'attachment.delete-many':",
            "case 'attachment.reap':",
            "replayReason: 'non-replayable'",
            "replayReason: 'unfenced-relative-update'",
          ),
        },
        common: 'typedReplayPolicy',
        reopened: ['attachment.delete-many:idempotence'],
      },
    ] as const

    for (const scenario of cases) {
      const result = reopenedFrom(scenario.overrides)
      const expected = withForegroundCommandFootprintBounds(scenario.reopened)
      expect(result.common[scenario.common], scenario.name).toBe(false)
      expect(result.reopened, scenario.name).toEqual(expected)
      expect(result.gapCells, scenario.name).toBe(baseline.gapCells + expected.length)
    }
  }, 300_000)

  it('reopens the attachment-reap cells when its typed page contract is weakened', async () => {
    const baseline = evaluateDurableCommandPipeline(
      canonicalInventory,
      'inventory',
      { detail: true },
      sourceFacts,
    ) as DurableCommandPipelineReport & {
      readonly gaps: readonly {
        readonly scope: string
        readonly variant: string
        readonly stage: string
      }[]
    }
    const browserRepoSource = readFileSync(resolve(ROOT, 'src/store/browser-repo.ts'), 'utf8')
    const mutationRuntimeSource = readFileSync(
      resolve(ROOT, 'src/store/browser-mutation-runtime.ts'),
      'utf8',
    )
    const { createProductionTypeScriptProgram } = (await import(TYPESCRIPT_SOURCE_URL)) as {
      createProductionTypeScriptProgram(
        root?: string,
        options?: {
          readonly sourceTextOverrides?: Readonly<Record<string, string>>
        },
      ): unknown
    }
    const replaceOwnerSource = (
      source: string,
      startToken: string,
      endToken: string,
      target: string,
      replacement: string,
    ): string => {
      const start = source.indexOf(startToken)
      const end = source.indexOf(endToken, start)
      expect(start).toBeGreaterThanOrEqual(0)
      expect(end).toBeGreaterThan(start)
      const owner = source.slice(start, end)
      expect(owner).toContain(target)
      return source.slice(0, start) + owner.replace(target, replacement) + source.slice(end)
    }
    const baselineKeys = new Set(
      baseline.gaps.map(({ scope, variant, stage }) => `${scope}:${variant}:${stage}`),
    )
    const reopenedFrom = (
      sourceTextOverrides: Readonly<Record<string, string>>,
    ): {
      readonly common: Readonly<Record<string, boolean>>
      readonly reopened: readonly string[]
      readonly gapCells: number
    } => {
      const facts = buildDurableCommandPipelineSourceFacts({
        program: createProductionTypeScriptProgram(ROOT, { sourceTextOverrides }),
      }) as {
        readonly scopeDerivedMutationFamily: {
          readonly fixedReceiptFamily: {
            readonly attachmentReap: {
              readonly commonKernel: Readonly<Record<string, boolean>>
            }
          }
        }
      }
      const result = evaluateDurableCommandPipeline(
        canonicalInventory,
        'inventory',
        { detail: true },
        facts,
      ) as DurableCommandPipelineReport & {
        readonly gaps: readonly {
          readonly scope: string
          readonly variant: string
          readonly stage: string
        }[]
      }
      return {
        common: facts.scopeDerivedMutationFamily.fixedReceiptFamily.attachmentReap.commonKernel,
        reopened: result.gaps
          .filter(({ scope, variant, stage }) => !baselineKeys.has(`${scope}:${variant}:${stage}`))
          .map(({ variant, stage }) => `${variant}:${stage}`)
          .sort(),
        gapCells: result.gapCells,
      }
    }
    const cases = [
      {
        name: 'command-lifetime preflight receipt',
        overrides: {
          'src/store/browser-repo.ts': replaceOwnerSource(
            browserRepoSource,
            'async function readAttachmentReapPlan(',
            'function protocolDiscoveryCacheEvictions(',
            'rowCount: plan.candidates.length,',
            'rowCount: 0,',
          ),
        },
        common: 'exactPreflightReceipt',
        reopened: ['attachment.reap:receiptDelta', 'attachment.reap:tables'],
      },
      {
        name: 'shared bounded disposition snapshot',
        overrides: {
          'src/store/browser-mutation-runtime.ts': replaceOwnerSource(
            mutationRuntimeSource,
            'const readAttachmentDispositionState = async (',
            'const requireConsistentAttachmentDispositionState = (',
            '.first()',
            '.toArray()',
          ),
        },
        common: 'sharedCurrentStateTransition',
        reopened: [
          'attachment.delete-if-unreferenced:receiptDelta',
          'attachment.delete-if-unreferenced:tables',
          'attachment.delete-many:receiptDelta',
          'attachment.delete-many:tables',
          'attachment.reap:receiptDelta',
          'attachment.reap:tables',
        ],
      },
      {
        name: 'retention-state receipt absorption',
        overrides: {
          'src/store/browser-repo.ts': replaceOwnerSource(
            browserRepoSource,
            'private async reapAttachments(',
            'private async putDraftRow(',
            'receipt.absorb(await commitStorageRetentionPage(tx, cycle, outcome))',
            'await commitStorageRetentionPage(tx, cycle, outcome)',
          ),
        },
        common: 'exactTransactionReceipt',
        reopened: ['attachment.reap:receiptDelta'],
      },
      {
        name: 'durable page replay identity',
        overrides: {
          'src/store/browser-repo.ts': replaceOwnerSource(
            browserRepoSource,
            'function attachmentReapReplayPlan(',
            'async function readAttachmentReapPlan(',
            "owner: 'storage-retention:attachment-reap'",
            "owner: 'storage-retention:other'",
          ),
        },
        common: 'typedDurableReplay',
        reopened: ['attachment.reap:idempotence'],
      },
    ] as const

    for (const scenario of cases) {
      const result = reopenedFrom(scenario.overrides)
      const expected = withForegroundCommandFootprintBounds(scenario.reopened)
      expect(result.common[scenario.common], scenario.name).toBe(false)
      expect(result.reopened, scenario.name).toEqual(expected)
      expect(result.gapCells, scenario.name).toBe(baseline.gapCells + expected.length)
    }
  }, 300_000)

  it('reopens exactly the presentation-message table and bound cells', () => {
    const facts = sourceFacts as {
      readonly semanticCapabilities: Readonly<Record<string, Readonly<Record<string, unknown>>>>
      readonly scopeDerivedMutationFamily: {
        readonly fixedReceiptFamily: {
          readonly presentationOnly: { readonly variants: readonly string[] }
        }
      }
    }
    const variants = facts.scopeDerivedMutationFamily.fixedReceiptFamily.presentationOnly.variants
    const semanticCapabilities = { ...facts.semanticCapabilities }
    for (const variant of variants) {
      semanticCapabilities[variant] = {
        ...semanticCapabilities[variant],
        tablesProved: false,
        boundsProved: false,
      }
    }
    const result = evaluateDurableCommandPipeline(
      canonicalInventory,
      'inventory',
      { detail: true },
      { ...(sourceFacts as object), semanticCapabilities },
    ) as DurableCommandPipelineReport & {
      readonly gaps: readonly {
        readonly scope: string
        readonly variant: string
        readonly stage: string
      }[]
    }

    expect(result.gapCells).toBe(runAudit('inventory').report.gapCells + variants.length * 2)
    expect(
      result.gaps
        .filter(({ scope, variant }) => scope === 'workspace' && variants.includes(variant))
        .map(({ variant, stage }) => `${variant}:${stage}`)
        .sort(),
    ).toEqual(variants.flatMap((variant) => [`${variant}:bounds`, `${variant}:tables`]).sort())
  })

  it('reopens exactly the attempt dispatch table, replay, and bound cells', () => {
    const facts = sourceFacts as {
      readonly semanticCapabilities: Readonly<Record<string, Readonly<Record<string, unknown>>>>
    }
    const semanticCapabilities = {
      ...facts.semanticCapabilities,
      'attempt.dispatch': {
        ...facts.semanticCapabilities['attempt.dispatch'],
        tablesProved: false,
        boundsProved: false,
        idempotenceProved: false,
      },
    }
    const result = evaluateDurableCommandPipeline(
      canonicalInventory,
      'inventory',
      { detail: true },
      { ...(sourceFacts as object), semanticCapabilities },
    ) as DurableCommandPipelineReport & {
      readonly gaps: readonly {
        readonly scope: string
        readonly variant: string
        readonly stage: string
      }[]
    }

    expect(result.gapCells).toBe(runAudit('inventory').report.gapCells + 3)
    expect(
      result.gaps
        .filter(({ scope, variant }) => scope === 'workspace' && variant === 'attempt.dispatch')
        .map(({ stage }) => stage)
        .sort(),
    ).toEqual(['bounds', 'idempotence', 'tables'])
  })

  it('reopens exactly the attempt preparation table cell', () => {
    const facts = sourceFacts as {
      readonly semanticCapabilities: Readonly<Record<string, Readonly<Record<string, unknown>>>>
    }
    const variant = 'attempt.prepare'
    const semanticCapabilities = {
      ...facts.semanticCapabilities,
      [variant]: {
        ...facts.semanticCapabilities[variant],
        tablesProved: false,
      },
    }
    const baseline = evaluateDurableCommandPipeline(
      canonicalInventory,
      'inventory',
      { detail: true },
      sourceFacts,
    ) as DurableCommandPipelineReport & {
      readonly gaps: readonly {
        readonly scope: string
        readonly variant: string
        readonly stage: string
      }[]
    }
    const result = evaluateDurableCommandPipeline(
      canonicalInventory,
      'inventory',
      { detail: true },
      { ...(sourceFacts as object), semanticCapabilities },
    ) as DurableCommandPipelineReport & {
      readonly gaps: readonly {
        readonly scope: string
        readonly variant: string
        readonly stage: string
      }[]
    }

    expect(result.gapCells).toBe(baseline.gapCells + 1)
    const baselineGapKeys = new Set(
      baseline.gaps.map(({ scope, variant, stage }) => `${scope}:${variant}:${stage}`),
    )
    expect(
      result.gaps
        .filter(
          ({ scope, variant: gapVariant, stage }) =>
            !baselineGapKeys.has(`${scope}:${gapVariant}:${stage}`),
        )
        .map(({ stage }) => stage),
    ).toEqual(['tables'])
  })

  it('reopens exactly the temporary-chat table and bound cells', () => {
    const facts = sourceFacts as {
      readonly semanticCapabilities: Readonly<Record<string, Readonly<Record<string, unknown>>>>
    }
    const variant = 'chat.materialize-temporary'
    const semanticCapabilities = {
      ...facts.semanticCapabilities,
      [variant]: {
        ...facts.semanticCapabilities[variant],
        tablesProved: false,
        boundsProved: false,
      },
    }
    const result = evaluateDurableCommandPipeline(
      canonicalInventory,
      'inventory',
      { detail: true },
      { ...(sourceFacts as object), semanticCapabilities },
    ) as DurableCommandPipelineReport & {
      readonly gaps: readonly {
        readonly scope: string
        readonly variant: string
        readonly stage: string
      }[]
    }

    expect(result.gapCells).toBe(runAudit('inventory').report.gapCells + 2)
    expect(
      result.gaps
        .filter(({ scope, variant: gapVariant }) => scope === 'workspace' && gapVariant === variant)
        .map(({ stage }) => stage)
        .sort(),
    ).toEqual(['bounds', 'tables'])
  })

  it('reopens exactly the attempt finalization table and replay cells', () => {
    const facts = sourceFacts as {
      readonly semanticCapabilities: Readonly<Record<string, Readonly<Record<string, unknown>>>>
    }
    const variant = 'attempt.finalize'
    const semanticCapabilities = {
      ...facts.semanticCapabilities,
      [variant]: {
        ...facts.semanticCapabilities[variant],
        tablesProved: false,
        idempotenceProved: false,
      },
    }
    const baseline = evaluateDurableCommandPipeline(
      canonicalInventory,
      'inventory',
      { detail: true },
      sourceFacts,
    ) as DurableCommandPipelineReport & {
      readonly gaps: readonly {
        readonly scope: string
        readonly variant: string
        readonly stage: string
      }[]
    }
    const result = evaluateDurableCommandPipeline(
      canonicalInventory,
      'inventory',
      { detail: true },
      { ...(sourceFacts as object), semanticCapabilities },
    ) as DurableCommandPipelineReport & {
      readonly gaps: readonly {
        readonly scope: string
        readonly variant: string
        readonly stage: string
      }[]
    }

    const baselineGapKeys = new Set(
      baseline.gaps.map(({ scope, variant, stage }) => `${scope}:${variant}:${stage}`),
    )
    expect(result.gapCells).toBe(baseline.gapCells + 2)
    expect(
      result.gaps
        .filter(
          ({ scope, variant: gapVariant, stage }) =>
            !baselineGapKeys.has(`${scope}:${gapVariant}:${stage}`),
        )
        .filter(({ scope, variant: gapVariant }) => scope === 'workspace' && gapVariant === variant)
        .map(({ stage }) => stage)
        .sort(),
    ).toEqual(['idempotence', 'tables'])
  })

  it('reopens every credited table and bound cell when the shared command lifetime breaks', () => {
    const facts = sourceFacts as {
      readonly commandLifetimeReceipt: {
        readonly commonKernel: Readonly<Record<string, boolean>>
      }
    }
    const baseline = evaluateDurableCommandPipeline(
      canonicalInventory,
      'inventory',
      { detail: true },
      sourceFacts,
    ) as DurableCommandPipelineReport & {
      readonly gaps: readonly {
        readonly scope: string
        readonly variant: string
        readonly stage: string
      }[]
    }
    const result = evaluateDurableCommandPipeline(
      canonicalInventory,
      'inventory',
      { detail: true },
      {
        ...(sourceFacts as object),
        commandLifetimeReceipt: {
          commonKernel: {
            ...facts.commandLifetimeReceipt.commonKernel,
            cachedFenceInsideAuthoritativeGate: false,
          },
        },
      },
    ) as DurableCommandPipelineReport & {
      readonly gaps: readonly {
        readonly scope: string
        readonly variant: string
        readonly stage: string
      }[]
    }
    const baselineGapKeys = new Set(
      baseline.gaps.map(({ scope, variant, stage }) => `${scope}:${variant}:${stage}`),
    )
    const reopened = result.gaps.filter(
      ({ scope, variant, stage }) => !baselineGapKeys.has(`${scope}:${variant}:${stage}`),
    )
    const expectedReopened =
      baseline.pipelineRecords * 2 -
      ((baseline.gapStageCounts.tables ?? 0) + (baseline.gapStageCounts.bounds ?? 0))

    expect(result.gapCells).toBe(baseline.gapCells + expectedReopened)
    expect(result.gapStageCounts.tables).toBe(baseline.pipelineRecords)
    expect(result.gapStageCounts.bounds).toBe(baseline.pipelineRecords)
    expect(reopened).toHaveLength(expectedReopened)
    expect(reopened.every(({ stage }) => stage === 'tables' || stage === 'bounds')).toBe(true)
  })

  it('derives both single-chat metadata receipts from one transaction-local executor', () => {
    const facts = sourceFacts as {
      readonly singleChatMetadataFamily: {
        readonly variants: readonly string[]
        readonly commonKernel: Readonly<Record<string, boolean>>
        readonly capabilities: Readonly<
          Record<
            string,
            {
              readonly tablesProved: boolean
              readonly exactEffectsProved: boolean
              readonly boundsProved: boolean
              readonly idempotenceProved: boolean
            }
          >
        >
      }
    }

    expect(facts.singleChatMetadataFamily.variants).toEqual([
      'chat.touch-viewed',
      'chat.set-manual-title',
    ])
    expect(Object.values(facts.singleChatMetadataFamily.commonKernel).every(Boolean)).toBe(true)
    expect(Object.values(facts.singleChatMetadataFamily.capabilities)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tablesProved: true,
          exactEffectsProved: true,
          boundsProved: true,
          byteBoundsProved: false,
          idempotenceProved: true,
        }),
      ]),
    )
  })

  it('derives archive mutation from one consumed preflight plan and exact transaction receipt', () => {
    const facts = sourceFacts as {
      readonly chatSetArchivedFamily: {
        readonly variant: string
        readonly commonKernel: Readonly<Record<string, boolean>>
        readonly capabilities: Readonly<
          Record<
            string,
            {
              readonly tablesProved: boolean
              readonly exactEffectsProved: boolean
              readonly boundsProved: boolean
              readonly byteBoundsProved: boolean
              readonly idempotenceProved: boolean
            }
          >
        >
      }
    }

    expect(facts.chatSetArchivedFamily.variant).toBe('chat.set-archived')
    expect(Object.values(facts.chatSetArchivedFamily.commonKernel).every(Boolean)).toBe(true)
    expect(facts.chatSetArchivedFamily.capabilities['chat.set-archived']).toMatchObject({
      tablesProved: true,
      exactEffectsProved: true,
      boundsProved: true,
      byteBoundsProved: false,
      idempotenceProved: true,
    })
  })

  it('reopens exactly the archive, prepare, and move cells from source omissions', async () => {
    const baseline = evaluateDurableCommandPipeline(
      canonicalInventory,
      'inventory',
      { detail: true },
      sourceFacts,
    ) as DurableCommandPipelineReport & {
      readonly gaps: readonly {
        readonly scope: string
        readonly variant: string
        readonly stage: string
      }[]
    }
    const sourcePath = resolve(ROOT, 'src/store/browser-catalog-command-runtime.ts')
    const sourceText = readFileSync(sourcePath, 'utf8')
    const mutationTarget = 'commit.readSemanticOperationPreflight('
    expect(sourceText).toContain(mutationTarget)
    const receiptMutationTarget = 'semanticOperationExactReceipt(plan.exactPlan, {'
    expect(sourceText).toContain(receiptMutationTarget)
    let mutatedSource = sourceText
      .replace(mutationTarget, 'commit.readUntrackedSemanticOperationPreflight(')
      .replace(receiptMutationTarget, 'semanticOperationUntrackedReceipt(plan.exactPlan, {')
    const descriptorStart = mutatedSource.indexOf('const CHAT_SET_ARCHIVED_OPERATION')
    const descriptorEnd = mutatedSource.indexOf(
      'const CHAT_SET_ARCHIVED_PREFLIGHT_TRANSACTION_CAPABILITY',
      descriptorStart,
    )
    expect(descriptorStart).toBeGreaterThanOrEqual(0)
    expect(descriptorEnd).toBeGreaterThan(descriptorStart)
    const descriptorText = mutatedSource.slice(descriptorStart, descriptorEnd)
    const replayMutationTarget =
      "replay: semanticOperationCallerSingleAttemptReplayContract('unfenced-relative-update')"
    expect(descriptorText).toContain(replayMutationTarget)
    mutatedSource =
      mutatedSource.slice(0, descriptorStart) +
      descriptorText.replace(
        replayMutationTarget,
        "replay: semanticOperationUntrackedReplayContract('unfenced-relative-update')",
      ) +
      mutatedSource.slice(descriptorEnd)
    const replaceOwnerSource = (
      source: string,
      startToken: string,
      endToken: string,
      target: string,
      replacement: string,
    ) => {
      const start = source.indexOf(startToken)
      const end = source.indexOf(endToken, start)
      expect(start).toBeGreaterThanOrEqual(0)
      expect(end).toBeGreaterThan(start)
      const owner = source.slice(start, end)
      expect(owner).toContain(target)
      return source.slice(0, start) + owner.replace(target, replacement) + source.slice(end)
    }
    mutatedSource = replaceOwnerSource(
      mutatedSource,
      'const CHAT_MOVE_TO_FOLDER_OPERATION',
      'const CHAT_SET_TAGS_FROM_NAMES_OPERATION',
      'semanticOperationExactReceiptContracts<ChatMoveToFolderPlan, PhysicalStorageTableName>()',
      'semanticOperationUntrackedReceiptContracts<ChatMoveToFolderPlan, PhysicalStorageTableName>()',
    )
    mutatedSource = replaceOwnerSource(
      mutatedSource,
      'const CHAT_MOVE_TO_FOLDER_OPERATION',
      'const CHAT_SET_TAGS_FROM_NAMES_OPERATION',
      replayMutationTarget,
      "replay: semanticOperationUntrackedReplayContract('unfenced-relative-update')",
    )
    mutatedSource = replaceOwnerSource(
      mutatedSource,
      'function chatMoveToFolderExactPlan',
      'function chatMoveToFolderLinkedResourceNames',
      'maxRows: 28 * chatCount + 4',
      'maxRows: 27 * chatCount + 4',
    )
    mutatedSource = replaceOwnerSource(
      mutatedSource,
      'async function readChatMoveToFolderPlan',
      'function chatMoveToFolderReceipt',
      'commit.readSemanticOperationPreflight(',
      'commit.readUntrackedSemanticOperationPreflight(',
    )
    mutatedSource = replaceOwnerSource(
      mutatedSource,
      'function chatMoveToFolderReceipt',
      'function chatMoveToFolderResult',
      'semanticOperationExactReceipt(plan.exactPlan, {',
      'semanticOperationUntrackedReceipt(plan.exactPlan, {',
    )
    const mutationPlanPath = resolve(ROOT, 'src/store/browser-mutation-plan.ts')
    const mutationPlanSource = readFileSync(mutationPlanPath, 'utf8')
    const prepareReplayTarget = `case 'attempt.prepare':
      return {
        replayReason: 'random-identity',
      }`
    expect(mutationPlanSource).toContain(prepareReplayTarget)
    const mutatedMutationPlanSource = mutationPlanSource.replace(
      prepareReplayTarget,
      `case 'attempt.prepare':
      return {}`,
    )
    const admissionPath = resolve(ROOT, 'src/store/generation-admission-controller.ts')
    const admissionSource = readFileSync(admissionPath, 'utf8')
    const streamIdentityTarget = 'const streamId = newId()'
    expect(admissionSource).toContain(streamIdentityTarget)
    const mutatedAdmissionSource = admissionSource.replace(
      streamIdentityTarget,
      'const streamId = claimId',
    )
    const { createProductionTypeScriptProgram } = (await import(TYPESCRIPT_SOURCE_URL)) as {
      createProductionTypeScriptProgram(
        root?: string,
        options?: {
          readonly sourceTextOverrides?: Readonly<Record<string, string>>
        },
      ): unknown
    }
    const mutatedFacts = buildDurableCommandPipelineSourceFacts({
      program: createProductionTypeScriptProgram(ROOT, {
        sourceTextOverrides: {
          'src/store/browser-catalog-command-runtime.ts': mutatedSource,
          'src/store/browser-mutation-plan.ts': mutatedMutationPlanSource,
          'src/store/generation-admission-controller.ts': mutatedAdmissionSource,
        },
      }),
    }) as {
      readonly chatSetArchivedFamily: {
        readonly commonKernel: Readonly<Record<string, boolean>>
      }
      readonly chatOrganizationFamily: {
        readonly moveToFolder: Readonly<Record<string, boolean>>
      }
      readonly scopeDerivedMutationFamily: {
        readonly fixedReceiptFamily: {
          readonly attemptPrepare: {
            readonly replayCommonKernel: Readonly<Record<string, boolean>>
          }
        }
      }
    }
    expect(mutatedFacts.chatSetArchivedFamily.commonKernel.oneBoundedPreflight).toBe(false)
    expect(mutatedFacts.chatSetArchivedFamily.commonKernel.exactReceipt).toBe(false)
    expect(mutatedFacts.chatSetArchivedFamily.commonKernel.typedReplayPolicy).toBe(false)
    expect(mutatedFacts.chatOrganizationFamily.moveToFolder.exactTypedDescriptor).toBe(false)
    expect(mutatedFacts.chatOrganizationFamily.moveToFolder.typedReplayPolicy).toBe(false)
    expect(mutatedFacts.chatOrganizationFamily.moveToFolder.typedCommandLifetimePreflight).toBe(
      false,
    )
    expect(mutatedFacts.chatOrganizationFamily.moveToFolder.exactReceipt).toBe(false)
    expect(mutatedFacts.chatOrganizationFamily.moveToFolder.centralizedInputShapedBounds).toBe(
      false,
    )
    expect(
      mutatedFacts.scopeDerivedMutationFamily.fixedReceiptFamily.attemptPrepare.replayCommonKernel
        .typedSingleAttemptPolicy,
    ).toBe(false)
    expect(
      mutatedFacts.scopeDerivedMutationFamily.fixedReceiptFamily.attemptPrepare.replayCommonKernel
        .freshStreamIdentity,
    ).toBe(false)
    const result = evaluateDurableCommandPipeline(
      canonicalInventory,
      'inventory',
      { detail: true },
      mutatedFacts,
    ) as DurableCommandPipelineReport & {
      readonly gaps: readonly {
        readonly scope: string
        readonly variant: string
        readonly stage: string
      }[]
    }
    const baselineKeys = new Set(
      baseline.gaps.map(({ scope, variant, stage }) => `${scope}:${variant}:${stage}`),
    )

    const reopenedGaps = result.gaps
      .filter(({ scope, variant, stage }) => !baselineKeys.has(`${scope}:${variant}:${stage}`))
      .map(({ variant, stage }) => `${variant}:${stage}`)
      .sort()
    expect(reopenedGaps).toEqual([
      'attempt.prepare:idempotence',
      'chat.move-to-folder:bounds',
      'chat.move-to-folder:idempotence',
      'chat.move-to-folder:receiptDelta',
      'chat.move-to-folder:tables',
      'chat.set-archived:bounds',
      'chat.set-archived:idempotence',
      'chat.set-archived:receiptDelta',
      'chat.set-archived:tables',
    ])
    expect(result.gapCells).toBe(baseline.gapCells + reopenedGaps.length)
  }, 30_000)

  it('derives page-shaped calibration receipts without a total-operation bound', () => {
    const facts = sourceFacts as {
      readonly chatCalibrationFamily: {
        readonly variants: readonly string[]
        readonly commonKernel: Readonly<Record<string, boolean>>
        readonly capabilities: Readonly<
          Record<
            string,
            {
              readonly tablesProved: boolean
              readonly exactEffectsProved: boolean
              readonly boundsProved: boolean
              readonly byteBoundsProved: boolean
              readonly idempotenceProved: boolean
            }
          >
        >
      }
    }

    expect(facts.chatCalibrationFamily.variants).toEqual([
      'chat.calibration.clear',
      'chat.calibration.clear-family',
      'chat.calibration.clear-all',
    ])
    expect(Object.values(facts.chatCalibrationFamily.commonKernel).every(Boolean)).toBe(true)
    expect(facts.chatCalibrationFamily.capabilities['chat.calibration.clear']).toMatchObject({
      tablesProved: true,
      exactEffectsProved: true,
      boundsProved: true,
      byteBoundsProved: false,
      idempotenceProved: true,
    })
    for (const kind of ['chat.calibration.clear-family', 'chat.calibration.clear-all']) {
      expect(facts.chatCalibrationFamily.capabilities[kind]).toMatchObject({
        tablesProved: true,
        exactEffectsProved: true,
        boundsProved: false,
        byteBoundsProved: false,
        idempotenceProved: true,
      })
    }
  })

  it('reopens every newly closed metadata, stream, and calibration proof cell independently', () => {
    const facts = sourceFacts as {
      readonly semanticCapabilities: Readonly<Record<string, Readonly<Record<string, unknown>>>>
    }
    const semanticCapabilities = { ...facts.semanticCapabilities }
    for (const kind of [
      'chat.touch-viewed',
      'chat.set-manual-title',
      'chat.calibration.clear',
      'chat.calibration.clear-family',
      'chat.calibration.clear-all',
    ]) {
      semanticCapabilities[kind] = {
        ...semanticCapabilities[kind],
        idempotenceProved: false,
      }
    }
    for (const kind of [
      'chat.touch-viewed',
      'chat.set-manual-title',
      'chat.calibration.clear',
      'stream.append-journal-frames',
      'stream.finish-cleanup',
      'maintenance.reconcile-stream-journal-integrity',
      'maintenance.prune-terminal-stream-journals',
    ]) {
      semanticCapabilities[kind] = {
        ...semanticCapabilities[kind],
        boundsProved: false,
      }
    }
    for (const kind of [
      'chat.calibration.clear',
      'chat.calibration.clear-family',
      'chat.calibration.clear-all',
    ]) {
      semanticCapabilities[kind] = {
        ...semanticCapabilities[kind],
        tablesProved: false,
        exactEffectsProved: false,
      }
    }

    const result = evaluateDurableCommandPipeline(
      canonicalInventory,
      'inventory',
      {},
      { ...(sourceFacts as object), semanticCapabilities },
    )

    const baseline = runAudit('inventory').report
    expect(result.gapCells).toBe(baseline.gapCells + 18)
    expect(result.gapStageCounts).toMatchObject({
      tables: (baseline.gapStageCounts.tables ?? 0) + 3,
      physicalWrites: baseline.gapStageCounts.physicalWrites ?? 0,
      receiptDelta: (baseline.gapStageCounts.receiptDelta ?? 0) + 3,
      idempotence: (baseline.gapStageCounts.idempotence ?? 0) + 5,
      bounds: (baseline.gapStageCounts.bounds ?? 0) + 7,
    })
  })

  it('derives all six lease transitions from one exact per-stream semantic family', () => {
    const facts = sourceFacts as {
      readonly streamLeaseOperationFamily: {
        readonly variants: readonly string[]
        readonly commonKernel: Readonly<Record<string, boolean>>
        readonly capabilities: Readonly<Record<string, { readonly idempotenceProved: boolean }>>
      }
    }

    expect(facts.streamLeaseOperationFamily.variants).toEqual([
      'attempt.request-stop',
      'attempt.seal-terminal',
      'stream.note-selected-key',
      'stream.renew',
      'stream.handoff-recovery',
      'stream.claim-recovery',
    ])
    expect(Object.values(facts.streamLeaseOperationFamily.commonKernel).every(Boolean)).toBe(true)
    expect(
      Object.entries(facts.streamLeaseOperationFamily.capabilities)
        .filter(([, capability]) => capability.idempotenceProved)
        .map(([kind]) => kind),
    ).toEqual([
      'attempt.request-stop',
      'attempt.seal-terminal',
      'stream.note-selected-key',
      'stream.renew',
      'stream.handoff-recovery',
      'stream.claim-recovery',
    ])
  })

  it('derives journal append from one active-writer exact receipt', () => {
    const facts = sourceFacts as {
      readonly streamJournalAppendFamily: {
        readonly variants: readonly string[]
        readonly commonKernel: Readonly<Record<string, boolean>>
        readonly capabilities: Readonly<
          Record<
            string,
            {
              readonly tablesProved: boolean
              readonly exactEffectsProved: boolean
              readonly boundsProved: boolean
              readonly idempotenceProved: boolean
            }
          >
        >
      }
    }

    expect(facts.streamJournalAppendFamily.variants).toEqual(['stream.append-journal-frames'])
    expect(Object.values(facts.streamJournalAppendFamily.commonKernel).every(Boolean)).toBe(true)
    expect(
      facts.streamJournalAppendFamily.capabilities['stream.append-journal-frames'],
    ).toMatchObject({
      tablesProved: true,
      exactEffectsProved: true,
      boundsProved: true,
      byteBoundsProved: false,
      idempotenceProved: true,
    })
  })

  it('derives all three journal retirement commands from one bounded exact page owner', () => {
    const facts = sourceFacts as {
      readonly streamJournalRetirementFamily: {
        readonly variants: readonly string[]
        readonly commonKernel: Readonly<Record<string, boolean>>
        readonly capabilities: Readonly<
          Record<
            string,
            {
              readonly tablesProved: boolean
              readonly exactEffectsProved: boolean
              readonly boundsProved: boolean
              readonly idempotenceProved: boolean
            }
          >
        >
      }
    }

    expect(facts.streamJournalRetirementFamily.variants).toEqual([
      'stream.finish-cleanup',
      'maintenance.reconcile-stream-journal-integrity',
      'maintenance.prune-terminal-stream-journals',
    ])
    expect(Object.values(facts.streamJournalRetirementFamily.commonKernel).every(Boolean)).toBe(
      true,
    )
    expect(Object.values(facts.streamJournalRetirementFamily.capabilities)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tablesProved: true,
          exactEffectsProved: true,
          boundsProved: true,
          byteBoundsProved: false,
          idempotenceProved: true,
        }),
      ]),
    )
  })

  it('derives the key-material family from one typed receipt atom', () => {
    const facts = sourceFacts as {
      readonly configurationKeyMaterialFamily: {
        readonly variants: readonly string[]
        readonly routesByVariant: Readonly<
          Record<
            string,
            { readonly consumed: boolean; readonly legacyTerminals: readonly string[] }
          >
        >
        readonly commonKernel: Readonly<Record<string, boolean>>
      }
    }
    const family = facts.configurationKeyMaterialFamily

    expect(family.variants).toEqual(['key.delete', 'key.material-replace', 'key.put'])
    expect(Object.values(family.routesByVariant).every((route) => route.consumed)).toBe(true)
    expect(
      Object.values(family.routesByVariant).every((route) => route.legacyTerminals.length === 0),
    ).toBe(true)
    expect(Object.values(family.commonKernel).every(Boolean)).toBe(true)
  })

  it('derives the settings family from its executable handler routes and exact atom', () => {
    const facts = sourceFacts as {
      readonly configurationSettingFamily: {
        readonly variants: readonly string[]
        readonly routesByVariant: Readonly<
          Record<
            string,
            { readonly consumed: boolean; readonly legacyTerminals: readonly string[] }
          >
        >
        readonly commonKernel: Readonly<Record<string, boolean>>
        readonly capabilities: Readonly<Record<string, { readonly idempotenceProved: boolean }>>
      }
    }
    const family = facts.configurationSettingFamily

    expect(family.variants).toHaveLength(11)
    expect(Object.values(family.routesByVariant).every((route) => route.consumed)).toBe(true)
    expect(
      Object.values(family.routesByVariant).every((route) => route.legacyTerminals.length === 0),
    ).toBe(true)
    expect(Object.values(family.commonKernel).every(Boolean)).toBe(true)
    expect(
      Object.values(family.capabilities).every((capability) => capability.idempotenceProved),
    ).toBe(true)
  })

  it('withholds all setting-row replay credit without the typed single-attempt owner', () => {
    const facts = sourceFacts as {
      readonly semanticCapabilities: Readonly<Record<string, Readonly<Record<string, unknown>>>>
      readonly configurationSettingFamily: {
        readonly variants: readonly string[]
      }
    }
    const semanticCapabilities = { ...facts.semanticCapabilities }
    for (const variant of facts.configurationSettingFamily.variants) {
      semanticCapabilities[variant] = {
        ...semanticCapabilities[variant],
        idempotenceProved: false,
      }
    }

    const result = evaluateDurableCommandPipeline(
      canonicalInventory,
      'inventory',
      {},
      { ...(sourceFacts as object), semanticCapabilities },
    )

    const baseline = runAudit('inventory').report
    expect(result.gapCells).toBe(baseline.gapCells + 11)
    expect(result.gapStageCounts.idempotence).toBe((baseline.gapStageCounts.idempotence ?? 0) + 11)
  })

  it('derives exact configuration replay credit from typed plans and real production ingresses', () => {
    const facts = sourceFacts as {
      readonly semanticCapabilities: Readonly<
        Record<string, { readonly idempotenceProved: boolean }>
      >
      readonly configurationReplayOwnership: {
        readonly typedReplayVariants: readonly string[]
        readonly callerPolicyVariants: readonly string[]
        readonly callerPolicyDescriptors: readonly string[]
        readonly constructedVariants: readonly string[]
        readonly constructorlessVariants: readonly string[]
        readonly ordinaryVariants: readonly string[]
        readonly keyVariants: readonly string[]
        readonly switchVariants: readonly string[]
        readonly resolutionVariants: readonly string[]
        readonly provedVariants: readonly string[]
        readonly ordinaryConstructorSubmitFacts: readonly {
          readonly variant: string
          readonly owner: string
          readonly singleSubmit: boolean
        }[]
        readonly commonKernel: Readonly<Record<string, boolean>>
      }
    }
    const replay = facts.configurationReplayOwnership

    expect(replay.typedReplayVariants).toHaveLength(33)
    expect(replay.callerPolicyVariants).toEqual([])
    expect(replay.callerPolicyDescriptors).toEqual([])
    expect(replay.constructedVariants).toHaveLength(33)
    expect(replay.constructorlessVariants).toEqual([])
    expect(replay.ordinaryVariants).toHaveLength(27)
    expect(replay.keyVariants).toEqual([
      'key.delete',
      'key.material-replace',
      'key.put',
      'key.touch',
    ])
    expect(replay.switchVariants).toEqual(['chat.switch-profile'])
    expect(replay.resolutionVariants).toEqual(['chat.resolve-model'])
    expect(replay.provedVariants).toEqual(replay.constructedVariants)
    expect(replay.ordinaryConstructorSubmitFacts.length).toBeGreaterThan(0)
    expect(replay.ordinaryConstructorSubmitFacts.every((fact) => fact.singleSubmit)).toBe(true)
    expect(Object.values(replay.commonKernel).every(Boolean)).toBe(true)
    expect(
      replay.provedVariants.every(
        (variant) => facts.semanticCapabilities[variant]?.idempotenceProved,
      ),
    ).toBe(true)
    expect(
      replay.constructorlessVariants.every(
        (variant) => !facts.semanticCapabilities[variant]?.idempotenceProved,
      ),
    ).toBe(true)
  })

  it('withholds all 33 configuration replay cells without their typed ingress proof', () => {
    const facts = sourceFacts as {
      readonly semanticCapabilities: Readonly<Record<string, Readonly<Record<string, unknown>>>>
      readonly configurationReplayOwnership: {
        readonly provedVariants: readonly string[]
      }
    }
    const semanticCapabilities = { ...facts.semanticCapabilities }
    for (const variant of facts.configurationReplayOwnership.provedVariants) {
      semanticCapabilities[variant] = {
        ...semanticCapabilities[variant],
        idempotenceProved: false,
      }
    }

    const result = evaluateDurableCommandPipeline(
      canonicalInventory,
      'inventory',
      {},
      { ...(sourceFacts as object), semanticCapabilities },
    )

    const baseline = runAudit('inventory').report
    expect(result.gapCells).toBe(baseline.gapCells + 33)
    expect(result.gapStageCounts.idempotence).toBe((baseline.gapStageCounts.idempotence ?? 0) + 33)
  })

  it('derives the single-row entity family from its executable handler routes and exact atom', () => {
    const facts = sourceFacts as {
      readonly configurationEntityRowFamily: {
        readonly variants: readonly string[]
        readonly routesByVariant: Readonly<
          Record<
            string,
            { readonly consumed: boolean; readonly legacyTerminals: readonly string[] }
          >
        >
        readonly commonKernel: Readonly<Record<string, boolean>>
      }
    }
    const family = facts.configurationEntityRowFamily

    expect(family.variants).toEqual(['key.touch', 'text-template.create', 'text-template.update'])
    expect(Object.values(family.routesByVariant).every((route) => route.consumed)).toBe(true)
    expect(
      Object.values(family.routesByVariant).every((route) => route.legacyTerminals.length === 0),
    ).toBe(true)
    expect(Object.values(family.commonKernel).every(Boolean)).toBe(true)
  })

  it('derives the linked-chat family from its executable routes and dynamic receipt', () => {
    const facts = sourceFacts as {
      readonly configurationChatFamily: {
        readonly variants: readonly string[]
        readonly routesByVariant: Readonly<
          Record<
            string,
            { readonly consumed: boolean; readonly legacyTerminals: readonly string[] }
          >
        >
        readonly commonKernel: Readonly<Record<string, boolean>>
      }
    }
    const family = facts.configurationChatFamily

    expect(family.variants).toEqual([
      'chat.settings-fields-patch',
      'chat.settings-patch',
      'chat.settings-replace',
      'prompt-preset.local-commit',
    ])
    expect(Object.values(family.routesByVariant).every((route) => route.consumed)).toBe(true)
    expect(
      Object.values(family.routesByVariant).every((route) => route.legacyTerminals.length === 0),
    ).toBe(true)
    expect(Object.values(family.commonKernel).every(Boolean)).toBe(true)
  })

  it('derives the remaining cataloged-row family from current product intents', () => {
    const facts = sourceFacts as {
      readonly configurationCatalogedRowFamily: {
        readonly variants: readonly string[]
        readonly routesByVariant: Readonly<
          Record<
            string,
            { readonly consumed: boolean; readonly legacyTerminals: readonly string[] }
          >
        >
        readonly commonKernel: Readonly<Record<string, boolean>>
      }
      readonly constructorsByConfigurationVariant: Readonly<Record<string, readonly unknown[]>>
    }
    const family = facts.configurationCatalogedRowFamily

    expect(family.variants).toEqual(['connection.touch', 'prompt-preset.rename'])
    expect(Object.values(family.routesByVariant).every((route) => route.consumed)).toBe(true)
    expect(
      Object.values(family.routesByVariant).every((route) => route.legacyTerminals.length === 0),
    ).toBe(true)
    expect(Object.values(family.commonKernel).every(Boolean)).toBe(true)
    expect(facts.constructorsByConfigurationVariant['connection.touch']).not.toHaveLength(0)
    expect(facts.constructorsByConfigurationVariant['prompt-preset.rename']).not.toHaveLength(0)
  })

  it('derives the bounded preset lifecycle from one receipt owner', () => {
    const facts = sourceFacts as {
      readonly configurationPresetLifecycleFamily: {
        readonly variants: readonly string[]
        readonly routesByVariant: Readonly<
          Record<
            string,
            { readonly consumed: boolean; readonly legacyTerminals: readonly string[] }
          >
        >
        readonly commonKernel: Readonly<Record<string, boolean>>
      }
      readonly constructorsByConfigurationVariant: Readonly<Record<string, readonly unknown[]>>
    }
    const family = facts.configurationPresetLifecycleFamily

    expect(family.variants).toEqual([
      'chat-preset.create',
      'chat-preset.create-and-link',
      'chat-preset.delete',
      'chat-preset.duplicate',
      'chat-preset.save',
      'chat-preset.set-archived',
      'chat-preset.update',
    ])
    expect(Object.values(family.routesByVariant).every((route) => route.consumed)).toBe(true)
    expect(
      Object.values(family.routesByVariant).every((route) => route.legacyTerminals.length === 0),
    ).toBe(true)
    expect(Object.values(family.commonKernel).every(Boolean)).toBe(true)
    expect(facts.constructorsByConfigurationVariant['chat-preset.create']).not.toHaveLength(0)
    expect(
      facts.constructorsByConfigurationVariant['chat-preset.create-and-link'],
    ).not.toHaveLength(0)
    expect(facts.constructorsByConfigurationVariant['chat-preset.delete']).not.toHaveLength(0)
    expect(facts.constructorsByConfigurationVariant['chat-preset.duplicate']).not.toHaveLength(0)
    expect(facts.constructorsByConfigurationVariant['chat-preset.save']).not.toHaveLength(0)
    expect(facts.constructorsByConfigurationVariant['chat-preset.update']).not.toHaveLength(0)
    expect(facts.constructorsByConfigurationVariant['chat-preset.set-archived']).not.toHaveLength(0)
  })

  it('derives the bounded chat-selection compositions from one receipt owner', () => {
    const facts = sourceFacts as {
      readonly configurationChatSelectionFamily: {
        readonly variants: readonly string[]
        readonly routesByVariant: Readonly<
          Record<
            string,
            { readonly consumed: boolean; readonly legacyTerminals: readonly string[] }
          >
        >
        readonly commonKernel: Readonly<Record<string, boolean>>
      }
      readonly constructorsByConfigurationVariant: Readonly<Record<string, readonly unknown[]>>
    }
    const family = facts.configurationChatSelectionFamily

    expect(family.variants).toEqual([
      'chat-preset.apply',
      'prompt-preset.create-and-pin',
      'prompt-preset.load-and-pin',
      'text-template.create-and-select',
    ])
    expect(Object.values(family.routesByVariant).every((route) => route.consumed)).toBe(true)
    expect(
      Object.values(family.routesByVariant).every((route) => route.legacyTerminals.length === 0),
    ).toBe(true)
    expect(Object.values(family.commonKernel).every(Boolean)).toBe(true)
    expect(facts.constructorsByConfigurationVariant['chat-preset.apply']).not.toHaveLength(0)
    expect(
      facts.constructorsByConfigurationVariant['prompt-preset.create-and-pin'],
    ).not.toHaveLength(0)
    expect(facts.constructorsByConfigurationVariant['prompt-preset.load-and-pin']).not.toHaveLength(
      0,
    )
    expect(
      facts.constructorsByConfigurationVariant['text-template.create-and-select'],
    ).not.toHaveLength(0)
  })

  it('derives chat request-target selection from one transaction-self-sufficient owner', () => {
    const facts = sourceFacts as {
      readonly configurationChatRequestTargetFamily: {
        readonly variants: readonly string[]
        readonly routesByVariant: Readonly<
          Record<
            string,
            { readonly consumed: boolean; readonly legacyTerminals: readonly string[] }
          >
        >
        readonly commonKernel: Readonly<Record<string, boolean>>
      }
      readonly constructorsByConfigurationVariant: Readonly<Record<string, readonly unknown[]>>
    }
    const family = facts.configurationChatRequestTargetFamily

    expect(family.variants).toEqual(['chat.resolve-model', 'chat.switch-profile'])
    expect(Object.values(family.routesByVariant).every((route) => route.consumed)).toBe(true)
    expect(
      Object.values(family.routesByVariant).every((route) => route.legacyTerminals.length === 0),
    ).toBe(true)
    expect(Object.values(family.commonKernel).every(Boolean)).toBe(true)
    expect(facts.constructorsByConfigurationVariant['chat.switch-profile']).not.toHaveLength(0)
    expect(facts.constructorsByConfigurationVariant['chat.resolve-model']).not.toHaveLength(0)
  })

  it('derives prompt target fanout from one bounded transaction-local owner', () => {
    const facts = sourceFacts as {
      readonly configurationTargetFanoutFamily: {
        readonly variants: readonly string[]
        readonly routesByVariant: Readonly<
          Record<
            string,
            { readonly consumed: boolean; readonly legacyTerminals: readonly string[] }
          >
        >
        readonly commonKernel: Readonly<Record<string, boolean>>
        readonly capabilities: Readonly<
          Record<
            string,
            {
              readonly boundsProved: boolean
            }
          >
        >
      }
      readonly constructorsByConfigurationVariant: Readonly<Record<string, readonly unknown[]>>
    }
    const family = facts.configurationTargetFanoutFamily

    expect(family.variants).toEqual([
      'prompt-preset.delete',
      'prompt-preset.overwrite-and-pin',
      'text-template.delete',
    ])
    expect(Object.values(family.routesByVariant).every((route) => route.consumed)).toBe(true)
    expect(
      Object.values(family.routesByVariant).every((route) => route.legacyTerminals.length === 0),
    ).toBe(true)
    expect(Object.values(family.commonKernel).every(Boolean)).toBe(true)
    for (const capability of Object.values(family.capabilities)) {
      expect(capability).toMatchObject({
        boundsProved: false,
      })
    }
    expect(facts.constructorsByConfigurationVariant['prompt-preset.delete']).not.toHaveLength(0)
    expect(
      facts.constructorsByConfigurationVariant['prompt-preset.overwrite-and-pin'],
    ).not.toHaveLength(0)
    expect(facts.constructorsByConfigurationVariant['text-template.delete']).not.toHaveLength(0)
  })

  it('derives bounded connection lifecycle semantics from one exact receipt', () => {
    const facts = sourceFacts as {
      readonly configurationConnectionLifecycleFamily: {
        readonly variants: readonly string[]
        readonly routesByVariant: Readonly<
          Record<
            string,
            { readonly consumed: boolean; readonly legacyTerminals: readonly string[] }
          >
        >
        readonly commonKernel: Readonly<Record<string, boolean>>
        readonly capabilities: Readonly<
          Record<
            string,
            {
              readonly owner: string
              readonly physicalWritesProved: boolean
              readonly exactEffectsProved: boolean
              readonly tablesProved: boolean
              readonly boundsProved: boolean
              readonly idempotenceProved: boolean
            }
          >
        >
      }
      readonly constructorsByConfigurationVariant: Readonly<Record<string, readonly unknown[]>>
    }
    const family = facts.configurationConnectionLifecycleFamily

    expect(family.variants).toEqual([
      'connection.create',
      'connection.duplicate',
      'connection.edit',
    ])
    expect(Object.values(family.routesByVariant).every((route) => route.consumed)).toBe(true)
    expect(
      Object.values(family.routesByVariant).every((route) => route.legacyTerminals.length === 0),
    ).toBe(true)
    expect(Object.values(family.commonKernel).every(Boolean)).toBe(true)
    expect(
      Object.values(family.capabilities).every(
        (capability) =>
          capability.owner === 'executeConnectionProfileLifecycleOperation' &&
          capability.physicalWritesProved &&
          capability.exactEffectsProved &&
          capability.tablesProved &&
          capability.boundsProved,
      ),
    ).toBe(true)
    expect(facts.constructorsByConfigurationVariant['connection.create']).not.toHaveLength(0)
    expect(facts.constructorsByConfigurationVariant['connection.edit']).not.toHaveLength(0)
    expect(facts.constructorsByConfigurationVariant['connection.duplicate']).not.toHaveLength(0)
  })

  it('derives connection deletion from one cardinality-fanout owner', () => {
    const facts = sourceFacts as {
      readonly configurationConnectionDeleteFamily: {
        readonly variants: readonly string[]
        readonly routesByVariant: Readonly<
          Record<
            string,
            { readonly consumed: boolean; readonly legacyTerminals: readonly string[] }
          >
        >
        readonly commonKernel: Readonly<Record<string, boolean>>
        readonly capabilities: Readonly<
          Record<
            string,
            {
              readonly owner: string
              readonly physicalWritesProved: boolean
              readonly exactEffectsProved: boolean
              readonly tablesProved: boolean
              readonly boundsProved: boolean
            }
          >
        >
      }
    }
    const family = facts.configurationConnectionDeleteFamily

    expect(family.variants).toEqual(['connection.delete'])
    expect(family.routesByVariant['connection.delete']?.consumed).toBe(true)
    expect(family.routesByVariant['connection.delete']?.legacyTerminals).toEqual([])
    expect(Object.values(family.commonKernel).every(Boolean)).toBe(true)
    expect(family.capabilities['connection.delete']).toEqual(
      expect.objectContaining({
        owner: 'executeConnectionDeleteOperation',
        physicalWritesProved: true,
        exactEffectsProved: true,
        tablesProved: true,
        boundsProved: false,
      }),
    )
  })

  it('derives the configuration envelope as one storage-free nested delegation', () => {
    const facts = sourceFacts as {
      readonly configurationEnvelopeFamily: {
        readonly variants: readonly string[]
        readonly nestedVariants: readonly string[]
        readonly commonKernel: Readonly<Record<string, boolean>>
        readonly capabilities: Readonly<
          Record<
            string,
            {
              readonly owner: string
              readonly consumed: boolean
              readonly physicalWritesProved: boolean
              readonly exactPhysicalWritesProved: boolean
              readonly exactEffectsProved: boolean
              readonly tablesProved: boolean
              readonly boundsProved: boolean
              readonly idempotenceProved: boolean
            }
          >
        >
      }
    }
    const family = facts.configurationEnvelopeFamily

    expect(family.variants).toEqual(['configuration.execute'])
    expect(family.nestedVariants).toHaveLength(44)
    expect(family.commonKernel).toEqual({
      exactNestedCoverage: true,
      typedDelegationCapability: true,
      nestedIdentityDerived: true,
      exactEnvelopeCommitIdentity: true,
      exactEnvelopeDispatch: true,
      noRedundantDatabaseOpen: true,
      exactOneNestedHandler: true,
      nestedResultDerived: true,
      zeroEnvelopeStorageOwnership: true,
      zeroEnvelopeControlLoop: true,
    })
    expect(family.capabilities['configuration.execute']).toEqual(
      expect.objectContaining({
        owner: 'executeConfigurationCommandInBrowser',
        consumed: true,
        physicalWritesProved: true,
        exactPhysicalWritesProved: true,
        exactEffectsProved: true,
        tablesProved: true,
        boundsProved: true,
        idempotenceProved: true,
      }),
    )
    const detailed = evaluateDurableCommandPipeline(
      canonicalInventory,
      'inventory',
      { detail: true },
      sourceFacts,
    ) as DurableCommandPipelineReport & {
      readonly gaps: readonly { readonly scope: string; readonly variant: string }[]
    }
    expect(
      detailed.gaps.filter(
        ({ scope, variant }) => scope === 'workspace' && variant === 'configuration.execute',
      ),
    ).toEqual([])
  })

  it('reopens only the five envelope stages when typed delegation proof is absent', () => {
    const facts = sourceFacts as {
      readonly semanticCapabilities: Readonly<Record<string, Readonly<Record<string, unknown>>>>
    }
    const capability = facts.semanticCapabilities['configuration.execute']
    const result = evaluateDurableCommandPipeline(
      canonicalInventory,
      'inventory',
      { detail: true },
      {
        ...(sourceFacts as object),
        semanticCapabilities: {
          ...facts.semanticCapabilities,
          'configuration.execute': {
            ...capability,
            tablesProved: false,
            physicalWritesProved: false,
            exactEffectsProved: false,
            idempotenceProved: false,
            boundsProved: false,
          },
        },
      },
    ) as DurableCommandPipelineReport & {
      readonly gaps: readonly {
        readonly scope: string
        readonly variant: string
        readonly stage: string
      }[]
    }

    expect(
      result.gaps
        .filter(
          ({ scope, variant }) => scope === 'workspace' && variant === 'configuration.execute',
        )
        .map(({ stage }) => stage),
    ).toEqual(['tables', 'physicalWrites', 'receiptDelta', 'idempotence', 'bounds'])
  })

  it('derives all discovery cache variants from one typed semantic family', () => {
    const facts = sourceFacts as {
      readonly discoveryCacheFamily: {
        readonly variants: readonly string[]
        readonly commonKernel: Readonly<Record<string, boolean>>
        readonly capabilities: Readonly<
          Record<
            string,
            {
              readonly owner: string
              readonly consumed: boolean
              readonly physicalWritesProved: boolean
              readonly exactEffectsProved: boolean
              readonly tablesProved: boolean
              readonly boundsProved: boolean
              readonly byteBoundsProved: boolean
            }
          >
        >
      }
    }
    const family = facts.discoveryCacheFamily

    expect(family.variants).toEqual([
      'discovery.endpoints.put',
      'discovery.models.delete',
      'discovery.models.put',
      'discovery.privacy.put',
      'maintenance.prune-discovery-cache',
    ])
    expect(Object.values(family.commonKernel).every(Boolean)).toBe(true)
    for (const [kind, capability] of Object.entries(family.capabilities)) {
      expect(capability).toEqual(
        expect.objectContaining({
          owner:
            kind === 'maintenance.prune-discovery-cache'
              ? 'DISCOVERY_CACHE_MAINTENANCE_OPERATION'
              : 'discoveryCacheOperationDescriptor',
          consumed: true,
          physicalWritesProved: true,
          exactEffectsProved: true,
          tablesProved: true,
          boundsProved: true,
          byteBoundsProved: false,
          idempotenceProved: true,
        }),
      )
    }
  })

  it('reopens every discovery receipt and replay gap when the typed proof is absent', () => {
    const facts = sourceFacts as {
      readonly semanticCapabilities: Readonly<Record<string, Readonly<Record<string, unknown>>>>
      readonly discoveryCacheFamily: {
        readonly variants: readonly string[]
      }
    }
    const semanticCapabilities = { ...facts.semanticCapabilities }
    for (const variant of facts.discoveryCacheFamily.variants) {
      semanticCapabilities[variant] = {
        ...semanticCapabilities[variant],
        physicalWritesProved: false,
        exactEffectsProved: false,
        tablesProved: false,
        idempotenceProved: false,
        boundsProved: false,
      }
    }

    const result = evaluateDurableCommandPipeline(
      canonicalInventory,
      'inventory',
      {},
      { ...(sourceFacts as object), semanticCapabilities },
    )

    const baseline = runAudit('inventory').report
    expect(result.gapCells).toBe(baseline.gapCells + 25)
    expect(result.gapStageCounts).toMatchObject({
      tables: (baseline.gapStageCounts.tables ?? 0) + 5,
      physicalWrites: (baseline.gapStageCounts.physicalWrites ?? 0) + 5,
      receiptDelta: (baseline.gapStageCounts.receiptDelta ?? 0) + 5,
      idempotence: (baseline.gapStageCounts.idempotence ?? 0) + 5,
      bounds: (baseline.gapStageCounts.bounds ?? 0) + 5,
    })
  })

  it('derives all folder commands from transaction-local typed operations', () => {
    const facts = sourceFacts as {
      readonly folderFamily: {
        readonly variants: readonly string[]
        readonly fixedRowVariants: readonly string[]
        readonly constructorFacts: readonly { readonly singleSubmit: boolean }[]
        readonly commonKernel: Readonly<Record<string, boolean>>
        readonly capabilities: Readonly<
          Record<
            string,
            {
              readonly consumed: boolean
              readonly physicalWritesProved: boolean
              readonly exactEffectsProved: boolean
              readonly tablesProved: boolean
              readonly boundsProved: boolean
              readonly byteBoundsProved: boolean
              readonly idempotenceProved: boolean
            }
          >
        >
      }
    }
    const family = facts.folderFamily

    expect(family.variants).toEqual([
      'folder.create',
      'folder.delete',
      'folder.ensure-and-move-chats',
      'folder.update',
    ])
    expect(family.fixedRowVariants).toEqual(['folder.create', 'folder.update'])
    expect(family.constructorFacts.every((fact) => fact.singleSubmit)).toBe(true)
    expect(Object.values(family.commonKernel).every(Boolean)).toBe(true)
    expect(family.capabilities['folder.ensure-and-move-chats']).toMatchObject({
      consumed: true,
      physicalWritesProved: true,
      exactEffectsProved: true,
      tablesProved: true,
      boundsProved: false,
      idempotenceProved: true,
    })
    expect(family.capabilities['folder.delete']).toMatchObject({
      consumed: true,
      physicalWritesProved: true,
      exactEffectsProved: true,
      tablesProved: true,
      boundsProved: false,
      idempotenceProved: true,
    })
    for (const kind of family.fixedRowVariants) {
      expect(family.capabilities[kind]).toMatchObject({
        consumed: true,
        physicalWritesProved: true,
        exactEffectsProved: true,
        tablesProved: true,
        boundsProved: true,
        byteBoundsProved: false,
        idempotenceProved: true,
      })
    }
  })

  it('reopens only the fixed folder-row cells when their typed exact contract is absent', () => {
    const facts = sourceFacts as {
      readonly semanticCapabilities: Readonly<Record<string, Readonly<Record<string, unknown>>>>
      readonly folderFamily: {
        readonly fixedRowVariants: readonly string[]
      }
    }
    const semanticCapabilities = { ...facts.semanticCapabilities }
    for (const variant of facts.folderFamily.fixedRowVariants) {
      semanticCapabilities[variant] = {
        ...semanticCapabilities[variant],
        exactEffectsProved: false,
        tablesProved: false,
        boundsProved: false,
        idempotenceProved: false,
      }
    }
    const result = evaluateDurableCommandPipeline(
      canonicalInventory,
      'inventory',
      { detail: true },
      { ...(sourceFacts as object), semanticCapabilities },
    ) as DurableCommandPipelineReport & {
      readonly gaps: readonly {
        readonly scope: string
        readonly variant: string
        readonly stage: string
      }[]
    }

    expect(result.gapCells).toBe(runAudit('inventory').report.gapCells + 8)
    expect(
      result.gaps
        .filter(
          ({ scope, variant }) =>
            scope === 'workspace' && facts.folderFamily.fixedRowVariants.includes(variant),
        )
        .map(({ variant, stage }) => `${variant}:${stage}`)
        .sort(),
    ).toEqual([
      'folder.create:bounds',
      'folder.create:idempotence',
      'folder.create:receiptDelta',
      'folder.create:tables',
      'folder.update:bounds',
      'folder.update:idempotence',
      'folder.update:receiptDelta',
      'folder.update:tables',
    ])
  })

  it('derives generation metadata from one fenced transaction and exact receipt', () => {
    const facts = sourceFacts as {
      readonly generationMetadataFamily: {
        readonly variants: readonly string[]
        readonly constructorFacts: readonly { readonly exactProof: boolean }[]
        readonly commonKernel: Readonly<Record<string, boolean>>
        readonly capabilities: Readonly<
          Record<
            string,
            {
              readonly consumed: boolean
              readonly physicalWritesProved: boolean
              readonly exactPhysicalWritesProved: boolean
              readonly exactEffectsProved: boolean
              readonly tablesProved: boolean
              readonly boundsProved: boolean
              readonly byteBoundsProved: boolean
              readonly idempotenceProved: boolean
            }
          >
        >
      }
    }
    const family = facts.generationMetadataFamily

    expect(family.variants).toEqual(['generation.post-commit-metadata'])
    expect(family.constructorFacts).toHaveLength(2)
    expect(family.constructorFacts.every((fact) => fact.exactProof)).toBe(true)
    expect(Object.values(family.commonKernel).every(Boolean)).toBe(true)
    expect(family.capabilities['generation.post-commit-metadata']).toMatchObject({
      consumed: true,
      physicalWritesProved: true,
      exactPhysicalWritesProved: true,
      exactEffectsProved: true,
      tablesProved: true,
      boundsProved: true,
      byteBoundsProved: false,
      idempotenceProved: true,
    })
  })

  it('reopens exactly the generation metadata receipt, table, replay, and bound cells', () => {
    const facts = sourceFacts as {
      readonly semanticCapabilities: Readonly<Record<string, Readonly<Record<string, unknown>>>>
      readonly generationMetadataFamily: {
        readonly variants: readonly string[]
      }
    }
    const semanticCapabilities = { ...facts.semanticCapabilities }
    for (const variant of facts.generationMetadataFamily.variants) {
      semanticCapabilities[variant] = {
        ...semanticCapabilities[variant],
        exactEffectsProved: false,
        tablesProved: false,
        boundsProved: false,
        idempotenceProved: false,
      }
    }
    const result = evaluateDurableCommandPipeline(
      canonicalInventory,
      'inventory',
      { detail: true },
      { ...(sourceFacts as object), semanticCapabilities },
    ) as DurableCommandPipelineReport & {
      readonly gaps: readonly {
        readonly scope: string
        readonly variant: string
        readonly stage: string
      }[]
    }

    expect(result.gapCells).toBe(runAudit('inventory').report.gapCells + 4)
    expect(
      result.gaps
        .filter(
          ({ scope, variant }) =>
            scope === 'workspace' && facts.generationMetadataFamily.variants.includes(variant),
        )
        .map(({ variant, stage }) => `${variant}:${stage}`)
        .sort(),
    ).toEqual([
      'generation.post-commit-metadata:bounds',
      'generation.post-commit-metadata:idempotence',
      'generation.post-commit-metadata:receiptDelta',
      'generation.post-commit-metadata:tables',
    ])
  })

  it('derives chat organization from selected-row and candidate-shaped operations', () => {
    const facts = sourceFacts as {
      readonly chatOrganizationFamily: {
        readonly variants: readonly string[]
        readonly commonKernel: Readonly<Record<string, boolean>>
        readonly moveToFolder: Readonly<Record<string, boolean>>
        readonly capabilities: Readonly<
          Record<
            string,
            {
              readonly consumed: boolean
              readonly physicalWritesProved: boolean
              readonly exactEffectsProved: boolean
              readonly tablesProved: boolean
              readonly boundsProved: boolean
              readonly byteBoundsProved?: boolean
              readonly idempotenceProved?: boolean
            }
          >
        >
      }
    }
    const family = facts.chatOrganizationFamily

    expect(family.variants).toEqual(['chat.move-to-folder', 'chat.set-tags-from-names'])
    expect(Object.values(family.commonKernel).every(Boolean)).toBe(true)
    expect(Object.values(family.moveToFolder).every(Boolean)).toBe(true)
    expect(family.capabilities['chat.move-to-folder']).toMatchObject({
      consumed: true,
      physicalWritesProved: true,
      exactEffectsProved: true,
      tablesProved: true,
      boundsProved: true,
      byteBoundsProved: false,
      idempotenceProved: true,
    })
    expect(family.capabilities['chat.set-tags-from-names']).toMatchObject({
      consumed: true,
      physicalWritesProved: true,
      exactEffectsProved: true,
      tablesProved: true,
      boundsProved: false,
      idempotenceProved: true,
    })
  })

  it('derives chat closure from one transaction-local ownership kernel', () => {
    const facts = sourceFacts as {
      readonly chatClosureFamily: {
        readonly variants: readonly string[]
        readonly commonKernel: Readonly<Record<string, boolean>>
        readonly capabilities: Readonly<
          Record<
            string,
            {
              readonly consumed: boolean
              readonly physicalWritesProved: boolean
              readonly exactEffectsProved: boolean
              readonly tablesProved: boolean
              readonly boundsProved: boolean
            }
          >
        >
      }
    }
    const family = facts.chatClosureFamily

    expect(family.variants).toEqual([
      'chat.delete-archived',
      'chat.discard-empty-drafts',
      'chat.empty-archive',
    ])
    expect(Object.values(family.commonKernel).every(Boolean)).toBe(true)
    for (const capability of Object.values(family.capabilities)) {
      expect(capability).toMatchObject({
        consumed: true,
        physicalWritesProved: true,
        exactEffectsProved: true,
        tablesProved: true,
        boundsProved: false,
        idempotenceProved: true,
      })
    }
  })

  it('derives chat fork from one transaction-local ancestry snapshot', () => {
    const facts = sourceFacts as {
      readonly chatForkFamily: {
        readonly variants: readonly string[]
        readonly commonKernel: Readonly<Record<string, boolean>>
        readonly capabilities: Readonly<
          Record<
            string,
            {
              readonly owner: string
              readonly consumed: boolean
              readonly physicalWritesProved: boolean
              readonly exactEffectsProved: boolean
              readonly tablesProved: boolean
              readonly boundsProved: boolean
            }
          >
        >
      }
    }
    const family = facts.chatForkFamily

    expect(family.variants).toEqual(['chat.fork'])
    expect(Object.values(family.commonKernel).every(Boolean)).toBe(true)
    expect(family.capabilities['chat.fork']).toMatchObject({
      owner: 'CHAT_FORK_OPERATION',
      consumed: true,
      physicalWritesProved: true,
      exactEffectsProved: true,
      tablesProved: true,
      boundsProved: false,
      idempotenceProved: true,
    })
  })

  it('derives maintenance reconciliation from final transaction occurrence receipts', () => {
    const facts = sourceFacts as {
      readonly maintenanceOccurrenceFamily: {
        readonly variants: readonly string[]
        readonly facts: Readonly<Record<string, Readonly<Record<string, boolean>>>>
        readonly capabilities: Readonly<
          Record<
            string,
            {
              readonly consumed: boolean
              readonly physicalWritesProved: boolean
              readonly exactPhysicalWritesProved: boolean
              readonly exactEffectsProved: boolean
              readonly tablesProved: boolean
              readonly boundsProved: boolean
              readonly idempotenceProved: boolean
            }
          >
        >
      }
    }
    const family = facts.maintenanceOccurrenceFamily

    expect(family.variants).toEqual([
      'maintenance.prune-empty-draft-chats',
      'maintenance.reconcile-attachment-integrity',
    ])
    for (const variant of family.variants) {
      expect(Object.values(family.facts[variant] ?? {}).every(Boolean)).toBe(true)
      expect(family.capabilities[variant]).toMatchObject({
        consumed: true,
        physicalWritesProved: true,
        exactPhysicalWritesProved: true,
        exactEffectsProved: true,
        tablesProved: true,
        boundsProved: false,
        idempotenceProved: true,
      })
    }
  })

  it('derives generated-output localization from explicit targets and one exact occurrence', () => {
    const facts = sourceFacts as {
      readonly generatedOutputLocalizationFamily: {
        readonly variants: readonly string[]
        readonly commonKernel: Readonly<Record<string, boolean>>
        readonly runtimeSubmitFacts: Readonly<Record<string, boolean>>
        readonly exactOccurrencePolicies: Readonly<Record<string, boolean>>
        readonly capabilities: Readonly<
          Record<
            string,
            {
              readonly physicalWritesProved: boolean
              readonly exactPhysicalWritesProved: boolean
              readonly exactEffectsProved: boolean
              readonly tablesProved: boolean
              readonly boundsProved: boolean
              readonly byteBoundsProved: boolean
              readonly idempotenceProved: boolean
            }
          >
        >
      }
    }
    const family = facts.generatedOutputLocalizationFamily

    expect(family.variants).toEqual([
      'generated-output.localization-claim',
      'generated-output.localization-complete',
      'generated-output.localization-fail',
      'generated-output.localization-retry',
      'generated-output.video-expand',
    ])
    expect(Object.values(family.commonKernel).every(Boolean)).toBe(true)
    expect(Object.values(family.runtimeSubmitFacts).every(Boolean)).toBe(true)
    expect(Object.values(family.exactOccurrencePolicies).every(Boolean)).toBe(true)
    for (const variant of family.variants) {
      expect(family.capabilities[variant]).toMatchObject({
        physicalWritesProved: true,
        exactPhysicalWritesProved: true,
        exactEffectsProved: true,
        tablesProved: true,
        boundsProved: false,
        byteBoundsProved: false,
        idempotenceProved: true,
      })
    }
  })

  it('reopens only the generated-output occurrence cells when its proof is absent', () => {
    const facts = sourceFacts as {
      readonly semanticCapabilities: Readonly<Record<string, Readonly<Record<string, unknown>>>>
      readonly generatedOutputLocalizationFamily: {
        readonly variants: readonly string[]
      }
    }
    const semanticCapabilities = { ...facts.semanticCapabilities }
    for (const variant of facts.generatedOutputLocalizationFamily.variants) {
      semanticCapabilities[variant] = {
        ...semanticCapabilities[variant],
        exactEffectsProved: false,
        tablesProved: false,
        idempotenceProved: false,
      }
    }
    const result = evaluateDurableCommandPipeline(
      canonicalInventory,
      'inventory',
      {},
      { ...(sourceFacts as object), semanticCapabilities },
    )
    const baseline = runAudit('inventory').report

    expect(result.gapCells).toBe(baseline.gapCells + 15)
    expect(result.gapStageCounts).toMatchObject({
      tables: (baseline.gapStageCounts.tables ?? 0) + 5,
      receiptDelta: (baseline.gapStageCounts.receiptDelta ?? 0) + 5,
      idempotence: (baseline.gapStageCounts.idempotence ?? 0) + 5,
    })
  })

  it('reopens the exact occurrence cells when their generated capability proof is absent', () => {
    const facts = sourceFacts as {
      readonly semanticCapabilities: Readonly<Record<string, Readonly<Record<string, unknown>>>>
    }
    const variants = [
      'chat.delete-archived',
      'chat.discard-empty-drafts',
      'chat.empty-archive',
      'chat.fork',
      'chat.set-tags-from-names',
      'folder.delete',
      'folder.ensure-and-move-chats',
      'maintenance.prune-empty-draft-chats',
      'maintenance.reconcile-attachment-integrity',
    ] as const
    const semanticCapabilities = { ...facts.semanticCapabilities }
    for (const variant of variants) {
      semanticCapabilities[variant] = {
        ...semanticCapabilities[variant],
        physicalWritesProved: false,
        exactEffectsProved: false,
        tablesProved: false,
        idempotenceProved: false,
      }
    }
    const result = evaluateDurableCommandPipeline(
      canonicalInventory,
      'inventory',
      { detail: true },
      { ...(sourceFacts as object), semanticCapabilities },
    ) as DurableCommandPipelineReport & {
      readonly gaps: readonly {
        readonly scope: string
        readonly variant: string
        readonly stage: string
      }[]
    }

    const baseline = evaluateDurableCommandPipeline(
      canonicalInventory,
      'inventory',
      { detail: true },
      sourceFacts,
    ) as DurableCommandPipelineReport & {
      readonly gaps: readonly {
        readonly scope: string
        readonly variant: string
        readonly stage: string
      }[]
    }
    const baselineKeys = new Set(
      baseline.gaps.map(({ scope, variant, stage }) => `${scope}:${variant}:${stage}`),
    )
    const reopened = result.gaps
      .filter(
        ({ scope, variant, stage }) =>
          scope === 'workspace' &&
          variants.includes(variant as never) &&
          !baselineKeys.has(`${scope}:${variant}:${stage}`),
      )
      .map(({ variant, stage }) => `${variant}:${stage}`)
    expect(reopened).toHaveLength(variants.length * 4)
    for (const variant of variants) {
      expect(reopened).toEqual(
        expect.arrayContaining([
          `${variant}:tables`,
          `${variant}:physicalWrites`,
          `${variant}:receiptDelta`,
          `${variant}:idempotence`,
        ]),
      )
    }
  })

  it('derives interchange imports from transaction-local indexed resolution', () => {
    const facts = sourceFacts as {
      readonly interchangeImportFamily: {
        readonly variants: readonly string[]
        readonly commonKernel: Readonly<Record<string, boolean>>
        readonly occurrence: Readonly<Record<string, boolean>>
        readonly capabilities: Readonly<
          Record<
            string,
            {
              readonly consumed: boolean
              readonly physicalWritesProved: boolean
              readonly exactEffectsProved: boolean
              readonly tablesProved: boolean
              readonly boundsProved: boolean
              readonly idempotenceProved: boolean
            }
          >
        >
      }
    }
    const family = facts.interchangeImportFamily

    expect(family.variants).toEqual([
      'interchange.import-chat',
      'interchange.import-chat-preset',
      'interchange.import-connection-profile',
    ])
    expect(Object.values(family.commonKernel).every(Boolean)).toBe(true)
    expect(Object.values(family.occurrence).every(Boolean)).toBe(true)
    for (const capability of Object.values(family.capabilities)) {
      expect(capability).toMatchObject({
        consumed: true,
        physicalWritesProved: true,
        exactEffectsProved: true,
        tablesProved: true,
        boundsProved: false,
        idempotenceProved: true,
      })
    }
  })

  it('reopens exactly the interchange and message exact cells when their source contracts drift', async () => {
    const { createProductionTypeScriptProgram } = (await import(TYPESCRIPT_SOURCE_URL)) as {
      createProductionTypeScriptProgram(
        root?: string,
        options?: {
          readonly sourceTextOverrides?: Readonly<Record<string, string>>
        },
      ): unknown
    }
    const current = evaluateDurableCommandPipeline(
      canonicalInventory,
      'inventory',
      { detail: true },
      sourceFacts,
    ) as DurableCommandPipelineReport & {
      readonly gaps: readonly {
        readonly scope: string
        readonly variant: string
        readonly stage: string
      }[]
    }
    const currentKeys = new Set(
      current.gaps.map(({ scope, variant, stage }) => `${scope}:${variant}:${stage}`),
    )

    const importPath = resolve(ROOT, 'src/store/browser-import-export.ts')
    const importSource = readFileSync(importPath, 'utf8')
    expect(importSource.match(/semanticOperationExactReceiptContracts</gu)).toHaveLength(3)
    const mutationPlanPath = resolve(ROOT, 'src/store/browser-mutation-plan.ts')
    const mutationPlanSource = readFileSync(mutationPlanPath, 'utf8')
    const editPolicy = `case 'message.edit-body':
      return {
        exactOccurrence: true,`
    expect(mutationPlanSource).toContain(editPolicy)
    const browserRepoPath = resolve(ROOT, 'src/store/browser-repo.ts')
    const browserRepoSource = readFileSync(browserRepoPath, 'utf8')
    expect(browserRepoSource).toContain(
      `const MESSAGE_STRUCTURE_PREFLIGHT_TRANSACTION_PLAN = physicalTransactionPlan(
  physicalStorageTables('messages'),
)`,
    )

    const mutatedFacts = buildDurableCommandPipelineSourceFacts({
      program: createProductionTypeScriptProgram(ROOT, {
        sourceTextOverrides: {
          'src/store/browser-import-export.ts': importSource.replaceAll(
            'semanticOperationExactReceiptContracts<',
            'semanticOperationUntrackedReceiptContracts<',
          ),
          'src/store/browser-mutation-plan.ts': mutationPlanSource.replace(
            editPolicy,
            editPolicy.replace('exactOccurrence: true', 'exactOccurrence: false'),
          ),
          'src/store/browser-repo.ts': browserRepoSource.replace(
            `const MESSAGE_STRUCTURE_PREFLIGHT_TRANSACTION_PLAN = physicalTransactionPlan(
  physicalStorageTables('messages'),
)`,
            `const MESSAGE_STRUCTURE_PREFLIGHT_TRANSACTION_PLAN = physicalTransactionPlan(
  physicalStorageTables('messages', 'chats'),
)`,
          ),
        },
      }),
    })
    const result = evaluateDurableCommandPipeline(
      canonicalInventory,
      'inventory',
      { detail: true },
      mutatedFacts,
    ) as DurableCommandPipelineReport & {
      readonly gaps: readonly {
        readonly scope: string
        readonly variant: string
        readonly stage: string
      }[]
    }
    const variants = [
      'interchange.import-chat',
      'interchange.import-chat-preset',
      'interchange.import-connection-profile',
      'message.delete',
      'message.edit-body',
      'message.import',
      'message.restore-structure',
    ]
    const reopened = result.gaps
      .filter(
        ({ scope, variant, stage }) =>
          scope === 'workspace' &&
          variants.includes(variant) &&
          !currentKeys.has(`${scope}:${variant}:${stage}`),
      )
      .map(({ variant, stage }) => `${variant}:${stage}`)
      .sort()
    expect(reopened).toEqual(
      withForegroundCommandFootprintBounds(
        [
          ...variants.flatMap((variant) => [
            `${variant}:idempotence`,
            `${variant}:receiptDelta`,
            `${variant}:tables`,
          ]),
          'message.edit-body:bounds',
        ].sort(),
      ),
    )
  }, 60_000)

  it('derives preset-order move from its consumed literal capability', () => {
    const facts = sourceFacts as {
      readonly semanticCapabilities: Readonly<
        Record<
          string,
          {
            readonly owner: string
            readonly transaction: string
            readonly consumed: boolean
            readonly physicalWritesProved: boolean
            readonly exactEffectsProved: boolean
            readonly tablesProved: boolean
            readonly boundsProved: boolean
          }
        >
      >
      readonly constructorsByConfigurationVariant: Readonly<Record<string, readonly unknown[]>>
    }
    const capability = facts.semanticCapabilities['chat-preset.move']
    if (!capability) throw new Error('ChatPresetMoveCapabilityMissing')

    expect(capability).toMatchObject({
      owner: 'presetOrderMoveOperationDescriptor',
      consumed: true,
      physicalWritesProved: true,
      exactEffectsProved: true,
      tablesProved: true,
      boundsProved: true,
    })
    expect(capability.transaction).toContain('PRESET_ORDER_MUTATION_TRANSACTION_CAPABILITY')
    expect(facts.constructorsByConfigurationVariant['chat-preset.move']).not.toHaveLength(0)
  })

  it('rejects stale variants, incomplete paths, transaction bypasses, false publication claims, and handler drift', () => {
    const fork = omit(
      {
        ...canonicalInventory.WORKSPACE_COMMAND_PIPELINES['chat.fork'],
        handler: { status: 'observed', proof: 'notARealTouchHandler' },
        writeDetection: { status: 'gap', reason: 'claimed manual' },
        broadcast: { status: 'gap', reason: 'claimed manual' },
      },
      'tables',
    )
    const result = runAudit('inventory', {
      ...canonicalInventory,
      WORKSPACE_COMMAND_PIPELINES: {
        ...omit(canonicalInventory.WORKSPACE_COMMAND_PIPELINES, 'chat.touch-viewed'),
        'chat.fork': fork,
      },
      DIRECT_COMMAND_TRANSACTION_OWNER_COUNTS: Object.fromEntries(
        Object.entries(canonicalInventory.DIRECT_COMMAND_TRANSACTION_OWNER_COUNTS).slice(1),
      ),
      WRITE_DETECTION_ARCHITECTURE: {
        mechanism: 'manual-marker',
        status: 'gap',
        reason: '',
      },
    })

    expect(result.status).toBe(1)
    expect(result.report.problems).toEqual(
      expect.arrayContaining([
        'workspace command pipeline variants: missing chat.touch-viewed',
        'workspace chat.fork: dispatch handler missing notARealTouchHandler',
        'workspace chat.fork: transaction-derived write detection must be observed',
        'workspace chat.fork: committed-write broadcast must be observed',
        'workspace chat.touch-viewed: constructor stage must match reachable typed sites',
        'write-detection architecture must use the transaction-local mutation journal',
        'transaction-local write detection must remain observed',
        'transaction-local write detection needs proof',
        expect.stringContaining('direct command transaction owners: unclassified'),
      ]),
    )
  })
})

function runAudit(
  mode: 'inventory' | 'enforce',
  inventory: DurableCommandPipelineInventory = canonicalInventory,
) {
  const report = evaluateDurableCommandPipeline(inventory, mode, {}, sourceFacts)
  return { status: report.ok ? 0 : 1, report }
}

function omit<T>(value: Readonly<Record<string, T>>, key: string): Readonly<Record<string, T>> {
  return Object.fromEntries(Object.entries(value).filter(([entryKey]) => entryKey !== key))
}
