import { relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { staticAuditState } from './audit-result-state.mjs'
import { CONFIGURATION_COMMANDS } from './configuration-protocol-inventory.mjs'
import { discoverProductionDiscriminatedUnions } from './discover-production-discriminated-unions.mjs'
import * as defaultInventory from './durable-command-pipeline-inventory.mjs'
import { createProductionTypeScriptProgram } from './production-typescript-source.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const SRC_ROOT = resolve(ROOT, 'src')
const WORKSPACE_COMMAND_UNION_ID = 'src/store/workspace-protocol.ts#WorkspaceCommand|kind'
const SCOPE_DERIVED_MUTATION_COMMAND_UNION_ID =
  'src/store/workspace-protocol.ts#ScopeDerivedMutationCommand|kind'
const ATTEMPT_MUTATION_COMMAND_UNION_ID =
  'src/store/workspace-protocol.ts#AttemptMutationCommand|kind'
const CONFIGURATION_COMMAND_UNION_ID =
  'src/store/configuration-domain-contract.ts#ConfigurationDomainCommandUnion|kind'
const BROWSER_REPO_PATH = 'src/store/browser-repo.ts'
const BROWSER_CATALOG_COMMAND_RUNTIME_PATH = 'src/store/browser-catalog-command-runtime.ts'
const CHATS_PATH = 'src/store/chats.ts'
const ATTACHMENTS_PATH = 'src/store/attachments.ts'
const ATTACHMENT_BULK_DELETE_PATH = 'src/store/attachment-bulk-delete.ts'
const BROWSER_IMPORT_EXPORT_PATH = 'src/store/browser-import-export.ts'
const CONFIGURATION_HANDLER_PATH = 'src/store/browser-configuration-domain.ts'
const CONFIGURATION_APPLICATION_PATH = 'src/store/configuration-application.ts'
const CONFIGURATION_COMMAND_CLIENT_PATH = 'src/store/configuration-command-client.ts'
const CONFIGURATION_DOMAIN_PATH = 'src/store/configuration-domain.ts'
const CONFIGURATION_CATALOG_PROJECTION_PATH = 'src/store/configuration-catalog-projection.ts'
const BYTE_OWNER_MUTATION_PATH = 'src/store/byte-owner-mutation.ts'
const PRESET_ORDER_PATH = 'src/store/preset-order.ts'
const MUTATION_JOURNAL_PATH = 'src/store/browser-command-mutation-journal.ts'
const DATABASE_PATH = 'src/store/db.ts'
const BROWSER_WORKSPACE_LIFECYCLE_PATH = 'src/store/browser-workspace-lifecycle.ts'
const STORAGE_COMPACTION_STATE_PATH = 'src/store/storage-compaction-state.ts'
const WORKSPACE_REPOSITORY_PATH = 'src/store/workspace-repository.ts'
const WORKSPACE_EFFECT_HUB_PATH = 'src/store/workspace-effect-hub.ts'
const SEMANTIC_OPERATION_CAPABILITY_PATH = 'src/store/semantic-operation-capability.ts'
const ATTEMPT_TERMINALIZATION_PATH = 'src/store/attempt-terminalization.ts'
const GENERATION_ENGINE_PATH = 'src/store/generation-engine.ts'
const BROWSER_GENERATION_COMMAND_RUNTIME_PATH = 'src/store/browser-generation-command-runtime.ts'
const STREAM_LEASES_PATH = 'src/store/stream-leases.ts'
const STREAM_RECOVERY_PATH = 'src/store/stream-recovery.ts'
const STREAM_JOURNAL_CODEC_PATH = 'src/store/stream-journal-codec.ts'
const STREAM_JOURNAL_INTEGRITY_PATH = 'src/store/stream-journal-integrity.ts'
const STREAM_JOURNAL_STORAGE_PATH = 'src/store/stream-journal-storage.ts'
const DISCOVERY_CACHE_STORAGE_PATH = 'src/store/discovery-cache-storage.ts'
const DISCOVERY_SERVICE_PATH = 'src/store/discovery-service.ts'
const MODELS_CACHE_PATH = 'src/store/models-cache.ts'
const WORKSPACE_RUNTIME_PATH = 'src/store/workspace-runtime.ts'
const COMMAND_TRANSACTION_BOUNDARY_PATHS = [
  BROWSER_REPO_PATH,
  BROWSER_IMPORT_EXPORT_PATH,
  CONFIGURATION_HANDLER_PATH,
  'src/store/browser-domain-mutations.ts',
]
const VALID_STAGE_STATUSES = new Set(['observed', 'gap'])

const EXPECTED_PIPELINE_STAGES = Object.freeze([
  'constructor',
  'admission',
  'dispatch',
  'handler',
  'kernel',
  'lock',
  'transaction',
  'tables',
  'physicalWrites',
  'writeDetection',
  'receiptDelta',
  'broadcast',
  'rollback',
  'idempotence',
  'bounds',
])

export function buildDurableCommandPipelineSourceFacts(options = {}) {
  const program = options.program ?? createProductionTypeScriptProgram(ROOT)
  const discoveredUnions =
    options.discovered ?? discoverProductionDiscriminatedUnions(ROOT, { program })
  const workspaceUnion = exactUnion(discoveredUnions.unions, WORKSPACE_COMMAND_UNION_ID)
  const scopeDerivedMutationUnion = exactUnion(
    discoveredUnions.unions,
    SCOPE_DERIVED_MUTATION_COMMAND_UNION_ID,
  )
  const attemptMutationUnion = exactUnion(
    discoveredUnions.unions,
    ATTEMPT_MUTATION_COMMAND_UNION_ID,
  )
  const configurationUnion = exactUnion(discoveredUnions.unions, CONFIGURATION_COMMAND_UNION_ID)
  const browserRepoSource = exactSource(program, BROWSER_REPO_PATH)
  const sourceArchitectureProblems = []
  const commandLifetimeReceipt = commandLifetimeReceiptFacts(
    program,
    browserRepoSource,
    sourceArchitectureProblems,
  )
  const semanticCapabilities = semanticOperationCapabilityFacts(program, sourceArchitectureProblems)
  const singleChatMetadataFamily = singleChatMetadataCapabilityFacts(
    program,
    exactSource(program, BROWSER_CATALOG_COMMAND_RUNTIME_PATH),
    browserRepoSource,
    sourceArchitectureProblems,
  )
  for (const [kind, capability] of Object.entries(singleChatMetadataFamily.capabilities)) {
    if (semanticCapabilities.has(kind)) {
      sourceArchitectureProblems.push(`semantic operation capability duplicated ${kind}`)
      continue
    }
    semanticCapabilities.set(kind, capability)
  }
  const chatSetArchivedFamily = chatSetArchivedCapabilityFacts(
    program,
    exactSource(program, BROWSER_CATALOG_COMMAND_RUNTIME_PATH),
    browserRepoSource,
    sourceArchitectureProblems,
  )
  for (const [kind, capability] of Object.entries(chatSetArchivedFamily.capabilities)) {
    if (semanticCapabilities.has(kind)) {
      sourceArchitectureProblems.push(`semantic operation capability duplicated ${kind}`)
      continue
    }
    semanticCapabilities.set(kind, capability)
  }
  const chatCalibrationFamily = chatCalibrationCapabilityFacts(
    program,
    exactSource(program, BROWSER_CATALOG_COMMAND_RUNTIME_PATH),
    sourceArchitectureProblems,
  )
  for (const [kind, capability] of Object.entries(chatCalibrationFamily.capabilities)) {
    if (semanticCapabilities.has(kind)) {
      sourceArchitectureProblems.push(`semantic operation capability duplicated ${kind}`)
      continue
    }
    semanticCapabilities.set(kind, capability)
  }
  const streamLeaseOperationFamily = streamLeaseOperationCapabilityFacts(
    program,
    workspaceUnion,
    browserRepoSource,
    sourceArchitectureProblems,
  )
  for (const [kind, capability] of Object.entries(streamLeaseOperationFamily.capabilities)) {
    if (semanticCapabilities.has(kind)) {
      sourceArchitectureProblems.push(`semantic operation capability duplicated ${kind}`)
      continue
    }
    semanticCapabilities.set(kind, capability)
  }
  const streamJournalAppendFamily = streamJournalAppendCapabilityFacts(
    program,
    browserRepoSource,
    sourceArchitectureProblems,
  )
  for (const [kind, capability] of Object.entries(streamJournalAppendFamily.capabilities)) {
    if (semanticCapabilities.has(kind)) {
      sourceArchitectureProblems.push(`semantic operation capability duplicated ${kind}`)
      continue
    }
    semanticCapabilities.set(kind, capability)
  }
  const streamJournalRetirementFamily = streamJournalRetirementCapabilityFacts(
    program,
    browserRepoSource,
    sourceArchitectureProblems,
  )
  for (const [kind, capability] of Object.entries(streamJournalRetirementFamily.capabilities)) {
    if (semanticCapabilities.has(kind)) {
      sourceArchitectureProblems.push(`semantic operation capability duplicated ${kind}`)
      continue
    }
    semanticCapabilities.set(kind, capability)
  }
  const scopeDerivedMutationFamily = scopeDerivedMutationCapabilityFacts(
    program,
    browserRepoSource,
    workspaceUnion,
    scopeDerivedMutationUnion,
    attemptMutationUnion,
    commandLifetimeReceipt,
    sourceArchitectureProblems,
  )
  for (const [kind, capability] of Object.entries(scopeDerivedMutationFamily.capabilities)) {
    if (semanticCapabilities.has(kind)) {
      sourceArchitectureProblems.push(`semantic operation capability duplicated ${kind}`)
      continue
    }
    semanticCapabilities.set(kind, capability)
  }
  const configurationSettingFamily = configurationSettingCapabilityFacts(
    program,
    browserRepoSource,
    exactSource(program, CONFIGURATION_HANDLER_PATH),
    sourceArchitectureProblems,
  )
  for (const [kind, capability] of Object.entries(configurationSettingFamily.capabilities)) {
    if (semanticCapabilities.has(kind)) {
      sourceArchitectureProblems.push(`semantic operation capability duplicated ${kind}`)
      continue
    }
    semanticCapabilities.set(kind, capability)
  }
  const configurationEntityRowFamily = configurationEntityRowCapabilityFacts(
    program,
    browserRepoSource,
    exactSource(program, CONFIGURATION_HANDLER_PATH),
    sourceArchitectureProblems,
  )
  for (const [kind, capability] of Object.entries(configurationEntityRowFamily.capabilities)) {
    if (semanticCapabilities.has(kind)) {
      sourceArchitectureProblems.push(`semantic operation capability duplicated ${kind}`)
      continue
    }
    semanticCapabilities.set(kind, capability)
  }
  const configurationKeyMaterialFamily = configurationKeyMaterialCapabilityFacts(
    program,
    browserRepoSource,
    exactSource(program, CONFIGURATION_HANDLER_PATH),
    exactSource(program, MUTATION_JOURNAL_PATH),
    sourceArchitectureProblems,
  )
  for (const [kind, capability] of Object.entries(configurationKeyMaterialFamily.capabilities)) {
    if (semanticCapabilities.has(kind)) {
      sourceArchitectureProblems.push(`semantic operation capability duplicated ${kind}`)
      continue
    }
    semanticCapabilities.set(kind, capability)
  }
  const configurationChatFamily = configurationChatCapabilityFacts(
    program,
    browserRepoSource,
    exactSource(program, CONFIGURATION_HANDLER_PATH),
    sourceArchitectureProblems,
  )
  for (const [kind, capability] of Object.entries(configurationChatFamily.capabilities)) {
    if (semanticCapabilities.has(kind)) {
      sourceArchitectureProblems.push(`semantic operation capability duplicated ${kind}`)
      continue
    }
    semanticCapabilities.set(kind, capability)
  }
  const configurationCatalogedRowFamily = configurationCatalogedRowCapabilityFacts(
    program,
    browserRepoSource,
    exactSource(program, CONFIGURATION_HANDLER_PATH),
    exactSource(program, CONFIGURATION_CATALOG_PROJECTION_PATH),
    sourceArchitectureProblems,
  )
  for (const [kind, capability] of Object.entries(configurationCatalogedRowFamily.capabilities)) {
    if (semanticCapabilities.has(kind)) {
      sourceArchitectureProblems.push(`semantic operation capability duplicated ${kind}`)
      continue
    }
    semanticCapabilities.set(kind, capability)
  }
  const configurationPresetLifecycleFamily = configurationPresetLifecycleCapabilityFacts(
    program,
    browserRepoSource,
    exactSource(program, CONFIGURATION_HANDLER_PATH),
    exactSource(program, CONFIGURATION_CATALOG_PROJECTION_PATH),
    exactSource(program, BYTE_OWNER_MUTATION_PATH),
    exactSource(program, PRESET_ORDER_PATH),
    sourceArchitectureProblems,
  )
  for (const [kind, capability] of Object.entries(
    configurationPresetLifecycleFamily.capabilities,
  )) {
    if (semanticCapabilities.has(kind)) {
      sourceArchitectureProblems.push(`semantic operation capability duplicated ${kind}`)
      continue
    }
    semanticCapabilities.set(kind, capability)
  }
  const configurationChatSelectionFamily = configurationChatSelectionCapabilityFacts(
    program,
    browserRepoSource,
    exactSource(program, CONFIGURATION_HANDLER_PATH),
    exactSource(program, CONFIGURATION_CATALOG_PROJECTION_PATH),
    sourceArchitectureProblems,
  )
  for (const [kind, capability] of Object.entries(configurationChatSelectionFamily.capabilities)) {
    if (semanticCapabilities.has(kind)) {
      sourceArchitectureProblems.push(`semantic operation capability duplicated ${kind}`)
      continue
    }
    semanticCapabilities.set(kind, capability)
  }
  const configurationChatRequestTargetFamily = configurationChatRequestTargetCapabilityFacts(
    program,
    browserRepoSource,
    exactSource(program, CONFIGURATION_HANDLER_PATH),
    exactSource(program, CONFIGURATION_CATALOG_PROJECTION_PATH),
    sourceArchitectureProblems,
  )
  for (const [kind, capability] of Object.entries(
    configurationChatRequestTargetFamily.capabilities,
  )) {
    if (semanticCapabilities.has(kind)) {
      sourceArchitectureProblems.push(`semantic operation capability duplicated ${kind}`)
      continue
    }
    semanticCapabilities.set(kind, capability)
  }
  const configurationTargetFanoutFamily = configurationTargetFanoutCapabilityFacts(
    program,
    browserRepoSource,
    exactSource(program, CONFIGURATION_HANDLER_PATH),
    exactSource(program, CONFIGURATION_CATALOG_PROJECTION_PATH),
    sourceArchitectureProblems,
  )
  for (const [kind, capability] of Object.entries(configurationTargetFanoutFamily.capabilities)) {
    if (semanticCapabilities.has(kind)) {
      sourceArchitectureProblems.push(`semantic operation capability duplicated ${kind}`)
      continue
    }
    semanticCapabilities.set(kind, capability)
  }
  const configurationConnectionLifecycleFamily = configurationConnectionLifecycleCapabilityFacts(
    program,
    browserRepoSource,
    exactSource(program, CONFIGURATION_HANDLER_PATH),
    sourceArchitectureProblems,
  )
  for (const [kind, capability] of Object.entries(
    configurationConnectionLifecycleFamily.capabilities,
  )) {
    if (semanticCapabilities.has(kind)) {
      sourceArchitectureProblems.push(`semantic operation capability duplicated ${kind}`)
      continue
    }
    semanticCapabilities.set(kind, capability)
  }
  const configurationConnectionDeleteFamily = configurationConnectionDeleteCapabilityFacts(
    program,
    browserRepoSource,
    exactSource(program, CONFIGURATION_HANDLER_PATH),
    exactSource(program, CONFIGURATION_CATALOG_PROJECTION_PATH),
    sourceArchitectureProblems,
  )
  for (const [kind, capability] of Object.entries(
    configurationConnectionDeleteFamily.capabilities,
  )) {
    if (semanticCapabilities.has(kind)) {
      sourceArchitectureProblems.push(`semantic operation capability duplicated ${kind}`)
      continue
    }
    semanticCapabilities.set(kind, capability)
  }
  const configurationReplayOwnership = configurationReplayOwnershipFacts(
    program,
    configurationUnion,
    [
      [
        configurationEntityRowFamily,
        ['keyTouchOperationDescriptor', 'textTemplateEntityOperationDescriptor'],
      ],
      [configurationKeyMaterialFamily, ['keyMaterialOperationDescriptor']],
      [configurationChatFamily, ['chatConfigurationOperationDescriptor']],
      [configurationCatalogedRowFamily, ['catalogedConfigurationOperationDescriptor']],
      [configurationPresetLifecycleFamily, ['presetLifecycleOperationDescriptor']],
      [configurationChatSelectionFamily, ['chatSelectionOperationDescriptor']],
      [configurationChatRequestTargetFamily, ['chatRequestTargetOperationDescriptor']],
      [configurationTargetFanoutFamily, ['configurationTargetFanoutOperationDescriptor']],
      [configurationConnectionLifecycleFamily, ['connectionProfileLifecycleOperationDescriptor']],
      [configurationConnectionDeleteFamily, ['connectionDeleteOperationDescriptor']],
      [{ variants: ['chat-preset.move'] }, ['presetOrderMoveOperationDescriptor']],
    ],
    sourceArchitectureProblems,
  )
  for (const variant of configurationReplayOwnership.provedVariants) {
    const capability = semanticCapabilities.get(variant)
    if (!capability) {
      sourceArchitectureProblems.push(`configuration replay capability missing ${variant}`)
      continue
    }
    semanticCapabilities.set(
      variant,
      Object.freeze({
        ...capability,
        idempotenceProved: true,
      }),
    )
  }
  const configurationEnvelopeFamily = configurationEnvelopeCapabilityFacts(
    program,
    browserRepoSource,
    exactSource(program, CONFIGURATION_HANDLER_PATH),
    configurationUnion,
    sourceArchitectureProblems,
  )
  for (const [kind, capability] of Object.entries(configurationEnvelopeFamily.capabilities)) {
    if (semanticCapabilities.has(kind)) {
      sourceArchitectureProblems.push(`semantic operation capability duplicated ${kind}`)
      continue
    }
    semanticCapabilities.set(kind, capability)
  }
  const discoveryCacheFamily = discoveryCacheCapabilityFacts(
    program,
    browserRepoSource,
    exactSource(program, CONFIGURATION_HANDLER_PATH),
    workspaceUnion,
    sourceArchitectureProblems,
  )
  for (const [kind, capability] of Object.entries(discoveryCacheFamily.capabilities)) {
    if (semanticCapabilities.has(kind)) {
      sourceArchitectureProblems.push(`semantic operation capability duplicated ${kind}`)
      continue
    }
    semanticCapabilities.set(kind, capability)
  }
  const folderFamily = folderCapabilityFacts(
    program,
    exactSource(program, BROWSER_CATALOG_COMMAND_RUNTIME_PATH),
    workspaceUnion,
    sourceArchitectureProblems,
  )
  for (const [kind, capability] of Object.entries(folderFamily.capabilities)) {
    if (semanticCapabilities.has(kind)) {
      sourceArchitectureProblems.push(`semantic operation capability duplicated ${kind}`)
      continue
    }
    semanticCapabilities.set(kind, capability)
  }
  const generationMetadataFamily = generationMetadataCapabilityFacts(
    program,
    workspaceUnion,
    sourceArchitectureProblems,
  )
  for (const [kind, capability] of Object.entries(generationMetadataFamily.capabilities)) {
    if (semanticCapabilities.has(kind)) {
      sourceArchitectureProblems.push(`semantic operation capability duplicated ${kind}`)
      continue
    }
    semanticCapabilities.set(kind, capability)
  }
  const chatOrganizationFamily = chatOrganizationCapabilityFacts(
    program,
    exactSource(program, BROWSER_CATALOG_COMMAND_RUNTIME_PATH),
    workspaceUnion,
    sourceArchitectureProblems,
  )
  for (const [kind, capability] of Object.entries(chatOrganizationFamily.capabilities)) {
    if (semanticCapabilities.has(kind)) {
      sourceArchitectureProblems.push(`semantic operation capability duplicated ${kind}`)
      continue
    }
    semanticCapabilities.set(kind, capability)
  }
  const chatClosureFamily = chatClosureCapabilityFacts(
    exactSource(program, BROWSER_CATALOG_COMMAND_RUNTIME_PATH),
    exactSource(program, 'src/store/chat-storage-ownership.ts'),
    browserRepoSource,
    sourceArchitectureProblems,
  )
  for (const [kind, capability] of Object.entries(chatClosureFamily.capabilities)) {
    if (semanticCapabilities.has(kind)) {
      sourceArchitectureProblems.push(`semantic operation capability duplicated ${kind}`)
      continue
    }
    semanticCapabilities.set(kind, capability)
  }
  const chatForkFamily = chatForkCapabilityFacts(browserRepoSource, sourceArchitectureProblems)
  for (const [kind, capability] of Object.entries(chatForkFamily.capabilities)) {
    if (semanticCapabilities.has(kind)) {
      sourceArchitectureProblems.push(`semantic operation capability duplicated ${kind}`)
      continue
    }
    semanticCapabilities.set(kind, capability)
  }
  const interchangeImportFamily = interchangeImportCapabilityFacts(
    exactSource(program, BROWSER_IMPORT_EXPORT_PATH),
    workspaceUnion,
    sourceArchitectureProblems,
  )
  for (const [kind, capability] of Object.entries(interchangeImportFamily.capabilities)) {
    if (semanticCapabilities.has(kind)) {
      sourceArchitectureProblems.push(`semantic operation capability duplicated ${kind}`)
      continue
    }
    semanticCapabilities.set(kind, capability)
  }
  validateTransactionDerivedWriteSource(
    browserRepoSource,
    exactSource(program, MUTATION_JOURNAL_PATH),
    exactSource(program, DATABASE_PATH),
    exactSource(program, WORKSPACE_REPOSITORY_PATH),
    exactSource(program, WORKSPACE_EFFECT_HUB_PATH),
    sourceArchitectureProblems,
  )
  return Object.freeze({
    auditedUnionSubjects: Object.freeze(
      [
        ['workspace', workspaceUnion],
        ['configuration', configurationUnion],
      ].map(([name, union]) => Object.freeze({ name, id: union.id })),
    ),
    workspaceUnion,
    scopeDerivedMutationUnion,
    configurationUnion,
    constructorsByWorkspaceVariant: frozenArrayRecord(constructorSitesByVariant(workspaceUnion)),
    constructorsByConfigurationVariant: frozenArrayRecord(
      constructorSitesByVariant(configurationUnion),
    ),
    dispatchBodies: frozenScalarRecord(commandDispatchCaseBodies(browserRepoSource)),
    configurationHandlers: frozenScalarRecord(
      configurationHandlerTargets(exactSource(program, CONFIGURATION_HANDLER_PATH)),
    ),
    actualManualMarkers: frozenScalarRecord(manualWriteMarkerOwnerCounts(program)),
    actualDirectTransactions: frozenScalarRecord(directGrantTransactionOwnerCounts(program)),
    semanticCapabilities: frozenScalarRecord(semanticCapabilities),
    commandLifetimeReceipt,
    singleChatMetadataFamily,
    chatSetArchivedFamily,
    chatCalibrationFamily,
    streamLeaseOperationFamily,
    streamJournalAppendFamily,
    streamJournalRetirementFamily,
    scopeDerivedMutationFamily,
    configurationSettingFamily,
    configurationEntityRowFamily,
    configurationKeyMaterialFamily,
    configurationChatFamily,
    configurationCatalogedRowFamily,
    configurationPresetLifecycleFamily,
    configurationChatSelectionFamily,
    configurationChatRequestTargetFamily,
    configurationTargetFanoutFamily,
    configurationConnectionLifecycleFamily,
    configurationConnectionDeleteFamily,
    configurationReplayOwnership,
    configurationEnvelopeFamily,
    discoveryCacheFamily,
    folderFamily,
    generationMetadataFamily,
    chatOrganizationFamily,
    chatClosureFamily,
    chatForkFamily,
    interchangeImportFamily,
    sourceArchitectureProblems: Object.freeze(sourceArchitectureProblems.sort()),
    physicalTables: Object.freeze(
      literalArrayValues(
        exactSource(program, 'src/store/physical-storage-tables.ts'),
        'PHYSICAL_STORAGE_TABLE_NAMES',
      ),
    ),
  })
}

export function evaluateDurableCommandPipeline(
  inventory = defaultInventory,
  mode = 'inventory',
  options = {},
  facts = buildDurableCommandPipelineSourceFacts(),
) {
  const {
    CONFIGURATION_COMMAND_PIPELINES,
    DIRECT_COMMAND_TRANSACTION_OWNER_COUNTS,
    MANUAL_WRITE_MARKER_OWNER_COUNTS,
    REQUIRED_PIPELINE_STAGES,
    WORKSPACE_COMMAND_PIPELINES,
    WRITE_DETECTION_ARCHITECTURE,
  } = inventory
  const {
    workspaceUnion,
    configurationUnion,
    constructorsByWorkspaceVariant: workspaceConstructorRecord,
    constructorsByConfigurationVariant: configurationConstructorRecord,
    dispatchBodies: dispatchBodyRecord,
    configurationHandlers: configurationHandlerRecord,
    actualManualMarkers: manualMarkerRecord,
    actualDirectTransactions: directTransactionRecord,
    semanticCapabilities: semanticCapabilityRecord,
    commandLifetimeReceipt,
  } = facts
  const constructorsByWorkspaceVariant = new Map(Object.entries(workspaceConstructorRecord))
  const constructorsByConfigurationVariant = new Map(Object.entries(configurationConstructorRecord))
  const dispatchBodies = new Map(Object.entries(dispatchBodyRecord))
  const configurationHandlers = new Map(Object.entries(configurationHandlerRecord))
  const actualManualMarkers = new Map(Object.entries(manualMarkerRecord))
  const actualDirectTransactions = new Map(Object.entries(directTransactionRecord))
  const commandLifetimeProved =
    commandLifetimeReceipt &&
    Object.values(commandLifetimeReceipt.commonKernel ?? {}).every((value) => value === true)
  const semanticCapabilities = new Map(
    Object.entries(semanticCapabilityRecord ?? {}).map(([variant, capability]) => [
      variant,
      commandLifetimeProved
        ? capability
        : Object.freeze({
            ...capability,
            tablesProved: false,
            boundsProved: false,
          }),
    ]),
  )
  const effectiveWorkspacePipelines = applySemanticCapabilityStages(
    WORKSPACE_COMMAND_PIPELINES,
    semanticCapabilities,
  )
  const effectiveConfigurationPipelines = applySemanticCapabilityStages(
    CONFIGURATION_COMMAND_PIPELINES,
    semanticCapabilities,
  )
  const problems = []
  compareExact(
    'workspace command pipeline variants',
    workspaceUnion.variants,
    Object.keys(effectiveWorkspacePipelines),
    problems,
  )
  compareExact(
    'configuration command pipeline variants',
    configurationUnion.variants,
    Object.keys(effectiveConfigurationPipelines),
    problems,
  )
  const requiredStages = Array.isArray(REQUIRED_PIPELINE_STAGES) ? REQUIRED_PIPELINE_STAGES : []
  compareExact(
    'required durable pipeline stages',
    EXPECTED_PIPELINE_STAGES,
    requiredStages,
    problems,
  )
  validatePipelineRecords('workspace', effectiveWorkspacePipelines, requiredStages, problems)
  validatePipelineRecords(
    'configuration',
    effectiveConfigurationPipelines,
    requiredStages,
    problems,
  )
  for (const variant of workspaceUnion.variants) {
    const sites = constructorsByWorkspaceVariant.get(variant) ?? []
    if (sites.length === 0) problems.push(`workspace ${variant}: no typed production constructor`)
    if (effectiveWorkspacePipelines[variant]?.constructor?.status !== 'observed') {
      problems.push(`workspace ${variant}: constructor stage must match reachable typed sites`)
    }
  }
  for (const variant of configurationUnion.variants) {
    const contract = CONFIGURATION_COMMANDS[variant]
    const sites = constructorsByConfigurationVariant.get(variant) ?? []
    const stage = effectiveConfigurationPipelines?.[variant]?.constructor
    if (contract?.status === 'reachable') {
      if (sites.length === 0)
        problems.push(`configuration ${variant}: reachable without constructor`)
      if (stage?.status !== 'observed') {
        problems.push(`configuration ${variant}: constructor stage contradicts reachable protocol`)
      }
    } else if (contract?.status === 'gap') {
      if (sites.length > 0)
        problems.push(`configuration ${variant}: gap has typed constructor sites`)
      if (stage?.status !== 'gap')
        problems.push(`configuration ${variant}: constructor gap is hidden`)
    } else {
      problems.push(`configuration ${variant}: missing nested protocol classification`)
    }
  }
  compareExact(
    'workspace dispatch variants',
    workspaceUnion.variants,
    [...dispatchBodies.keys()],
    problems,
  )
  for (const variant of workspaceUnion.variants) {
    const body = dispatchBodies.get(variant) ?? ''
    const handler = effectiveWorkspacePipelines[variant]?.handler?.proof
    for (const token of proofTokens(handler)) {
      if (!body.includes(token))
        problems.push(`workspace ${variant}: dispatch handler missing ${token}`)
    }
  }
  compareExact(
    'configuration handler variants',
    configurationUnion.variants,
    [...configurationHandlers.keys()],
    problems,
  )
  for (const variant of configurationUnion.variants) {
    const expected = effectiveConfigurationPipelines?.[variant]?.handler?.proof
    const actual = configurationHandlers.get(variant)
    if (typeof expected === 'string' && actual !== expected) {
      problems.push(`configuration ${variant}: expected handler ${expected}, found ${actual}`)
    }
  }
  compareCountMap(
    'manual write-marker owners',
    MANUAL_WRITE_MARKER_OWNER_COUNTS ?? {},
    actualManualMarkers,
    problems,
  )
  compareCountMap(
    'direct command transaction owners',
    DIRECT_COMMAND_TRANSACTION_OWNER_COUNTS ?? {},
    actualDirectTransactions,
    problems,
  )
  validateWriteArchitectureDeclaration(WRITE_DETECTION_ARCHITECTURE, problems)
  problems.push(...facts.sourceArchitectureProblems)
  for (const [scope, records] of [
    ['workspace', effectiveWorkspacePipelines],
    ['configuration', effectiveConfigurationPipelines],
  ]) {
    for (const [variant, record] of Object.entries(records ?? {})) {
      if (record?.writeDetection?.status !== 'observed') {
        problems.push(`${scope} ${variant}: transaction-derived write detection must be observed`)
      }
      if (record?.broadcast?.status !== 'observed') {
        problems.push(`${scope} ${variant}: committed-write broadcast must be observed`)
      }
    }
  }
  const allRecords = [
    ...Object.entries(effectiveWorkspacePipelines).map(([variant, record]) => ({
      scope: 'workspace',
      variant,
      record,
      constructors: constructorsByWorkspaceVariant.get(variant) ?? [],
    })),
    ...Object.entries(effectiveConfigurationPipelines).map(([variant, record]) => ({
      scope: 'configuration',
      variant,
      record,
      constructors: constructorsByConfigurationVariant.get(variant) ?? [],
    })),
  ]
  const stageCells = allRecords.length * requiredStages.length
  const gaps = allRecords.flatMap(({ scope, variant, record }) =>
    requiredStages.flatMap((stage) =>
      record?.[stage]?.status === 'gap'
        ? [{ scope, variant, stage, reason: record[stage].reason }]
        : [],
    ),
  )
  const markerCalls = [...actualManualMarkers.values()].reduce((sum, count) => sum + count, 0)
  const directTransactionCalls = [...actualDirectTransactions.values()].reduce(
    (sum, count) => sum + count,
    0,
  )
  const gapStageCounts = Object.fromEntries(
    requiredStages.map((stage) => [stage, gaps.filter((gap) => gap.stage === stage).length]),
  )
  const structurallyValid = problems.length === 0
  return Object.freeze({
    mode,
    ok: structurallyValid && (mode !== 'enforce' || gaps.length === 0),
    structurallyValid,
    ...staticAuditState({ structurallyValid, gaps }),
    workspaceCommands: workspaceUnion.variants.length,
    workspaceConstructorSites: workspaceUnion.constructorSites.length,
    configurationCommands: configurationUnion.variants.length,
    configurationConstructorSites: configurationUnion.constructorSites.length,
    configurationConstructorGaps: Object.values(CONFIGURATION_COMMANDS).filter(
      (entry) => entry.status === 'gap',
    ).length,
    pipelineRecords: allRecords.length,
    requiredStages: requiredStages.length,
    stageCells,
    gapCells: gaps.length,
    observedCells: stageCells - gaps.length,
    manualMarkerOwners: actualManualMarkers.size,
    manualMarkerCalls: markerCalls,
    directTransactionOwners: actualDirectTransactions.size,
    directTransactionCalls,
    semanticCapabilityCommands: semanticCapabilities.size,
    physicalTables: facts.physicalTables,
    gapStageCounts,
    ...(options.detail ? { records: allRecords, gaps } : {}),
    limitations: Object.freeze([
      'Transaction table guards prove only tables declared by a selected helper; command-to-helper-to-table completeness remains unproven.',
      'Transaction-local mutation facts close write detection, but the exact semantic meaning of each mutated table is not inferred from bytes alone.',
      'Physical evidence is checked against the generic commit envelope, but exact command-to-semantic-effect completeness remains a per-command gap.',
      'A permitted-write guard does not close physical-write completeness until the command capability requires its primary writes.',
      'Effect-kind guards do not close receipt/delta completeness until exact dependency identities, facets, keys, and cardinality are capability-derived.',
      'Retry idempotence and work/memory bounds remain explicit gaps until each command has executable proof.',
    ]),
    problems: Object.freeze(problems.sort()),
  })
}

function configurationEnvelopeCapabilityFacts(
  program,
  browserRepoSource,
  configurationSource,
  configurationUnion,
  outputProblems,
) {
  const checker = program.getTypeChecker()
  const executor = findFunctionImplementation(
    configurationSource,
    'executeConfigurationCommandInBrowser',
  )
  const dispatchBody =
    commandDispatchCaseBodies(browserRepoSource).get('configuration.execute') ?? ''
  const handlers = configurationHandlerRoots(checker, configurationSource)
  const handlerCalls = executableCalls(executor).filter(
    (call) => call.expression.getText(configurationSource) === 'handler',
  )
  const executorText = executor.getText(configurationSource)
  const delegationText = findVariableInitializer(
    browserRepoSource,
    'CONFIGURATION_COMMAND_SEMANTIC_DELEGATION',
  ).getText(browserRepoSource)
  const kindResolverText = findFunction(
    browserRepoSource,
    'workspaceCommandSemanticOperationKind',
  ).getText(browserRepoSource)
  const repositoryExecuteText = findMethod(
    browserRepoSource,
    'BrowserWorkspaceRepository',
    'execute',
  ).getText(browserRepoSource)
  const envelopeText = [dispatchBody, executorText].join('\n')
  const commonKernel = {
    exactNestedCoverage:
      configurationUnion.variants.length > 0 &&
      configurationUnion.variants.every((variant) => handlers.has(variant)) &&
      handlers.size === configurationUnion.variants.length,
    typedDelegationCapability:
      delegationText.includes('semanticOperationDelegationCapability<') &&
      delegationText.includes("operationKind: 'configuration.execute'") &&
      delegationText.includes('configurationSemanticOperationKind(command.input.kind)'),
    nestedIdentityDerived:
      kindResolverText.includes(
        'command.kind === CONFIGURATION_COMMAND_SEMANTIC_DELEGATION.operationKind',
      ) &&
      kindResolverText.includes(
        'CONFIGURATION_COMMAND_SEMANTIC_DELEGATION.childOperationKind(command)',
      ) &&
      kindResolverText.includes('return command.kind'),
    exactEnvelopeCommitIdentity:
      countOccurrences(repositoryExecuteText, 'workspaceCommandSemanticOperationKind(command)') ===
        1 &&
      !repositoryExecuteText.includes(
        "command.kind === 'configuration.execute'\n          ? configurationSemanticOperationKind",
      ),
    exactEnvelopeDispatch:
      dispatchBody.split('executeConfigurationCommandInBrowser(command.input, commit)').length -
        1 ===
      1,
    noRedundantDatabaseOpen:
      !dispatchBody.includes('openDb(') &&
      !executorText.includes('openDb(') &&
      !executorText.includes('Dexie'),
    exactOneNestedHandler:
      handlerCalls.length === 1 &&
      handlerCalls[0]?.arguments.length === 2 &&
      handlerCalls[0]?.arguments[0]?.getText(configurationSource) === 'command' &&
      handlerCalls[0]?.arguments[1]?.getText(configurationSource) === 'commandMeta',
    nestedResultDerived:
      executorText.includes("ConfigurationDomainResult<Command['kind']>") &&
      executorText.includes("ConfigurationDomainResult<Command['kind']>>"),
    zeroEnvelopeStorageOwnership: [
      '.withLocks(',
      'runTransaction(',
      'executeSemanticOperation(',
      'completeSemanticOperation(',
      '.table(',
      '.table<',
      '.get(',
      '.put(',
      '.delete(',
      '.bulk',
      'while (',
      'setTimeout(',
    ].every((token) => !envelopeText.includes(token)),
    zeroEnvelopeControlLoop:
      !envelopeText.includes('for (') &&
      !envelopeText.includes('for await') &&
      !envelopeText.includes('retry') &&
      countOccurrences(executorText, 'executeConfigurationCommandInBrowser') === 1,
  }
  for (const [name, consumed] of Object.entries(commonKernel)) {
    if (!consumed) outputProblems.push(`configuration envelope missing ${name}`)
  }
  const consumed = Object.values(commonKernel).every(Boolean)
  return Object.freeze({
    variants: Object.freeze(['configuration.execute']),
    nestedVariants: Object.freeze([...configurationUnion.variants]),
    commonKernel: Object.freeze(commonKernel),
    capabilities: Object.freeze({
      'configuration.execute': Object.freeze({
        path: CONFIGURATION_HANDLER_PATH,
        owner: 'executeConfigurationCommandInBrowser',
        transaction: 'nested-configuration-semantic-operation',
        consumed,
        physicalWritesProved: true,
        exactPhysicalWritesProved: true,
        exactEffectsProved: true,
        tablesProved: true,
        boundsProved: true,
        idempotenceProved: true,
      }),
    }),
  })
}

function discoveryCacheCapabilityFacts(
  program,
  browserRepoSource,
  configurationSource,
  workspaceUnion,
  outputProblems,
) {
  const directVariants = workspaceUnion.variants
    .filter(
      (variant) =>
        variant.startsWith('discovery.') &&
        (variant.endsWith('.put') || variant.endsWith('.delete')),
    )
    .sort()
  const maintenanceVariant = 'maintenance.prune-discovery-cache'
  const variants = [...directVariants, maintenanceVariant].sort()
  const storageSource = exactSource(program, DISCOVERY_CACHE_STORAGE_PATH)
  const mutationJournalSource = exactSource(program, MUTATION_JOURNAL_PATH)
  const semanticCapabilitySource = exactSource(program, SEMANTIC_OPERATION_CAPABILITY_PATH)
  const discoveryServiceSource = exactSource(program, DISCOVERY_SERVICE_PATH)
  const modelResolutionSource = exactSource(
    program,
    'src/store/configuration-model-resolution-capability.ts',
  )
  const modelsCacheSource = exactSource(program, MODELS_CACHE_PATH)
  const descriptorText = findFunction(
    browserRepoSource,
    'discoveryCacheOperationDescriptor',
  ).getText(browserRepoSource)
  const transactionText = findFunction(
    browserRepoSource,
    'discoveryCacheOperationTransaction',
  ).getText(browserRepoSource)
  const dispatchText = findMethod(
    browserRepoSource,
    'BrowserWorkspaceRepository',
    'mutateDiscoveryCache',
  ).getText(browserRepoSource)
  const modelsText = findMethod(
    browserRepoSource,
    'BrowserWorkspaceRepository',
    'putModelsDiscoveryCacheRow',
  ).getText(browserRepoSource)
  const rowText = findMethod(
    browserRepoSource,
    'BrowserWorkspaceRepository',
    'putDiscoveryCacheRow',
  ).getText(browserRepoSource)
  const deleteText = findMethod(
    browserRepoSource,
    'BrowserWorkspaceRepository',
    'deleteDiscoveryCacheRow',
  ).getText(browserRepoSource)
  const maintenanceDescriptorText = findVariableInitializer(
    browserRepoSource,
    'DISCOVERY_CACHE_MAINTENANCE_OPERATION',
  ).getText(browserRepoSource)
  const maintenanceText = findMethod(
    browserRepoSource,
    'BrowserWorkspaceRepository',
    'pruneDiscoveryCache',
  ).getText(browserRepoSource)
  const exactReceiptText = findFunction(browserRepoSource, 'discoveryCacheExactReceipt').getText(
    browserRepoSource,
  )
  const putBoundsText = findVariableInitializer(
    browserRepoSource,
    'DISCOVERY_CACHE_PUT_OPERATION_BOUNDS',
  ).getText(browserRepoSource)
  const deleteBoundsText = findVariableInitializer(
    browserRepoSource,
    'DISCOVERY_CACHE_DELETE_OPERATION_BOUNDS',
  ).getText(browserRepoSource)
  const maintenanceBoundsText = findFunction(
    browserRepoSource,
    'discoveryCacheMaintenanceOperationBounds',
  ).getText(browserRepoSource)
  const putStorageText = findFunction(storageSource, 'putDiscoveryCacheRow').getText(storageSource)
  const deleteStorageText = findFunction(storageSource, 'deleteDiscoveryCacheRow').getText(
    storageSource,
  )
  const maintainStorageText = findFunction(storageSource, 'maintainDiscoveryCache').getText(
    storageSource,
  )
  const headerRepairProbeText = findFunction(
    storageSource,
    'readBoundedDiscoveryHeaderRepairCandidates',
  ).getText(storageSource)
  const payloadReferenceProbeText = findFunction(
    storageSource,
    'deletePayloadIfUnreferenced',
  ).getText(storageSource)
  const readEvidenceText = findFunction(storageSource, 'readDiscoveryCacheRowWithEvidence').getText(
    storageSource,
  )
  const readRecorderText = findFunction(storageSource, 'recordDiscoveryCacheRead').getText(
    storageSource,
  )
  const maintenanceReplayText = findFunction(
    storageSource,
    'discoveryCacheMaintenanceReplay',
  ).getText(storageSource)
  const publishText = findFunction(discoveryServiceSource, 'publishDiscoveryRow').getText(
    discoveryServiceSource,
  )
  const clearModelsText = findFunction(modelsCacheSource, 'clearCachedModels').getText(
    modelsCacheSource,
  )
  const switchText = findFunction(configurationSource, 'switchChatProfile').getText(
    configurationSource,
  )
  const switchTransactionText = findFunction(
    configurationSource,
    'chatRequestTargetOperationTransaction',
  ).getText(configurationSource)
  const switchResourcesText = findFunction(
    configurationSource,
    'chatRequestTargetResourceNames',
  ).getText(configurationSource)
  const switchedChatText = findFunction(configurationSource, 'switchedProfileChat').getText(
    configurationSource,
  )
  const commonKernel = {
    exactVariants:
      directVariants.length === 4 &&
      directVariants.every((variant) => dispatchText.includes(`case '${variant}'`)) &&
      workspaceUnion.variants.includes(maintenanceVariant),
    oneTypedDescriptor:
      descriptorText.includes('semanticOperationDescriptor') &&
      descriptorText.includes('operationKind: kind') &&
      descriptorText.includes('transaction') &&
      descriptorText.includes('resources: (input: DiscoveryCacheOperationInput)') &&
      descriptorText.includes('requiredWritesWhenMutated: []') &&
      descriptorText.includes('semanticOperationExactReceiptContracts<') &&
      descriptorText.includes('semanticOperationExactReceiptReplayProofContract'),
    maintenanceTypedDescriptor:
      maintenanceDescriptorText.includes(`operationKind: '${maintenanceVariant}'`) &&
      maintenanceDescriptorText.includes('semanticOperationExactReceiptContracts<') &&
      maintenanceDescriptorText.includes('semanticOperationExactReceiptReplayProofContract') &&
      maintenanceDescriptorText.includes('assertDiscoveryCacheMaintenanceReplayProof'),
    exactVariantTransactions:
      transactionText.includes("case 'discovery.models.put'") &&
      transactionText.includes("case 'discovery.endpoints.put'") &&
      transactionText.includes("case 'discovery.privacy.put'") &&
      transactionText.includes('DISCOVERY_CACHE_ROW_WRITE_TRANSACTION_CAPABILITY') &&
      transactionText.includes("case 'discovery.models.delete'") &&
      transactionText.includes('DISCOVERY_CACHE_MUTATION_TRANSACTION_CAPABILITY'),
    exactIntentResources:
      descriptorText.includes("'discovery-cache:retention'") &&
      descriptorText.includes('discoveryCacheOperationTable(input.kind)') &&
      descriptorText.includes('input.targetKey'),
    everyRouteConsumesSemanticOwner:
      directVariants.every((variant) => dispatchText.includes(`case '${variant}'`)) &&
      modelsText.includes('commit.executeSemanticOperation(') &&
      rowText.includes('commit.executeSemanticOperation(') &&
      deleteText.includes('commit.executeSemanticOperation(') &&
      maintenanceText.includes('commit.executeSemanticOperation('),
    oneExactReceiptOwner:
      [modelsText, rowText, deleteText, maintenanceText].every(
        (text) =>
          text.includes('requireDiscoveryCacheReceiptAccumulator(tx)') &&
          text.includes('discoveryCacheExactReceipt(') &&
          text.includes('semanticOperationExecution('),
      ) &&
      exactReceiptText.includes('receipt.snapshotFragment()') &&
      exactReceiptText.includes('semanticOperationExactReceipt('),
    exactStorageReadReceipt:
      putStorageText.includes('recordDiscoveryCacheRead(') &&
      deleteStorageText.includes('recordDiscoveryCacheRead(') &&
      maintainStorageText.includes('recordDiscoveryCacheRead(') &&
      readEvidenceText.includes('recordDiscoveryCacheRead(') &&
      readRecorderText.includes('receipt.physicalRead('),
    exactStorageDependencyReceipt:
      storageSource.getText().includes('receipt?.dependency(dependency)') &&
      modelsText.includes('receipt.dependency(dependency)') &&
      modelsText.includes("kind: 'model-resolution'"),
    guardedCurrentReadReused:
      rowText.includes('knownCurrent = (await readDiscoveryCacheRowWithEvidence(') &&
      rowText.includes('...(knownCurrent ? { knownCurrent } : {})') &&
      putStorageText.includes('const currentStorage = knownCurrent') &&
      putStorageText.includes('const knownMetadata = knownCurrent?.metadata'),
    payloadDeleteIdentityReadFree: mutationJournalSource
      .getText()
      .includes("'discoveryPayloadMetadata',\n  'discoveryPayloads'"),
    transactionLocalPublication:
      !modelsText.includes('pendingModelResolutionChatIds(') &&
      !modelsText.includes("tx.table<ConfigurationLink, string>('configurationLinks')") &&
      !modelsText.includes('applyChatRowWriteTransitions(') &&
      modelsText.includes('recordBrowserCommandInvalidation(tx, dependency)') &&
      !modelsText.includes('ModelResolutionPublicationPlanChangedError'),
    noLegacyPlanning:
      [modelsText, rowText, deleteText].every(
        (text) =>
          !text.includes('.withLocks(') &&
          !text.includes('for (;;)') &&
          !text.includes('setTimeout('),
      ) &&
      !modelsText.includes('this.openDb()') &&
      !maintenanceText.includes('setTimeout('),
    publicationSwitchTwoOrder:
      switchText.includes("readDiscoveryCacheRowWithEvidence(tx, 'models'") &&
      switchTransactionText.includes('input.readModelsCache') &&
      switchTransactionText.includes('CONFIGURATION_MODELS_CACHE_READ_TRANSACTION') &&
      switchResourcesText.includes('input.nextModelResolutionTarget') &&
      modelsText.includes("configurationTargetKey('model-resolution', row.profileRevision)") &&
      modelResolutionSource.getText().includes("kind: 'configuration.model-resolution-head'") &&
      modelResolutionSource.getText().includes("kind: 'configuration.model-resolution-page'") &&
      modelResolutionSource.getText().includes("kind: 'chat.resolve-model'") &&
      modelResolutionSource.getText().includes('resolveModelIdFromCatalog(') &&
      modelResolutionSource.getText().includes("impactKinds: ['model-resolution']") &&
      switchedChatText.includes('resolveModelIdFromCatalog('),
    maintenanceReplayFromDurableState:
      maintenanceText.includes('result.replay') &&
      maintainStorageText.includes('const replay = discoveryCacheMaintenanceReplay(') &&
      maintenanceReplayText.includes("kind: 'durable-page-resume'") &&
      maintenanceReplayText.includes("owner: 'discovery-cache:maintenance'") &&
      maintenanceReplayText.includes('cursor: stableStringify(current?.audit ?? null)') &&
      maintenanceReplayText.includes('limit'),
    directSingleAttemptReceipt:
      descriptorText.includes('assertDirectDiscoveryCacheReplayProof') &&
      [modelsText, rowText, deleteText].every(
        (text) =>
          text.includes("kind: 'single-attempt'") &&
          text.includes("reason: 'unfenced-relative-update'"),
      ),
    callerSingleAttemptOwned:
      countOccurrences(publishText, '.execute(authority, {') === 3 &&
      directVariants
        .filter((variant) => variant.endsWith('.put'))
        .every((variant) => countOccurrences(publishText, `case '${variant}'`) === 1) &&
      countOccurrences(clearModelsText, 'getWorkspaceRepository().execute(authority, {') === 1 &&
      countOccurrences(clearModelsText, "kind: 'discovery.models.delete'") === 1 &&
      countOccurrences(clearModelsText, "runWorkspaceAction('cache-refresh', clear)") === 1,
    finiteCardinalityBounds:
      exactReceiptText.includes('bounds: SemanticOperationPhysicalBounds') &&
      exactReceiptText.includes('bounds,') &&
      putBoundsText.includes('maxRequests: 79') &&
      putBoundsText.includes('maxRows: 851') &&
      putBoundsText.includes('maxBatchRows: 260') &&
      putBoundsText.includes('maxRequests: 137') &&
      putBoundsText.includes('maxRows: 198') &&
      putBoundsText.includes('maxBatchRows: 64') &&
      deleteBoundsText.includes('maxRequests: 7') &&
      deleteBoundsText.includes('maxRows: 7') &&
      deleteBoundsText.includes('maxRequests: 4') &&
      deleteBoundsText.includes('maxRows: 4') &&
      maintenanceBoundsText.includes('boundedMaintenanceLimit(limit)') &&
      maintenanceBoundsText.includes('maxRequests: 8 + 4 * boundedLimit') &&
      maintenanceBoundsText.includes('maxRows: 1_093 + 1_090 * boundedLimit') &&
      maintenanceBoundsText.includes('maxRequests: 2 * boundedLimit + 1') &&
      maintenanceBoundsText.includes('maxRows: 2 * boundedLimit + 1'),
    boundedStorageProbes:
      putStorageText.includes('DISCOVERY_CACHE_LIMITS.perProfileRows[tableName] + 1') &&
      putStorageText.includes('.primaryKeys()') &&
      !putStorageText.includes('.equals(row.profileId).count()') &&
      payloadReferenceProbeText.includes('.limit(1).primaryKeys()') &&
      maintainStorageText.includes('readBoundedDiscoveryHeaderRepairCandidates(tx, receipt)') &&
      headerRepairProbeText.includes('DISCOVERY_CACHE_LIMITS.globalRows[tableName]') &&
      headerRepairProbeText.includes('.limit(globalLimit + 1)'),
    byteBoundsRemainOpen:
      [putBoundsText, deleteBoundsText, maintenanceBoundsText].every((text) =>
        text.includes('maxBytes: Number.MAX_SAFE_INTEGER'),
      ) &&
      !modelsText.includes('pendingModelResolutionChatIds(') &&
      modelResolutionSource.getText().includes('if (!page.pageFull) return targetProgress') &&
      modelResolutionSource.getText().includes('if (!pageProgress) return targetProgress'),
    snapshotPrimitiveConsumed:
      semanticCapabilitySource.getText().includes('snapshotFragment()') &&
      semanticCapabilitySource.getText().includes('semanticOperationReceiptFragment(snapshot())'),
  }
  for (const [name, consumed] of Object.entries(commonKernel)) {
    if (!consumed) outputProblems.push(`discovery cache family missing ${name}`)
  }
  const consumed = Object.values(commonKernel).every(Boolean)
  const directReplayProved =
    commonKernel.directSingleAttemptReceipt && commonKernel.callerSingleAttemptOwned
  const maintenanceReplayProved = commonKernel.maintenanceReplayFromDurableState
  return Object.freeze({
    variants: Object.freeze(variants),
    commonKernel: Object.freeze(commonKernel),
    capabilities: Object.freeze(
      Object.fromEntries(
        variants.map((variant) => [
          variant,
          Object.freeze({
            path: BROWSER_REPO_PATH,
            owner:
              variant === maintenanceVariant
                ? 'DISCOVERY_CACHE_MAINTENANCE_OPERATION'
                : 'discoveryCacheOperationDescriptor',
            transaction:
              variant === maintenanceVariant
                ? 'DISCOVERY_CACHE_MUTATION_TRANSACTION_CAPABILITY'
                : 'discoveryCacheOperationTransaction',
            consumed,
            physicalWritesProved: true,
            exactPhysicalWritesProved: true,
            exactEffectsProved: true,
            tablesProved: true,
            boundsProved: true,
            byteBoundsProved: false,
            idempotenceProved:
              variant === maintenanceVariant ? maintenanceReplayProved : directReplayProved,
          }),
        ]),
      ),
    ),
  })
}

function applySemanticCapabilityStages(records, capabilities) {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(records ?? {}).map(([variant, record]) => {
        const capability = capabilities.get(variant)
        if (!capability?.consumed) return [variant, record]
        const proof = `${capability.path}#${capability.owner}`
        return [
          variant,
          Object.freeze({
            ...record,
            kernel: observedStage(`${proof}:compiled-and-executed`),
            lock: observedStage(`${proof}:resources`),
            transaction: observedStage(`${proof}:transaction`),
            ...(capability.tablesProved
              ? {
                  tables: observedStage(
                    `${SEMANTIC_OPERATION_CAPABILITY_PATH}#assertSemanticOperationExactPhysicalReads`,
                  ),
                }
              : {}),
            ...(capability.physicalWritesProved
              ? {
                  physicalWrites: observedStage(
                    `${SEMANTIC_OPERATION_CAPABILITY_PATH}#${
                      capability.exactPhysicalWritesProved
                        ? 'assertSemanticOperationExactPhysicalMutations'
                        : 'assertSemanticOperationWrites'
                    }`,
                  ),
                }
              : {}),
            ...(capability.exactEffectsProved
              ? {
                  receiptDelta: observedStage(
                    `${SEMANTIC_OPERATION_CAPABILITY_PATH}#assertSemanticOperationExactInvalidations`,
                  ),
                }
              : {}),
            rollback: observedStage(`${proof}:fenced-transaction`),
            ...(capability.boundsProved
              ? { bounds: observedStage(`${proof}:bounded-physical-io`) }
              : {}),
            ...(capability.idempotenceProved
              ? { idempotence: observedStage(`${proof}:replay-policy`) }
              : {}),
          }),
        ]
      }),
    ),
  )
}

function observedStage(proof) {
  return Object.freeze({ status: 'observed', proof })
}

function semanticOperationCapabilityFacts(program, outputProblems) {
  const facts = new Map()
  for (const source of program.getSourceFiles()) {
    if (!isProductionSource(source)) continue
    const path = relative(ROOT, source.fileName).split(sep).join('/')
    visit(source, (node) => {
      if (
        !ts.isCallExpression(node) ||
        node.expression.getText(source) !== 'semanticOperationDescriptor'
      ) {
        return
      }
      const definition = node.arguments[0] ? unwrap(node.arguments[0]) : undefined
      if (!definition || !ts.isObjectLiteralExpression(definition)) {
        outputProblems.push(`${path}: semantic operation descriptor must use an object literal`)
        return
      }
      const owner = containingVariableName(node) ?? '<anonymous>'
      const containingFunction = containingFunctionDeclaration(node)?.name?.text
      if (
        path === BROWSER_CATALOG_COMMAND_RUNTIME_PATH &&
        ((owner.startsWith('FOLDER_') && owner.endsWith('_OPERATION')) ||
          owner === 'CHAT_TOUCH_VIEWED_OPERATION' ||
          owner === 'CHAT_SET_MANUAL_TITLE_OPERATION' ||
          owner === 'CHAT_SET_ARCHIVED_OPERATION' ||
          owner === 'CHAT_CALIBRATION_CLEAR_OPERATION' ||
          owner === 'CHAT_CALIBRATION_CLEAR_FAMILY_OPERATION' ||
          owner === 'CHAT_CALIBRATION_CLEAR_ALL_OPERATION' ||
          owner === 'CHAT_MOVE_TO_FOLDER_OPERATION' ||
          owner === 'CHAT_SET_TAGS_FROM_NAMES_OPERATION' ||
          owner === 'CHAT_DISCARD_EMPTY_DRAFTS_OPERATION' ||
          owner === 'CHAT_DELETE_ARCHIVED_OPERATION' ||
          owner === 'CHAT_EMPTY_ARCHIVE_OPERATION')
      ) {
        return
      }
      if (path === BROWSER_REPO_PATH && owner === 'CHAT_FORK_OPERATION') return
      if (
        path === BROWSER_GENERATION_COMMAND_RUNTIME_PATH &&
        owner === 'GENERATION_METADATA_OPERATION'
      ) {
        return
      }
      if (
        path === BROWSER_REPO_PATH &&
        [
          'DISCOVERY_CACHE_MAINTENANCE_OPERATION',
          'STREAM_APPEND_JOURNAL_FRAMES_OPERATION',
          'STREAM_FINISH_CLEANUP_OPERATION',
          'STREAM_JOURNAL_INTEGRITY_OPERATION',
          'TERMINAL_STREAM_RETENTION_OPERATION',
        ].includes(owner)
      ) {
        return
      }
      if (
        path === BROWSER_IMPORT_EXPORT_PATH &&
        [
          'IMPORT_CHAT_OPERATION',
          'IMPORT_CHAT_PRESET_OPERATION',
          'IMPORT_CONNECTION_PROFILE_OPERATION',
        ].includes(owner)
      ) {
        return
      }
      if (
        path === CONFIGURATION_HANDLER_PATH &&
        (owner === 'keyTouchOperationDescriptor' ||
          containingFunction === 'textTemplateEntityOperationDescriptor' ||
          containingFunction === 'keyMaterialOperationDescriptor')
      ) {
        return
      }
      const operationKind = stringProperty(definition, 'operationKind')
      if (!operationKind) {
        if (
          !(
            path === 'src/store/browser-mutation-plan.ts' &&
            containingFunctionDeclaration(node)?.name?.text === 'planMutationSemanticOperation'
          ) &&
          !(
            path === CONFIGURATION_HANDLER_PATH &&
            containingFunctionDeclaration(node)?.name?.text === 'settingRowsOperationDescriptor'
          ) &&
          !(
            path === CONFIGURATION_HANDLER_PATH &&
            containingFunctionDeclaration(node)?.name?.text ===
              'chatConfigurationOperationDescriptor'
          ) &&
          !(
            path === CONFIGURATION_HANDLER_PATH &&
            containingFunctionDeclaration(node)?.name?.text ===
              'catalogedConfigurationOperationDescriptor'
          ) &&
          !(
            path === CONFIGURATION_HANDLER_PATH &&
            containingFunctionDeclaration(node)?.name?.text === 'presetLifecycleOperationDescriptor'
          ) &&
          !(
            path === CONFIGURATION_HANDLER_PATH &&
            containingFunctionDeclaration(node)?.name?.text === 'chatSelectionOperationDescriptor'
          ) &&
          !(
            path === CONFIGURATION_HANDLER_PATH &&
            containingFunctionDeclaration(node)?.name?.text ===
              'chatRequestTargetOperationDescriptor'
          ) &&
          !(
            path === CONFIGURATION_HANDLER_PATH &&
            containingFunctionDeclaration(node)?.name?.text ===
              'configurationTargetFanoutOperationDescriptor'
          ) &&
          !(
            path === CONFIGURATION_HANDLER_PATH &&
            containingFunctionDeclaration(node)?.name?.text ===
              'connectionProfileLifecycleOperationDescriptor'
          ) &&
          !(
            path === CONFIGURATION_HANDLER_PATH &&
            containingFunctionDeclaration(node)?.name?.text ===
              'connectionDeleteOperationDescriptor'
          ) &&
          !(
            path === BROWSER_REPO_PATH &&
            (containingFunctionDeclaration(node)?.name?.text ===
              'discoveryCacheOperationDescriptor' ||
              containingFunctionDeclaration(node)?.name?.text === 'streamLeaseOperationDescriptor')
          )
        ) {
          outputProblems.push(`${path}: semantic operation descriptor needs literal operationKind`)
        }
        return
      }
      const commandKind = operationKind.startsWith('configuration:')
        ? operationKind.slice('configuration:'.length)
        : operationKind
      if (facts.has(commandKind)) {
        outputProblems.push(`semantic operation descriptor duplicated ${commandKind}`)
        return
      }
      const transaction = objectPropertyInitializer(definition, 'transaction')
      const resources = objectPropertyInitializer(definition, 'resources')
      const permittedWrites = objectPropertyInitializer(definition, 'permittedWrites')
      const requiredWrites = objectPropertyInitializer(definition, 'requiredWritesWhenMutated')
      const effects = objectPropertyInitializer(definition, 'effects')
      const exactReceiptContracts = objectSpreadsCall(
        definition,
        'semanticOperationExactReceiptContracts',
      )
      if (!transaction) {
        outputProblems.push(`${path}#${owner}: semantic operation transaction missing`)
      }
      if (!resources) {
        outputProblems.push(`${path}#${owner}: semantic operation resource planner missing`)
      }
      if (!permittedWrites || !nonEmptyArrayLikeProperty(definition, 'permittedWrites')) {
        outputProblems.push(`${path}#${owner}: semantic operation permitted writes invalid`)
      }
      if (!requiredWrites || !arrayProperty(definition, 'requiredWritesWhenMutated')) {
        outputProblems.push(`${path}#${owner}: semantic operation required writes invalid`)
      }
      if ((!effects || !validSemanticEffects(unwrap(effects))) && !exactReceiptContracts) {
        outputProblems.push(`${path}#${owner}: semantic operation effects invalid`)
      }
      const exactPresetOrderMove =
        path === CONFIGURATION_HANDLER_PATH &&
        owner === 'presetOrderMoveOperationDescriptor' &&
        exactReceiptContracts &&
        source
          .getText()
          .includes('function presetOrderMoveOperationExactPlan(): SemanticOperationExactPlan') &&
        source.getText().includes('function presetOrderMoveOperationExactReceipt(') &&
        source.getText().includes('presetOrderMoveOperationExactReceipt(plan, input, receipt)') &&
        source.getText().includes('physicalMutations: receipt.mutations') &&
        source.getText().includes('...receipt.reads.map((read) => ({') &&
        source.getText().includes('maxRows: 512') &&
        source.getText().includes('maxBatchRows: 512')
      facts.set(
        commandKind,
        Object.freeze({
          path,
          owner,
          transaction: transaction?.getText(source) ?? '',
          consumed: semanticDescriptorOwnerIsConsumed(source, owner),
          physicalWritesProved: nonEmptyArrayProperty(definition, 'requiredWritesWhenMutated'),
          ...(exactPresetOrderMove
            ? {
                exactPhysicalWritesProved: true,
                exactEffectsProved: true,
                tablesProved: true,
                boundsProved: true,
              }
            : { exactEffectsProved: false }),
        }),
      )
    })
  }
  return facts
}

function singleChatMetadataCapabilityFacts(
  program,
  catalogSource,
  browserRepoSource,
  outputProblems,
) {
  const variants = Object.freeze([
    ['chat.touch-viewed', 'CHAT_TOUCH_VIEWED_OPERATION', 'touchChatViewed'],
    ['chat.set-manual-title', 'CHAT_SET_MANUAL_TITLE_OPERATION', 'setChatManualTitle'],
  ])
  const receiptText = findFunction(catalogSource, 'singleChatMetadataReceipt').getText(
    catalogSource,
  )
  const executorText = findFunction(catalogSource, 'patchSingleChatMetadataRow').getText(
    catalogSource,
  )
  const resourceText = findFunction(catalogSource, 'singleChatMetadataResourceNames').getText(
    catalogSource,
  )
  const planText = findVariableInitializer(
    catalogSource,
    'SINGLE_CHAT_METADATA_EXACT_PLAN',
  ).getText(catalogSource)
  const mutationJournalSource = exactSource(program, MUTATION_JOURNAL_PATH)
  const journalTransactionText = findFunction(
    mutationJournalSource,
    'runBrowserCommandTransaction',
  ).getText(mutationJournalSource)
  const callerSingleAttempt = chatMetadataCallerSingleAttemptFacts(program)
  const commonKernel = {
    exactTypedDescriptors: variants.every(([kind, owner]) => {
      const text = findVariableInitializer(catalogSource, owner).getText(catalogSource)
      return (
        text.includes(`operationKind: '${kind}'`) &&
        text.includes('transaction: CHAT_ROW_PRESERVING_LINKS_TRANSACTION_CAPABILITY') &&
        text.includes('resources: singleChatMetadataResourceNames') &&
        text.includes(
          'semanticOperationExactReceiptContracts<\n    SingleChatMetadataResourceInput,\n    PhysicalStorageTableName\n  >()',
        ) &&
        text.includes(
          "replay: semanticOperationCallerSingleAttemptReplayContract('unfenced-relative-update')",
        )
      )
    }),
    exactSingleChatResource:
      resourceText.includes('`chat-meta:') &&
      resourceText.includes('input.chatId') &&
      !resourceText.includes('linkedResourceNames'),
    oneTransactionLocalExecutor:
      executorText.includes('commit.executeSemanticOperation(descriptor, { chatId }') &&
      executorText.includes('const chatMutation = openPreservingChatMutation(tx)') &&
      executorText.includes('const current = await chatMutation.read(chatId)') &&
      executorText.includes('chatMutation.replace(chatId, () => next)') &&
      executorText.includes('const transition = await chatMutation.commit()') &&
      executorText.includes('semanticOperationExecution(') &&
      executorText.includes('singleChatMetadataReceipt(') &&
      !executorText.includes('NatterDb') &&
      !executorText.includes('bulkGet(') &&
      !executorText.includes('for (;;)') &&
      !executorText.includes('linkedResourceNames') &&
      !executorText.includes('stableStringify('),
    independentExactReceipt:
      receiptText.includes('semanticOperationExactReceipt(SINGLE_CHAT_METADATA_EXACT_PLAN, {') &&
      receiptText.includes('dependencies: fragment?.dependencies ?? []') &&
      receiptText.includes('physicalMutations: fragment?.physicalMutations ?? []') &&
      receiptText.includes("tableName: 'chats'") &&
      receiptText.includes("indexKind: 'primary'") &&
      receiptText.includes("operation: 'get'") &&
      receiptText.includes('rowCount: 1') &&
      receiptText.includes("indexKind: 'secondary'") &&
      receiptText.includes("indexName: 'updatedAt'") &&
      receiptText.includes("operation: 'query'") &&
      receiptText.includes('...(fragment?.physicalReads ?? [])'),
    finiteCardinalityBounds:
      planText.includes("kind: 'single-attempt'") &&
      planText.includes("reason: 'unfenced-relative-update'") &&
      planText.includes('maxRequests: 28') &&
      planText.includes('maxRows: 29') &&
      planText.includes('maxBatchRows: 2') &&
      planText.includes('maxRequests: 3') &&
      planText.includes('maxRows: 3') &&
      planText.includes('maxBatchRows: 1') &&
      planText.match(/maxBytes: Number\.MAX_SAFE_INTEGER/gu)?.length === 2,
    finalizationReadFree:
      journalTransactionText.includes('finalChatById: new Map()') &&
      journalTransactionText.includes('requiredFinalChatState(journal, chatId)') &&
      !journalTransactionText.includes('bulkGet(chatIds)'),
    callerSingleAttemptOwned: Object.values(callerSingleAttempt).every(Boolean),
    noRepositoryDatabasePreopen: variants.every(([, , method]) => {
      const text = findMethod(browserRepoSource, 'BrowserWorkspaceRepository', method).getText(
        browserRepoSource,
      )
      return (
        text.includes(`runtime.${method}(`) &&
        !text.includes(`runtime.${method}(await this.openDb()`) &&
        !text.includes('for (;;)')
      )
    }),
  }
  for (const [name, consumed] of Object.entries(commonKernel)) {
    if (!consumed) outputProblems.push(`single chat metadata family missing ${name}`)
  }
  const consumed = Object.values(commonKernel).every(Boolean)
  return Object.freeze({
    variants: Object.freeze(variants.map(([kind]) => kind)),
    commonKernel: Object.freeze(commonKernel),
    capabilities: Object.freeze(
      Object.fromEntries(
        variants.map(([kind, owner]) => [
          kind,
          Object.freeze({
            path: BROWSER_CATALOG_COMMAND_RUNTIME_PATH,
            owner,
            transaction: 'CHAT_ROW_PRESERVING_LINKS_TRANSACTION_CAPABILITY',
            consumed,
            physicalWritesProved: true,
            exactPhysicalWritesProved: true,
            exactEffectsProved: true,
            tablesProved: true,
            boundsProved: consumed,
            byteBoundsProved: false,
            idempotenceProved: consumed,
          }),
        ]),
      ),
    ),
  })
}

function chatSetArchivedCapabilityFacts(program, catalogSource, browserRepoSource, outputProblems) {
  const descriptorText = findVariableInitializer(
    catalogSource,
    'CHAT_SET_ARCHIVED_OPERATION',
  ).getText(catalogSource)
  const preflightText = findFunction(catalogSource, 'readChatSetArchivedPlan').getText(
    catalogSource,
  )
  const preflightReceiptText = findFunction(
    catalogSource,
    'chatSetArchivedPreflightPhysicalReads',
  ).getText(catalogSource)
  const planText = findFunction(catalogSource, 'chatSetArchivedExactPlan').getText(catalogSource)
  const receiptText = findFunction(catalogSource, 'chatSetArchivedReceipt').getText(catalogSource)
  const routeText = findFunction(catalogSource, 'setChatsArchived').getText(catalogSource)
  const repositoryText = findMethod(
    browserRepoSource,
    'BrowserWorkspaceRepository',
    'setChatsArchived',
  ).getText(browserRepoSource)
  const configurationSource = exactSource(program, 'src/store/configuration-domain-contract.ts')
  const byteOwnerSource = exactSource(program, BYTE_OWNER_MUTATION_PATH)
  const sidebarSource = exactSource(program, 'src/store/chat-sidebar-projection.ts')
  const semanticSource = exactSource(program, SEMANTIC_OPERATION_CAPABILITY_PATH)
  const domainMutationSource = exactSource(program, 'src/store/browser-domain-mutations.ts')
  const executablePreflightText = findMethod(
    browserRepoSource,
    'BrowserCommandCommit',
    'readSemanticOperationPreflight',
  ).getText(browserRepoSource)
  const executableTransactionText = findMethod(
    browserRepoSource,
    'BrowserCommandCommit',
    'runTransaction',
  ).getText(browserRepoSource)
  const executableCompletionText = findMethod(
    browserRepoSource,
    'BrowserCommandCommit',
    'completeSemanticOperation',
  ).getText(browserRepoSource)
  const callerSingleAttempt = chatMetadataCallerSingleAttemptFacts(program)
  const commonKernel = Object.freeze({
    exactTypedDescriptor:
      descriptorText.includes("operationKind: 'chat.set-archived'") &&
      descriptorText.includes('transaction: CHAT_ROW_LINKED_TRANSACTION_CAPABILITY') &&
      descriptorText.includes('resources: chatMetadataResourceNames') &&
      descriptorText.includes(
        'semanticOperationExactReceiptContracts<ChatSetArchivedPlan, PhysicalStorageTableName>()',
      ),
    typedReplayPolicy: descriptorText.includes(
      "replay: semanticOperationCallerSingleAttemptReplayContract('unfenced-relative-update')",
    ),
    typedCommandLifetimePreflight:
      catalogSource.getText().includes('interface ChatSetArchivedPlan') &&
      catalogSource.getText().includes('readonly configurationLinkCount: number') &&
      catalogSource.getText().includes('readonly exactPlan: SemanticOperationExactPlan') &&
      domainMutationSource
        .getText()
        .includes('readSemanticOperationPreflight<Tables extends PhysicalStorageTableName, T>(') &&
      executablePreflightText.includes("this.db.transaction(\n      'r',") &&
      executablePreflightText.includes('runBrowserCommandTransaction(') &&
      executablePreflightText.includes('observePhysicalReads: true') &&
      executablePreflightText.includes('assertPhysicalTransactionTablesDeclared(') &&
      executablePreflightText.includes('SemanticOperationPreflightMutationForbidden') &&
      executablePreflightText.includes(
        'semanticOperationCommandLifetimeReceiptWithPhysicalReads(',
      ) &&
      semanticSource
        .getText()
        .includes('readonly physicalReads: readonly SemanticOperationPhysicalRead[]') &&
      executableTransactionText.includes('...this.commandLifetimeReceipt.physicalReads') &&
      executableCompletionText.includes('this.commandLifetimeReceipt.physicalReads') &&
      preflightReceiptText.includes("tableName: 'configurationLinks' as const") &&
      preflightReceiptText.includes("indexName: 'ownerKey'") &&
      preflightReceiptText.includes("operation: 'open-cursor' as const") &&
      preflightReceiptText.includes('Math.ceil(chatCount / CONFIGURATION_OWNER_LINK_BATCH_SIZE)') &&
      preflightReceiptText.includes('CHAT_CONFIGURATION_LINK_SLOT_LIMIT * chatCount') &&
      receiptText.includes('plan.configurationLinkCount') &&
      receiptText.includes('chatSetArchivedPreflightPhysicalReads('),
    oneBoundedPreflight:
      countOccurrences(preflightText, 'commit.readSemanticOperationPreflight(') === 1 &&
      preflightText.includes('CHAT_SET_ARCHIVED_PREFLIGHT_TRANSACTION_PLAN') &&
      preflightText.includes("tx.table<ConfigurationLink, string>('configurationLinks')") &&
      countOccurrences(preflightText, ".where('ownerKey').anyOf(ownerKeys).toArray()") === 1 &&
      preflightText.includes('offset += CONFIGURATION_OWNER_LINK_BATCH_SIZE') &&
      preflightText.includes('uniqueChatIds.length === 0') &&
      preflightText.includes("configurationOwnerKey('chat', chatId)") &&
      preflightText.includes('configurationTargetResourceNamesForLinks(links)') &&
      !preflightText.includes('db.transaction(') &&
      !preflightText.includes('[db.chats]') &&
      !preflightText.includes(".table<Chat, ChatId>('chats')") &&
      !preflightText.includes('for (;;)') &&
      !preflightText.includes('while (') &&
      !preflightText.includes('setTimeout('),
    oneAuthoritativeAttempt:
      countOccurrences(routeText, 'readChatSetArchivedPlan(') === 1 &&
      countOccurrences(routeText, 'commit.executeSemanticOperation(') === 1 &&
      countOccurrences(routeText, 'commit.completeSemanticOperation(') === 1 &&
      routeText.includes('const chatMutation = openLinkedChatMutation(tx)') &&
      routeText.includes('const rows = await chatMutation.readMany(plan.chatIds)') &&
      routeText.includes('normalizeNamedLocks(currentResourceNames)') &&
      routeText.includes('throw new ChatSetArchivedLinkPlanChangedError()') &&
      routeText.includes('chatMutation.replaceLinked(current.id, () => next)') &&
      routeText.includes('const transition = await chatMutation.commit()') &&
      routeText.includes('semanticOperationExecution(') &&
      !routeText.includes('for (;;)') &&
      !routeText.includes('catch (') &&
      !routeText.includes('setTimeout('),
    exactReceipt:
      receiptText.includes('semanticOperationExactReceipt(plan.exactPlan, {') &&
      receiptText.includes('dependencies: fragment?.dependencies ?? []') &&
      receiptText.includes('physicalMutations: fragment?.physicalMutations ?? []') &&
      receiptText.includes("tableName: 'chats' as const") &&
      receiptText.includes("operation: 'get-many' as const") &&
      receiptText.includes("indexName: 'updatedAt'") &&
      receiptText.includes('...chatSetArchivedPreflightPhysicalReads(') &&
      receiptText.includes('...(fragment?.physicalReads ?? [])') &&
      routeText.includes('chatSetArchivedReceipt(plan, transition, writes.length > 0)'),
    centralizedInputShapedBounds:
      configurationSource.getText().includes('export const CHAT_CONFIGURATION_LINK_SLOT_LIMIT =') &&
      byteOwnerSource
        .getText()
        .includes('export const CONFIGURATION_OWNER_LINK_BATCH_SIZE = 128') &&
      sidebarSource
        .getText()
        .includes('export const CHAT_SIDEBAR_FOLDER_EXTREMA_READ_REQUEST_LIMIT = 24') &&
      planText.includes('Math.ceil(chatCount / CONFIGURATION_OWNER_LINK_BATCH_SIZE)') &&
      planText.includes('CHAT_CONFIGURATION_LINK_SLOT_LIMIT *') &&
      planText.includes('CHAT_SIDEBAR_FOLDER_EXTREMA_READ_REQUEST_LIMIT * chatCount') &&
      planText.includes('5 + 3 * ownerBatches') &&
      planText.includes('(29 + 2 * CHAT_CONFIGURATION_LINK_SLOT_LIMIT) * chatCount + 3') &&
      planText.includes('(4 + 2 * CHAT_CONFIGURATION_LINK_SLOT_LIMIT) * chatCount + 2') &&
      planText.match(/maxBytes: Number\.MAX_SAFE_INTEGER/gu)?.length === 2,
    callerSingleAttemptOwned: Object.values(callerSingleAttempt).every(Boolean),
    oneRepositoryIngress:
      countOccurrences(repositoryText, 'runtime.setChatsArchived(') === 1 &&
      !repositoryText.includes('this.openDb()') &&
      !repositoryText.includes('for (;;)') &&
      !repositoryText.includes('while (') &&
      !repositoryText.includes('setTimeout('),
  })
  for (const [name, consumed] of Object.entries(commonKernel)) {
    if (!consumed) outputProblems.push(`chat set archived family missing ${name}`)
  }
  const consumed =
    commonKernel.exactTypedDescriptor &&
    commonKernel.oneAuthoritativeAttempt &&
    commonKernel.oneRepositoryIngress
  const tablesProved =
    consumed &&
    commonKernel.typedCommandLifetimePreflight &&
    commonKernel.oneBoundedPreflight &&
    commonKernel.exactReceipt
  return Object.freeze({
    variant: 'chat.set-archived',
    commonKernel,
    capabilities: Object.freeze({
      'chat.set-archived': Object.freeze({
        path: BROWSER_CATALOG_COMMAND_RUNTIME_PATH,
        owner: 'CHAT_SET_ARCHIVED_OPERATION',
        transaction: 'CHAT_ROW_LINKED_TRANSACTION_CAPABILITY',
        consumed,
        physicalWritesProved: true,
        exactPhysicalWritesProved: true,
        exactEffectsProved: consumed && commonKernel.exactReceipt,
        tablesProved,
        boundsProved: tablesProved && commonKernel.centralizedInputShapedBounds,
        byteBoundsProved: false,
        idempotenceProved:
          consumed && commonKernel.typedReplayPolicy && commonKernel.callerSingleAttemptOwned,
      }),
    }),
  })
}

function chatMetadataCallerSingleAttemptFacts(program) {
  const chatsSource = exactSource(program, CHATS_PATH)
  const executeChatCommand = findFunction(chatsSource, 'executeChatCommand')
  const executeText = executeChatCommand.getText(chatsSource)
  const submitCalls = executableCalls(executeChatCommand).filter(
    (call) =>
      call.expression.getText(chatsSource) === 'getWorkspaceRepository().execute' ||
      call.expression.getText(chatsSource).endsWith('.execute'),
  )
  return Object.freeze({
    oneApplicationAdmission:
      countOccurrences(executeText, "runWorkspaceAction(\n    'chat-metadata'") === 1 &&
      countOccurrences(executeText, '.execute(permit, command)') === 1,
    noApplicationRetry:
      !executeText.includes('for (') &&
      !executeText.includes('for (;;)') &&
      !executeText.includes('while (') &&
      submitCalls.every((call) => !callHasIterationAncestor(call, executeChatCommand)),
    ...workspaceRuntimeSingleAttemptFacts(program),
  })
}

function chatCalibrationCapabilityFacts(program, catalogSource, outputProblems) {
  const variants = Object.freeze([
    ['chat.calibration.clear', 'CHAT_CALIBRATION_CLEAR_OPERATION'],
    ['chat.calibration.clear-family', 'CHAT_CALIBRATION_CLEAR_FAMILY_OPERATION'],
    ['chat.calibration.clear-all', 'CHAT_CALIBRATION_CLEAR_ALL_OPERATION'],
  ])
  const descriptorTexts = new Map(
    variants.map(([, owner]) => [
      owner,
      findVariableInitializer(catalogSource, owner).getText(catalogSource),
    ]),
  )
  const receiptText = findFunction(catalogSource, 'chatCalibrationReceipt').getText(catalogSource)
  const singleRouteText = findFunction(catalogSource, 'clearChatCalibration').getText(catalogSource)
  const fanoutRouteText = findFunction(catalogSource, 'clearCalibrationEverywhere').getText(
    catalogSource,
  )
  const fanoutTransactionText = findFunction(
    catalogSource,
    'clearCalibrationEverywhereTransaction',
  ).getText(catalogSource)
  const singlePlanText = findVariableInitializer(
    catalogSource,
    'CHAT_CALIBRATION_CLEAR_EXACT_PLAN',
  ).getText(catalogSource)
  const fanoutPlanText = findVariableInitializer(
    catalogSource,
    'CHAT_CALIBRATION_FANOUT_EXACT_PLAN',
  ).getText(catalogSource)
  const mutationJournalSource = exactSource(program, MUTATION_JOURNAL_PATH)
  const callerSingleAttempt = chatMetadataCallerSingleAttemptFacts(program)
  const commonKernel = {
    exactTypedDescriptors: [...descriptorTexts.values()].every(
      (text) =>
        text.includes('transaction: CHAT_CALIBRATION_TRANSACTION_CAPABILITY') &&
        text.includes('resources: chatCalibrationResourceNames') &&
        text.includes('semanticOperationExactReceiptContracts<') &&
        text.includes(
          "replay: semanticOperationCallerSingleAttemptReplayContract('unfenced-relative-update')",
        ),
    ),
    oneExactReceiptOwner:
      receiptText.includes('semanticOperationExactReceipt(plan, {') &&
      receiptText.includes('normalizeWorkspaceDependencies([') &&
      receiptText.includes('...(fragment?.dependencies ?? [])') &&
      receiptText.includes("kind: 'setting' as const") &&
      receiptText.includes("tableName: 'settings' as const") &&
      receiptText.includes("operation: 'write' as const") &&
      receiptText.includes("tableName: 'chats' as const") &&
      receiptText.includes('operation: chatRead.operation') &&
      receiptText.includes('...(fragment?.physicalReads ?? [])'),
    exactSingleRoute:
      singleRouteText.includes('CHAT_CALIBRATION_CLEAR_OPERATION') &&
      singleRouteText.match(/semanticOperationExecution\(/gu)?.length === 2 &&
      singleRouteText.match(/chatCalibrationReceipt\(/gu)?.length === 2 &&
      singleRouteText.includes('CHAT_CALIBRATION_CLEAR_EXACT_PLAN') &&
      singleRouteText.includes("operation: 'get'") &&
      !singleRouteText.includes('.toArray()') &&
      !singleRouteText.includes('for (;;)'),
    exactFanoutRoutes:
      fanoutRouteText.includes('CHAT_CALIBRATION_CLEAR_ALL_OPERATION') &&
      fanoutRouteText.includes('CHAT_CALIBRATION_CLEAR_FAMILY_OPERATION') &&
      fanoutTransactionText.includes('semanticOperationExecution(') &&
      fanoutTransactionText.includes('chatCalibrationReceipt(') &&
      fanoutTransactionText.includes('CHAT_CALIBRATION_FANOUT_EXACT_PLAN') &&
      fanoutTransactionText.includes("operation: 'query'"),
    callerSingleAttemptOwned: Object.values(callerSingleAttempt).every(Boolean),
    finalizationReadSubtracted:
      mutationJournalSource.getText().includes('finalChatById: Map<ChatId, Chat | null>') &&
      mutationJournalSource.getText().includes('requiredFinalChatState(journal, chatId)') &&
      !mutationJournalSource.getText().includes("tx.table<Chat, ChatId>('chats').bulkGet(chatIds)"),
    atomicFanoutAdmitted:
      fanoutTransactionText.includes('const chatMutation = openPreservingChatMutation(tx)') &&
      fanoutTransactionText.includes('const rows = await chatMutation.readAll()') &&
      fanoutTransactionText.includes('const changedChats = rows.map(') &&
      fanoutTransactionText.includes(
        'for (const next of changedChats) chatMutation.replace(next.id, () => next)',
      ) &&
      fanoutTransactionText.includes('const transition = await chatMutation.commit()') &&
      fanoutPlanText.match(/Number\.MAX_SAFE_INTEGER/gu)?.length === 8,
  }
  const singleFiniteBounds =
    singlePlanText.match(/maxRequests: 2/gu)?.length === 2 &&
    singlePlanText.match(/maxRows: 2/gu)?.length === 2 &&
    singlePlanText.match(/maxBatchRows: 1/gu)?.length === 2 &&
    singlePlanText.match(/maxBytes: Number\.MAX_SAFE_INTEGER/gu)?.length === 2
  if (!singleFiniteBounds) {
    outputProblems.push('chat calibration family missing singleFiniteBounds')
  }
  for (const [name, consumed] of Object.entries(commonKernel)) {
    if (!consumed) outputProblems.push(`chat calibration family missing ${name}`)
  }
  const consumed = Object.values(commonKernel).every(Boolean) && singleFiniteBounds
  return Object.freeze({
    variants: Object.freeze(variants.map(([kind]) => kind)),
    commonKernel: Object.freeze({ ...commonKernel, singleFiniteBounds }),
    capabilities: Object.freeze(
      Object.fromEntries(
        variants.map(([kind, owner]) => [
          kind,
          Object.freeze({
            path: BROWSER_CATALOG_COMMAND_RUNTIME_PATH,
            owner,
            transaction: 'CHAT_CALIBRATION_TRANSACTION_CAPABILITY',
            consumed,
            physicalWritesProved: true,
            exactPhysicalWritesProved: true,
            exactEffectsProved: true,
            tablesProved: true,
            boundsProved: kind === 'chat.calibration.clear' && consumed,
            byteBoundsProved: false,
            idempotenceProved: consumed,
            ...(kind === 'chat.calibration.clear'
              ? {}
              : { boundsDisposition: 'admitted-atomic-calibration-fanout' }),
          }),
        ]),
      ),
    ),
  })
}

function streamLeaseOperationCapabilityFacts(
  program,
  workspaceUnion,
  browserRepoSource,
  outputProblems,
) {
  const sharedDescriptor = findFunction(
    browserRepoSource,
    'streamLeaseOperationDescriptor',
  ).getText(browserRepoSource)
  const resourcePlanner = findFunction(browserRepoSource, 'streamOperationResourceNames').getText(
    browserRepoSource,
  )
  const executor = findFunction(browserRepoSource, 'executeStreamLeaseOperation')
  const executorText = executor.getText(browserRepoSource)
  const transactionText = findMethod(
    browserRepoSource,
    'BrowserCommandCommit',
    'runTransaction',
  ).getText(browserRepoSource)
  const completedOperationText = findMethod(
    browserRepoSource,
    'BrowserCommandCommit',
    'completeSemanticOperation',
  ).getText(browserRepoSource)
  const terminalizationSource = exactSource(program, ATTEMPT_TERMINALIZATION_PATH)
  const terminalizationText = terminalizationSource.getText()
  const generationEngineText = exactSource(program, GENERATION_ENGINE_PATH).getText()
  const streamLeasesText = exactSource(program, STREAM_LEASES_PATH).getText()
  const streamRecoveryText = exactSource(program, STREAM_RECOVERY_PATH).getText()
  const terminalOwnerText = findFunction(
    terminalizationSource,
    'createAttemptTerminalOwner',
  ).getText(terminalizationSource)
  const terminalAdvanceText = findFunction(
    terminalizationSource,
    'advanceAttemptTerminalCustody',
  ).getText(terminalizationSource)
  const writerTerminalPortText = findFunction(
    terminalizationSource,
    'createWriterAttemptTerminalPort',
  ).getText(terminalizationSource)
  const recoveryTerminalPortText = findFunction(
    terminalizationSource,
    'createRecoveryAttemptTerminalPort',
  ).getText(terminalizationSource)
  const terminalConstructors =
    constructorSitesByVariant(workspaceUnion).get('attempt.seal-terminal')
  const directSealTerminalCalls = program
    .getSourceFiles()
    .filter(isProductionSource)
    .flatMap((source) => {
      const matches = []
      visit(source, (node) => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'sealTerminal'
        ) {
          matches.push(relative(ROOT, source.fileName).split(sep).join('/'))
        }
      })
      return matches
    })
  const boundsText = findVariableInitializer(
    browserRepoSource,
    'STREAM_LEASE_OPERATION_BOUNDS',
  ).getText(browserRepoSource)
  const variants = Object.freeze([
    ['attempt.request-stop', 'ATTEMPT_REQUEST_STOP_OPERATION', 'requestAttemptStop'],
    ['attempt.seal-terminal', 'ATTEMPT_SEAL_TERMINAL_OPERATION', 'sealAttemptTerminal'],
    ['stream.note-selected-key', 'STREAM_NOTE_SELECTED_KEY_OPERATION', 'noteStreamSelectedKey'],
    ['stream.renew', 'STREAM_RENEW_OPERATION', 'renewStreamLease'],
    [
      'stream.handoff-recovery',
      'STREAM_HANDOFF_RECOVERY_OPERATION',
      'handoffStreamLeaseForRecovery',
    ],
    ['stream.claim-recovery', 'STREAM_CLAIM_RECOVERY_OPERATION', 'claimStreamLeaseForRecovery'],
  ])
  const commonKernel = {
    oneTypedFactory:
      sharedDescriptor.includes('semanticOperationDescriptor({') &&
      sharedDescriptor.includes('transaction: STREAM_LEASE_MUTATION_TRANSACTION_CAPABILITY') &&
      sharedDescriptor.includes('resources: streamOperationResourceNames') &&
      sharedDescriptor.includes(
        'permittedWrites: STREAM_LEASE_MUTATION_TRANSACTION_CAPABILITY.tableNames',
      ) &&
      sharedDescriptor.includes("requiredWritesWhenMutated: ['streamLeases']") &&
      sharedDescriptor.includes(
        "semanticOperationExactReceiptContracts<StreamLeaseOperationResourceInput, 'streamLeases'>()",
      ) &&
      sharedDescriptor.includes('...(replayContract') &&
      sharedDescriptor.includes(
        'replay: semanticOperationExactReceiptReplayContract<StreamLeaseOperationResourceInput>',
      ) &&
      sharedDescriptor.includes(
        'semanticOperationExactReceiptReplayProofContract<StreamLeaseOperationResourceInput>',
      ) &&
      sharedDescriptor.includes('assertStreamLeaseReplayProof'),
    oneExactTransitionExecutor:
      executorText.includes('commit.executeSemanticOperation(descriptor, { streamId, replay }') &&
      executorText.includes(".table<StreamLeaseRow, string>('streamLeases').get(streamId)") &&
      executorText.includes('putStreamLeaseByteOwner(tx, decision.next, current)') &&
      executorText.includes('observedReplay?:') &&
      executorText.includes('semanticOperationExecution(') &&
      executorText.includes('semanticOperationExactPlan({') &&
      executorText.includes(
        'replay: observedReplay ? observedReplay(current, decision) : replay',
      ) &&
      executorText.includes('bounds: STREAM_LEASE_OPERATION_BOUNDS') &&
      executorText.includes("kind: 'stream-lease'") &&
      executorText.includes("tableName: 'streamLeases'") &&
      executorText.includes("indexKind: 'primary'") &&
      executorText.includes("operation: 'get'") &&
      executorText.includes('requestCount: 1') &&
      executorText.includes('rowCount: 1'),
    exactReplayAndBounds:
      boundsText.includes('maxRequests: 1') &&
      boundsText.includes('maxRows: 1') &&
      boundsText.includes('maxBatchRows: 1') &&
      transactionText.includes('if (semanticOperation) {') &&
      transactionText.includes(
        'assertSemanticOperationReplay(descriptor, resourceInput, receipt)',
      ) &&
      transactionText.indexOf('assertSemanticOperationReplay(descriptor, resourceInput, receipt)') <
        transactionText.indexOf('assertSemanticOperationExactInvalidations(') &&
      completedOperationText.includes(
        'assertSemanticOperationReplay(descriptor, resourceInput, executableReceipt)',
      ),
    exactPerStreamResource:
      resourcePlanner.includes('`stream-journal:') &&
      resourcePlanner.includes('input.streamId') &&
      !resourcePlanner.includes('chat-catalog') &&
      !resourcePlanner.includes('workspace'),
    everyVariantDeclared: variants.every(([kind, owner]) => {
      const text = findVariableInitializer(browserRepoSource, owner).getText(browserRepoSource)
      return text.includes('streamLeaseOperationDescriptor') && text.includes(`'${kind}'`)
    }),
    everyRouteConsumesSemanticOwner: variants.every(([, owner, method]) => {
      const text = findMethod(browserRepoSource, 'BrowserWorkspaceRepository', method).getText(
        browserRepoSource,
      )
      return (
        text.includes('executeStreamLeaseOperation') &&
        text.includes(owner) &&
        !text.includes('.withLocks(') &&
        !text.includes('for (;;)')
      )
    }),
    terminalCallerAtMostOnce:
      JSON.stringify(terminalConstructors) ===
        JSON.stringify([
          {
            path: ATTEMPT_TERMINALIZATION_PATH,
            owner: 'createRecoveryAttemptTerminalPort',
            confidence: 'type-assignable',
          },
          {
            path: STREAM_LEASES_PATH,
            owner: 'leaseHandle',
            confidence: 'type-assignable',
          },
        ]) &&
      JSON.stringify(directSealTerminalCalls) === JSON.stringify([ATTEMPT_TERMINALIZATION_PATH]) &&
      terminalOwnerText.match(/settlement \?\?=/gu)?.length === 2 &&
      terminalOwnerText.includes(
        'settlement ??= advanceAttemptTerminalCustody({ port, ...input })',
      ) &&
      terminalAdvanceText.match(/input\.port\.seal\(/gu)?.length === 1 &&
      terminalAdvanceText.includes("lease.phase === 'terminal-decided' ? lease.terminal") &&
      terminalAdvanceText.includes("if (lease.phase !== 'terminal-decided')") &&
      writerTerminalPortText.indexOf('await input.journal().settle()') <
        writerTerminalPortText.indexOf('await input.handle.sealTerminal({') &&
      recoveryTerminalPortText.match(/kind: 'attempt\.seal-terminal'/gu)?.length === 1 &&
      generationEngineText.match(/createWriterAttemptTerminalOwner\(/gu)?.length === 1 &&
      streamRecoveryText.match(/createRecoveryAttemptTerminalOwner\(/gu)?.length === 1 &&
      terminalizationText.match(/createAttemptTerminalOwner\(/gu)?.length === 3 &&
      streamLeasesText.match(/kind: 'attempt\.seal-terminal'/gu)?.length === 1,
  }
  for (const [name, consumed] of Object.entries(commonKernel)) {
    if (!consumed) outputProblems.push(`stream lease operation family missing ${name}`)
  }
  const consumed = Object.values(commonKernel).every(Boolean)
  return Object.freeze({
    variants: Object.freeze(variants.map(([kind]) => kind)),
    commonKernel: Object.freeze(commonKernel),
    capabilities: Object.freeze(
      Object.fromEntries(
        variants.map(([kind, owner, method]) => {
          const ownerText = findVariableInitializer(browserRepoSource, owner).getText(
            browserRepoSource,
          )
          const methodText = findMethod(
            browserRepoSource,
            'BrowserWorkspaceRepository',
            method,
          ).getText(browserRepoSource)
          const replayContractDeclared =
            /streamLeaseOperationDescriptor\(\s*['"][^'"]+['"]\s*,\s*['"](?:exact|receipt-proof)['"]\s*,?\s*\)/u.test(
              ownerText,
            )
          const independentReplayObserved =
            replayContractDeclared &&
            ((kind === 'stream.note-selected-key' &&
              methodText.includes('observedSelectedKeyReplayPlan') &&
              methodText.includes('decision.next ?? lease')) ||
              (kind === 'stream.handoff-recovery' &&
                methodText.includes('observedHandoffReplayPlan') &&
                methodText.includes('decision.value')) ||
              (kind === 'stream.renew' &&
                methodText.includes('requestedRenewReplayPlan') &&
                methodText.includes('observedRenewReplayPlan')) ||
              (kind === 'stream.claim-recovery' &&
                methodText.includes('requestedClaimRecoveryReplayPlan') &&
                methodText.includes('observedClaimRecoveryReplayPlan')) ||
              (kind === 'attempt.request-stop' &&
                methodText.includes('attemptStopReplayPlan') &&
                methodText.includes('observedAttemptStopReplayPlan')) ||
              (kind === 'attempt.seal-terminal' &&
                commonKernel.terminalCallerAtMostOnce &&
                methodText.includes('attemptTerminalReplayPlan') &&
                methodText.includes('observedAttemptTerminalReplayPlan')))
          return [
            kind,
            Object.freeze({
              path: BROWSER_REPO_PATH,
              owner,
              transaction: 'STREAM_LEASE_MUTATION_TRANSACTION_CAPABILITY',
              consumed,
              physicalWritesProved: true,
              exactPhysicalWritesProved: true,
              exactEffectsProved: true,
              tablesProved: true,
              boundsProved: true,
              idempotenceProved: independentReplayObserved,
            }),
          ]
        }),
      ),
    ),
  })
}

function streamJournalAppendCapabilityFacts(program, browserRepoSource, outputProblems) {
  const storageSource = exactSource(program, STREAM_JOURNAL_STORAGE_PATH)
  const codecSource = exactSource(program, STREAM_JOURNAL_CODEC_PATH)
  const mutationJournalSource = exactSource(program, MUTATION_JOURNAL_PATH)
  const descriptorText = findVariableInitializer(
    browserRepoSource,
    'STREAM_APPEND_JOURNAL_FRAMES_OPERATION',
  ).getText(browserRepoSource)
  const boundsText = findVariableInitializer(
    browserRepoSource,
    'STREAM_JOURNAL_APPEND_OPERATION_BOUNDS',
  ).getText(browserRepoSource)
  const replayText = findFunction(browserRepoSource, 'streamJournalAppendReplayPlan').getText(
    browserRepoSource,
  )
  const routeText = findMethod(
    browserRepoSource,
    'BrowserWorkspaceRepository',
    'appendStreamJournalFrames',
  ).getText(browserRepoSource)
  const transitionText = findFunction(storageSource, 'appendStreamJournalFrames').getText(
    storageSource,
  )
  const receiptText = findFunction(storageSource, 'streamJournalAppendResult').getText(
    storageSource,
  )
  const batchText = findFunction(codecSource, 'canonicalStreamJournalFrameBatch').getText(
    codecSource,
  )
  const journalTransactionText = findFunction(
    mutationJournalSource,
    'runBrowserCommandTransaction',
  ).getText(mutationJournalSource)
  const commonKernel = {
    exactTypedDescriptor:
      descriptorText.includes("operationKind: 'stream.append-journal-frames'") &&
      descriptorText.includes('transaction: STREAM_JOURNAL_MUTATION_TRANSACTION_CAPABILITY') &&
      descriptorText.includes('resources: streamOperationResourceNames') &&
      descriptorText.includes(
        'permittedWrites: STREAM_JOURNAL_MUTATION_TRANSACTION_CAPABILITY.tableNames',
      ) &&
      descriptorText.includes("requiredWritesWhenMutated: ['streamLeases']") &&
      descriptorText.includes('semanticOperationExactReceiptContracts<') &&
      descriptorText.includes('StreamJournalAppendResourceInput') &&
      descriptorText.includes(
        'semanticOperationExactReceiptReplayContract<StreamJournalAppendResourceInput>',
      ),
    exactPerStreamResource: findFunction(browserRepoSource, 'streamOperationResourceNames')
      .getText(browserRepoSource)
      .includes('`stream-journal:' + '$' + '{input.streamId}`'),
    oneTransactionLocalRoute:
      routeText.includes('canonicalStreamJournalFrameBatch(frames)') &&
      routeText.includes('streamJournalWriterAuthority(first)') &&
      routeText.includes('commit.executeSemanticOperation(') &&
      routeText.includes('STREAM_APPEND_JOURNAL_FRAMES_OPERATION') &&
      routeText.includes('persistStreamJournalFrames(tx, batch, observedAt)') &&
      routeText.includes('semanticOperationExecution(') &&
      routeText.includes('semanticOperationExactReceipt(') &&
      routeText.includes('semanticOperationExactPlan({') &&
      routeText.includes('transition.authority') &&
      routeText.includes('transition.acceptedFrameIds') &&
      !routeText.includes('.withLocks(') &&
      !routeText.includes('for (;;)') &&
      !routeText.includes('openDb('),
    boundedLookupShape:
      transitionText.includes(
        'const overlapFrames = frames.filter((frame) => frame.seq <= journalMaxSeq)',
      ) &&
      transitionText.includes(
        'const newFrames = frames.filter((frame) => frame.seq > journalMaxSeq)',
      ) &&
      transitionText.includes('const lookupFrameIds = overlapFrames.map((frame) => frame.id)') &&
      transitionText.includes(
        'if (!lookupFrameIds.includes(tailId)) lookupFrameIds.push(tailId)',
      ) &&
      transitionText.match(/streamFrames\.bulkGet\(/gu)?.length === 1 &&
      !transitionText.includes('streamFrames.get('),
    exactTransitionReceipt:
      receiptText.includes('semanticOperationReceiptFragment({') &&
      receiptText.includes('dependencies,') &&
      receiptText.includes("kind: 'stream-chunks'") &&
      receiptText.includes("kind: 'stream-lease'") &&
      receiptText.includes('heartbeatChanged') &&
      receiptText.includes("tableName: 'streamLeases'") &&
      receiptText.includes("tableName: 'streamChunks'") &&
      receiptText.includes("indexKind: 'primary'") &&
      receiptText.includes("operation: 'get-many'") &&
      receiptText.includes('rowCount: lookupFrameIds.length'),
    activeWriterAppendReplay:
      replayText.includes("kind: 'append-by-key'") &&
      replayText.includes('owner: `stream:' + '$' + '{authority.streamId}`') &&
      replayText.includes('authority.ownerClientId') &&
      replayText.includes('authority.fenceToken') &&
      replayText.includes('authority.replacementEpoch') &&
      replayText.includes('authority.admissionSequence') &&
      replayText.includes("equality: 'canonical-equal-or-conflict'") &&
      replayText.includes("lifecycle: 'active-writer'") &&
      routeText.includes('streamJournalAppendReplayPlan(') &&
      routeText.includes('transition.authority'),
    duplicateAndConflictAreNoWrite:
      transitionText.includes('if (newFrames.length === 0) {') &&
      transitionText.indexOf('if (newFrames.length === 0) {') <
        transitionText.indexOf('await replacePhysicalStorageRow') &&
      transitionText.includes('StreamJournalFrameConflict:') &&
      transitionText.indexOf('StreamJournalFrameConflict:') <
        transitionText.indexOf('await replacePhysicalStorageRow') &&
      transitionText.includes('newFrames.length > 0 &&') &&
      transitionText.includes(
        'observedAt - lease.heartbeatAt > STREAM_LEASE_HEARTBEAT_COALESCE_MS',
      ) &&
      !transitionText.includes('nextStreamLeaseRevision'),
    canonicalUniqueIncreasingBatch:
      batchText.includes('let previousSeq = -1') &&
      batchText.includes('if (frame.seq <= previousSeq)') &&
      batchText.includes("throw new Error('StreamJournalAppendBatchOrderInvalid')") &&
      batchText.includes('previousSeq = frame.seq'),
    finiteCardinalityBounds:
      boundsText.includes('maxRequests: 2') &&
      boundsText.includes('maxRows: STREAM_JOURNAL_APPEND_MAX_ROWS + 1') &&
      boundsText.includes('maxBatchRows: STREAM_JOURNAL_APPEND_MAX_ROWS') &&
      boundsText.match(/maxBytes: Number\.MAX_SAFE_INTEGER/gu)?.length === 2 &&
      batchText.includes('values.length > STREAM_JOURNAL_APPEND_MAX_ROWS') &&
      batchText.includes('bytes > STREAM_JOURNAL_APPEND_MAX_BYTES'),
    finalizationReadFree:
      receiptText.includes("kind: 'stream-chunks'") &&
      receiptText.includes("kind: 'stream-lease'") &&
      !receiptText.includes("kind: 'key'") &&
      journalTransactionText.includes('recordKeyRequestMaterialDependents(tx, journal)') &&
      !journalTransactionText.includes('bulkGet(chatIds)'),
  }
  for (const [name, consumed] of Object.entries(commonKernel)) {
    if (!consumed) outputProblems.push(`stream journal append family missing ${name}`)
  }
  const consumed = Object.values(commonKernel).every(Boolean)
  return Object.freeze({
    variants: Object.freeze(['stream.append-journal-frames']),
    commonKernel: Object.freeze(commonKernel),
    capabilities: Object.freeze({
      'stream.append-journal-frames': Object.freeze({
        path: BROWSER_REPO_PATH,
        owner: 'STREAM_APPEND_JOURNAL_FRAMES_OPERATION',
        transaction: 'STREAM_JOURNAL_MUTATION_TRANSACTION_CAPABILITY',
        consumed,
        physicalWritesProved: true,
        exactPhysicalWritesProved: true,
        exactEffectsProved: true,
        tablesProved: true,
        boundsProved: consumed,
        byteBoundsProved: false,
        idempotenceProved: true,
      }),
    }),
  })
}

function streamJournalRetirementCapabilityFacts(program, browserRepoSource, outputProblems) {
  const storageSource = exactSource(program, STREAM_JOURNAL_STORAGE_PATH)
  const integritySource = exactSource(program, STREAM_JOURNAL_INTEGRITY_PATH)
  const mutationJournalSource = exactSource(program, MUTATION_JOURNAL_PATH)
  const descriptorOwners = [
    'STREAM_FINISH_CLEANUP_OPERATION',
    'STREAM_JOURNAL_INTEGRITY_OPERATION',
    'TERMINAL_STREAM_RETENTION_OPERATION',
  ]
  const descriptors = descriptorOwners.map((owner) =>
    findVariableInitializer(browserRepoSource, owner).getText(browserRepoSource),
  )
  const retirementText = findFunction(storageSource, 'retireOneStreamJournalPage').getText(
    storageSource,
  )
  const finishText = findMethod(
    browserRepoSource,
    'BrowserWorkspaceRepository',
    'deleteStreamJournal',
  ).getText(browserRepoSource)
  const terminalText = findMethod(
    browserRepoSource,
    'BrowserWorkspaceRepository',
    'pruneTerminalStreamJournals',
  ).getText(browserRepoSource)
  const integrityRouteText = findMethod(
    browserRepoSource,
    'BrowserWorkspaceRepository',
    'reconcileStreamJournalIntegrity',
  ).getText(browserRepoSource)
  const integrityTransitionText = findFunction(
    integritySource,
    'reconcileStreamJournalIntegrityPage',
  ).getText(integritySource)
  const journalTransactionText = findFunction(
    mutationJournalSource,
    'runBrowserCommandTransaction',
  ).getText(mutationJournalSource)
  const boundsTextByOwner = new Map(
    [
      'STREAM_FINISH_CLEANUP_OPERATION_BOUNDS',
      'STREAM_JOURNAL_INTEGRITY_OPERATION_BOUNDS',
      'TERMINAL_STREAM_RETENTION_OPERATION_BOUNDS',
    ].map((owner) => [
      owner,
      findVariableInitializer(browserRepoSource, owner).getText(browserRepoSource),
    ]),
  )
  const commonKernel = {
    exactTypedDescriptors: descriptors.every(
      (text) =>
        text.includes('semanticOperationExactReceiptContracts<') &&
        text.includes('semanticOperationExactReceiptReplayProofContract<'),
    ),
    oneBoundedSingleStreamOwner:
      retirementText.includes(
        'const maxFrameRows = boundedStreamJournalRetirementRows(request.maxFrameRows)',
      ) &&
      retirementText.includes('.limit(maxFrameRows + 1)') &&
      retirementText.includes('const page = rows.slice(0, maxFrameRows)') &&
      retirementText.includes('const done = rows.length <= maxFrameRows') &&
      retirementText.includes('recordBrowserCommandStreamJournalRetirementPage(') &&
      retirementText.includes("recordBrowserCommandPhysicalDeletionRows(tx, 'streamLeases'") &&
      retirementText.includes('semanticOperationReceiptFragment({') &&
      retirementText.includes("operation: 'delete-group'") &&
      retirementText.includes("operation: 'delete'") &&
      retirementText.includes("indexName: 'streamId'") &&
      retirementText.includes("operation: 'query'"),
    exactFinishRoute:
      finishText.includes('STREAM_JOURNAL_RETIREMENT_MAX_ROWS') &&
      finishText.includes('maxFrameRows,') &&
      finishText.includes('transition.receipt') &&
      finishText.includes('streamFinishCleanupReplayPlan(') &&
      finishText.includes('semanticOperationExactReceipt(') &&
      finishText.includes('bounds: STREAM_FINISH_CLEANUP_OPERATION_BOUNDS') &&
      !finishText.includes('.withLocks(') &&
      !finishText.includes('for (;;)'),
    actualTerminalLimit:
      terminalText.includes('boundedMaintenanceLimit(requestedLimit)') &&
      terminalText.includes('STREAM_JOURNAL_RETIREMENT_MAX_ROWS') &&
      terminalText.includes('maxFrameRows: limit') &&
      terminalText.includes('receipt.absorb(transition.receipt)') &&
      terminalText.includes('terminalStreamRetentionReplayPlan(cycle, limit)') &&
      terminalText.includes('bounds: TERMINAL_STREAM_RETENTION_OPERATION_BOUNDS') &&
      !terminalText.includes('.withLocks(') &&
      !terminalText.includes('for (;;)'),
    durableIntegrityTransition:
      integrityTransitionText.includes('createSemanticOperationExactReceiptAccumulator<') &&
      integrityTransitionText.includes('maxFrameRows: limit') &&
      integrityTransitionText.includes('receipt.absorb(retired.receipt)') &&
      integrityTransitionText.includes("indexName: 'streamId'") &&
      integrityTransitionText.includes("operation: 'open-cursor'") &&
      integrityTransitionText.includes("operation: 'get-many'") &&
      integrityTransitionText.includes("tableName: 'settings'") &&
      integrityTransitionText.includes("operation: 'write'") &&
      integrityRouteText.includes('transition.replay') &&
      integrityRouteText.includes('transition.receipt') &&
      integrityRouteText.includes('bounds: STREAM_JOURNAL_INTEGRITY_OPERATION_BOUNDS'),
    independentReplayProofs:
      browserRepoSource.getText().includes('function assertStreamFinishCleanupReplayProof(') &&
      browserRepoSource.getText().includes("kind: 'level-triggered-merge'") &&
      browserRepoSource.getText().includes('function terminalStreamRetentionReplayPlan(') &&
      integritySource.getText().includes('function streamJournalIntegrityReplayPlan(') &&
      browserRepoSource.getText().includes('function assertDurablePageReplayProof('),
    finiteCardinalityBounds:
      boundsTextByOwner
        .get('STREAM_FINISH_CLEANUP_OPERATION_BOUNDS')
        ?.includes('maxRequests: 2') === true &&
      boundsTextByOwner
        .get('STREAM_FINISH_CLEANUP_OPERATION_BOUNDS')
        ?.includes('maxRows: STREAM_JOURNAL_RETIREMENT_MAX_ROWS + 2') === true &&
      boundsTextByOwner
        .get('STREAM_FINISH_CLEANUP_OPERATION_BOUNDS')
        ?.includes('maxBatchRows: STREAM_JOURNAL_RETIREMENT_MAX_ROWS + 1') === true &&
      boundsTextByOwner
        .get('STREAM_FINISH_CLEANUP_OPERATION_BOUNDS')
        ?.includes('maxRows: STREAM_JOURNAL_RETIREMENT_MAX_ROWS + 1') === true &&
      boundsTextByOwner
        .get('STREAM_JOURNAL_INTEGRITY_OPERATION_BOUNDS')
        ?.includes('maxRequests: 3') === true &&
      boundsTextByOwner
        .get('STREAM_JOURNAL_INTEGRITY_OPERATION_BOUNDS')
        ?.includes('maxRows: 1 + 2 * MAX_STORAGE_MAINTENANCE_BATCH') === true &&
      boundsTextByOwner
        .get('STREAM_JOURNAL_INTEGRITY_OPERATION_BOUNDS')
        ?.includes('maxBatchRows: MAX_STORAGE_MAINTENANCE_BATCH') === true &&
      boundsTextByOwner
        .get('TERMINAL_STREAM_RETENTION_OPERATION_BOUNDS')
        ?.includes('maxRequests: 5') === true &&
      boundsTextByOwner
        .get('TERMINAL_STREAM_RETENTION_OPERATION_BOUNDS')
        ?.includes('maxRows: STREAM_JOURNAL_RETIREMENT_MAX_ROWS + 5') === true &&
      boundsTextByOwner
        .get('TERMINAL_STREAM_RETENTION_OPERATION_BOUNDS')
        ?.includes('maxBatchRows: STREAM_JOURNAL_RETIREMENT_MAX_ROWS + 1') === true &&
      boundsTextByOwner
        .get('TERMINAL_STREAM_RETENTION_OPERATION_BOUNDS')
        ?.includes('maxRequests: 3') === true &&
      boundsTextByOwner
        .get('TERMINAL_STREAM_RETENTION_OPERATION_BOUNDS')
        ?.includes('maxRows: STREAM_JOURNAL_RETIREMENT_MAX_ROWS + 2') === true &&
      boundsTextByOwner
        .get('TERMINAL_STREAM_RETENTION_OPERATION_BOUNDS')
        ?.includes('maxBatchRows: STREAM_JOURNAL_RETIREMENT_MAX_ROWS') === true,
    byteBoundsExplicitlyOpen: [...boundsTextByOwner.values()].every(
      (text) => text.match(/maxBytes: Number\.MAX_SAFE_INTEGER/gu)?.length === 2,
    ),
    finalizationReadFree:
      retirementText.includes("kind: 'stream-chunks'") &&
      retirementText.includes("kind: 'stream-lease'") &&
      !retirementText.includes("kind: 'key'") &&
      journalTransactionText.includes('recordKeyRequestMaterialDependents(tx, journal)') &&
      !journalTransactionText.includes('bulkGet(chatIds)'),
  }
  for (const [name, consumed] of Object.entries(commonKernel)) {
    if (!consumed) outputProblems.push(`stream journal retirement family missing ${name}`)
  }
  const consumed = Object.values(commonKernel).every(Boolean)
  const variants = Object.freeze([
    ['stream.finish-cleanup', 'STREAM_FINISH_CLEANUP_OPERATION'],
    ['maintenance.reconcile-stream-journal-integrity', 'STREAM_JOURNAL_INTEGRITY_OPERATION'],
    ['maintenance.prune-terminal-stream-journals', 'TERMINAL_STREAM_RETENTION_OPERATION'],
  ])
  return Object.freeze({
    variants: Object.freeze(variants.map(([kind]) => kind)),
    commonKernel: Object.freeze(commonKernel),
    capabilities: Object.freeze(
      Object.fromEntries(
        variants.map(([kind, owner]) => [
          kind,
          Object.freeze({
            path: BROWSER_REPO_PATH,
            owner,
            transaction:
              kind === 'stream.finish-cleanup'
                ? 'STREAM_JOURNAL_MUTATION_TRANSACTION_CAPABILITY'
                : kind === 'maintenance.reconcile-stream-journal-integrity'
                  ? 'STREAM_JOURNAL_INTEGRITY_TRANSACTION_CAPABILITY'
                  : 'TERMINAL_STREAM_RETENTION_TRANSACTION_CAPABILITY',
            consumed,
            physicalWritesProved: true,
            exactPhysicalWritesProved: true,
            exactEffectsProved: true,
            tablesProved: true,
            boundsProved: consumed,
            byteBoundsProved: false,
            idempotenceProved: true,
          }),
        ]),
      ),
    ),
  })
}

function chatOrganizationCapabilityFacts(program, catalogSource, workspaceUnion, outputProblems) {
  const moveDescriptor = findVariableInitializer(
    catalogSource,
    'CHAT_MOVE_TO_FOLDER_OPERATION',
  ).getText(catalogSource)
  const tagsDescriptor = findVariableInitializer(
    catalogSource,
    'CHAT_SET_TAGS_FROM_NAMES_OPERATION',
  ).getText(catalogSource)
  const moveText = findFunction(catalogSource, 'moveChatRowsToFolder').getText(catalogSource)
  const tagsText = findFunction(catalogSource, 'setChatRowsTagsFromNames').getText(catalogSource)
  const movePlanText = findFunction(catalogSource, 'readChatMoveToFolderPlan').getText(
    catalogSource,
  )
  const moveReceiptText = findFunction(catalogSource, 'chatMoveToFolderReceipt').getText(
    catalogSource,
  )
  const moveBoundsText = findFunction(catalogSource, 'chatMoveToFolderExactPlan').getText(
    catalogSource,
  )
  const moveResourceText = findFunction(
    catalogSource,
    'chatMoveToFolderLinkedResourceNames',
  ).getText(catalogSource)
  const allCommandText = [moveText, tagsText].join('\n')
  const commonKernel = {
    exactTypedDescriptors:
      moveDescriptor.includes("operationKind: 'chat.move-to-folder'") &&
      moveDescriptor.includes('transaction: CHAT_FOLDER_TRANSACTION_CAPABILITY') &&
      tagsDescriptor.includes("operationKind: 'chat.set-tags-from-names'") &&
      tagsDescriptor.includes('transaction: CHAT_TAG_TRANSACTION_CAPABILITY'),
    exactIntentResources:
      moveDescriptor.includes('resources: chatMetadataResourceNames') &&
      moveResourceText.includes('folderMembershipResourceName(folderId)') &&
      tagsDescriptor.includes('resources: chatMetadataResourceNames') &&
      tagsText.includes('tag-name:'),
    everyRouteConsumesSemanticOwner:
      moveText.includes('commit.executeSemanticOperation(') &&
      moveText.includes('CHAT_MOVE_TO_FOLDER_OPERATION') &&
      tagsText.includes('commit.executeSemanticOperation(') &&
      tagsText.includes('CHAT_SET_TAGS_FROM_NAMES_OPERATION'),
    transactionLocalSelection:
      moveText.includes("table<ChatFolder, FolderId>('folders').get(plan.folderId)") &&
      moveText.includes('const chatMutation = openPreservingChatMutation(tx)') &&
      moveText.includes('const rows = await chatMutation.readMany(plan.chatIds)') &&
      tagsText.includes('const chatMutation = openPreservingChatMutation(tx)') &&
      tagsText.includes('await chatMutation.readMany(uniqueChatIds)'),
    candidateShapedTagWork:
      tagsText.includes("tags.where('nameLower').anyOf(nameKeys).toArray()") &&
      tagsText.includes("chats.where('tags').anyOf(candidateIds).uniqueKeys()") &&
      tagsText.includes('tags.bulkGet(missingCandidateRows)') &&
      !tagsText.includes("orderBy('tags')") &&
      !tagsText.includes('tags.toArray()'),
    noLegacyPlanning:
      !allCommandText.includes('.withLocks(') &&
      !allCommandText.includes('for (;;)') &&
      !allCommandText.includes('setTimeout(') &&
      !allCommandText.includes('.transaction(') &&
      !allCommandText.includes('openDb(') &&
      !allCommandText.includes("'folder-catalog'") &&
      !allCommandText.includes("'tag-catalog'"),
  }
  for (const [name, consumed] of Object.entries(commonKernel)) {
    if (!consumed) outputProblems.push(`chat organization family missing ${name}`)
  }
  const consumed = Object.values(commonKernel).every(Boolean)
  const moveConstructors =
    constructorSitesByVariant(workspaceUnion, true).get('chat.move-to-folder') ?? []
  const chatsSource = exactSource(program, CHATS_PATH)
  const moveConstructorOwner =
    moveConstructors.length === 1 && moveConstructors[0]?.path === CHATS_PATH
      ? findFunction(chatsSource, moveConstructors[0].owner)
      : undefined
  const moveConstructorCalls = moveConstructorOwner ? executableCalls(moveConstructorOwner) : []
  const moveSubmissions = moveConstructorCalls.filter(
    (call) => call.expression.getText(chatsSource) === 'executeChatCommand',
  )
  const callerSingleAttempt = chatMetadataCallerSingleAttemptFacts(program)
  const moveToFolder = {
    exactTypedDescriptor: moveDescriptor.includes(
      'semanticOperationExactReceiptContracts<ChatMoveToFolderPlan, PhysicalStorageTableName>()',
    ),
    typedReplayPolicy: moveDescriptor.includes(
      "replay: semanticOperationCallerSingleAttemptReplayContract('unfenced-relative-update')",
    ),
    typedCommandLifetimePreflight:
      movePlanText.includes('commit.readSemanticOperationPreflight(') &&
      movePlanText.includes('CHAT_MOVE_TO_FOLDER_PREFLIGHT_TRANSACTION_PLAN') &&
      movePlanText.includes(
        "table<ChatSidebarProjectionRow, ChatId>('chatSidebarRows').bulkGet(uniqueChatIds)",
      ) &&
      !movePlanText.includes("table<Chat, ChatId>('chats')") &&
      !movePlanText.includes('for (;;)') &&
      !movePlanText.includes('setTimeout('),
    exactMembershipPlan:
      moveResourceText.includes('folderId === null ? [] : [`folder:') &&
      moveResourceText.includes('folderId}`]') &&
      moveResourceText.includes('folderMembershipResourceName(folderId)') &&
      moveResourceText.includes(
        'pending.map((row) => folderMembershipResourceName(row.folderId ?? null))',
      ) &&
      moveText.includes('chatMoveToFolderLinkedResourceNames(rows, plan.folderId)') &&
      moveText.includes('throw new ChatMoveToFolderPlanChangedError()'),
    exactReceipt:
      moveReceiptText.includes('semanticOperationExactReceipt(plan.exactPlan, {') &&
      moveReceiptText.includes('dependencies: fragment?.dependencies ?? []') &&
      moveReceiptText.includes('physicalMutations: fragment?.physicalMutations ?? []') &&
      moveReceiptText.includes("tableName: 'chatSidebarRows' as const") &&
      moveReceiptText.includes("tableName: 'chats' as const") &&
      moveReceiptText.includes("tableName: 'folders' as const") &&
      moveReceiptText.includes("indexName: 'updatedAt'") &&
      moveReceiptText.includes('...(fragment?.physicalReads ?? [])') &&
      moveText.includes('accumulator.snapshotFragment()') &&
      countOccurrences(moveText, 'semanticOperationExecution(') === 3 &&
      countOccurrences(moveText, 'commit.completeSemanticOperation(') === 1 &&
      countOccurrences(moveText, 'chatMoveToFolderReceipt(') === 4,
    centralizedInputShapedBounds:
      moveBoundsText.includes('6 + CHAT_SIDEBAR_FOLDER_EXTREMA_READ_REQUEST_LIMIT * chatCount') &&
      moveBoundsText.includes('maxRows: 28 * chatCount + 4') &&
      moveBoundsText.includes('maxBatchRows: chatCount + 2') &&
      moveBoundsText.includes('maxRequests: 6') &&
      moveBoundsText.includes('maxRows: 3 * chatCount + 2') &&
      moveBoundsText.includes('maxBatchRows: chatCount + 1') &&
      moveBoundsText.match(/maxBytes: Number\.MAX_SAFE_INTEGER/gu)?.length === 2,
    oneApplicationSubmission:
      moveConstructors.length === 1 &&
      moveConstructorOwner !== undefined &&
      moveSubmissions.length === 1 &&
      !callHasIterationAncestor(moveSubmissions[0], moveConstructorOwner) &&
      !moveConstructorCalls.some(
        (call) => call.expression.getText(chatsSource) === moveConstructors[0]?.owner,
      ),
    callerSingleAttemptOwned: Object.values(callerSingleAttempt).every(Boolean),
    noRetryOrBroadPlanning:
      countOccurrences(moveText, 'commit.executeSemanticOperation(') === 1 &&
      countOccurrences(moveText, 'commit.completeSemanticOperation(') === 1 &&
      !moveText.includes('for (;;)') &&
      !moveText.includes('catch (') &&
      !moveText.includes('setTimeout(') &&
      !moveText.includes('.withLocks('),
  }
  for (const [name, proved] of Object.entries(moveToFolder)) {
    if (!proved) outputProblems.push(`chat move-to-folder family missing ${name}`)
  }
  const moveConsumed =
    consumed && moveToFolder.exactMembershipPlan && moveToFolder.noRetryOrBroadPlanning
  const moveExactReceiptProved =
    moveConsumed && moveToFolder.exactTypedDescriptor && moveToFolder.exactReceipt
  const moveTablesProved = moveExactReceiptProved && moveToFolder.typedCommandLifetimePreflight
  return Object.freeze({
    variants: Object.freeze(['chat.move-to-folder', 'chat.set-tags-from-names']),
    commonKernel: Object.freeze(commonKernel),
    moveToFolder: Object.freeze(moveToFolder),
    capabilities: Object.freeze({
      'chat.move-to-folder': Object.freeze({
        path: BROWSER_CATALOG_COMMAND_RUNTIME_PATH,
        owner: 'CHAT_MOVE_TO_FOLDER_OPERATION',
        transaction: 'CHAT_FOLDER_TRANSACTION_CAPABILITY',
        consumed: moveConsumed,
        physicalWritesProved: true,
        exactPhysicalWritesProved: moveExactReceiptProved,
        exactEffectsProved: moveExactReceiptProved,
        tablesProved: moveTablesProved,
        boundsProved: moveTablesProved && moveToFolder.centralizedInputShapedBounds,
        byteBoundsProved: false,
        idempotenceProved:
          moveConsumed &&
          moveToFolder.typedReplayPolicy &&
          moveToFolder.oneApplicationSubmission &&
          moveToFolder.callerSingleAttemptOwned,
      }),
      'chat.set-tags-from-names': Object.freeze({
        path: BROWSER_CATALOG_COMMAND_RUNTIME_PATH,
        owner: 'CHAT_SET_TAGS_FROM_NAMES_OPERATION',
        transaction: 'CHAT_TAG_TRANSACTION_CAPABILITY',
        consumed,
        physicalWritesProved: true,
        exactPhysicalWritesProved: false,
        exactEffectsProved: false,
        tablesProved: false,
        boundsProved: false,
      }),
    }),
  })
}

function chatClosureCapabilityFacts(
  catalogSource,
  ownershipSource,
  browserRepoSource,
  outputProblems,
) {
  const discardDescriptor = findVariableInitializer(
    catalogSource,
    'CHAT_DISCARD_EMPTY_DRAFTS_OPERATION',
  ).getText(catalogSource)
  const deleteDescriptor = findVariableInitializer(
    catalogSource,
    'CHAT_DELETE_ARCHIVED_OPERATION',
  ).getText(catalogSource)
  const emptyDescriptor = findVariableInitializer(
    catalogSource,
    'CHAT_EMPTY_ARCHIVE_OPERATION',
  ).getText(catalogSource)
  const effects = findVariableInitializer(catalogSource, 'CHAT_CLOSURE_EFFECTS').getText(
    catalogSource,
  )
  const discardText = findFunction(catalogSource, 'discardEmptyDraftChats').getText(catalogSource)
  const deleteText = findFunction(catalogSource, 'deleteArchivedChatRows').getText(catalogSource)
  const emptyText = findFunction(catalogSource, 'emptyArchivedChatRows').getText(catalogSource)
  const emptyEligibilityText = findFunction(
    ownershipSource,
    'deleteEligibleEmptyDraftChatClosure',
  ).getText(ownershipSource)
  const archivedEligibilityText = findFunction(
    ownershipSource,
    'deleteArchivedChatClosure',
  ).getText(ownershipSource)
  const closureText = findFunction(ownershipSource, 'deleteKnownChatClosure').getText(
    ownershipSource,
  )
  const repoDiscardText = findMethod(
    browserRepoSource,
    'BrowserWorkspaceRepository',
    'discardEmptyDraftChats',
  ).getText(browserRepoSource)
  const repoDeleteText = findMethod(
    browserRepoSource,
    'BrowserWorkspaceRepository',
    'deleteArchivedChatRows',
  ).getText(browserRepoSource)
  const repoEmptyText = findMethod(
    browserRepoSource,
    'BrowserWorkspaceRepository',
    'emptyArchivedChatRows',
  ).getText(browserRepoSource)
  const allCommandText = [discardText, deleteText, emptyText].join('\n')
  const allRepoText = [repoDiscardText, repoDeleteText, repoEmptyText].join('\n')
  const commonKernel = {
    exactTypedDescriptors:
      discardDescriptor.includes("operationKind: 'chat.discard-empty-drafts'") &&
      deleteDescriptor.includes("operationKind: 'chat.delete-archived'") &&
      emptyDescriptor.includes("operationKind: 'chat.empty-archive'") &&
      [discardDescriptor, deleteDescriptor, emptyDescriptor].every((descriptor) =>
        descriptor.includes('transaction: CHAT_CLOSURE_TRANSACTION_CAPABILITY'),
      ),
    sharedTypedEffects:
      [discardDescriptor, deleteDescriptor, emptyDescriptor].every((descriptor) =>
        descriptor.includes('effects: CHAT_CLOSURE_EFFECTS'),
      ) &&
      effects.includes("'chat'") &&
      effects.includes("'sidebar'") &&
      effects.includes("'attachment'") &&
      effects.includes("'profile'") &&
      effects.includes("'setting'"),
    exactIntentResources:
      discardDescriptor.includes('resources: chatClosureResourceNames') &&
      deleteDescriptor.includes('resources: chatClosureResourceNames') &&
      emptyDescriptor.includes('resources: emptyArchiveResourceNames'),
    everyRouteConsumesSemanticOwner:
      discardText.includes('CHAT_DISCARD_EMPTY_DRAFTS_OPERATION') &&
      deleteText.includes('CHAT_DELETE_ARCHIVED_OPERATION') &&
      emptyText.includes('CHAT_EMPTY_ARCHIVE_OPERATION') &&
      [discardText, deleteText, emptyText].every((text) =>
        text.includes('commit.executeSemanticOperation('),
      ),
    transactionLocalEligibility:
      emptyEligibilityText.includes("table<Chat, ChatId>('chats').bulkGet(uniqueIds)") &&
      emptyEligibilityText.includes(".where('chatId')") &&
      emptyEligibilityText.includes('.uniqueKeys()') &&
      archivedEligibilityText.includes("table<Chat, ChatId>('chats').bulkGet(uniqueIds)") &&
      emptyText.includes('readArchivedChatIdPage(tx,') &&
      emptyText.includes('deleteArchivedChatClosure(tx, page.chatIds, input.now)'),
    oneClosureOwner:
      emptyEligibilityText.includes("deleteKnownChatClosure(tx, eligible, now, 'skip')") &&
      archivedEligibilityText.includes('deleteKnownChatClosure(') &&
      closureText.includes("table<StreamLeaseRow, string>('streamLeases')") &&
      closureText.includes('.anyOf(candidateIds)') &&
      closureText.includes('deleteLinkedSemanticByteOwnerBatchRepairingLinks('),
    boundedCommandWork:
      discardText.includes('CHAT_CLOSURE_BATCH_LIMIT') &&
      deleteText.includes('CHAT_CLOSURE_BATCH_LIMIT') &&
      emptyText.includes('CHAT_CLOSURE_BATCH_LIMIT'),
    noLegacyPlanning:
      !allCommandText.includes('.withLocks(') &&
      !allCommandText.includes('for (;;)') &&
      !allCommandText.includes('setTimeout(') &&
      !allCommandText.includes('.transaction(') &&
      !allCommandText.includes('archivedDeleteSnapshots') &&
      !allCommandText.includes('ChatClosurePlanChangedError') &&
      !allRepoText.includes('await this.openDb()'),
  }
  for (const [name, consumed] of Object.entries(commonKernel)) {
    if (!consumed) outputProblems.push(`chat closure family missing ${name}`)
  }
  const consumed = Object.values(commonKernel).every(Boolean)
  return Object.freeze({
    variants: Object.freeze([
      'chat.delete-archived',
      'chat.discard-empty-drafts',
      'chat.empty-archive',
    ]),
    commonKernel: Object.freeze(commonKernel),
    capabilities: Object.freeze({
      'chat.discard-empty-drafts': Object.freeze({
        path: BROWSER_CATALOG_COMMAND_RUNTIME_PATH,
        owner: 'CHAT_DISCARD_EMPTY_DRAFTS_OPERATION',
        transaction: 'CHAT_CLOSURE_TRANSACTION_CAPABILITY',
        consumed,
        physicalWritesProved: true,
        exactPhysicalWritesProved: false,
        exactEffectsProved: false,
        tablesProved: false,
        boundsProved: false,
      }),
      'chat.delete-archived': Object.freeze({
        path: BROWSER_CATALOG_COMMAND_RUNTIME_PATH,
        owner: 'CHAT_DELETE_ARCHIVED_OPERATION',
        transaction: 'CHAT_CLOSURE_TRANSACTION_CAPABILITY',
        consumed,
        physicalWritesProved: true,
        exactPhysicalWritesProved: false,
        exactEffectsProved: false,
        tablesProved: false,
        boundsProved: false,
      }),
      'chat.empty-archive': Object.freeze({
        path: BROWSER_CATALOG_COMMAND_RUNTIME_PATH,
        owner: 'CHAT_EMPTY_ARCHIVE_OPERATION',
        transaction: 'CHAT_CLOSURE_TRANSACTION_CAPABILITY',
        consumed,
        physicalWritesProved: true,
        exactPhysicalWritesProved: false,
        exactEffectsProved: false,
        tablesProved: false,
        boundsProved: false,
      }),
    }),
  })
}

function chatForkCapabilityFacts(browserRepoSource, outputProblems) {
  const descriptor = findVariableInitializer(browserRepoSource, 'CHAT_FORK_OPERATION').getText(
    browserRepoSource,
  )
  const resources = findFunction(browserRepoSource, 'chatForkResourceNames').getText(
    browserRepoSource,
  )
  const pathReader = findFunction(browserRepoSource, 'readForkLivePathHeaders').getText(
    browserRepoSource,
  )
  const clone = findFunction(browserRepoSource, 'cloneForkMessages').getText(browserRepoSource)
  const command = findMethod(
    browserRepoSource,
    'BrowserWorkspaceRepository',
    'forkChatFromMessage',
  ).getText(browserRepoSource)
  const commonKernel = {
    exactTypedDescriptor:
      descriptor.includes("operationKind: 'chat.fork'") &&
      descriptor.includes('transaction: FORK_CHAT_TRANSACTION_CAPABILITY') &&
      descriptor.includes('permittedWrites: FORK_CHAT_TRANSACTION_CAPABILITY.tableNames') &&
      descriptor.includes("'chats'") &&
      descriptor.includes("'messages'") &&
      descriptor.includes("'messageBodies'") &&
      descriptor.includes("'messagePreviews'") &&
      descriptor.includes("'childLists'") &&
      descriptor.includes("'childSlotMembers'"),
    exactIntentResources:
      resources.includes('input.sourceChatId') &&
      resources.includes('input.targetMessageId') &&
      resources.includes('input.destinationChatId') &&
      resources.includes('message-topology:'),
    everyRouteConsumesSemanticOwner:
      command.includes('commit.executeSemanticOperation(') &&
      command.includes('CHAT_FORK_OPERATION'),
    transactionLocalSnapshot:
      command.includes("tx.table<Chat, ChatId>('chats')") &&
      command.includes('readForkLivePathHeaders(') &&
      command.includes("table<MessageBodyRow, MessageId>('messageBodies')") &&
      command.includes('.bulkGet(headers.map((header) => header.id))') &&
      pathReader.includes('readLiveBranchPath('),
    freshIdentityAndPayload:
      command.includes('const destinationMessageIds = ancestors.map(() => newId())') &&
      clone.includes('destinationTurnIdBySourceTurnId') &&
      clone.includes('clone.turnId = destinationTurnId') &&
      clone.includes('clone.nodeVersion = 0'),
    batchedDestinationWrites:
      command.includes("addPhysicalStorageRows(\n            tx,\n            'messages'") &&
      command.includes("'messageBodies'") &&
      command.includes("'messagePreviews'") &&
      command.includes("'childLists'") &&
      command.includes("'childSlotMembers'"),
    noDuplicateDestinationPathRead: command.includes(
      'exactPathHeaders: storageRows.map(({ header }) => header)',
    ),
    oneLinkedAttachmentAwareCommit:
      command.includes('const chatMutation = openLinkedChatMutation(tx)') &&
      command.includes('await chatMutation.add(chat)') &&
      command.includes('await chatMutation.commit()') &&
      command.includes('applyAttachmentReferenceOwnerTransitions('),
    noLegacyPlanning:
      !command.includes('.withLocks(') &&
      !command.includes('for (;;)') &&
      !command.includes('setTimeout(') &&
      !command.includes('planForkWrite') &&
      !command.includes('ForkWritePlanChangedError') &&
      !command.includes('this.openDb()') &&
      !browserRepoSource.text.includes('interface ForkWritePlan') &&
      !browserRepoSource.text.includes('class ForkWritePlanChangedError'),
  }
  for (const [name, consumed] of Object.entries(commonKernel)) {
    if (!consumed) outputProblems.push(`chat fork missing ${name}`)
  }
  const consumed = Object.values(commonKernel).every(Boolean)
  return Object.freeze({
    variants: Object.freeze(['chat.fork']),
    commonKernel: Object.freeze(commonKernel),
    capabilities: Object.freeze({
      'chat.fork': Object.freeze({
        path: BROWSER_REPO_PATH,
        owner: 'CHAT_FORK_OPERATION',
        transaction: 'FORK_CHAT_TRANSACTION_CAPABILITY',
        consumed,
        physicalWritesProved: true,
        exactPhysicalWritesProved: false,
        exactEffectsProved: false,
        tablesProved: false,
        boundsProved: false,
      }),
    }),
  })
}

function interchangeImportCapabilityFacts(importSource, workspaceUnion, outputProblems) {
  const expectedVariants = [
    'interchange.import-chat',
    'interchange.import-chat-preset',
    'interchange.import-connection-profile',
  ]
  const variants = workspaceUnion.variants
    .filter((variant) => variant.startsWith('interchange.import-'))
    .sort()
  compareExact('interchange import command variants', expectedVariants, variants, outputProblems)
  const chatDescriptor = findVariableInitializer(importSource, 'IMPORT_CHAT_OPERATION').getText(
    importSource,
  )
  const presetDescriptor = findVariableInitializer(
    importSource,
    'IMPORT_CHAT_PRESET_OPERATION',
  ).getText(importSource)
  const profileDescriptor = findVariableInitializer(
    importSource,
    'IMPORT_CONNECTION_PROFILE_OPERATION',
  ).getText(importSource)
  const chatResources = findFunction(importSource, 'importChatResourceNames').getText(importSource)
  const presetResources = findFunction(importSource, 'importChatPresetResourceNames').getText(
    importSource,
  )
  const profileResources = findFunction(
    importSource,
    'importConnectionProfileResourceNames',
  ).getText(importSource)
  const profileResolutionResources = findFunction(
    importSource,
    'importedProfileResolutionResourceNames',
  ).getText(importSource)
  const chatMethod = findMethod(importSource, 'BrowserImportExportHandler', 'importChat').getText(
    importSource,
  )
  const presetMethod = findMethod(
    importSource,
    'BrowserImportExportHandler',
    'importChatPreset',
  ).getText(importSource)
  const profileMethod = findMethod(
    importSource,
    'BrowserImportExportHandler',
    'importConnectionProfile',
  ).getText(importSource)
  const routeText = [chatMethod, presetMethod, profileMethod].join('\n')
  const profileResolution = findFunction(importSource, 'resolveProfileId').getText(importSource)
  const folderResolution = findFunction(importSource, 'ensurePortableFolder').getText(importSource)
  const tagResolution = findFunction(importSource, 'ensurePortableTags').getText(importSource)
  const profileNameResolution = findFunction(importSource, 'uniqueConnectionName').getText(
    importSource,
  )
  const presetNameResolution = findFunction(importSource, 'uniquePresetName').getText(importSource)
  const attachmentPreparation = findFunction(importSource, 'prepareImportedAttachments').getText(
    importSource,
  )
  const attachmentRewrite = findFunction(importSource, 'rewriteAttachmentForImport').getText(
    importSource,
  )
  const jobRewrite = findFunction(importSource, 'rewriteJobForImport').getText(importSource)
  const referenceReplacement = findFunction(
    importSource,
    'replaceMessageAttachmentReferenceOwnersInPages',
  ).getText(importSource)
  const messageWrites = findFunction(importSource, 'storeNewMessageTransitionsInPages').getText(
    importSource,
  )
  const commonKernel = {
    exactVariants:
      variants.length === expectedVariants.length &&
      JSON.stringify(variants) === JSON.stringify(expectedVariants),
    exactTypedDescriptors:
      chatDescriptor.includes("operationKind: 'interchange.import-chat'") &&
      chatDescriptor.includes('transaction: IMPORT_CHAT_TRANSACTION_CAPABILITY') &&
      chatDescriptor.includes("'attachment-job'") &&
      chatDescriptor.includes("'chats'") &&
      presetDescriptor.includes("operationKind: 'interchange.import-chat-preset'") &&
      presetDescriptor.includes('transaction: IMPORT_CHAT_PRESET_TRANSACTION_CAPABILITY') &&
      presetDescriptor.includes("'presets'") &&
      profileDescriptor.includes("operationKind: 'interchange.import-connection-profile'") &&
      profileDescriptor.includes('transaction: IMPORT_CONNECTION_PROFILE_TRANSACTION_CAPABILITY') &&
      profileDescriptor.includes("'profiles'"),
    exactIntentResources:
      chatResources.includes('chat-meta:') &&
      chatResources.includes('message-topology:') &&
      chatResources.includes('folder-name:') &&
      chatResources.includes('tag-name:') &&
      chatResources.includes('attachment-fingerprint:') &&
      presetResources.includes('preset-order') &&
      presetResources.includes('preset-name:') &&
      profileResources.includes('profile-name:') &&
      profileResolutionResources.includes('configuration-target:profile:') &&
      profileResolutionResources.includes('profile-match:'),
    everyRouteConsumesSemanticOwner:
      chatMethod.includes('commit.executeSemanticOperation(') &&
      chatMethod.includes('IMPORT_CHAT_OPERATION') &&
      presetMethod.includes('commit.executeSemanticOperation(') &&
      presetMethod.includes('IMPORT_CHAT_PRESET_OPERATION') &&
      profileMethod.includes('commit.executeSemanticOperation(') &&
      profileMethod.includes('IMPORT_CONNECTION_PROFILE_OPERATION'),
    transactionLocalResolution:
      chatMethod.includes('async (tx) =>') &&
      chatMethod.includes('resolveProfileId(') &&
      chatMethod.includes('findExistingAttachment(') &&
      chatMethod.includes('ensurePortableFolder(') &&
      chatMethod.includes('ensurePortableTags(') &&
      presetMethod.includes('async (tx) =>') &&
      presetMethod.includes('resolveProfileId(') &&
      profileMethod.includes('async (tx) =>') &&
      profileMethod.includes('uniqueConnectionName('),
    indexedCatalogResolution:
      profileResolution.includes(".where('kind')") &&
      profileResolution.includes('.filter(') &&
      !profileResolution.includes('.toArray(') &&
      folderResolution.includes(".where('name').equalsIgnoreCase(name).first()") &&
      folderResolution.includes(".orderBy('sortIndex').last()") &&
      !folderResolution.includes('.toArray(') &&
      tagResolution.includes(".where('nameLower')") &&
      tagResolution.includes('.anyOf(') &&
      profileNameResolution.includes(".where('name').equals(base).count()") &&
      profileNameResolution.includes(".where('name').equals(candidate).count()") &&
      presetNameResolution.includes('ConfigurationPresetCatalogProjectionRow') &&
      presetNameResolution.includes('.each(') &&
      !presetNameResolution.includes('.toArray('),
    singlePersistedClock:
      countOccurrences(chatMethod, 'Date.now()') === 1 &&
      countOccurrences(presetMethod, 'Date.now()') === 1 &&
      countOccurrences(profileMethod, 'Date.now()') === 1 &&
      attachmentPreparation.includes(
        'validatedAttachmentBundleFromPortableWithNewIds(bundle, now)',
      ) &&
      attachmentRewrite.includes('missingSince: now') &&
      jobRewrite.includes('rewritten.updatedAt = now') &&
      referenceReplacement.includes(',\n      now,\n    )') &&
      ![attachmentPreparation, attachmentRewrite, jobRewrite, referenceReplacement].some((text) =>
        text.includes('Date.now()'),
      ),
    boundedTranscriptWrites:
      messageWrites.includes('for (const page of pages(transitions))') &&
      messageWrites.includes('bulkAdd(') &&
      chatMethod.includes('exactPathHeaders: messageGraph.branchTransitions.map('),
    noLegacyPlanning:
      !routeText.includes('.withLocks(') &&
      !routeText.includes('for (;;)') &&
      !routeText.includes('setTimeout(') &&
      !routeText.includes('this.openDb()') &&
      !routeText.includes('this.db') &&
      !importSource.text.includes('planImportChatLinks') &&
      !importSource.text.includes('ImportChatLinkPlanChangedError') &&
      !importSource.text.includes("'interchange:import-"),
  }
  for (const [name, consumed] of Object.entries(commonKernel)) {
    if (!consumed) outputProblems.push(`interchange imports missing ${name}`)
  }
  const consumed = Object.values(commonKernel).every(Boolean)
  return Object.freeze({
    variants: Object.freeze(variants),
    commonKernel: Object.freeze(commonKernel),
    capabilities: Object.freeze(
      Object.fromEntries(
        expectedVariants.map((variant) => [
          variant,
          Object.freeze({
            path: BROWSER_IMPORT_EXPORT_PATH,
            owner:
              variant === 'interchange.import-chat'
                ? 'IMPORT_CHAT_OPERATION'
                : variant === 'interchange.import-chat-preset'
                  ? 'IMPORT_CHAT_PRESET_OPERATION'
                  : 'IMPORT_CONNECTION_PROFILE_OPERATION',
            transaction:
              variant === 'interchange.import-chat'
                ? 'IMPORT_CHAT_TRANSACTION_CAPABILITY'
                : variant === 'interchange.import-chat-preset'
                  ? 'IMPORT_CHAT_PRESET_TRANSACTION_CAPABILITY'
                  : 'IMPORT_CONNECTION_PROFILE_TRANSACTION_CAPABILITY',
            consumed,
            physicalWritesProved: true,
            exactPhysicalWritesProved: false,
            exactEffectsProved: false,
            tablesProved: false,
            boundsProved: false,
          }),
        ]),
      ),
    ),
  })
}

function folderCapabilityFacts(program, catalogSource, workspaceUnion, outputProblems) {
  const variants = workspaceUnion.variants.filter((variant) => variant.startsWith('folder.')).sort()
  const createDescriptorNode = findVariableInitializer(catalogSource, 'FOLDER_CREATE_OPERATION')
  const updateDescriptorNode = findVariableInitializer(catalogSource, 'FOLDER_UPDATE_OPERATION')
  const createDescriptor = createDescriptorNode.getText(catalogSource)
  const updateDescriptor = updateDescriptorNode.getText(catalogSource)
  const ensureDescriptor = findVariableInitializer(
    catalogSource,
    'FOLDER_ENSURE_AND_MOVE_CHATS_OPERATION',
  ).getText(catalogSource)
  const deleteMoveDescriptor = findVariableInitializer(
    catalogSource,
    'FOLDER_DELETE_MOVE_TOP_LEVEL_OPERATION',
  ).getText(catalogSource)
  const deleteArchiveDescriptor = findVariableInitializer(
    catalogSource,
    'FOLDER_DELETE_ARCHIVE_OPERATION',
  ).getText(catalogSource)
  const createText = findFunction(catalogSource, 'createFolder').getText(catalogSource)
  const updateText = findFunction(catalogSource, 'updateFolder').getText(catalogSource)
  const ensureText = findFunction(catalogSource, 'ensureFolderAndMoveChats').getText(catalogSource)
  const deleteText = findFunction(catalogSource, 'deleteFolder').getText(catalogSource)
  const allCommandText = [createText, updateText, ensureText, deleteText].join('\n')
  const fixedRowVariants = [createDescriptorNode, updateDescriptorNode]
    .flatMap((descriptor) => {
      const definition = semanticDescriptorDefinition(descriptor, catalogSource)
      const operationKind = literalText(objectPropertyInitializer(definition, 'operationKind'))
      return operationKind === undefined ? [] : [operationKind]
    })
    .sort()
  const folderRowExactPlanText = findFunction(catalogSource, 'folderRowExactPlan').getText(
    catalogSource,
  )
  const folderRowExactReceiptText = findFunction(catalogSource, 'folderRowExactReceipt').getText(
    catalogSource,
  )
  const constructors = constructorSitesByVariant(workspaceUnion, true)
  const constructorFacts = fixedRowVariants.map((variant) => {
    const sites = constructors.get(variant) ?? []
    if (sites.length !== 1) return Object.freeze({ variant, singleSubmit: false })
    const site = sites[0]
    const source = exactSource(program, site.path)
    const [rootOwnerName, nestedOwnerName] = site.owner.split('.')
    const rootOwner = findFunctionOrVariableInitializer(source, rootOwnerName)
    const owner = nestedOwnerName
      ? findNestedVariableFunction(rootOwner, nestedOwnerName)
      : rootOwner
    const calls = executableCalls(owner)
    const submits = calls.filter((call) => call.expression.getText(source).endsWith('.execute'))
    return Object.freeze({
      variant,
      path: site.path,
      owner: site.owner,
      singleSubmit:
        site.path === 'src/store/folders.ts' &&
        submits.length === 1 &&
        !callHasIterationAncestor(submits[0], owner) &&
        !calls.some((call) =>
          call.expression.getText(source).endsWith(nestedOwnerName ?? rootOwnerName),
        ),
    })
  })
  const constructorSingleSubmit = constructorFacts.every((fact) => fact.singleSubmit)
  const runtimeSingleAttempt = workspaceRuntimeSingleAttemptFacts(program)
  const commonKernel = {
    exactVariants:
      variants.length === 4 &&
      JSON.stringify(variants) ===
        JSON.stringify([
          'folder.create',
          'folder.delete',
          'folder.ensure-and-move-chats',
          'folder.update',
        ]),
    exactTypedDescriptors:
      createDescriptor.includes("operationKind: 'folder.create'") &&
      createDescriptor.includes('transaction: FOLDER_TRANSACTION_CAPABILITY') &&
      updateDescriptor.includes("operationKind: 'folder.update'") &&
      updateDescriptor.includes('transaction: FOLDER_TRANSACTION_CAPABILITY') &&
      ensureDescriptor.includes("operationKind: 'folder.ensure-and-move-chats'") &&
      ensureDescriptor.includes('transaction: CHAT_FOLDER_TRANSACTION_CAPABILITY') &&
      deleteMoveDescriptor.includes("operationKind: 'folder.delete'") &&
      deleteMoveDescriptor.includes('transaction: CHAT_FOLDER_TRANSACTION_CAPABILITY') &&
      deleteArchiveDescriptor.includes("operationKind: 'folder.delete'") &&
      deleteArchiveDescriptor.includes('transaction: CHAT_FOLDER_LINK_TRANSACTION_CAPABILITY'),
    exactIntentResources:
      createDescriptor.includes('resources: folderRowResourceNames') &&
      updateDescriptor.includes('resources: folderRowResourceNames') &&
      ensureDescriptor.includes('resources: ensureFolderResourceNames') &&
      deleteMoveDescriptor.includes('resources: deleteFolderResourceNames') &&
      deleteArchiveDescriptor.includes('resources: deleteFolderResourceNames'),
    everyRouteConsumesSemanticOwner:
      createText.includes('commit.executeSemanticOperation(') &&
      createText.includes('FOLDER_CREATE_OPERATION') &&
      updateText.includes('commit.executeSemanticOperation(') &&
      updateText.includes('FOLDER_UPDATE_OPERATION') &&
      ensureText.includes('commit.executeSemanticOperation(') &&
      ensureText.includes('FOLDER_ENSURE_AND_MOVE_CHATS_OPERATION') &&
      deleteText.includes('commit.executeSemanticOperation(descriptor'),
    transactionLocalFolderMembership:
      ensureText.includes('await folders.each(') &&
      ensureText.includes('const chatMutation = openPreservingChatMutation(tx)') &&
      ensureText.includes('const rows = await chatMutation.readMany(uniqueChatIds)') &&
      ensureText.includes('await chatMutation.commit()') &&
      deleteText.includes('const chatMutation = openLinkedChatMutation(tx)') &&
      deleteText.includes('await chatMutation.readFolder(folderId)') &&
      deleteText.includes('await chatMutation.commit()'),
    boundedVariantIo:
      createText.includes('await table.get(folder.id)') &&
      updateText.includes('await table.get(folderId)') &&
      !ensureText.includes('.toArray(') &&
      !deleteText.includes('.primaryKeys(') &&
      !deleteText.includes('.bulkGet('),
    noLegacyPlanning:
      !allCommandText.includes('.withLocks(') &&
      !allCommandText.includes('for (;;)') &&
      !allCommandText.includes('setTimeout(') &&
      !allCommandText.includes('.transaction(') &&
      !allCommandText.includes('openDb('),
    fixedRowFamilyDerived:
      fixedRowVariants.length === 2 &&
      fixedRowVariants.every((variant) => variants.includes(variant)),
    fixedRowExactReceipts:
      createDescriptor.includes('semanticOperationExactReceiptContracts') &&
      updateDescriptor.includes('semanticOperationExactReceiptContracts') &&
      createText.includes('folderRowExactReceipt(tx, FOLDER_CREATE_EXACT_PLAN)') &&
      updateText.includes('folderRowExactReceipt(tx, FOLDER_UPDATE_EXACT_PLAN)') &&
      folderRowExactReceiptText.includes('boundSemanticOperationExactReceiptAccumulator') &&
      folderRowExactReceiptText.includes("tableName: 'folders'") &&
      folderRowExactReceiptText.includes("operation: 'get'") &&
      folderRowExactReceiptText.includes('requestCount: 1') &&
      folderRowExactReceiptText.includes('rowCount: 1'),
    fixedRowReplayBound:
      createDescriptor.includes(
        "semanticOperationCallerSingleAttemptReplayContract('random-identity')",
      ) &&
      updateDescriptor.includes(
        "semanticOperationCallerSingleAttemptReplayContract('unfenced-relative-update')",
      ) &&
      folderRowExactPlanText.includes("kind: 'single-attempt'"),
    fixedRowBounds:
      folderRowExactPlanText.includes('maxRequests: 1') &&
      folderRowExactPlanText.includes('maxRows: 1') &&
      folderRowExactPlanText.includes('maxBatchRows: 1') &&
      !createText.includes('.where(') &&
      !updateText.includes('.where('),
    fixedRowConstructorSingleSubmit: constructorSingleSubmit,
    ...runtimeSingleAttempt,
  }
  for (const [name, consumed] of Object.entries(commonKernel)) {
    if (!consumed) outputProblems.push(`folder family missing ${name}`)
  }
  const consumed = Object.values(commonKernel).every(Boolean)
  const fixedRowExactEffectsProved =
    commonKernel.fixedRowFamilyDerived && commonKernel.fixedRowExactReceipts
  const fixedRowReplayProved =
    commonKernel.fixedRowFamilyDerived &&
    commonKernel.fixedRowReplayBound &&
    commonKernel.fixedRowConstructorSingleSubmit &&
    commonKernel.runningRuntimeSingleInvoke &&
    commonKernel.waitingRuntimeSingleInvoke &&
    commonKernel.admittedRootSingleInvoke
  const fixedRowBoundsProved =
    commonKernel.fixedRowFamilyDerived &&
    commonKernel.fixedRowExactReceipts &&
    commonKernel.fixedRowBounds
  const capabilities = {}
  for (const variant of variants) {
    const fixedRow = fixedRowVariants.includes(variant)
    capabilities[variant] = Object.freeze({
      path: BROWSER_CATALOG_COMMAND_RUNTIME_PATH,
      owner:
        variant === 'folder.create'
          ? 'FOLDER_CREATE_OPERATION'
          : variant === 'folder.update'
            ? 'FOLDER_UPDATE_OPERATION'
            : variant === 'folder.ensure-and-move-chats'
              ? 'FOLDER_ENSURE_AND_MOVE_CHATS_OPERATION'
              : 'FOLDER_DELETE_MOVE_TOP_LEVEL_OPERATION/FOLDER_DELETE_ARCHIVE_OPERATION',
      transaction:
        variant === 'folder.create' || variant === 'folder.update'
          ? 'FOLDER_TRANSACTION_CAPABILITY'
          : variant === 'folder.ensure-and-move-chats'
            ? 'CHAT_FOLDER_TRANSACTION_CAPABILITY'
            : 'CHAT_FOLDER_TRANSACTION_CAPABILITY/CHAT_FOLDER_LINK_TRANSACTION_CAPABILITY',
      consumed,
      physicalWritesProved: variant !== 'folder.ensure-and-move-chats',
      exactPhysicalWritesProved: fixedRow && fixedRowExactEffectsProved,
      exactEffectsProved: fixedRow && fixedRowExactEffectsProved,
      tablesProved: fixedRow && fixedRowExactEffectsProved,
      boundsProved: fixedRow && fixedRowBoundsProved,
      byteBoundsProved: false,
      idempotenceProved: fixedRow && fixedRowReplayProved,
    })
  }
  return Object.freeze({
    variants: Object.freeze(variants),
    fixedRowVariants: Object.freeze(fixedRowVariants),
    constructorFacts: Object.freeze(constructorFacts),
    commonKernel: Object.freeze(commonKernel),
    capabilities: Object.freeze(capabilities),
  })
}

function generationMetadataCapabilityFacts(program, workspaceUnion, outputProblems) {
  const source = exactSource(program, BROWSER_GENERATION_COMMAND_RUNTIME_PATH)
  const browserRepoSource = exactSource(program, BROWSER_REPO_PATH)
  const mutationJournalSource = exactSource(program, MUTATION_JOURNAL_PATH)
  const catalogProjectionSource = exactSource(program, CONFIGURATION_CATALOG_PROJECTION_PATH)
  const chatRowSource = exactSource(program, 'src/store/chat-row-transition.ts')
  const protocolSource = exactSource(program, 'src/store/workspace-protocol.ts')
  const descriptorNode = findVariableInitializer(source, 'GENERATION_METADATA_OPERATION')
  const descriptor = descriptorNode.getText(source)
  const definition = semanticDescriptorDefinition(descriptorNode, source)
  const operationKind = stringProperty(definition, 'operationKind')
  const executor = findFunction(source, 'commitBrowserGenerationMetadata')
  const executorText = executor.getText(source)
  const receiptText = findFunction(source, 'generationMetadataExactReceipt').getText(source)
  const planText = findFunction(source, 'generationMetadataExactPlan').getText(source)
  const replayText = findFunction(source, 'generationMetadataReplayPlan').getText(source)
  const readText = findFunction(source, 'recordGenerationMetadataPrimaryRead').getText(source)
  const profileProjectionText = findFunction(
    catalogProjectionSource,
    'putConfigurationProfileCatalogProjection',
  ).getText(catalogProjectionSource)
  const presetProjectionText = findFunction(
    catalogProjectionSource,
    'putConfigurationPresetRecencyCatalogProjection',
  ).getText(catalogProjectionSource)
  const chatTransitionText = findFunctionImplementation(
    chatRowSource,
    'applyChatRowWriteTransitions',
  ).getText(chatRowSource)
  const resourceProofText = findFunction(
    protocolSource,
    'generationPostCommitMetadataResourceProof',
  ).getText(protocolSource)
  const constructorSites = constructorSitesByVariant(workspaceUnion, true).get(operationKind) ?? []
  const constructorFacts = constructorSites.map((site) => {
    const constructorSource = exactSource(program, site.path)
    const owner = findFunctionOrVariableInitializer(constructorSource, site.owner)
    const text = owner.getText(constructorSource)
    return Object.freeze({
      path: site.path,
      owner: site.owner,
      exactProof:
        text.includes('generationPostCommitMetadataResourceProof(') &&
        text.includes("kind: 'generation.post-commit-metadata'"),
    })
  })
  const sourceTemplate = (prefix, expression) => `\`${prefix}\${${expression}}\``
  const commonKernel = {
    exactVariant:
      operationKind === 'generation.post-commit-metadata' &&
      workspaceUnion.variants.includes(operationKind),
    exactTypedDescriptor:
      descriptor.includes('transaction: GENERATION_METADATA_TRANSACTION_CAPABILITY') &&
      descriptor.includes('semanticOperationExactReceiptContracts<') &&
      descriptor.includes('GenerationPostCommitMetadataInput,') &&
      descriptor.includes('GenerationMetadataTable') &&
      descriptor.includes(
        'semanticOperationExactReceiptReplayContract(generationMetadataReplayPlan)',
      ),
    exactIntentResources: [
      sourceTemplate('stream-journal:', 'input.streamId'),
      sourceTemplate('chat-meta:', 'input.resourceProof.chatId'),
      sourceTemplate('message:', 'input.resourceProof.messageId'),
      sourceTemplate('profile:', 'input.resourceProof.profileId'),
      sourceTemplate('preset:', 'input.resourceProof.presetId'),
      sourceTemplate('key:', 'input.resourceProof.selectedKeyId'),
      sourceTemplate('setting:', 'key'),
    ].every((token) => descriptor.includes(token)),
    oneTransactionOwner:
      countOccurrences(executorText, 'commit.executeSemanticOperation(') === 1 &&
      executorText.includes('GENERATION_METADATA_OPERATION') &&
      !executorText.includes('.withLocks(') &&
      !executorText.includes('.runTransaction(') &&
      !executorText.includes('for (;;)') &&
      !executorText.includes('setTimeout('),
    transactionSelfSufficient:
      executor.parameters.length === 4 &&
      executor.parameters[0]?.name.getText(source) === 'support' &&
      executorText.includes('const lease = await leases.get(input.streamId)') &&
      executorText.includes('generationPostCommitMetadataResourceProof(lease)') &&
      executorText.includes('streamFenceMatches(lease, input.fence, replacementEpoch)'),
    exactOccurrenceReceipt:
      receiptText.includes('boundSemanticOperationExactReceiptAccumulator') &&
      receiptText.includes('const fragment = accumulator.snapshotFragment()') &&
      receiptText.includes('dependencies: fragment.dependencies') &&
      receiptText.includes('physicalMutations: fragment.physicalMutations') &&
      receiptText.includes('physicalReads: [...fragment.physicalReads, ...physicalReads]') &&
      executorText.includes('const finish = (value: GenerationPostCommitMetadataResult)') &&
      countOccurrences(executorText, 'return finish(') === 5 &&
      mutationJournalSource
        .getText()
        .includes('boundSemanticOperationExactReceiptAccumulator(tx)?.dependency(') &&
      mutationJournalSource.getText().includes("kind: 'message-header'"),
    exactPhysicalReads:
      readText.includes('if (requestCount === 0) return') &&
      readText.includes('existing.requestCount + requestCount') &&
      readText.includes('existing.rowCount + requestCount') &&
      countOccurrences(executorText, 'recordGenerationMetadataPrimaryRead(') === 11 &&
      executorText.includes('const projection = await putConfigurationProfileCatalogProjection') &&
      executorText.includes('projection.aggregateIds.length') &&
      executorText.includes('await putConfigurationPresetRecencyCatalogProjection') &&
      executorText.includes('const chatMutation = openPreservingChatMutation(tx)') &&
      executorText.includes('chatMutation.read(lease.chatId)') &&
      executorText.includes('const transition = await chatMutation.commit()') &&
      profileProjectionText.includes(
        'table<ConfigurationProfileCatalogProjectionRow, ProfileId>(',
      ) &&
      profileProjectionText.includes('.get(profile.id)') &&
      presetProjectionText.includes('table<ConfigurationPresetCatalogProjectionRow, PresetId>(') &&
      presetProjectionText.includes('.get(preset.id)') &&
      chatTransitionText.includes('const fragment = chatRowWriteMutationReceiptFragment') &&
      executorText.includes('transition.fragment'),
    projectionDerivedPublication:
      browserRepoSource.getText().includes('function sidebarChatIdsForMutationFacts(') &&
      browserRepoSource.getText().includes("mutation.tableName !== 'chatSidebarRows'") &&
      browserRepoSource.getText().includes('if (sidebarChatIds.has(chatId))'),
    fencedReplay:
      replayText.includes("kind: 'fenced-convergent'") &&
      replayText.includes(`owner: ${sourceTemplate('stream:', 'input.streamId')}`) &&
      [
        'input.fence.ownerClientId',
        'input.fence.fenceToken',
        'input.fence.replacementEpoch',
        'input.fence.admissionSequence',
        'input.resourceProof.chatId',
        'input.resourceProof.messageId',
        'input.resourceProof.profileId',
        'input.resourceProof.presetId ?? null',
        'input.resourceProof.selectedKeyId ?? null',
        '...input.resourceProof.settingKeys',
      ].every((token) => replayText.includes(token)) &&
      replayText.includes("'metadata-committed'") &&
      replayText.includes("alreadyApplied: 'return-current-or-conflict'") &&
      executorText.includes("lease.phase === 'metadata-committed'") &&
      executorText.includes("outcome: 'already-applied'"),
    finiteCardinalityBounds:
      planText.includes('maxRequests: 14') &&
      planText.match(/maxRows: 14/gu)?.length === 2 &&
      planText.includes('maxRequests: 13') &&
      planText.includes('maxBatchRows: 1') &&
      planText.includes('maxBatchRows: 2') &&
      !executorText.includes('.where(') &&
      !executorText.includes('.toArray(') &&
      !executorText.includes('.each(') &&
      !executorText.includes('for ('),
    boundedNestedInputs:
      resourceProofText.includes('[RECENT_MODEL_RECENCY_KEY, RECENT_MODELS_KEY]') &&
      resourceProofText.includes('[GLOBAL_TOKEN_CALIBRATION_KEY]') &&
      executorText.includes('chatMutation.replace(lease.chatId, (current) => ({') &&
      executorText.includes("recordGenerationMetadataPrimaryRead(physicalReads, 'settings', 2)") &&
      executorText.includes('const transition = await chatMutation.commit()') &&
      chatTransitionText.includes(
        'chatRowWriteMutationReceiptFragment(chatWrites, linkPhases, sidebar)',
      ) &&
      executorText.includes('transition.fragment') &&
      profileProjectionText.includes('.get(profile.id)') &&
      presetProjectionText.includes('.get(preset.id)'),
    byteBoundsExplicitlyOpen: planText.match(/maxBytes: Number\.MAX_SAFE_INTEGER/gu)?.length === 2,
    exactConstructors:
      constructorFacts.length === 2 && constructorFacts.every((fact) => fact.exactProof),
  }
  for (const [name, consumed] of Object.entries(commonKernel)) {
    if (!consumed) outputProblems.push(`generation metadata family missing ${name}`)
  }
  const consumed = Object.values(commonKernel).every(Boolean)
  return Object.freeze({
    variants: Object.freeze(operationKind ? [operationKind] : []),
    constructorFacts: Object.freeze(constructorFacts),
    commonKernel: Object.freeze(commonKernel),
    capabilities: Object.freeze({
      'generation.post-commit-metadata': Object.freeze({
        path: BROWSER_GENERATION_COMMAND_RUNTIME_PATH,
        owner: 'GENERATION_METADATA_OPERATION',
        transaction: 'GENERATION_METADATA_TRANSACTION_CAPABILITY',
        consumed,
        physicalWritesProved: true,
        exactPhysicalWritesProved: true,
        exactEffectsProved: true,
        tablesProved: true,
        boundsProved: true,
        byteBoundsProved: false,
        idempotenceProved: true,
      }),
    }),
  })
}

function configurationKeyMaterialCapabilityFacts(
  program,
  browserRepoSource,
  configurationSource,
  mutationJournalSource,
  outputProblems,
) {
  const checker = program.getTypeChecker()
  const domainSource = exactSource(program, 'src/store/browser-domain-mutations.ts')
  const executor = findFunctionImplementation(configurationSource, 'executeKeyMaterialOperation')
  const executeSemanticOperation = findMethod(
    browserRepoSource,
    'BrowserCommandCommit',
    'executeSemanticOperation',
  )
  const semanticPortExecute = findInterfaceMethod(
    domainSource,
    'BrowserSemanticCommandPort',
    'executeSemanticOperation',
  )
  const roots = configurationHandlerRoots(checker, configurationSource)
  const routes = new Map()
  for (const [variant, root] of roots) {
    routes.set(variant, commandRouteFacts(checker, [root], [executor]))
  }
  const variants = [...routes]
    .filter(([, route]) => route.semanticTerminals.length > 0)
    .map(([variant]) => variant)
    .sort()
  compareExact(
    'configuration key-material command routes',
    ['key.delete', 'key.material-replace', 'key.put'],
    variants,
    outputProblems,
  )
  const descriptor = findFunction(configurationSource, 'keyMaterialOperationDescriptor')
  const descriptorCall = executableCalls(descriptor).find(
    (call) => call.expression.getText(configurationSource) === 'semanticOperationDescriptor',
  )
  const definition = semanticDescriptorDefinition(
    descriptorCall?.arguments[0] ? unwrap(descriptorCall.arguments[0]) : undefined,
    configurationSource,
  )
  const exactReceiptFactory = typedExactReceiptFactoryFacts(
    definition,
    configurationSource,
    'keyMaterialOperationExactPlan',
    'keyMaterialOperationExactReceipt',
  )
  const replayPlanText = findFunction(
    configurationSource,
    'keyMaterialOperationReplayPlan',
  ).getText(configurationSource)
  const executorCalls = executableCalls(executor)
  const executorText = executor.getText(configurationSource)
  const keyMaterialTransactionText = findVariableInitializer(
    configurationSource,
    'CONFIGURATION_KEY_MATERIAL_TRANSACTION',
  ).getText(configurationSource)
  const transactionText = findMethod(
    browserRepoSource,
    'BrowserCommandCommit',
    'runTransaction',
  ).getText(browserRepoSource)
  const semanticPortText = findInterfaceMethod(
    domainSource,
    'BrowserSemanticCommandPort',
    'executeSemanticOperation',
  ).getText(domainSource)
  const journalText = mutationJournalSource.getText()
  const commonKernel = {
    nestedKindBound: browserRepoSource
      .getText()
      .includes('configurationSemanticOperationKind(command.input.kind)'),
    exactVariantsBound:
      objectPropertyInitializer(definition, 'operationKind')?.getText(configurationSource) ===
      'configurationSemanticOperationKind(operationKind)',
    exactTransaction:
      objectPropertyInitializer(definition, 'transaction')?.getText(configurationSource) ===
        'CONFIGURATION_KEY_MATERIAL_TRANSACTION' &&
      keyMaterialTransactionText.includes("physicalStorageTables('keys')") &&
      !keyMaterialTransactionText.includes('configurationLinks'),
    exactIntentResource:
      objectPropertyInitializer(definition, 'resources')
        ?.getText(configurationSource)
        .includes('`key:$' + '{keyId}`') === true &&
      objectPropertyInitializer(definition, 'resources')
        ?.getText(configurationSource)
        .includes('configuration-target') === false,
    exactEffects:
      exactReceiptFactory.contractBound &&
      exactReceiptFactory.receiptText.includes(
        'workspaceDependenciesForConfigurationSemanticMutation',
      ) &&
      !exactReceiptFactory.receiptText.includes("kind: 'profile' as const") &&
      !exactReceiptFactory.receiptText.includes("kind: 'discovery-cache' as const") &&
      exactReceiptFactory.receiptText.includes('physicalMutations:'),
    exactPhysicalReads:
      exactReceiptFactory.contractBound &&
      exactReceiptFactory.receiptText.includes("tableName: 'keys'") &&
      exactReceiptFactory.receiptText.includes("indexKind: 'primary'") &&
      exactReceiptFactory.receiptText.includes("operation: 'get'") &&
      !exactReceiptFactory.receiptText.includes("tableName: 'configurationLinks'") &&
      !exactReceiptFactory.receiptText.includes("operation: 'query'"),
    typedExactPlan:
      exactReceiptFactory.planBound &&
      exactReceiptFactory.planText.includes('replay: keyMaterialOperationReplayPlan(input)') &&
      replayPlanText.includes("kind: 'single-attempt'") &&
      replayPlanText.includes("kind: 'fenced-convergent'") &&
      replayPlanText.includes("reason: 'unfenced-relative-update'") &&
      replayPlanText.includes("alreadyApplied: 'return-current-or-conflict'") &&
      exactReceiptFactory.planText.includes('maxRequests: 1') &&
      exactReceiptFactory.planText.includes('maxRows: 1') &&
      exactReceiptFactory.planText.includes('maxBatchRows: 1') &&
      exactReceiptFactory.receiptBound,
    typedReceiptBound:
      semanticPortText.includes('Receipt') &&
      browserRepoSource.getText().includes('semanticOperationExecutionParts') &&
      transactionText.includes('execution.receipt') &&
      executorText.includes('semanticOperationExecution'),
    executorConsumed: executorCalls.some(
      (call) =>
        callResolvesTo(checker, call, executeSemanticOperation) ||
        callResolvesTo(checker, call, semanticPortExecute),
    ),
    primaryReadOwnedWithoutTargetScan:
      executorText.includes("table<KeyRecord, KeyId>('keys')") &&
      !executorText.includes("readTargetLinksFromTransaction(tx, 'key'"),
    writesOwned:
      executorText.includes('putSemanticByteOwner') &&
      executorText.includes('deleteSemanticByteOwner'),
    exactAffectedSetOwned:
      executorText.includes('recordBrowserCommandKeyRequestMaterialAffectedSet') &&
      journalText.includes('handledKeyRequestMaterialIds') &&
      journalText.includes('!journal.handledKeyRequestMaterialIds.has(keyId)'),
    noExternalPreflight:
      !executorText.includes('readTargetLinks(db') && !executorText.includes('sameLinkIds('),
    transactionLocalExactAssertions:
      transactionText.includes('assertSemanticOperationExactInvalidations') &&
      transactionText.includes('assertSemanticOperationExactPhysicalMutations') &&
      transactionText.includes('assertSemanticOperationExactPhysicalReads'),
    readObservationOptIn: transactionText.includes(
      'observePhysicalReads: semanticOperation?.descriptor.exactPhysicalReads !== undefined',
    ),
    boundedTargetIo:
      exactReceiptFactory.receiptText.includes('requestCount: 1') &&
      !executorText.includes('.toCollection('),
    legacyCallsAbsent: !executorCalls.some((call) =>
      call.expression.getText(configurationSource).endsWith('.withLocks'),
    ),
  }
  for (const [name, consumed] of Object.entries(commonKernel)) {
    if (!consumed) outputProblems.push(`configuration key-material common kernel missing ${name}`)
  }
  const commonConsumed = Object.values(commonKernel).every(Boolean)
  const capabilities = {}
  const routeFacts = {}
  for (const variant of variants) {
    const route = routes.get(variant)
    const consumed =
      commonConsumed && route.semanticTerminals.length > 0 && route.legacyTerminals.length === 0
    if (route.legacyTerminals.length > 0) {
      outputProblems.push(
        `configuration key-material ${variant}: legacy terminals ${route.legacyTerminals.join(', ')}`,
      )
    }
    capabilities[variant] = Object.freeze({
      path: CONFIGURATION_HANDLER_PATH,
      owner: 'executeKeyMaterialOperation',
      transaction: 'CONFIGURATION_KEY_MATERIAL_TRANSACTION',
      consumed,
      physicalWritesProved: true,
      exactPhysicalWritesProved: true,
      exactEffectsProved: true,
      tablesProved: true,
      boundsProved: true,
    })
    routeFacts[variant] = Object.freeze({
      entries: Object.freeze(route.entries),
      semanticTerminals: Object.freeze(route.semanticTerminals),
      legacyTerminals: Object.freeze(route.legacyTerminals),
      consumed,
    })
  }
  return Object.freeze({
    variants: Object.freeze(variants),
    routesByVariant: Object.freeze(routeFacts),
    commonKernel: Object.freeze(commonKernel),
    capabilities: Object.freeze(capabilities),
  })
}

function configurationChatCapabilityFacts(
  program,
  browserRepoSource,
  configurationSource,
  outputProblems,
) {
  const checker = program.getTypeChecker()
  const domainSource = exactSource(program, 'src/store/browser-domain-mutations.ts')
  const chatRowSource = exactSource(program, 'src/store/chat-row-transition.ts')
  const byteOwnerSource = exactSource(program, 'src/store/byte-owner-mutation.ts')
  const sidebarSource = exactSource(program, 'src/store/chat-sidebar-projection.ts')
  const executor = findFunctionImplementation(configurationSource, 'mutateChatConfiguration')
  const executeSemanticOperation = findMethod(
    browserRepoSource,
    'BrowserCommandCommit',
    'executeSemanticOperation',
  )
  const semanticPortExecute = findInterfaceMethod(
    domainSource,
    'BrowserSemanticCommandPort',
    'executeSemanticOperation',
  )
  const roots = configurationHandlerRoots(checker, configurationSource)
  const routes = new Map()
  for (const [variant, root] of roots) {
    routes.set(variant, commandRouteFacts(checker, [root], [executor]))
  }
  const variants = [...routes]
    .filter(([, route]) => route.semanticTerminals.length > 0)
    .map(([variant]) => variant)
    .sort()
  compareExact(
    'configuration linked-chat command routes',
    [
      'chat.settings-fields-patch',
      'chat.settings-patch',
      'chat.settings-replace',
      'prompt-preset.local-commit',
    ],
    variants,
    outputProblems,
  )
  const expectedResourceArguments = new Map([
    ['chat.settings-fields-patch', 'chatSettingsFieldIntroducedTargetResources(command.patches)'],
    ['chat.settings-patch', 'serializedChatSettingsIntroducedTargetResources(command.patch)'],
    [
      'chat.settings-replace',
      'replacementChatSettingsIntroducedTargetResources(command.settings, command.presetId)',
    ],
    ['prompt-preset.local-commit', '[]'],
  ])
  const routeExecutorCalls = new Map(
    variants.map((variant) => [
      variant,
      reachableCallsResolvingTo(checker, [roots.get(variant)], executor),
    ]),
  )

  const descriptor = findFunction(configurationSource, 'chatConfigurationOperationDescriptor')
  const descriptorCall = executableCalls(descriptor).find(
    (call) => call.expression.getText(configurationSource) === 'semanticOperationDescriptor',
  )
  const definition = semanticDescriptorDefinition(
    descriptorCall?.arguments[0] ? unwrap(descriptorCall.arguments[0]) : undefined,
    configurationSource,
  )
  const effects = objectPropertyInitializer(definition, 'effects')
  const physicalMutations = objectPropertyInitializer(definition, 'exactPhysicalMutations')
  const physicalReads = objectPropertyInitializer(definition, 'exactPhysicalReads')
  const descriptorText = descriptor.getText(configurationSource)
  const physicalMutationText = physicalMutations?.getText(configurationSource) ?? ''
  const physicalReadText = physicalReads?.getText(configurationSource) ?? ''
  const exactReceiptFactory = typedExactReceiptFactoryFacts(
    definition,
    configurationSource,
    'chatConfigurationOperationExactPlan',
    'chatConfigurationOperationExactReceipt',
  )
  const linkedDependencyText = findFunction(
    configurationSource,
    'linkedChatTransitionsDependencies',
  ).getText(configurationSource)
  const linkedPhysicalMutationText = findFunction(
    configurationSource,
    'linkedChatTransitionsPhysicalMutations',
  ).getText(configurationSource)
  const linkedPhysicalReadText = findFunction(
    configurationSource,
    'linkedChatTransitionPhysicalReads',
  ).getText(configurationSource)
  const executorCalls = executableCalls(executor)
  const semanticExecutorCalls = executorCalls.filter(
    (call) =>
      callResolvesTo(checker, call, executeSemanticOperation) ||
      callResolvesTo(checker, call, semanticPortExecute),
  )
  const executorText = executor.getText(configurationSource)
  const chatRowText = [
    findClass(chatRowSource, 'TransactionChatMutationOwner'),
    findFunctionImplementation(chatRowSource, 'applyChatRowWriteTransitions'),
    findFunction(chatRowSource, 'chatRowWriteMutationReceiptFragment'),
  ]
    .map((owner) => owner.getText(chatRowSource))
    .join('\n')
  const linkTransitionText = findFunction(
    byteOwnerSource,
    'applyConfigurationOwnerLinkTransitions',
  ).getText(byteOwnerSource)
  const profileUsageText = findFunction(
    byteOwnerSource,
    'applyConfigurationProfileUsageDeltas',
  ).getText(byteOwnerSource)
  const sidebarTransitionText = findFunction(
    sidebarSource,
    'applyChatSidebarProjectionTransitions',
  ).getText(sidebarSource)
  const sidebarCommitText = findFunction(
    sidebarSource,
    'commitChatSidebarProjectionCandidates',
  ).getText(sidebarSource)
  const sidebarDeltaText = findFunction(sidebarSource, 'applyChatSidebarProjectionDeltas').getText(
    sidebarSource,
  )
  const repoTransactionText = findMethod(
    browserRepoSource,
    'BrowserCommandCommit',
    'runTransaction',
  ).getText(browserRepoSource)
  const semanticPortText = semanticPortExecute.getText(domainSource)
  const exactTables = [
    'chats',
    'configurationLinks',
    'configurationProfileUsageRows',
    'configurationCatalogAggregates',
    'chatSidebarRows',
    'chatSidebarAggregates',
  ]
  const commonKernel = {
    nestedKindBound: browserRepoSource
      .getText()
      .includes('configurationSemanticOperationKind(command.input.kind)'),
    exactVariantsBound:
      objectPropertyInitializer(definition, 'operationKind')?.getText(configurationSource) ===
      'configurationSemanticOperationKind(operationKind)',
    exactTransaction:
      objectPropertyInitializer(definition, 'transaction')?.getText(configurationSource) ===
      'CHAT_ROW_LINKED_TRANSACTION_CAPABILITY',
    exactTablePolicies:
      objectPropertyInitializer(definition, 'permittedWrites')?.getText(configurationSource) ===
        '[...CHAT_ROW_LINKED_TRANSACTION_CAPABILITY.tableNames]' &&
      sameSortedValues(stringArrayProperty(definition, 'requiredWritesWhenMutated'), [
        'chats',
        'chatSidebarRows',
      ]),
    exactResources:
      /`chat-meta:\$\{chatId\}`/u.test(descriptorText) &&
      descriptorText.includes('...introducedTargetResources'),
    exactRouteInputs: [...expectedResourceArguments].every(([variant, expected]) => {
      const calls = routeExecutorCalls.get(variant) ?? []
      return calls.length === 1 && calls[0]?.arguments[3]?.getText(configurationSource) === expected
    }),
    exactEffects:
      ((effects !== undefined &&
        validSemanticEffects(unwrap(effects)) &&
        effects.getText(configurationSource).includes('ChatConfigurationOperationReceipt') &&
        effects.getText(configurationSource).includes('linkedChatTransitionDependencies')) ||
        (exactReceiptFactory.contractBound &&
          exactReceiptFactory.receiptText.includes('linkedChatTransitionDependencies') &&
          exactReceiptFactory.receiptText.includes('physicalMutations:'))) &&
      linkedDependencyText.includes('transition.links.profileUsageMutations.map') &&
      ((physicalMutations !== undefined && physicalReads !== undefined) ||
        exactReceiptFactory.receiptBound),
    exactPhysicalMutations:
      exactTables.every((tableName) =>
        linkedPhysicalMutationText.includes(`tableName: '${tableName}'`),
      ) &&
      [
        'links.removedLinkIds.map',
        'links.writtenLinkIds.map',
        'links.profileUsageMutations.map',
        'links.profileManagerRevisionChanged',
        'sidebar.mutatedRowIds.map',
        'sidebar.aggregateMutations.map',
      ].every((fragment) => linkedPhysicalMutationText.includes(fragment)) &&
      (physicalMutationText.includes('linkedChatTransitionPhysicalMutations') ||
        exactReceiptFactory.receiptText.includes('linkedChatTransitionPhysicalMutations')),
    exactPhysicalReads:
      exactTables.every((tableName) =>
        linkedPhysicalReadText.includes(`tableName: '${tableName}'`),
      ) &&
      linkedPhysicalReadText.includes("indexName: 'ownerKey'") &&
      linkedPhysicalReadText.includes("operation: 'open-cursor'") &&
      linkedPhysicalReadText.includes("indexName: 'updatedAt'") &&
      [
        'transition.links.ownerQueryRequests',
        'transition.links.ownerQueryRowCount',
        'transition.links.profileUsageReadRequests',
        'transition.links.profileUsageMutations.length',
        'transition.links.profileManagerRevisionChanged',
        'transition.sidebar.rowReadRequests',
        'transition.sidebar.rowReadCount',
        'transition.sidebar.aggregateReadRequests',
        'transition.sidebar.aggregateReadCount',
        'transition.sidebar.extremaReads.map',
      ].every((fragment) => linkedPhysicalReadText.includes(fragment)) &&
      (physicalReadText.includes('linkedChatTransitionPhysicalReads') ||
        exactReceiptFactory.receiptText.includes('linkedChatTransitionPhysicalReads')),
    typedExactPlan:
      exactReceiptFactory.planBound &&
      hasTypedSingleAttemptReplayPlan(exactReceiptFactory.planText) &&
      exactReceiptFactory.planText.includes('maxRequests: 31') &&
      exactReceiptFactory.planText.includes('maxRows: 41') &&
      exactReceiptFactory.planText.includes('maxBatchRows: 9') &&
      exactReceiptFactory.receiptBound,
    typedReceiptBound:
      semanticPortText.includes('Receipt') &&
      executorText.includes('ChatConfigurationOperationReceipt') &&
      executorText.includes('semanticOperationExecution') &&
      repoTransactionText.includes('execution.receipt'),
    executorConsumed:
      semanticExecutorCalls.length === 1 &&
      semanticExecutorCalls[0]?.arguments[0]?.getText(configurationSource) ===
        'chatConfigurationOperationDescriptor(operationKind)',
    noDatabaseParameter:
      executor.parameters.length === 6 &&
      executor.parameters[0]?.name.getText(configurationSource) === 'operationKind' &&
      identifierCount(executor, 'db') === 0 &&
      identifierCount(executor, '_db') === 0,
    primaryReadOwned:
      executorText.includes('const chatMutation = openLinkedChatMutation(tx)') &&
      executorText.includes('const current = await chatMutation.read(chatId)'),
    linkedWritesOwned:
      executorText.includes('chatMutation.replaceLinked(chatId, () => written)') &&
      executorText.includes('const transition = await chatMutation.commit()') &&
      chatRowText.includes('replaceLinkedSemanticByteOwnerBatch') &&
      chatRowText.includes('applyChatSidebarProjectionTransitions'),
    dynamicFanoutOwned:
      linkTransitionText.includes(".where('ownerKey')") &&
      linkTransitionText.includes('applyConfigurationProfileUsageDeltas') &&
      profileUsageText.includes('.bulkGet(') &&
      sidebarTransitionText.includes('commitChatSidebarProjectionCandidates') &&
      sidebarCommitText.includes('applyChatSidebarProjectionDeltas') &&
      sidebarDeltaText.includes('readFolderSortExtrema') &&
      chatRowText.includes('await replaceLinkedSemanticByteOwnerBatch') &&
      chatRowText.includes('const sidebar = await applyChatSidebarProjectionTransitions') &&
      chatRowText.includes('const fragment = chatRowWriteMutationReceiptFragment') &&
      chatRowText.includes('return Object.freeze({'),
    noExternalPreflight:
      !executorText.includes('executeRevalidatedConfigurationPlan') &&
      !executorText.includes('readConfigurationLinksForOwner') &&
      !executorText.includes('while (') &&
      !executorText.includes('for ('),
    transactionLocalExactAssertions:
      repoTransactionText.includes('assertSemanticOperationExactInvalidations') &&
      repoTransactionText.includes('assertSemanticOperationExactPhysicalMutations') &&
      repoTransactionText.includes('assertSemanticOperationExactPhysicalReads') &&
      repoTransactionText.includes('semanticDependenciesForMutationFacts(result.facts)'),
    readObservationOptIn: repoTransactionText.includes(
      'observePhysicalReads: semanticOperation?.descriptor.exactPhysicalReads !== undefined',
    ),
    boundedPhysicalIo:
      executorText.includes('const chatMutation = openLinkedChatMutation(tx)') &&
      executorText.includes('const current = await chatMutation.read(chatId)') &&
      linkTransitionText.includes('CONFIGURATION_OWNER_LINK_BATCH_SIZE') &&
      profileUsageText.includes('CONFIGURATION_OWNER_LINK_BATCH_SIZE') &&
      linkedPhysicalReadText.includes('requestCount: transition.links.ownerQueryRequests') &&
      linkedPhysicalReadText.includes('requestCount: transition.sidebar.rowReadRequests') &&
      linkedPhysicalReadText.includes('requestCount: transition.sidebar.aggregateReadRequests') &&
      !executorText.includes('.toCollection('),
    legacyCallsAbsent: !executorCalls.some((call) =>
      call.expression.getText(configurationSource).endsWith('.withLocks'),
    ),
  }
  for (const [name, consumed] of Object.entries(commonKernel)) {
    if (!consumed) outputProblems.push(`configuration linked-chat common kernel missing ${name}`)
  }
  const commonConsumed = Object.values(commonKernel).every(Boolean)
  const capabilities = {}
  const routeFacts = {}
  for (const variant of variants) {
    const route = routes.get(variant)
    const consumed =
      commonConsumed && route.semanticTerminals.length > 0 && route.legacyTerminals.length === 0
    if (route.legacyTerminals.length > 0) {
      outputProblems.push(
        `configuration linked-chat ${variant}: legacy terminals ${route.legacyTerminals.join(', ')}`,
      )
    }
    capabilities[variant] = Object.freeze({
      path: CONFIGURATION_HANDLER_PATH,
      owner: 'mutateChatConfiguration',
      transaction: 'CHAT_ROW_LINKED_TRANSACTION_CAPABILITY',
      consumed,
      physicalWritesProved: true,
      exactPhysicalWritesProved: true,
      exactEffectsProved: true,
      tablesProved: true,
      boundsProved: true,
    })
    routeFacts[variant] = Object.freeze({
      entries: Object.freeze(route.entries),
      semanticTerminals: Object.freeze(route.semanticTerminals),
      legacyTerminals: Object.freeze(route.legacyTerminals),
      consumed,
    })
  }
  return Object.freeze({
    variants: Object.freeze(variants),
    routesByVariant: Object.freeze(routeFacts),
    commonKernel: Object.freeze(commonKernel),
    capabilities: Object.freeze(capabilities),
  })
}

function configurationCatalogedRowCapabilityFacts(
  program,
  browserRepoSource,
  configurationSource,
  catalogProjectionSource,
  outputProblems,
) {
  const checker = program.getTypeChecker()
  const domainSource = exactSource(program, 'src/store/browser-domain-mutations.ts')
  const executor = findFunctionImplementation(
    configurationSource,
    'executeCatalogedConfigurationOperation',
  )
  const executeSemanticOperation = findMethod(
    browserRepoSource,
    'BrowserCommandCommit',
    'executeSemanticOperation',
  )
  const semanticPortExecute = findInterfaceMethod(
    domainSource,
    'BrowserSemanticCommandPort',
    'executeSemanticOperation',
  )
  const roots = configurationHandlerRoots(checker, configurationSource)
  const routes = new Map()
  for (const [variant, root] of roots) {
    routes.set(variant, commandRouteFacts(checker, [root], [executor]))
  }
  const variants = [...routes]
    .filter(([, route]) => route.semanticTerminals.length > 0)
    .map(([variant]) => variant)
    .sort()
  const expectedVariants = ['connection.touch', 'prompt-preset.rename']
  compareExact(
    'configuration cataloged-row command routes',
    expectedVariants,
    variants,
    outputProblems,
  )
  const descriptor = findFunction(configurationSource, 'catalogedConfigurationOperationDescriptor')
  const descriptorCall = executableCalls(descriptor).find(
    (call) => call.expression.getText(configurationSource) === 'semanticOperationDescriptor',
  )
  const definition = semanticDescriptorDefinition(
    descriptorCall?.arguments[0] ? unwrap(descriptorCall.arguments[0]) : undefined,
    configurationSource,
  )
  const effects = objectPropertyInitializer(definition, 'effects')
  const physicalMutations = objectPropertyInitializer(definition, 'exactPhysicalMutations')
  const physicalReads = objectPropertyInitializer(definition, 'exactPhysicalReads')
  const resources = objectPropertyInitializer(definition, 'resources')
  const exactReceiptFactory = typedExactReceiptFactoryFacts(
    definition,
    configurationSource,
    'catalogedConfigurationOperationExactPlan',
    'catalogedConfigurationOperationExactReceipt',
  )
  const executorCalls = executableCalls(executor)
  const executorText = executor.getText(configurationSource)
  const projectionText = catalogProjectionSource.getText()
  const operationDefinitionText = findFunction(
    configurationSource,
    'catalogedConfigurationOperationDefinition',
  ).getText(configurationSource)
  const entityWriterText = findFunction(
    configurationSource,
    'writeCatalogedConfigurationEntity',
  ).getText(configurationSource)
  const projectionWriterText = findFunction(
    configurationSource,
    'applyCatalogedConfigurationProjectionTransition',
  ).getText(configurationSource)
  const repoTransactionText = findMethod(
    browserRepoSource,
    'BrowserCommandCommit',
    'runTransaction',
  ).getText(browserRepoSource)
  const semanticCalls = executorCalls.filter(
    (call) =>
      callResolvesTo(checker, call, executeSemanticOperation) ||
      callResolvesTo(checker, call, semanticPortExecute),
  )
  const routeExecutorCalls = new Map(
    variants.map((variant) => [
      variant,
      reachableCallsResolvingTo(checker, [roots.get(variant)], executor),
    ]),
  )
  const commonKernel = {
    nestedKindBound: browserRepoSource
      .getText()
      .includes('configurationSemanticOperationKind(command.input.kind)'),
    exactVariantsBound:
      objectPropertyInitializer(definition, 'operationKind')?.getText(configurationSource) ===
      'configurationSemanticOperationKind(operationKind)',
    capabilityDerivedTransactions:
      objectPropertyInitializer(definition, 'transaction')?.getText(configurationSource) ===
        'definition.transaction' &&
      objectPropertyInitializer(definition, 'permittedWrites')?.getText(configurationSource) ===
        'definition.transaction.tableNames' &&
      expectedVariants.every((variant) => operationDefinitionText.includes(`case '${variant}'`)),
    exactEntityResources:
      resources
        ?.getText(configurationSource)
        .includes('catalogedConfigurationEntityResourceName(entityKind, entityId)') === true,
    exactEffects:
      (effects !== undefined &&
        validSemanticEffects(unwrap(effects)) &&
        effects.getText(configurationSource).includes('CatalogedConfigurationOperationReceipt') &&
        physicalMutations !== undefined &&
        physicalReads !== undefined) ||
      (exactReceiptFactory.contractBound &&
        exactReceiptFactory.receiptText.includes(
          'catalogedConfigurationOperationDependencies(receipt)',
        ) &&
        exactReceiptFactory.receiptText.includes('physicalMutations:')),
    exactReceiptWrites:
      (physicalMutations?.getText(configurationSource).includes('receipt.projection') === true &&
        physicalMutations
          .getText(configurationSource)
          .includes("tableName: 'configurationCatalogAggregates'")) ||
      (exactReceiptFactory.receiptText.includes('const projection = receipt.projection') &&
        exactReceiptFactory.receiptText.includes(
          "tableName: 'configurationCatalogAggregates' as const",
        )),
    exactBoundedReads:
      (physicalReads?.getText(configurationSource).includes('definition.entityTable') === true &&
        physicalReads
          .getText(configurationSource)
          .includes("tableName: 'configurationCatalogAggregates'") &&
        !physicalReads.getText(configurationSource).includes('projection.projectionTable')) ||
      (exactReceiptFactory.receiptText.includes('tableName: definition.entityTable') &&
        exactReceiptFactory.receiptText.includes(
          "tableName: 'configurationCatalogAggregates' as const",
        ) &&
        !exactReceiptFactory.receiptText.includes('indexName:')),
    typedExactPlan:
      exactReceiptFactory.planBound &&
      hasTypedSingleAttemptReplayPlan(exactReceiptFactory.planText) &&
      exactReceiptFactory.planText.includes('maxRequests: 4') &&
      exactReceiptFactory.planText.includes('maxRows: 4') &&
      exactReceiptFactory.planText.includes('maxRequests: 5') &&
      exactReceiptFactory.planText.includes('maxRows: 5') &&
      exactReceiptFactory.receiptBound,
    executorConsumed: semanticCalls.length === 1,
    routeExecutorExact: [...routeExecutorCalls.values()].every((calls) => calls.length === 1),
    transitionReceiptBound:
      executorText.includes('catalogedConfigurationOperationReceipt') &&
      executorText.includes('applyCatalogedConfigurationProjectionTransition') &&
      projectionWriterText.includes('applyConfigurationProfileCatalogProjectionTransition') &&
      projectionWriterText.includes('applyConfigurationPromptPresetCatalogProjectionTransition'),
    projectionReadsSubtracted: [
      'applyConfigurationProfileCatalogProjectionTransition',
      'applyConfigurationPromptPresetCatalogProjectionTransition',
    ].every((name) => {
      const text = findFunction(catalogProjectionSource, name).getText(catalogProjectionSource)
      return !text.includes('.table') && !text.includes('.get(')
    }),
    writesOwned:
      entityWriterText.includes('replaceLinkedSemanticByteOwner') &&
      entityWriterText.includes('putSemanticByteOwner') &&
      projectionText.includes('ConfigurationCatalogProjectionMutationReceipt'),
    noLegacyTerminal:
      !executorText.includes('executeDirectConfigurationTransaction') &&
      !executorText.includes('executeRevalidatedConfigurationPlan') &&
      !executorText.includes('.withLocks('),
    noBroadWork:
      !executorText.includes('.toCollection(') &&
      !executorText.includes('.openCursor(') &&
      !executorText.includes('.toArray(') &&
      !projectionWriterText.includes('readOwnerLinks'),
    transactionLocalExactAssertions:
      repoTransactionText.includes('assertSemanticOperationExactInvalidations') &&
      repoTransactionText.includes('assertSemanticOperationExactPhysicalMutations') &&
      repoTransactionText.includes('assertSemanticOperationExactPhysicalReads'),
    readObservationOptIn: repoTransactionText.includes(
      'observePhysicalReads: semanticOperation?.descriptor.exactPhysicalReads !== undefined',
    ),
  }
  for (const [name, consumed] of Object.entries(commonKernel)) {
    if (!consumed) outputProblems.push(`configuration cataloged-row common kernel missing ${name}`)
  }
  const commonConsumed = Object.values(commonKernel).every(Boolean)
  const capabilities = {}
  const routeFacts = {}
  for (const variant of variants) {
    const route = routes.get(variant)
    const consumed =
      commonConsumed && route.semanticTerminals.length > 0 && route.legacyTerminals.length === 0
    if (route.legacyTerminals.length > 0) {
      outputProblems.push(
        `configuration cataloged-row ${variant}: legacy terminals ${route.legacyTerminals.join(', ')}`,
      )
    }
    capabilities[variant] = Object.freeze({
      path: CONFIGURATION_HANDLER_PATH,
      owner: 'executeCatalogedConfigurationOperation',
      transaction: 'catalogedConfigurationOperationDefinition',
      consumed,
      physicalWritesProved: true,
      exactPhysicalWritesProved: true,
      exactEffectsProved: true,
      tablesProved: true,
      boundsProved: true,
    })
    routeFacts[variant] = Object.freeze({
      entries: Object.freeze(route.entries),
      semanticTerminals: Object.freeze(route.semanticTerminals),
      legacyTerminals: Object.freeze(route.legacyTerminals),
      consumed,
    })
  }
  return Object.freeze({
    variants: Object.freeze(variants),
    routesByVariant: Object.freeze(routeFacts),
    commonKernel: Object.freeze(commonKernel),
    capabilities: Object.freeze(capabilities),
  })
}

function configurationPresetLifecycleCapabilityFacts(
  program,
  browserRepoSource,
  configurationSource,
  catalogProjectionSource,
  byteOwnerSource,
  presetOrderSource,
  outputProblems,
) {
  const checker = program.getTypeChecker()
  const domainSource = exactSource(program, 'src/store/browser-domain-mutations.ts')
  const executor = findFunctionImplementation(
    configurationSource,
    'executePresetLifecycleOperation',
  )
  const executeSemanticOperation = findMethod(
    browserRepoSource,
    'BrowserCommandCommit',
    'executeSemanticOperation',
  )
  const semanticPortExecute = findInterfaceMethod(
    domainSource,
    'BrowserSemanticCommandPort',
    'executeSemanticOperation',
  )
  const roots = configurationHandlerRoots(checker, configurationSource)
  const expectedVariants = [
    'chat-preset.create',
    'chat-preset.create-and-link',
    'chat-preset.delete',
    'chat-preset.duplicate',
    'chat-preset.save',
    'chat-preset.set-archived',
    'chat-preset.update',
  ]
  const routes = new Map(
    expectedVariants.map((variant) => [
      variant,
      commandRouteFacts(checker, [roots.get(variant)], [executor]),
    ]),
  )
  const variants = [...routes]
    .filter(([, route]) => route.semanticTerminals.length > 0)
    .map(([variant]) => variant)
    .sort()
  compareExact(
    'configuration preset-lifecycle command routes',
    expectedVariants,
    variants,
    outputProblems,
  )
  const descriptor = findFunction(configurationSource, 'presetLifecycleOperationDescriptor')
  const descriptorCall = executableCalls(descriptor).find(
    (call) => call.expression.getText(configurationSource) === 'semanticOperationDescriptor',
  )
  const definition = semanticDescriptorDefinition(
    descriptorCall?.arguments[0] ? unwrap(descriptorCall.arguments[0]) : undefined,
    configurationSource,
  )
  const effects = objectPropertyInitializer(definition, 'effects')
  const physicalMutations = objectPropertyInitializer(definition, 'exactPhysicalMutations')
  const physicalReads = objectPropertyInitializer(definition, 'exactPhysicalReads')
  const resources = objectPropertyInitializer(definition, 'resources')
  const permittedWrites = objectPropertyInitializer(definition, 'permittedWrites')
  const exactReceiptFactory = typedExactReceiptFactoryFacts(
    definition,
    configurationSource,
    'presetLifecycleOperationExactPlan',
    'presetLifecycleOperationExactReceipt',
  )
  const exactDependencyText = findFunction(
    configurationSource,
    'presetLifecycleOperationDependencies',
  ).getText(configurationSource)
  const exactMutationText = findFunction(
    configurationSource,
    'presetLifecycleOperationPhysicalMutations',
  ).getText(configurationSource)
  const exactReadText = findFunction(
    configurationSource,
    'presetLifecycleOperationPhysicalReads',
  ).getText(configurationSource)
  const executorCalls = executableCalls(executor)
  const semanticCalls = executorCalls.filter(
    (call) =>
      callResolvesTo(checker, call, executeSemanticOperation) ||
      callResolvesTo(checker, call, semanticPortExecute),
  )
  const routeExecutorCalls = new Map(
    expectedVariants.map((variant) => [
      variant,
      reachableCallsResolvingTo(checker, [roots.get(variant)], executor),
    ]),
  )
  const routeText = expectedVariants
    .map((variant) => roots.get(variant).getText(configurationSource))
    .join('\n')
  const executorText = executor.getText(configurationSource)
  const transactionText = findFunction(configurationSource, 'presetLifecycleTransaction').getText(
    configurationSource,
  )
  const receiptText = findFunction(configurationSource, 'presetLifecycleOperationReceipt').getText(
    configurationSource,
  )
  const receiptAssertionText = findFunction(
    configurationSource,
    'assertPresetLifecycleOperationReceipt',
  ).getText(configurationSource)
  const transitionText = findFunction(
    catalogProjectionSource,
    'applyConfigurationPresetCatalogProjectionTransition',
  ).getText(catalogProjectionSource)
  const linkAdditionText = findFunction(byteOwnerSource, 'addLinkedSemanticByteOwner').getText(
    byteOwnerSource,
  )
  const linkReplacementText = findFunction(
    byteOwnerSource,
    'replaceLinkedSemanticByteOwner',
  ).getText(byteOwnerSource)
  const repoTransactionText = findMethod(
    browserRepoSource,
    'BrowserCommandCommit',
    'runTransaction',
  ).getText(browserRepoSource)
  const commonKernel = {
    nestedKindBound: browserRepoSource
      .getText()
      .includes('configurationSemanticOperationKind(command.input.kind)'),
    exactVariantsBound:
      objectPropertyInitializer(definition, 'operationKind')?.getText(configurationSource) ===
      'configurationSemanticOperationKind(operationKind)',
    descriptorTransactionBound:
      definition?.getText(configurationSource).includes('\n    transaction,') === true &&
      permittedWrites?.getText(configurationSource) === 'transaction.tableNames',
    exactTransactionTables:
      transactionText.includes('CONFIGURATION_LINK_MUTATION_TRANSACTION_CAPABILITY.tableNames') &&
      transactionText.includes('CONFIGURATION_PRESET_CATALOG_TRANSACTION_CAPABILITY.tableNames') &&
      transactionText.includes('PRESET_ORDER_MUTATION_TRANSACTION_CAPABILITY.tableNames') &&
      transactionText.includes('CHAT_ROW_LINKED_TRANSACTION_CAPABILITY.tableNames') &&
      transactionText.includes("operationKind === 'chat-preset.update'") &&
      transactionText.includes("operationKind === 'chat-preset.create'") &&
      transactionText.includes("operationKind === 'chat-preset.create-and-link'") &&
      transactionText.includes("operationKind === 'chat-preset.delete'") &&
      transactionText.includes("operationKind === 'chat-preset.save'"),
    exactIntentResources:
      resources?.getText(configurationSource).includes('resourceNames') === true &&
      !routeText.includes("'preset-catalog'"),
    exactEffects:
      (effects !== undefined &&
        validSemanticEffects(unwrap(effects)) &&
        effects
          .getText(configurationSource)
          .includes('workspaceDependenciesForConfigurationSemanticMutation') &&
        effects.getText(configurationSource).includes('receipt.links.profileUsageMutations') &&
        effects.getText(configurationSource).includes('receipt.order.changed') &&
        effects.getText(configurationSource).includes('linkedChatTransitionDependencies')) ||
      (exactReceiptFactory.contractBound &&
        exactDependencyText.includes('workspaceDependenciesForConfigurationSemanticMutation') &&
        exactDependencyText.includes('receipt.links.profileUsageMutations') &&
        exactDependencyText.includes('receipt.order.changed') &&
        exactDependencyText.includes('linkedChatTransitionDependencies')),
    exactReceiptWrites: [
      'receipt.links.removedLinkIds',
      'receipt.links.writtenLinkIds',
      'receipt.links.profileUsageMutations',
      'receipt.links.profileManagerRevisionChanged',
      'catalog.projection.projectionMutation',
      'receipt.order.mutations',
      'catalog?.order.mutations',
      'linkedChatTransitionPhysicalMutations',
    ].every(
      (value) =>
        physicalMutations?.getText(configurationSource).includes(value) === true ||
        exactMutationText.includes(value),
    ),
    exactBoundedReads: [
      'receipt.presetReadRequests',
      'receipt.profileReadRequests',
      'receipt.links.ownerQueryRequests',
      'receipt.links.profileUsageReadRequests',
      'receipt.links.profileManagerRevisionChanged',
      'receipt.order.reads',
      'receipt.catalog?.order.reads',
      'linkedChatTransitionPhysicalReads',
    ].every(
      (value) =>
        physicalReads?.getText(configurationSource).includes(value) === true ||
        exactReadText.includes(value),
    ),
    typedExactPlan:
      exactReceiptFactory.planBound &&
      hasTypedSingleAttemptReplayPlan(exactReceiptFactory.planText) &&
      exactReceiptFactory.receiptBound &&
      exactReceiptFactory.receiptText.includes('presetLifecycleOperationDependencies') &&
      exactReceiptFactory.receiptText.includes('presetLifecycleOperationPhysicalMutations') &&
      exactReceiptFactory.receiptText.includes('presetLifecycleOperationPhysicalReads'),
    executorConsumed: semanticCalls.length === 1,
    routeExecutorExact: [...routeExecutorCalls.values()].every((calls) => calls.length === 1),
    receiptBound:
      receiptText.includes('emptyConfigurationOwnerLinkMutationReceipt') &&
      receiptText.includes('emptyPresetOrderMutationReceipt') &&
      receiptText.includes('chatConfigurationOperationReceipt') &&
      receiptAssertionText.includes('receipt.catalog.projection') &&
      receiptAssertionText.includes('assertChatConfigurationOperationReceipt') &&
      expectedVariants.every((variant) => {
        const text = roots.get(variant).getText(configurationSource)
        return (
          text.includes('const operationKind = command.kind') &&
          text.includes('presetLifecycleOperationReceipt')
        )
      }),
    transactionLocalTransitions:
      routeText.includes('addLinkedSemanticByteOwner') &&
      routeText.includes('replaceLinkedSemanticByteOwner') &&
      routeText.includes('applyConfigurationPresetCatalogProjectionTransition') &&
      routeText.includes('selectedChatConfigurationTransition') &&
      routeText.includes('appendPresetOrderEntry') &&
      routeText.includes('removePresetOrderEntry') &&
      routeText.includes('applyConfigurationPresetCatalogProjectionDeletion') &&
      routeText.includes('readTargetLinksFromTransaction') &&
      routeText.includes('const chatMutation = openLinkedChatMutation(tx)') &&
      routeText.includes('chatMutation.readMany(') &&
      routeText.includes('chatMutation.replaceLinked(') &&
      routeText.includes('chatMutation.commit()') &&
      linkAdditionText.includes('ConfigurationOwnerLinkMutationReceipt') &&
      linkReplacementText.includes('ConfigurationOwnerLinkMutationReceipt') &&
      presetOrderSource.getText().includes('PresetOrderMutationReceipt'),
    projectionReadsSubtracted:
      !transitionText.includes('.table') && !transitionText.includes('.get('),
    noLegacyTerminal:
      !routeText.includes('executeDirectConfigurationTransaction') &&
      !routeText.includes('executeRevalidatedConfigurationPlan') &&
      !routeText.includes('readOwnerLinks(') &&
      !routeText.includes('readOwnerLinksFromTransaction(') &&
      !executorText.includes('.withLocks('),
    noBroadWork:
      !routeText.includes('.toCollection(') &&
      !routeText.includes('.toArray(') &&
      !routeText.includes('while (') &&
      !routeText.includes('setTimeout('),
    transactionLocalExactAssertions:
      repoTransactionText.includes('assertSemanticOperationExactInvalidations') &&
      repoTransactionText.includes('assertSemanticOperationExactPhysicalMutations') &&
      repoTransactionText.includes('assertSemanticOperationExactPhysicalReads'),
    readObservationOptIn: repoTransactionText.includes(
      'observePhysicalReads: semanticOperation?.descriptor.exactPhysicalReads !== undefined',
    ),
  }
  for (const [name, consumed] of Object.entries(commonKernel)) {
    if (!consumed) {
      outputProblems.push(`configuration preset-lifecycle common kernel missing ${name}`)
    }
  }
  const commonConsumed = Object.values(commonKernel).every(Boolean)
  const capabilities = {}
  const routeFacts = {}
  for (const variant of expectedVariants) {
    const route = routes.get(variant)
    const consumed =
      commonConsumed && route.semanticTerminals.length > 0 && route.legacyTerminals.length === 0
    if (route.legacyTerminals.length > 0) {
      outputProblems.push(
        `configuration preset-lifecycle ${variant}: legacy terminals ${route.legacyTerminals.join(', ')}`,
      )
    }
    capabilities[variant] = Object.freeze({
      path: CONFIGURATION_HANDLER_PATH,
      owner: 'executePresetLifecycleOperation',
      transaction: 'presetLifecycleTransaction',
      consumed,
      physicalWritesProved: true,
      exactPhysicalWritesProved: true,
      exactEffectsProved: true,
      tablesProved: true,
      boundsProved: true,
    })
    routeFacts[variant] = Object.freeze({
      entries: Object.freeze(route.entries),
      semanticTerminals: Object.freeze(route.semanticTerminals),
      legacyTerminals: Object.freeze(route.legacyTerminals),
      consumed,
    })
  }
  return Object.freeze({
    variants: Object.freeze(variants),
    routesByVariant: Object.freeze(routeFacts),
    commonKernel: Object.freeze(commonKernel),
    capabilities: Object.freeze(capabilities),
  })
}

function configurationChatSelectionCapabilityFacts(
  program,
  browserRepoSource,
  configurationSource,
  catalogProjectionSource,
  outputProblems,
) {
  const checker = program.getTypeChecker()
  const domainSource = exactSource(program, 'src/store/browser-domain-mutations.ts')
  const executor = findFunctionImplementation(configurationSource, 'executeChatSelectionOperation')
  const executeSemanticOperation = findMethod(
    browserRepoSource,
    'BrowserCommandCommit',
    'executeSemanticOperation',
  )
  const semanticPortExecute = findInterfaceMethod(
    domainSource,
    'BrowserSemanticCommandPort',
    'executeSemanticOperation',
  )
  const roots = configurationHandlerRoots(checker, configurationSource)
  const expectedVariants = [
    'chat-preset.apply',
    'prompt-preset.create-and-pin',
    'prompt-preset.load-and-pin',
    'text-template.create-and-select',
  ]
  const routes = new Map(
    expectedVariants.map((variant) => [
      variant,
      commandRouteFacts(checker, [roots.get(variant)], [executor]),
    ]),
  )
  const variants = [...routes]
    .filter(([, route]) => route.semanticTerminals.length > 0)
    .map(([variant]) => variant)
    .sort()
  compareExact(
    'configuration chat-selection command routes',
    expectedVariants,
    variants,
    outputProblems,
  )

  const descriptor = findFunction(configurationSource, 'chatSelectionOperationDescriptor')
  const descriptorCall = executableCalls(descriptor).find(
    (call) => call.expression.getText(configurationSource) === 'semanticOperationDescriptor',
  )
  const definition = semanticDescriptorDefinition(
    descriptorCall?.arguments[0] ? unwrap(descriptorCall.arguments[0]) : undefined,
    configurationSource,
  )
  const effects = objectPropertyInitializer(definition, 'effects')
  const physicalMutations = objectPropertyInitializer(definition, 'exactPhysicalMutations')
  const physicalReads = objectPropertyInitializer(definition, 'exactPhysicalReads')
  const resources = objectPropertyInitializer(definition, 'resources')
  const permittedWrites = objectPropertyInitializer(definition, 'permittedWrites')
  const exactReceiptFactory = typedExactReceiptFactoryFacts(
    definition,
    configurationSource,
    'chatSelectionOperationExactPlan',
    'chatSelectionOperationExactReceipt',
  )
  const executorCalls = executableCalls(executor)
  const semanticCalls = executorCalls.filter(
    (call) =>
      callResolvesTo(checker, call, executeSemanticOperation) ||
      callResolvesTo(checker, call, semanticPortExecute),
  )
  const routeExecutorCalls = new Map(
    expectedVariants.map((variant) => [
      variant,
      reachableCallsResolvingTo(checker, [roots.get(variant)], executor),
    ]),
  )
  const routeText = expectedVariants
    .map((variant) => roots.get(variant).getText(configurationSource))
    .join('\n')
  const descriptorText = descriptor.getText(configurationSource)
  const executorText = executor.getText(configurationSource)
  const transactionText = findFunction(
    configurationSource,
    'chatSelectionOperationTransaction',
  ).getText(configurationSource)
  const requiredWritesText = findFunction(
    configurationSource,
    'chatSelectionRequiredWrites',
  ).getText(configurationSource)
  const receiptText = findFunction(configurationSource, 'chatSelectionOperationReceipt').getText(
    configurationSource,
  )
  const receiptAssertionText = findFunction(
    configurationSource,
    'assertChatSelectionOperationReceipt',
  ).getText(configurationSource)
  const selectedChatTransitionText = findFunction(
    configurationSource,
    'selectedChatConfigurationTransition',
  ).getText(configurationSource)
  const recencyProjectionText = findFunction(
    catalogProjectionSource,
    'applyConfigurationPromptPresetRecencyCatalogProjectionTransition',
  ).getText(catalogProjectionSource)
  const catalogProjectionText = findFunction(
    catalogProjectionSource,
    'applyConfigurationPromptPresetCatalogProjectionTransition',
  ).getText(catalogProjectionSource)
  const repoTransactionText = findMethod(
    browserRepoSource,
    'BrowserCommandCommit',
    'runTransaction',
  ).getText(browserRepoSource)
  const physicalMutationText = physicalMutations?.getText(configurationSource) ?? ''
  const physicalReadText = physicalReads?.getText(configurationSource) ?? ''
  const chatResourceFragment = '`chat-meta:$' + '{command.chatId}`'
  const expectedRouteResources = new Map([
    ['chat-preset.apply', [chatResourceFragment, '`preset:$' + '{command.presetId}`']],
    [
      'prompt-preset.create-and-pin',
      [
        chatResourceFragment,
        "configurationTargetResourceName('prompt-preset', command.preset.id)",
        '`prompt-preset:$' + '{command.preset.id}`',
      ],
    ],
    [
      'prompt-preset.load-and-pin',
      [
        chatResourceFragment,
        "configurationTargetResourceName('prompt-preset', command.presetId)",
        '`prompt-preset:$' + '{command.presetId}`',
      ],
    ],
    [
      'text-template.create-and-select',
      [
        chatResourceFragment,
        "configurationTargetResourceName('text-template', command.template.id)",
      ],
    ],
  ])
  const commonKernel = {
    nestedKindBound: browserRepoSource
      .getText()
      .includes('configurationSemanticOperationKind(command.input.kind)'),
    exactVariantsBound:
      objectPropertyInitializer(definition, 'operationKind')?.getText(configurationSource) ===
      'configurationSemanticOperationKind(operationKind)',
    descriptorTransactionBound:
      definition?.getText(configurationSource).includes('\n    transaction,') === true &&
      permittedWrites?.getText(configurationSource) === 'transaction.tableNames',
    exactTransactionTables:
      transactionText.includes('CHAT_ROW_LINKED_TRANSACTION_CAPABILITY.tableNames') &&
      transactionText.includes('CONFIGURATION_PROMPT_PRESET_RECENCY_TRANSACTION_CAPABILITY') &&
      transactionText.includes('CONFIGURATION_PROMPT_PRESET_CATALOG_TRANSACTION_CAPABILITY') &&
      ["'textTemplates'", "'presets'", "'promptPresets'"].every((name) =>
        transactionText.includes(name),
      ),
    exactRequiredWrites:
      ["'textTemplates'", "'chats'", "'chatSidebarRows'", "'promptPresets'"].every((name) =>
        requiredWritesText.includes(name),
      ) &&
      requiredWritesText.includes("'configurationPromptPresetCatalogRows'") &&
      requiredWritesText.includes("'configurationCatalogAggregates'"),
    exactIntentResources:
      resources?.getText(configurationSource).includes('resourceNames') === true &&
      [...expectedRouteResources].every(([variant, fragments]) => {
        const text = roots.get(variant).getText(configurationSource)
        return fragments.every((fragment) => text.includes(fragment))
      }),
    exactEffects:
      (effects !== undefined &&
        validSemanticEffects(unwrap(effects)) &&
        descriptorText.includes('ChatSelectionOperationReceipt') &&
        descriptorText.includes('workspaceDependenciesForConfigurationSemanticMutation') &&
        descriptorText.includes('linkedChatTransitionDependencies') &&
        descriptorText.includes("receipt.sourceTable === 'textTemplates'")) ||
      (exactReceiptFactory.contractBound &&
        exactReceiptFactory.receiptText.includes(
          'workspaceDependenciesForConfigurationSemanticMutation',
        ) &&
        exactReceiptFactory.receiptText.includes('linkedChatTransitionDependencies') &&
        exactReceiptFactory.receiptText.includes("receipt.sourceTable === 'textTemplates'")),
    exactReceiptWrites: [
      'receipt.sourceMutation',
      'receipt.sourceTable',
      'projection?.projectionMutation',
      'projection?.aggregateIds',
      'linkedChatTransitionPhysicalMutations',
    ].every(
      (value) =>
        physicalMutationText.includes(value) || exactReceiptFactory.receiptText.includes(value),
    ),
    exactBoundedReads: [
      "tableName: 'chats'",
      'tableName: receipt.sourceTable',
      'projection.aggregateIds.length',
      'linkedChatTransitionPhysicalReads',
    ].every(
      (value) =>
        physicalReadText.includes(value) || exactReceiptFactory.receiptText.includes(value),
    ),
    typedExactPlan:
      exactReceiptFactory.planBound &&
      hasTypedSingleAttemptReplayPlan(exactReceiptFactory.planText) &&
      exactReceiptFactory.planText.includes('maxRequests: 40') &&
      exactReceiptFactory.planText.includes('maxRows: 50') &&
      exactReceiptFactory.receiptBound,
    executorConsumed:
      semanticCalls.length === 1 &&
      semanticCalls[0]?.arguments[0]?.getText(configurationSource) ===
        'chatSelectionOperationDescriptor(operationKind)',
    routeExecutorExact: [...routeExecutorCalls.values()].every((calls) => calls.length === 1),
    receiptBound:
      receiptText.includes('chatSelectionSourceTable(operationKind)') &&
      receiptText.includes('chatConfigurationOperationReceipt(undefined, undefined)') &&
      receiptAssertionText.includes('assertChatConfigurationOperationReceipt') &&
      receiptAssertionText.includes('receipt.sourceMutation') &&
      receiptAssertionText.includes('receipt.projection'),
    transactionLocalTransitions:
      routeText.includes('const chatMutation = openLinkedChatMutation(tx)') &&
      routeText.includes('chatMutation.read(command.chatId)') &&
      routeText.includes('selectedChatConfigurationTransition') &&
      routeText.includes('applyConfigurationPromptPresetRecencyCatalogProjectionTransition') &&
      routeText.includes('applyConfigurationPromptPresetCatalogProjectionTransition') &&
      selectedChatTransitionText.includes(
        'chatMutation.replaceLinked(current.id, () => written)',
      ) &&
      selectedChatTransitionText.includes('const transition = await chatMutation.commit()'),
    projectionReadsSubtracted:
      !recencyProjectionText.includes('.table') &&
      !recencyProjectionText.includes('.get(') &&
      !catalogProjectionText.includes('.table') &&
      !catalogProjectionText.includes('.get('),
    noLegacyTerminal:
      !routeText.includes('mutateChatConfigurationWithTables') &&
      !routeText.includes('executeRevalidatedConfigurationPlan') &&
      !routeText.includes('readOwnerLinks(') &&
      !routeText.includes('readOwnerLinksFromTransaction(') &&
      !executorText.includes('.withLocks('),
    noBroadWork:
      !routeText.includes('.toCollection(') &&
      !routeText.includes('.toArray(') &&
      !routeText.includes('while (') &&
      !routeText.includes('setTimeout('),
    transactionLocalExactAssertions:
      repoTransactionText.includes('assertSemanticOperationExactInvalidations') &&
      repoTransactionText.includes('assertSemanticOperationExactPhysicalMutations') &&
      repoTransactionText.includes('assertSemanticOperationExactPhysicalReads'),
    readObservationOptIn: repoTransactionText.includes(
      'observePhysicalReads: semanticOperation?.descriptor.exactPhysicalReads !== undefined',
    ),
  }
  for (const [name, consumed] of Object.entries(commonKernel)) {
    if (!consumed) {
      outputProblems.push(`configuration chat-selection common kernel missing ${name}`)
    }
  }
  const commonConsumed = Object.values(commonKernel).every(Boolean)
  const capabilities = {}
  const routeFacts = {}
  for (const variant of expectedVariants) {
    const route = routes.get(variant)
    const consumed =
      commonConsumed && route.semanticTerminals.length > 0 && route.legacyTerminals.length === 0
    if (route.legacyTerminals.length > 0) {
      outputProblems.push(
        `configuration chat-selection ${variant}: legacy terminals ${route.legacyTerminals.join(', ')}`,
      )
    }
    capabilities[variant] = Object.freeze({
      path: CONFIGURATION_HANDLER_PATH,
      owner: 'executeChatSelectionOperation',
      transaction: 'chatSelectionOperationTransaction',
      consumed,
      physicalWritesProved: true,
      exactPhysicalWritesProved: true,
      exactEffectsProved: true,
      tablesProved: true,
      boundsProved: true,
    })
    routeFacts[variant] = Object.freeze({
      entries: Object.freeze(route.entries),
      semanticTerminals: Object.freeze(route.semanticTerminals),
      legacyTerminals: Object.freeze(route.legacyTerminals),
      consumed,
    })
  }
  return Object.freeze({
    variants: Object.freeze(variants),
    routesByVariant: Object.freeze(routeFacts),
    commonKernel: Object.freeze(commonKernel),
    capabilities: Object.freeze(capabilities),
  })
}

function configurationChatRequestTargetCapabilityFacts(
  program,
  browserRepoSource,
  configurationSource,
  catalogProjectionSource,
  outputProblems,
) {
  const checker = program.getTypeChecker()
  const domainSource = exactSource(program, 'src/store/browser-domain-mutations.ts')
  const executor = findFunctionImplementation(
    configurationSource,
    'executeChatRequestTargetOperation',
  )
  const executeSemanticOperation = findMethod(
    browserRepoSource,
    'BrowserCommandCommit',
    'executeSemanticOperation',
  )
  const semanticPortExecute = findInterfaceMethod(
    domainSource,
    'BrowserSemanticCommandPort',
    'executeSemanticOperation',
  )
  const roots = configurationHandlerRoots(checker, configurationSource)
  const expectedVariants = ['chat.resolve-model', 'chat.switch-profile']
  const routes = new Map(
    expectedVariants.map((variant) => [
      variant,
      commandRouteFacts(checker, [roots.get(variant)], [executor]),
    ]),
  )
  const variants = [...routes]
    .filter(([, route]) => route.semanticTerminals.length > 0)
    .map(([variant]) => variant)
    .sort()
  compareExact(
    'configuration chat-request-target command routes',
    expectedVariants,
    variants,
    outputProblems,
  )

  const descriptor = findFunction(configurationSource, 'chatRequestTargetOperationDescriptor')
  const descriptorCall = executableCalls(descriptor).find(
    (call) => call.expression.getText(configurationSource) === 'semanticOperationDescriptor',
  )
  const definition = semanticDescriptorDefinition(
    descriptorCall?.arguments[0] ? unwrap(descriptorCall.arguments[0]) : undefined,
    configurationSource,
  )
  const effects = objectPropertyInitializer(definition, 'effects')
  const physicalMutations = objectPropertyInitializer(definition, 'exactPhysicalMutations')
  const physicalReads = objectPropertyInitializer(definition, 'exactPhysicalReads')
  const resources = objectPropertyInitializer(definition, 'resources')
  const permittedWrites = objectPropertyInitializer(definition, 'permittedWrites')
  const exactReceiptFactory = typedExactReceiptFactoryFacts(
    definition,
    configurationSource,
    'chatRequestTargetOperationExactPlan',
    'chatRequestTargetOperationExactReceipt',
  )
  const executorCalls = executableCalls(executor)
  const semanticCalls = executorCalls.filter(
    (call) =>
      callResolvesTo(checker, call, executeSemanticOperation) ||
      callResolvesTo(checker, call, semanticPortExecute),
  )
  const routeExecutorCalls = new Map(
    expectedVariants.map((variant) => [
      variant,
      reachableCallsResolvingTo(checker, [roots.get(variant)], executor),
    ]),
  )
  const routeText = expectedVariants
    .map((variant) => roots.get(variant).getText(configurationSource))
    .join('\n')
  const descriptorText = descriptor.getText(configurationSource)
  const executorText = executor.getText(configurationSource)
  const transactionText = findFunction(
    configurationSource,
    'chatRequestTargetOperationTransaction',
  ).getText(configurationSource)
  const resourceText = findFunction(configurationSource, 'chatRequestTargetResourceNames').getText(
    configurationSource,
  )
  const receiptText = findFunction(
    configurationSource,
    'chatRequestTargetOperationReceipt',
  ).getText(configurationSource)
  const receiptAssertionText = findFunction(
    configurationSource,
    'assertChatRequestTargetOperationReceipt',
  ).getText(configurationSource)
  const selectedChatTransitionText = findFunction(
    configurationSource,
    'selectedChatConfigurationTransition',
  ).getText(configurationSource)
  const profileProjectionText = findFunction(
    catalogProjectionSource,
    'applyConfigurationProfileCatalogProjectionTransition',
  ).getText(catalogProjectionSource)
  const repoTransactionText = findMethod(
    browserRepoSource,
    'BrowserCommandCommit',
    'runTransaction',
  ).getText(browserRepoSource)
  const physicalMutationText = physicalMutations?.getText(configurationSource) ?? ''
  const physicalReadText = physicalReads?.getText(configurationSource) ?? ''
  const commonKernel = {
    nestedKindBound: browserRepoSource
      .getText()
      .includes('configurationSemanticOperationKind(command.input.kind)'),
    exactVariantsBound:
      objectPropertyInitializer(definition, 'operationKind')?.getText(configurationSource) ===
      'configurationSemanticOperationKind(operationKind)',
    descriptorTransactionBound:
      definition?.getText(configurationSource).includes('\n    transaction,') === true &&
      permittedWrites?.getText(configurationSource) === 'transaction.tableNames',
    exactTransactionTables:
      transactionText.includes('CHAT_ROW_LINKED_TRANSACTION_CAPABILITY.tableNames') &&
      transactionText.includes('CONFIGURATION_PROFILE_CATALOG_TRANSACTION_CAPABILITY') &&
      transactionText.includes("'keys'") &&
      transactionText.includes("'profiles'"),
    exactIntentResources:
      resources?.getText(configurationSource) === 'chatRequestTargetResourceNames' &&
      [
        '`chat-meta:$' + '{input.chatId}`',
        '`profile:$' + '{input.profileId}`',
        "configurationTargetKey('profile', profileId)",
        "configurationTargetKey('key', input.requestKeyId)",
        "configurationTargetKey(\n          'model-resolution'",
      ].every((fragment) => resourceText.includes(fragment)),
    exactEphemeralTarget:
      routeText.includes('command.requestKeyId') &&
      routeText.includes('command.previousProfileId') &&
      routeText.includes('command.previousModelResolutionTarget') &&
      routeText.includes('configurationRequestRevisionFor(currentProfile, currentKey)'),
    exactEffects:
      (effects !== undefined &&
        validSemanticEffects(unwrap(effects)) &&
        descriptorText.includes('ChatRequestTargetOperationReceipt') &&
        descriptorText.includes('linkedChatTransitionDependencies') &&
        descriptorText.includes('workspaceDependenciesForConfigurationSemanticMutation')) ||
      (exactReceiptFactory.contractBound &&
        exactReceiptFactory.receiptText.includes('linkedChatTransitionDependencies') &&
        exactReceiptFactory.receiptText.includes(
          'workspaceDependenciesForConfigurationSemanticMutation',
        )),
    exactReceiptWrites: [
      'linkedChatTransitionPhysicalMutations',
      'receipt.profileMutation',
      'projection?.projectionMutation',
      'projection?.aggregateIds',
    ].every(
      (fragment) =>
        physicalMutationText.includes(fragment) ||
        exactReceiptFactory.receiptText.includes(fragment),
    ),
    exactBoundedReads: [
      "tableName: 'chats'",
      "tableName: 'profiles'",
      "tableName: 'keys'",
      'projection.aggregateIds.length',
      'linkedChatTransitionPhysicalReads',
      'aggregateExactPhysicalReads',
    ].every(
      (fragment) =>
        physicalReadText.includes(fragment) || exactReceiptFactory.receiptText.includes(fragment),
    ),
    typedExactPlan:
      exactReceiptFactory.planBound &&
      hasTypedSingleAttemptReplayPlan(exactReceiptFactory.planText) &&
      exactReceiptFactory.planText.includes('maxRequests: 40') &&
      exactReceiptFactory.planText.includes('maxRows: 50') &&
      exactReceiptFactory.receiptBound,
    executorConsumed:
      semanticCalls.length === 1 &&
      semanticCalls[0]?.arguments[0]?.getText(configurationSource) ===
        'chatRequestTargetOperationDescriptor(operationKind, input)',
    routeExecutorExact: [...routeExecutorCalls.values()].every((calls) => calls.length === 1),
    receiptBound:
      receiptText.includes('ChatRequestTargetOperationReceipt') &&
      receiptAssertionText.includes('assertChatConfigurationOperationReceipt') &&
      receiptAssertionText.includes('configurationLinksForProfile') &&
      receiptAssertionText.includes('receipt.profileProjection'),
    transactionLocalTransitions:
      routeText.includes('const chatMutation = openLinkedChatMutation(tx)') &&
      routeText.includes('chatMutation.read(command.chatId)') &&
      routeText.includes("tx.table<ConnectionProfile, ProfileId>('profiles').get") &&
      routeText.includes("tx.table<KeyRecord, KeyId>('keys').get") &&
      routeText.includes('selectedChatConfigurationTransition') &&
      routeText.includes('replaceLinkedSemanticByteOwnerPreservingLinksBatch') &&
      routeText.includes('applyConfigurationProfileCatalogProjectionTransition') &&
      selectedChatTransitionText.includes(
        'chatMutation.replaceLinked(current.id, () => written)',
      ) &&
      selectedChatTransitionText.includes('const transition = await chatMutation.commit()'),
    projectionReadsSubtracted:
      !profileProjectionText.includes('.table') && !profileProjectionText.includes('.get('),
    noLegacyTerminal:
      !routeText.includes('planConfigurationRequestTarget') &&
      !routeText.includes('revalidateConfigurationRequestTarget') &&
      !routeText.includes('executeRevalidatedConfigurationPlan') &&
      !routeText.includes('readOwnerLinks(') &&
      !routeText.includes('readOwnerLinksFromTransaction(') &&
      !executorText.includes('.withLocks('),
    noBroadWork:
      !routeText.includes('.toCollection(') &&
      !routeText.includes('.toArray(') &&
      !routeText.includes('while (') &&
      !routeText.includes('for (') &&
      !routeText.includes('setTimeout('),
    transactionLocalExactAssertions:
      repoTransactionText.includes('assertSemanticOperationExactInvalidations') &&
      repoTransactionText.includes('assertSemanticOperationExactPhysicalMutations') &&
      repoTransactionText.includes('assertSemanticOperationExactPhysicalReads'),
    readObservationOptIn: repoTransactionText.includes(
      'observePhysicalReads: semanticOperation?.descriptor.exactPhysicalReads !== undefined',
    ),
  }
  for (const [name, consumed] of Object.entries(commonKernel)) {
    if (!consumed) {
      outputProblems.push(`configuration chat-request-target common kernel missing ${name}`)
    }
  }
  const commonConsumed = Object.values(commonKernel).every(Boolean)
  const capabilities = {}
  const routeFacts = {}
  for (const variant of expectedVariants) {
    const route = routes.get(variant)
    const consumed =
      commonConsumed && route.semanticTerminals.length > 0 && route.legacyTerminals.length === 0
    if (route.legacyTerminals.length > 0) {
      outputProblems.push(
        `configuration chat-request-target ${variant}: legacy terminals ${route.legacyTerminals.join(', ')}`,
      )
    }
    capabilities[variant] = Object.freeze({
      path: CONFIGURATION_HANDLER_PATH,
      owner: 'executeChatRequestTargetOperation',
      transaction: 'chatRequestTargetOperationTransaction',
      consumed,
      physicalWritesProved: true,
      exactPhysicalWritesProved: true,
      exactEffectsProved: true,
      tablesProved: true,
      boundsProved: true,
    })
    routeFacts[variant] = Object.freeze({
      entries: Object.freeze(route.entries),
      semanticTerminals: Object.freeze(route.semanticTerminals),
      legacyTerminals: Object.freeze(route.legacyTerminals),
      consumed,
    })
  }
  return Object.freeze({
    variants: Object.freeze(variants),
    routesByVariant: Object.freeze(routeFacts),
    commonKernel: Object.freeze(commonKernel),
    capabilities: Object.freeze(capabilities),
  })
}

function configurationTargetFanoutCapabilityFacts(
  program,
  browserRepoSource,
  configurationSource,
  catalogProjectionSource,
  outputProblems,
) {
  const checker = program.getTypeChecker()
  const domainSource = exactSource(program, 'src/store/browser-domain-mutations.ts')
  const mutationJournalSource = exactSource(program, MUTATION_JOURNAL_PATH)
  const executor = findFunctionImplementation(
    configurationSource,
    'executeConfigurationTargetFanoutOperation',
  )
  const commit = findFunctionImplementation(
    configurationSource,
    'commitConfigurationTargetFanoutOperation',
  )
  const executeSemanticOperation = findMethod(
    browserRepoSource,
    'BrowserCommandCommit',
    'executeSemanticOperation',
  )
  const semanticPortExecute = findInterfaceMethod(
    domainSource,
    'BrowserSemanticCommandPort',
    'executeSemanticOperation',
  )
  const roots = configurationHandlerRoots(checker, configurationSource)
  const expectedVariants = [
    'prompt-preset.delete',
    'prompt-preset.overwrite-and-pin',
    'text-template.delete',
  ]
  const routes = new Map(
    expectedVariants.map((variant) => [
      variant,
      commandRouteFacts(checker, [roots.get(variant)], [executor]),
    ]),
  )
  const variants = [...routes]
    .filter(([, route]) => route.semanticTerminals.length > 0)
    .map(([variant]) => variant)
    .sort()
  compareExact(
    'configuration target-fanout command routes',
    expectedVariants,
    variants,
    outputProblems,
  )

  const descriptor = findFunction(
    configurationSource,
    'configurationTargetFanoutOperationDescriptor',
  )
  const descriptorCall = executableCalls(descriptor).find(
    (call) => call.expression.getText(configurationSource) === 'semanticOperationDescriptor',
  )
  const definition = semanticDescriptorDefinition(
    descriptorCall?.arguments[0] ? unwrap(descriptorCall.arguments[0]) : undefined,
    configurationSource,
  )
  const effects = objectPropertyInitializer(definition, 'effects')
  const physicalMutations = objectPropertyInitializer(definition, 'exactPhysicalMutations')
  const physicalReads = objectPropertyInitializer(definition, 'exactPhysicalReads')
  const resources = objectPropertyInitializer(definition, 'resources')
  const permittedWrites = objectPropertyInitializer(definition, 'permittedWrites')
  const exactReceiptFactory = typedExactReceiptFactoryFacts(
    definition,
    configurationSource,
    'configurationTargetFanoutOperationExactPlan',
    'configurationTargetFanoutOperationExactReceipt',
  )
  const executorCalls = executableCalls(executor)
  const semanticCalls = executorCalls.filter(
    (call) =>
      callResolvesTo(checker, call, executeSemanticOperation) ||
      callResolvesTo(checker, call, semanticPortExecute),
  )
  const routeExecutorCalls = new Map(
    expectedVariants.map((variant) => [
      variant,
      reachableCallsResolvingTo(checker, [roots.get(variant)], executor),
    ]),
  )
  const routeText = expectedVariants
    .map((variant) => roots.get(variant).getText(configurationSource))
    .join('\n')
  const descriptorText = descriptor.getText(configurationSource)
  const executorText = executor.getText(configurationSource)
  const commitText = commit.getText(configurationSource)
  const textTemplateCommitText = findFunction(
    configurationSource,
    'commitTextTemplateTargetFanout',
  ).getText(configurationSource)
  const familyText = [routeText, executorText, commitText, textTemplateCommitText].join('\n')
  const transactionText = findFunction(
    configurationSource,
    'configurationTargetFanoutOperationTransaction',
  ).getText(configurationSource)
  const receiptText = findFunction(
    configurationSource,
    'configurationTargetFanoutOperationReceipt',
  ).getText(configurationSource)
  const receiptAssertionText = findFunction(
    configurationSource,
    'assertConfigurationTargetFanoutOperationReceipt',
  ).getText(configurationSource)
  const receiptCompilerText = findFunction(
    configurationSource,
    'configurationTargetFanoutOperationReceiptCompiler',
  ).getText(configurationSource)
  const promptResourceFragment = '`prompt-preset:$' + '{sourceId}`'
  const chatResourceFragment = '`chat-meta:$' + '{selectedChatId}`'
  const deletionProjectionText = findFunction(
    catalogProjectionSource,
    'applyConfigurationPromptPresetCatalogProjectionDeletion',
  ).getText(catalogProjectionSource)
  const transitionProjectionText = findFunction(
    catalogProjectionSource,
    'applyConfigurationPromptPresetCatalogProjectionTransition',
  ).getText(catalogProjectionSource)
  const repoTransactionText = findMethod(
    browserRepoSource,
    'BrowserCommandCommit',
    'runTransaction',
  ).getText(browserRepoSource)
  const physicalMutationText = physicalMutations?.getText(configurationSource) ?? ''
  const physicalReadText = physicalReads?.getText(configurationSource) ?? ''
  const commonKernel = {
    nestedKindBound: browserRepoSource
      .getText()
      .includes('configurationSemanticOperationKind(command.input.kind)'),
    exactVariantsBound:
      objectPropertyInitializer(definition, 'operationKind')?.getText(configurationSource) ===
      'configurationSemanticOperationKind(input.operationKind)',
    descriptorTransactionBound:
      definition?.getText(configurationSource).includes('\n    transaction,') === true &&
      permittedWrites?.getText(configurationSource) === 'transaction.tableNames',
    exactTransactionTables:
      transactionText.includes('CHAT_ROW_LINKED_TRANSACTION_CAPABILITY.tableNames') &&
      transactionText.includes('CONFIGURATION_PROMPT_PRESET_CATALOG_TRANSACTION_CAPABILITY') &&
      transactionText.includes("'presets'") &&
      transactionText.includes("'promptPresets'") &&
      !transactionText.includes('textMayChange'),
    exactIntentResources:
      resources
        ?.getText(configurationSource)
        .includes('configurationTargetResourceName(sourceKind, sourceId)') === true &&
      resources.getText(configurationSource).includes(promptResourceFragment) &&
      resources.getText(configurationSource).includes(chatResourceFragment) &&
      !resources.getText(configurationSource).includes('configurationOwnerLockName'),
    exactEffects:
      (effects !== undefined &&
        validSemanticEffects(unwrap(effects)) &&
        descriptorText.includes('ConfigurationTargetFanoutOperationReceipt') &&
        descriptorText.includes('workspaceDependenciesForConfigurationSemanticMutation') &&
        descriptorText.includes('linkedChatTransitionsDependencies') &&
        descriptorText.includes('receipt.presetLinks.profileUsageMutations')) ||
      (exactReceiptFactory.contractBound &&
        receiptCompilerText.includes('workspaceDependenciesForConfigurationSemanticMutation') &&
        receiptCompilerText.includes('linkedChatTransitionsDependencies') &&
        receiptCompilerText.includes('receipt.presetLinks.profileUsageMutations')),
    exactReceiptWrites: [
      'receipt.sourceMutation',
      'projection?.projectionMutation',
      'projection?.aggregateIds',
      'receipt.nextPresets',
      'receipt.presetLinks.removedLinkIds',
      'receipt.presetLinks.writtenLinkIds',
      'linkedChatTransitionsPhysicalMutations',
    ].every(
      (fragment) =>
        physicalMutationText.includes(fragment) || receiptCompilerText.includes(fragment),
    ),
    exactPhysicalReadShape: [
      "'promptPresets'",
      "'textTemplates'",
      'receipt.targetQueryExecuted',
      "indexName: 'targetKey'",
      'receipt.chatReadIds.length',
      'receipt.presetReadIds.length',
      'receipt.presetLinks.ownerQueryRequests',
      'linkedChatTransitionPhysicalReads',
      'aggregateExactPhysicalReads',
    ].every(
      (fragment) => physicalReadText.includes(fragment) || receiptCompilerText.includes(fragment),
    ),
    typedExactPlan:
      exactReceiptFactory.planBound &&
      hasTypedSingleAttemptReplayPlan(exactReceiptFactory.planText) &&
      exactReceiptFactory.planText.match(/maxRequests: Number\.MAX_SAFE_INTEGER/g)?.length === 1 &&
      exactReceiptFactory.planText.match(/maxRows: Number\.MAX_SAFE_INTEGER/g)?.length === 1 &&
      exactReceiptFactory.planText.match(/maxBatchRows: Number\.MAX_SAFE_INTEGER/g)?.length === 1 &&
      exactReceiptFactory.planText.match(/maxBytes: Number\.MAX_SAFE_INTEGER/g)?.length === 1 &&
      !exactReceiptFactory.planText.includes('textMayChange') &&
      exactReceiptFactory.receiptBound &&
      exactReceiptFactory.receiptText.includes('configurationTargetFanoutOperationReceiptCompiler'),
    executorConsumed:
      semanticCalls.length === 1 &&
      semanticCalls[0]?.arguments[0]?.getText(configurationSource) ===
        'configurationTargetFanoutOperationDescriptor(input)',
    routeExecutorExact: [...routeExecutorCalls.values()].every((calls) => calls.length === 1),
    receiptBound:
      receiptText.includes('emptyConfigurationOwnerLinkMutationReceipt') &&
      receiptAssertionText.includes('receipt.targetLinkIds') &&
      receiptAssertionText.includes('removedTargetLinks') &&
      receiptAssertionText.includes('receipt.sourceProjection') &&
      receiptAssertionText.includes('receipt.chats.sidebar.mutatedRowIds'),
    transactionLocalTransitions:
      commitText.includes('readTargetLinksFromTransaction') &&
      commitText.includes('const chatMutation = openLinkedChatMutation(tx)') &&
      commitText.includes('chatMutation.readMany(chatReadIds)') &&
      commitText.includes("tx.table<ChatPreset, PresetId>('presets').bulkGet(presetReadIds)") &&
      commitText.includes('replaceLinkedSemanticByteOwnerBatch') &&
      commitText.includes('chatMutation.replaceLinked(previous.id, () => next)') &&
      commitText.includes('chatMutation.commit()') &&
      commitText.includes('applyConfigurationPromptPresetCatalogProjectionTransition') &&
      commitText.includes('applyConfigurationPromptPresetCatalogProjectionDeletion') &&
      textTemplateCommitText.includes('deleteTextTemplateByteOwner'),
    projectionReadsSubtracted:
      !deletionProjectionText.includes('.table') &&
      !deletionProjectionText.includes('.get(') &&
      !transitionProjectionText.includes('.table') &&
      !transitionProjectionText.includes('.get('),
    noLegacyTerminal:
      !familyText.includes('mutatePromptTargetLinks') &&
      !familyText.includes('executeRevalidatedConfigurationPlan') &&
      !familyText.includes('configurationOwnerLockName') &&
      !familyText.includes('.withLocks('),
    noBroadWork:
      !familyText.includes('.toCollection(') &&
      !familyText.includes('.toArray(') &&
      !familyText.includes('while (') &&
      !familyText.includes('setTimeout('),
    transactionLocalExactAssertions:
      repoTransactionText.includes('assertSemanticOperationExactInvalidations') &&
      repoTransactionText.includes('assertSemanticOperationExactPhysicalMutations') &&
      repoTransactionText.includes('assertSemanticOperationExactPhysicalReads'),
    readObservationOptIn: repoTransactionText.includes(
      'observePhysicalReads: semanticOperation?.descriptor.exactPhysicalReads !== undefined',
    ),
    finalizationFanoutAdmitted:
      mutationJournalSource.getText().includes("journal.physicalReadPhase = 'finalization'") &&
      !mutationJournalSource
        .getText()
        .includes("tx.table<Chat, ChatId>('chats').bulkGet(chatIds)") &&
      mutationJournalSource.getText().includes('finalChatById: Map<ChatId, Chat | null>') &&
      mutationJournalSource.getText().includes('requiredFinalChatState(journal, chatId)') &&
      mutationJournalSource.getText().includes('chat ? structuredClone(chat) : null') &&
      mutationJournalSource.getText().includes('finalizationPhysicalReads'),
  }
  for (const [name, consumed] of Object.entries(commonKernel)) {
    if (!consumed) {
      outputProblems.push(`configuration target-fanout common kernel missing ${name}`)
    }
  }
  const commonConsumed = Object.values(commonKernel).every(Boolean)
  const capabilities = {}
  const routeFacts = {}
  for (const variant of expectedVariants) {
    const route = routes.get(variant)
    const consumed =
      commonConsumed && route.semanticTerminals.length > 0 && route.legacyTerminals.length === 0
    if (route.legacyTerminals.length > 0) {
      outputProblems.push(
        `configuration target-fanout ${variant}: legacy terminals ${route.legacyTerminals.join(', ')}`,
      )
    }
    capabilities[variant] = Object.freeze({
      path: CONFIGURATION_HANDLER_PATH,
      owner: 'executeConfigurationTargetFanoutOperation',
      transaction: 'configurationTargetFanoutOperationTransaction',
      consumed,
      physicalWritesProved: true,
      exactPhysicalWritesProved: true,
      exactEffectsProved: true,
      tablesProved: true,
      boundsProved: false,
      boundsDisposition: 'admitted-atomic-target-fanout',
    })
    routeFacts[variant] = Object.freeze({
      entries: Object.freeze(route.entries),
      semanticTerminals: Object.freeze(route.semanticTerminals),
      legacyTerminals: Object.freeze(route.legacyTerminals),
      consumed,
    })
  }
  return Object.freeze({
    variants: Object.freeze(variants),
    routesByVariant: Object.freeze(routeFacts),
    commonKernel: Object.freeze(commonKernel),
    capabilities: Object.freeze(capabilities),
  })
}

function configurationConnectionLifecycleCapabilityFacts(
  program,
  browserRepoSource,
  configurationSource,
  outputProblems,
) {
  const checker = program.getTypeChecker()
  const domainSource = exactSource(program, 'src/store/browser-domain-mutations.ts')
  const executor = findFunctionImplementation(
    configurationSource,
    'executeConnectionProfileLifecycleOperation',
  )
  const commit = findFunctionImplementation(
    configurationSource,
    'commitConnectionProfileLifecycleOperation',
  )
  const createCommit = findFunctionImplementation(
    configurationSource,
    'commitConnectionCreateOperation',
  )
  const editCommit = findFunctionImplementation(
    configurationSource,
    'commitConnectionEditOperation',
  )
  const duplicateCommit = findFunctionImplementation(
    configurationSource,
    'commitConnectionDuplicateOperation',
  )
  const keyTransition = findFunctionImplementation(
    configurationSource,
    'finalizeConnectionKeyTransition',
  )
  const executeSemanticOperation = findMethod(
    browserRepoSource,
    'BrowserCommandCommit',
    'executeSemanticOperation',
  )
  const semanticPortExecute = findInterfaceMethod(
    domainSource,
    'BrowserSemanticCommandPort',
    'executeSemanticOperation',
  )
  const roots = configurationHandlerRoots(checker, configurationSource)
  const expectedVariants = ['connection.create', 'connection.duplicate', 'connection.edit']
  const routes = new Map(
    expectedVariants.map((variant) => [
      variant,
      commandRouteFacts(checker, [roots.get(variant)], [executor]),
    ]),
  )
  const variants = [...routes]
    .filter(([, route]) => route.semanticTerminals.length > 0)
    .map(([variant]) => variant)
    .sort()
  compareExact(
    'configuration connection-lifecycle command routes',
    expectedVariants,
    variants,
    outputProblems,
  )

  const descriptor = findFunction(
    configurationSource,
    'connectionProfileLifecycleOperationDescriptor',
  )
  const descriptorCall = executableCalls(descriptor).find(
    (call) => call.expression.getText(configurationSource) === 'semanticOperationDescriptor',
  )
  const definition = semanticDescriptorDefinition(
    descriptorCall?.arguments[0] ? unwrap(descriptorCall.arguments[0]) : undefined,
    configurationSource,
  )
  const physicalMutations = objectPropertyInitializer(definition, 'exactPhysicalMutations')
  const physicalReads = objectPropertyInitializer(definition, 'exactPhysicalReads')
  const resources = objectPropertyInitializer(definition, 'resources')
  const permittedWrites = objectPropertyInitializer(definition, 'permittedWrites')
  const requiredWrites = objectPropertyInitializer(definition, 'requiredWritesWhenMutated')
  const exactReceiptFactory = typedExactReceiptFactoryFacts(
    definition,
    configurationSource,
    'connectionProfileLifecycleOperationExactPlan',
    'connectionProfileLifecycleOperationExactReceipt',
  )
  const executorCalls = executableCalls(executor)
  const semanticCalls = executorCalls.filter(
    (call) =>
      callResolvesTo(checker, call, executeSemanticOperation) ||
      callResolvesTo(checker, call, semanticPortExecute),
  )
  const routeExecutorCalls = new Map(
    expectedVariants.map((variant) => [
      variant,
      reachableCallsResolvingTo(checker, [roots.get(variant)], executor),
    ]),
  )
  const routeText = expectedVariants
    .map((variant) => roots.get(variant).getText(configurationSource))
    .join('\n')
  const inputText = findFunction(
    configurationSource,
    'connectionProfileLifecycleOperationInput',
  ).getText(configurationSource)
  const transactionText = findFunction(
    configurationSource,
    'connectionProfileLifecycleOperationTransaction',
  ).getText(configurationSource)
  const descriptorText = descriptor.getText(configurationSource)
  const executorText = executor.getText(configurationSource)
  const commitText = commit.getText(configurationSource)
  const createText = createCommit.getText(configurationSource)
  const editText = editCommit.getText(configurationSource)
  const duplicateText = duplicateCommit.getText(configurationSource)
  const keyTransitionText = keyTransition.getText(configurationSource)
  const dependencyText = findFunction(
    configurationSource,
    'connectionProfileLifecycleOperationDependencies',
  ).getText(configurationSource)
  const ownerLinkReadText = findFunction(
    configurationSource,
    'configurationOwnerLinkPhysicalReads',
  ).getText(configurationSource)
  const catalogReadText = findFunction(
    configurationSource,
    'configurationCatalogProjectionPhysicalReads',
  ).getText(configurationSource)
  const familyText = [
    routeText,
    inputText,
    transactionText,
    descriptorText,
    executorText,
    commitText,
    createText,
    editText,
    duplicateText,
    keyTransitionText,
  ].join('\n')
  const receiptText = findFunction(
    configurationSource,
    'connectionProfileLifecycleOperationReceipt',
  ).getText(configurationSource)
  const receiptAssertionText = findFunction(
    configurationSource,
    'assertConnectionProfileLifecycleOperationReceipt',
  ).getText(configurationSource)
  const createdProfileResourceFragment = '`profile:$' + '{command.profile.id}`'
  const sourceProfileResourceFragment = '`profile:$' + '{command.sourceId}`'
  const copiedProfileResourceFragment = '`profile:$' + '{command.copyId}`'
  const resetChatResourceFragment = '`chat-meta:$' + '{command.resetModelChatId}`'
  const keyResourceFragment = '`key:$' + '{keyId}`'
  const discoveryResourceFragment = '`discovery-cache:models:$' + '{command.profileId}`'
  const repoTransactionText = findMethod(
    browserRepoSource,
    'BrowserCommandCommit',
    'runTransaction',
  ).getText(browserRepoSource)
  const commonKernel = {
    nestedKindBound: browserRepoSource
      .getText()
      .includes('configurationSemanticOperationKind(command.input.kind)'),
    exactVariantsBound:
      objectPropertyInitializer(definition, 'operationKind')?.getText(configurationSource) ===
      'configurationSemanticOperationKind(input.operationKind)',
    descriptorTransactionBound:
      definition?.getText(configurationSource).includes('\n    transaction,') === true &&
      permittedWrites?.getText(configurationSource) === 'transaction.tableNames',
    variantSpecificTransactionTables:
      transactionText.includes("input.operationKind === 'connection.create'") &&
      transactionText.includes("input.operationKind === 'connection.edit'") &&
      transactionText.includes('CONFIGURATION_LINK_MUTATION_TRANSACTION_CAPABILITY.tableNames') &&
      transactionText.includes('CONFIGURATION_PROFILE_CATALOG_TRANSACTION_CAPABILITY.tableNames') &&
      transactionText.includes('CONFIGURATION_PRESET_CATALOG_TRANSACTION_CAPABILITY.tableNames') &&
      transactionText.includes('PRESET_ORDER_MUTATION_TRANSACTION_CAPABILITY.tableNames') &&
      transactionText.includes('CHAT_ROW_LINKED_TRANSACTION_CAPABILITY.tableNames') &&
      transactionText.includes('DISCOVERY_CACHE_MUTATION_TRANSACTION_CAPABILITY.tableNames'),
    exactIntentResources:
      resources?.getText(configurationSource) === '({ resourceNames }) => resourceNames' &&
      inputText.includes('configurationLockNames(') &&
      inputText.includes(createdProfileResourceFragment) &&
      inputText.includes(sourceProfileResourceFragment) &&
      inputText.includes(copiedProfileResourceFragment) &&
      inputText.includes(resetChatResourceFragment) &&
      inputText.includes(keyResourceFragment) &&
      inputText.includes(discoveryResourceFragment) &&
      !inputText.includes("'profile-catalog'") &&
      !inputText.includes("'preset-catalog'") &&
      !inputText.includes("'discovery-cache:retention'") &&
      !inputText.includes('configurationOwnerLockName'),
    exactEffects:
      exactReceiptFactory.contractBound &&
      dependencyText.includes('workspaceDependenciesForConfigurationSemanticMutation') &&
      dependencyText.includes('receipt.profileLinks.profileUsageMutations') &&
      dependencyText.includes("receipt.key?.mutation === 'write'") &&
      !dependencyText.includes('receipt.key.profileIds') &&
      dependencyText.includes('receipt.initialPreset') &&
      dependencyText.includes('receipt.resetChat.transition') &&
      dependencyText.includes('receipt.discovery'),
    exactReceiptWrites:
      exactReceiptFactory.receiptBound &&
      exactReceiptFactory.receiptText.includes('boundSemanticOperationExactReceiptAccumulator') &&
      exactReceiptFactory.receiptText.includes('physicalMutations: fragment?.physicalMutations') &&
      exactReceiptFactory.receiptText.includes('assertConnectionProfileLifecycleOperationReceipt'),
    exactBoundedReads:
      exactReceiptFactory.receiptText.includes('fragment?.physicalReads') &&
      exactReceiptFactory.receiptText.includes('configurationOwnerLinkPhysicalReads') &&
      exactReceiptFactory.receiptText.includes('configurationCatalogProjectionPhysicalReads') &&
      exactReceiptFactory.receiptText.includes('presetLifecycleOperationPhysicalReads') &&
      exactReceiptFactory.receiptText.includes('linkedChatTransitionPhysicalReads') &&
      ownerLinkReadText.includes("indexName: 'ownerKey'") &&
      catalogReadText.includes("'configurationCatalogAggregates'") &&
      createText.includes('recordConnectionProfileLifecyclePhysicalRead') &&
      editText.includes('recordConnectionProfileLifecyclePhysicalRead') &&
      duplicateText.includes('recordConnectionProfileLifecyclePhysicalRead') &&
      editText.includes('boundSemanticOperationExactReceiptAccumulator'),
    typedExactPlan:
      exactReceiptFactory.planBound &&
      hasTypedSingleAttemptReplayPlan(exactReceiptFactory.planText) &&
      exactReceiptFactory.planText.includes('maxRequests: 4_096') &&
      exactReceiptFactory.planText.includes('maxRows: 4_096') &&
      exactReceiptFactory.planText.includes('maxBatchRows: 529') &&
      exactReceiptFactory.planText.includes('maxRequests: 8_192') &&
      exactReceiptFactory.planText.includes('maxRows: 8_192') &&
      exactReceiptFactory.planText.includes('maxBytes: Number.MAX_SAFE_INTEGER'),
    executorConsumed:
      semanticCalls.length === 1 &&
      semanticCalls[0]?.arguments[0]?.getText(configurationSource) ===
        'connectionProfileLifecycleOperationDescriptor(input)',
    routeExecutorExact: [...routeExecutorCalls.values()].every((calls) => calls.length === 1),
    receiptBound:
      receiptText.includes('emptyConfigurationOwnerLinkMutationReceipt') &&
      receiptText.includes('chatConfigurationOperationReceipt') &&
      receiptAssertionText.includes('assertKeyMaterialOperationReceipt') &&
      receiptAssertionText.includes('receipt.initialPreset') &&
      receiptAssertionText.includes('receipt.resetChat') &&
      receiptAssertionText.includes('receipt.discovery'),
    transactionLocalTransitions:
      createText.includes('addLinkedSemanticByteOwner') &&
      createText.includes('applyConfigurationProfileCatalogProjectionTransition') &&
      createText.includes('applyConfigurationPresetCatalogProjectionTransition') &&
      createText.includes('appendPresetOrderEntry') &&
      editText.includes('replaceLinkedSemanticByteOwner') &&
      editText.includes('selectedChatConfigurationTransition') &&
      editText.includes('clearDiscoveryCacheProfileRows') &&
      duplicateText.includes('addLinkedSemanticByteOwner') &&
      duplicateText.includes('applyConfigurationProfileCatalogProjectionTransition') &&
      !keyTransitionText.includes('readTargetLinksFromTransaction') &&
      keyTransitionText.includes('recordBrowserCommandKeyRequestMaterialAffectedSet'),
    readsBeforeWrites:
      createText.indexOf('const currentProfile = await profiles.get(profile.id)') <
        createText.indexOf("addSemanticByteOwner(tx, 'keys'") &&
      duplicateText.indexOf('const source = await profiles.get(command.sourceId)') <
        duplicateText.indexOf("addLinkedSemanticByteOwner(tx, 'profiles'") &&
      duplicateText.indexOf('const currentCopy = await profiles.get(command.copyId)') <
        duplicateText.indexOf("addLinkedSemanticByteOwner(tx, 'profiles'"),
    missingOldKeyPermissive:
      editText.includes('const primaryKeyChanged = written.apiKeyRef !== current.apiKeyRef') &&
      editText.includes('} else if (primaryKeyChanged && written.apiKeyRef) {') &&
      !editText.includes("table<KeyRecord, KeyId>('keys').get(current.apiKeyRef"),
    projectionReadsSubtracted:
      !familyText.includes('putConfigurationProfileCatalogProjection') &&
      !familyText.includes('putConfigurationPresetCatalogProjection'),
    exactReceiptOwned:
      physicalMutations === undefined &&
      physicalReads === undefined &&
      requiredWrites?.getText(configurationSource) === '[]' &&
      exactReceiptFactory.contractBound,
    noLegacyTerminal:
      !familyText.includes('executeDirectConfigurationTransaction') &&
      !familyText.includes('executeRevalidatedConfigurationPlan') &&
      !familyText.includes('configurationPlanRetry') &&
      !familyText.includes('.withLocks('),
    noBroadWork:
      !familyText.includes('.toCollection(') &&
      !familyText.includes('.toArray(') &&
      !familyText.includes('while (') &&
      !familyText.includes('setTimeout('),
    transactionLocalExactAssertions:
      repoTransactionText.includes('assertSemanticOperationExactInvalidations') &&
      repoTransactionText.includes('assertSemanticOperationExactPhysicalMutations') &&
      repoTransactionText.includes('assertSemanticOperationExactPhysicalReads'),
    readObservationOptIn: repoTransactionText.includes(
      'observePhysicalReads: semanticOperation?.descriptor.exactPhysicalReads !== undefined',
    ),
  }
  for (const [name, consumed] of Object.entries(commonKernel)) {
    if (!consumed) {
      outputProblems.push(`configuration connection-lifecycle common kernel missing ${name}`)
    }
  }
  const commonConsumed = Object.values(commonKernel).every(Boolean)
  const capabilities = {}
  const routeFacts = {}
  for (const variant of expectedVariants) {
    const route = routes.get(variant)
    const consumed =
      commonConsumed && route.semanticTerminals.length > 0 && route.legacyTerminals.length === 0
    if (route.legacyTerminals.length > 0) {
      outputProblems.push(
        `configuration connection-lifecycle ${variant}: legacy terminals ${route.legacyTerminals.join(', ')}`,
      )
    }
    capabilities[variant] = Object.freeze({
      path: CONFIGURATION_HANDLER_PATH,
      owner: 'executeConnectionProfileLifecycleOperation',
      transaction: 'connectionProfileLifecycleOperationTransaction',
      consumed,
      physicalWritesProved: true,
      exactPhysicalWritesProved: true,
      exactEffectsProved: true,
      tablesProved: true,
      boundsProved: true,
    })
    routeFacts[variant] = Object.freeze({
      entries: Object.freeze(route.entries),
      semanticTerminals: Object.freeze(route.semanticTerminals),
      legacyTerminals: Object.freeze(route.legacyTerminals),
      consumed,
    })
  }
  return Object.freeze({
    variants: Object.freeze(variants),
    routesByVariant: Object.freeze(routeFacts),
    commonKernel: Object.freeze(commonKernel),
    capabilities: Object.freeze(capabilities),
  })
}

function configurationConnectionDeleteCapabilityFacts(
  program,
  browserRepoSource,
  configurationSource,
  catalogProjectionSource,
  outputProblems,
) {
  const checker = program.getTypeChecker()
  const domainSource = exactSource(program, 'src/store/browser-domain-mutations.ts')
  const executor = findFunctionImplementation(
    configurationSource,
    'executeConnectionDeleteOperation',
  )
  const commit = findFunctionImplementation(configurationSource, 'commitConnectionDeleteOperation')
  const executeSemanticOperation = findMethod(
    browserRepoSource,
    'BrowserCommandCommit',
    'executeSemanticOperation',
  )
  const semanticPortExecute = findInterfaceMethod(
    domainSource,
    'BrowserSemanticCommandPort',
    'executeSemanticOperation',
  )
  const roots = configurationHandlerRoots(checker, configurationSource)
  const expectedVariants = ['connection.delete']
  const routes = new Map([
    ['connection.delete', commandRouteFacts(checker, [roots.get('connection.delete')], [executor])],
  ])
  const variants = [...routes]
    .filter(([, route]) => route.semanticTerminals.length > 0)
    .map(([variant]) => variant)
    .sort()
  compareExact(
    'configuration connection-delete command routes',
    expectedVariants,
    variants,
    outputProblems,
  )

  const descriptor = findFunction(configurationSource, 'connectionDeleteOperationDescriptor')
  const descriptorCall = executableCalls(descriptor).find(
    (call) => call.expression.getText(configurationSource) === 'semanticOperationDescriptor',
  )
  const definition = semanticDescriptorDefinition(
    descriptorCall?.arguments[0] ? unwrap(descriptorCall.arguments[0]) : undefined,
    configurationSource,
  )
  const effects = objectPropertyInitializer(definition, 'effects')
  const physicalMutations = objectPropertyInitializer(definition, 'exactPhysicalMutations')
  const physicalReads = objectPropertyInitializer(definition, 'exactPhysicalReads')
  const resources = objectPropertyInitializer(definition, 'resources')
  const permittedWrites = objectPropertyInitializer(definition, 'permittedWrites')
  const requiredWrites = objectPropertyInitializer(definition, 'requiredWritesWhenMutated')
  const exactReceiptFactory = typedExactReceiptFactoryFacts(
    definition,
    configurationSource,
    'connectionDeleteOperationExactPlan',
    'connectionDeleteOperationExactReceipt',
  )
  const semanticCalls = executableCalls(executor).filter(
    (call) =>
      callResolvesTo(checker, call, executeSemanticOperation) ||
      callResolvesTo(checker, call, semanticPortExecute),
  )
  const route = routes.get('connection.delete')
  const routeText = roots.get('connection.delete').getText(configurationSource)
  const inputText = findFunction(configurationSource, 'connectionDeleteOperationInput').getText(
    configurationSource,
  )
  const transactionText = findFunction(
    configurationSource,
    'connectionDeleteOperationTransaction',
  ).getText(configurationSource)
  const descriptorText = descriptor.getText(configurationSource)
  const executorText = executor.getText(configurationSource)
  const commitText = commit.getText(configurationSource)
  const dependencyText = findFunction(
    configurationSource,
    'connectionDeleteOperationDependencies',
  ).getText(configurationSource)
  const physicalReadText = findFunction(
    configurationSource,
    'connectionDeleteOperationPhysicalReads',
  ).getText(configurationSource)
  const receiptText = findFunction(configurationSource, 'connectionDeleteOperationReceipt').getText(
    configurationSource,
  )
  const assertionText = findFunction(
    configurationSource,
    'assertConnectionDeleteOperationReceipt',
  ).getText(configurationSource)
  const familyText = [
    routeText,
    inputText,
    transactionText,
    descriptorText,
    executorText,
    commitText,
    receiptText,
    assertionText,
  ].join('\n')
  const projectionDeletionText = findFunction(
    catalogProjectionSource,
    'applyConfigurationProfileCatalogProjectionDeletion',
  ).getText(catalogProjectionSource)
  const repoTransactionText = findMethod(
    browserRepoSource,
    'BrowserCommandCommit',
    'runTransaction',
  ).getText(browserRepoSource)
  const commonKernel = {
    nestedKindBound: browserRepoSource
      .getText()
      .includes('configurationSemanticOperationKind(command.input.kind)'),
    exactVariantBound:
      objectPropertyInitializer(definition, 'operationKind')?.getText(configurationSource) ===
      "configurationSemanticOperationKind('connection.delete')",
    descriptorTransactionBound:
      definition?.getText(configurationSource).includes('\n    transaction,') === true &&
      permittedWrites?.getText(configurationSource) === 'transaction.tableNames',
    variantSpecificTransactionTables:
      transactionText.includes('CONFIGURATION_LINK_MUTATION_TRANSACTION_CAPABILITY.tableNames') &&
      transactionText.includes('CONFIGURATION_PROFILE_CATALOG_TRANSACTION_CAPABILITY.tableNames') &&
      transactionText.includes('DISCOVERY_CACHE_MUTATION_TRANSACTION_CAPABILITY.tableNames') &&
      transactionText.includes('CHAT_ROW_LINKED_TRANSACTION_CAPABILITY.tableNames') &&
      transactionText.includes('CONFIGURATION_PRESET_CATALOG_TRANSACTION_CAPABILITY.tableNames') &&
      transactionText.includes('input.replacementProfileId'),
    exactIntentResources:
      resources?.getText(configurationSource) === '({ resourceNames }) => resourceNames' &&
      inputText.includes("configurationTargetResourceName('profile', command.profileId)") &&
      inputText.includes("'preset-order'") &&
      inputText.includes('discovery-cache:models:') &&
      !inputText.includes("'profile-catalog'") &&
      !inputText.includes("'preset-catalog'") &&
      !inputText.includes("'discovery-cache:retention'") &&
      !inputText.includes('configurationOwnerLockName'),
    exactEffects:
      effects === undefined &&
      exactReceiptFactory.contractBound &&
      dependencyText.includes('workspaceDependenciesForConfigurationSemanticMutation') &&
      dependencyText.includes('linkedChatTransitionsDependencies') &&
      dependencyText.includes('receipt.presetLinks.profileUsageMutations') &&
      dependencyText.includes('receipt.discovery') &&
      dependencyText.includes('receipt.keys'),
    exactReceiptWrites:
      exactReceiptFactory.receiptBound &&
      exactReceiptFactory.receiptText.includes('boundSemanticOperationExactReceiptAccumulator') &&
      exactReceiptFactory.receiptText.includes('physicalMutations: fragment?.physicalMutations') &&
      exactReceiptFactory.receiptText.includes('assertConnectionDeleteOperationReceipt'),
    exactPhysicalReads:
      exactReceiptFactory.receiptText.includes('fragment?.physicalReads') &&
      exactReceiptFactory.receiptText.includes('connectionDeleteOperationPhysicalReads') &&
      physicalReadText.includes("tableName: 'profiles'") &&
      physicalReadText.includes("tableName: 'configurationLinks'") &&
      physicalReadText.includes("indexName: 'targetKey'") &&
      physicalReadText.includes("tableName: 'presets'") &&
      physicalReadText.includes("tableName: 'chats'") &&
      physicalReadText.includes('configurationOwnerLinkPhysicalReads') &&
      physicalReadText.includes('configurationCatalogProjectionPhysicalReads') &&
      physicalReadText.includes('linkedChatTransitionPhysicalReads') &&
      physicalReadText.includes("'[activeKey+mruSortKey+nameSortKey+id]'"),
    typedExactPlan:
      exactReceiptFactory.planBound &&
      hasTypedSingleAttemptReplayPlan(exactReceiptFactory.planText) &&
      exactReceiptFactory.planText.match(/maxRequests: Number\.MAX_SAFE_INTEGER/g)?.length === 2 &&
      exactReceiptFactory.planText.match(/maxRows: Number\.MAX_SAFE_INTEGER/g)?.length === 2 &&
      exactReceiptFactory.planText.match(/maxBatchRows: Number\.MAX_SAFE_INTEGER/g)?.length === 2 &&
      exactReceiptFactory.planText.match(/maxBytes: Number\.MAX_SAFE_INTEGER/g)?.length === 2,
    executorConsumed:
      semanticCalls.length === 1 &&
      semanticCalls[0]?.arguments[0]?.getText(configurationSource) ===
        'connectionDeleteOperationDescriptor(input)',
    routeExecutorExact:
      reachableCallsResolvingTo(checker, [roots.get('connection.delete')], executor).length === 1,
    receiptBound:
      receiptText.includes('emptyConfigurationOwnerLinkMutationReceipt') &&
      assertionText.includes('receipt.targetLinkIds') &&
      assertionText.includes('receipt.profileLinks') &&
      assertionText.includes('receipt.profileCatalog') &&
      assertionText.includes('receipt.discovery') &&
      assertionText.includes('receipt.keys'),
    transactionLocalTransitions:
      commitText.includes('readTargetLinksFromTransaction') &&
      commitText.includes("tx.table<ChatPreset, PresetId>('presets').bulkGet(presetReadIds)") &&
      commitText.includes('const chatMutation = openLinkedChatMutation(tx)') &&
      commitText.includes('chatMutation.readMany(chatReadIds)') &&
      commitText.includes('replaceLinkedSemanticByteOwnerBatch') &&
      commitText.includes('chatMutation.replaceLinked(previous.id, () => next)') &&
      commitText.includes('chatMutation.commit()') &&
      commitText.includes('deleteLinkedSemanticByteOwner') &&
      commitText.includes('applyConfigurationProfileCatalogProjectionDeletion') &&
      commitText.includes('clearDiscoveryCacheProfileRows'),
    readsBeforeWrites:
      commitText.indexOf('const [presetRows, chatRows]') <
      commitText.indexOf("replaceLinkedSemanticByteOwnerBatch(tx, 'presets'"),
    projectionReadsSubtracted:
      !projectionDeletionText.includes('.table') && !projectionDeletionText.includes('.get('),
    exactReceiptOwned:
      physicalMutations === undefined &&
      physicalReads === undefined &&
      requiredWrites?.getText(configurationSource) === '[]' &&
      exactReceiptFactory.contractBound,
    noLegacyTerminal:
      !familyText.includes('executeDirectConfigurationTransaction') &&
      !familyText.includes('executeRevalidatedConfigurationPlan') &&
      !familyText.includes('configurationPlanRetry') &&
      !familyText.includes('.withLocks('),
    noBroadWork:
      !familyText.includes('.toCollection(') &&
      !familyText.includes('.toArray(') &&
      !familyText.includes('while (') &&
      !familyText.includes('setTimeout('),
    transactionLocalExactAssertions:
      repoTransactionText.includes('assertSemanticOperationExactInvalidations') &&
      repoTransactionText.includes('assertSemanticOperationExactPhysicalMutations') &&
      repoTransactionText.includes('assertSemanticOperationExactPhysicalReads'),
  }
  for (const [name, consumed] of Object.entries(commonKernel)) {
    if (!consumed) {
      outputProblems.push(`configuration connection-delete common kernel missing ${name}`)
    }
  }
  const consumed =
    Object.values(commonKernel).every(Boolean) &&
    route.semanticTerminals.length > 0 &&
    route.legacyTerminals.length === 0
  if (route.legacyTerminals.length > 0) {
    outputProblems.push(
      `configuration connection-delete: legacy terminals ${route.legacyTerminals.join(', ')}`,
    )
  }
  return Object.freeze({
    variants: Object.freeze(variants),
    routesByVariant: Object.freeze({
      'connection.delete': Object.freeze({
        entries: Object.freeze(route.entries),
        semanticTerminals: Object.freeze(route.semanticTerminals),
        legacyTerminals: Object.freeze(route.legacyTerminals),
        consumed,
      }),
    }),
    commonKernel: Object.freeze(commonKernel),
    capabilities: Object.freeze({
      'connection.delete': Object.freeze({
        path: CONFIGURATION_HANDLER_PATH,
        owner: 'executeConnectionDeleteOperation',
        transaction: 'connectionDeleteOperationTransaction',
        consumed,
        physicalWritesProved: true,
        exactPhysicalWritesProved: true,
        exactEffectsProved: true,
        tablesProved: true,
        boundsProved: false,
      }),
    }),
  })
}

function configurationEntityRowCapabilityFacts(
  program,
  browserRepoSource,
  configurationSource,
  outputProblems,
) {
  const checker = program.getTypeChecker()
  const domainSource = exactSource(program, 'src/store/browser-domain-mutations.ts')
  const executeSemanticOperation = findMethod(
    browserRepoSource,
    'BrowserCommandCommit',
    'executeSemanticOperation',
  )
  const semanticPortExecute = findInterfaceMethod(
    domainSource,
    'BrowserSemanticCommandPort',
    'executeSemanticOperation',
  )
  const entityExecutor = findFunctionImplementation(
    configurationSource,
    'executeConfigurationEntityRowOperation',
  )
  const roots = configurationHandlerRoots(checker, configurationSource)
  const routes = new Map()
  for (const [variant, root] of roots) {
    routes.set(variant, commandRouteFacts(checker, [root], [entityExecutor]))
  }
  const variants = [...routes]
    .filter(([, route]) => route.semanticTerminals.length > 0)
    .map(([variant]) => variant)
    .sort()
  const expectedVariants = ['key.touch', 'text-template.create', 'text-template.update']
  compareExact(
    'configuration entity-row command routes',
    expectedVariants,
    variants,
    outputProblems,
  )
  const commonKernel = configurationEntityRowCommonKernelFacts(
    checker,
    browserRepoSource,
    configurationSource,
    entityExecutor,
    executeSemanticOperation,
    semanticPortExecute,
  )
  for (const [name, consumed] of Object.entries(commonKernel)) {
    if (!consumed) outputProblems.push(`configuration entity-row common kernel missing ${name}`)
  }
  const commonConsumed = Object.values(commonKernel).every(Boolean)
  const capabilities = {}
  const routeFacts = {}
  for (const variant of variants) {
    const route = routes.get(variant)
    const consumed =
      commonConsumed && route.semanticTerminals.length > 0 && route.legacyTerminals.length === 0
    if (route.legacyTerminals.length > 0) {
      outputProblems.push(
        `configuration entity-row ${variant}: legacy terminals ${route.legacyTerminals.join(', ')}`,
      )
    }
    capabilities[variant] = Object.freeze({
      path: CONFIGURATION_HANDLER_PATH,
      owner: 'executeConfigurationEntityRowOperation',
      transaction:
        variant === 'key.touch'
          ? 'CONFIGURATION_KEY_ENTITY_TRANSACTION'
          : 'CONFIGURATION_TEXT_TEMPLATE_ENTITY_TRANSACTION',
      consumed,
      physicalWritesProved: true,
      exactPhysicalWritesProved: true,
      exactEffectsProved: true,
      tablesProved: true,
      boundsProved: true,
    })
    routeFacts[variant] = Object.freeze({
      entries: Object.freeze(route.entries),
      semanticTerminals: Object.freeze(route.semanticTerminals),
      legacyTerminals: Object.freeze(route.legacyTerminals),
      consumed,
    })
  }
  return Object.freeze({
    variants: Object.freeze(variants),
    routesByVariant: Object.freeze(routeFacts),
    commonKernel: Object.freeze(commonKernel),
    capabilities: Object.freeze(capabilities),
  })
}

function configurationEntityRowCommonKernelFacts(
  checker,
  browserRepoSource,
  configurationSource,
  entityExecutor,
  executeSemanticOperation,
  semanticPortExecute,
) {
  const keyDefinition = semanticDescriptorDefinition(
    findVariableInitializer(configurationSource, 'keyTouchOperationDescriptor'),
    configurationSource,
  )
  const templateDescriptor = findFunction(
    configurationSource,
    'textTemplateEntityOperationDescriptor',
  )
  const templateDescriptorCall = executableCalls(templateDescriptor).find(
    (call) => call.expression.getText(configurationSource) === 'semanticOperationDescriptor',
  )
  const templateDefinition = semanticDescriptorDefinition(
    templateDescriptorCall?.arguments[0] ? unwrap(templateDescriptorCall.arguments[0]) : undefined,
    configurationSource,
  )
  const executorCalls = executableCalls(entityExecutor)
  const semanticCalls = executorCalls.filter(
    (call) =>
      callResolvesTo(checker, call, executeSemanticOperation) ||
      callResolvesTo(checker, call, semanticPortExecute),
  )
  const keyEffects = objectPropertyInitializer(keyDefinition, 'effects')
  const keyPhysical = objectPropertyInitializer(keyDefinition, 'exactPhysicalMutations')
  const keyReads = objectPropertyInitializer(keyDefinition, 'exactPhysicalReads')
  const templateEffects = objectPropertyInitializer(templateDefinition, 'effects')
  const templatePhysical = objectPropertyInitializer(templateDefinition, 'exactPhysicalMutations')
  const templateReads = objectPropertyInitializer(templateDefinition, 'exactPhysicalReads')
  const keyExactReceiptContract = objectSpreadsCall(
    keyDefinition,
    'semanticOperationExactReceiptContracts',
  )
  const templateExactReceiptContract = objectSpreadsCall(
    templateDefinition,
    'semanticOperationExactReceiptContracts',
  )
  const exactPlan = findFunction(configurationSource, 'configurationEntityOperationExactPlan')
  const exactReceipt = findFunction(configurationSource, 'configurationEntityOperationExactReceipt')
  const exactPlanText = exactPlan.getText(configurationSource)
  const exactReceiptText = exactReceipt.getText(configurationSource)
  const executorText = entityExecutor.getText(configurationSource)
  const repoTransactionText = findMethod(
    browserRepoSource,
    'BrowserCommandCommit',
    'runTransaction',
  ).getText(browserRepoSource)
  return {
    nestedKindBound: browserRepoSource
      .getText()
      .includes('configurationSemanticOperationKind(command.input.kind)'),
    exactVariantsBound:
      objectPropertyInitializer(keyDefinition, 'operationKind')?.getText(configurationSource) ===
        "'configuration:key.touch'" &&
      objectPropertyInitializer(templateDefinition, 'operationKind')?.getText(
        configurationSource,
      ) === 'configurationSemanticOperationKind(operationKind)',
    exactTransactions:
      objectPropertyInitializer(keyDefinition, 'transaction')?.getText(configurationSource) ===
        'CONFIGURATION_KEY_ENTITY_TRANSACTION' &&
      objectPropertyInitializer(templateDefinition, 'transaction')?.getText(configurationSource) ===
        'CONFIGURATION_TEXT_TEMPLATE_ENTITY_TRANSACTION',
    exactEffects:
      (keyEffects !== undefined &&
        templateEffects !== undefined &&
        validSemanticEffects(unwrap(keyEffects)) &&
        validSemanticEffects(unwrap(templateEffects)) &&
        keyPhysical !== undefined &&
        templatePhysical !== undefined &&
        keyReads !== undefined &&
        templateReads !== undefined) ||
      (keyExactReceiptContract &&
        templateExactReceiptContract &&
        exactReceiptText.includes('dependencies: changed ? [dependency] : []') &&
        exactReceiptText.includes('physicalMutations: changed')),
    exactPrimaryReads:
      (keyReads !== undefined &&
        templateReads !== undefined &&
        keyReads.getText(configurationSource).includes("tableName: 'keys'") &&
        keyReads.getText(configurationSource).includes("indexKind: 'primary'") &&
        keyReads.getText(configurationSource).includes("operation: 'get'") &&
        keyReads.getText(configurationSource).includes('requestCount: 1') &&
        keyReads.getText(configurationSource).includes('rowCount: 1') &&
        templateReads.getText(configurationSource).includes("tableName: 'textTemplates'") &&
        templateReads.getText(configurationSource).includes("indexKind: 'primary'") &&
        templateReads.getText(configurationSource).includes("operation: 'get'") &&
        templateReads.getText(configurationSource).includes('requestCount: 1') &&
        templateReads.getText(configurationSource).includes('rowCount: 1')) ||
      (keyExactReceiptContract &&
        templateExactReceiptContract &&
        exactReceiptText.includes('tableName,') &&
        exactReceiptText.includes("indexKind: 'primary' as const") &&
        exactReceiptText.includes("operation: 'get' as const") &&
        exactReceiptText.includes('requestCount: 1') &&
        exactReceiptText.includes('rowCount: 1')),
    typedExactPlan:
      keyExactReceiptContract &&
      templateExactReceiptContract &&
      exactPlanText.includes('semanticOperationExactPlan({') &&
      hasTypedSingleAttemptReplayPlan(exactPlanText) &&
      exactPlanText.includes('maxRequests: 1') &&
      exactPlanText.includes('maxRows: 1') &&
      exactPlanText.includes('maxBatchRows: 1') &&
      exactReceiptText.includes('semanticOperationExactReceipt(plan, {'),
    descriptorConsumed:
      executorText.includes('keyTouchOperationDescriptor') &&
      executorText.includes('textTemplateEntityOperationDescriptor(command.kind)'),
    executorConsumed: semanticCalls.length === 3,
    primaryKeyReadsOwned:
      executorText.includes(".table<KeyRecord, KeyId>('keys').get(") &&
      executorText.includes(".table<SavedTextTemplate, TextTemplateId>('textTemplates')"),
    writesOwned:
      executorText.includes('replaceSemanticByteOwner') &&
      executorText.includes('addTextTemplateByteOwner') &&
      executorText.includes('replaceTextTemplateByteOwner'),
    transactionLocalExactAssertions:
      repoTransactionText.includes('assertSemanticOperationExactInvalidations') &&
      repoTransactionText.includes('assertSemanticOperationExactPhysicalMutations') &&
      repoTransactionText.includes('assertSemanticOperationExactPhysicalReads'),
    readObservationOptIn: repoTransactionText.includes(
      'observePhysicalReads: semanticOperation?.descriptor.exactPhysicalReads !== undefined',
    ),
    boundedPrimaryIo:
      !executorText.includes('.where(') &&
      !executorText.includes('.toArray(') &&
      !executorText.includes('.toCollection('),
    legacyCallsAbsent: !executorCalls.some((call) =>
      call.expression.getText(configurationSource).endsWith('.withLocks'),
    ),
  }
}

function commandLifetimeReceiptFacts(program, browserRepoSource, outputProblems) {
  const lifecycleSource = exactSource(program, BROWSER_WORKSPACE_LIFECYCLE_PATH)
  const compactionSource = exactSource(program, STORAGE_COMPACTION_STATE_PATH)
  const semanticSource = exactSource(program, SEMANTIC_OPERATION_CAPABILITY_PATH)
  const executeText = findMethod(
    browserRepoSource,
    'BrowserWorkspaceRepository',
    'execute',
  ).getText(browserRepoSource)
  const executeSemanticText = findMethod(
    browserRepoSource,
    'BrowserCommandCommit',
    'executeSemanticOperation',
  ).getText(browserRepoSource)
  const completeSemanticText = findMethod(
    browserRepoSource,
    'BrowserCommandCommit',
    'completeSemanticOperation',
  ).getText(browserRepoSource)
  const mismatchText = findMethod(
    browserRepoSource,
    'BrowserCommandCommit',
    'semanticOperationMismatch',
  ).getText(browserRepoSource)
  const resumeText = findFunction(
    lifecycleSource,
    'resumeBrowserWorkspaceRepositoryCapabilities',
  ).getText(lifecycleSource)
  const activateText = findFunction(
    compactionSource,
    'activateStorageCompactionWriteAdmission',
  ).getText(compactionSource)
  const awaitAdmissionText = findFunction(
    compactionSource,
    'awaitStorageCompactionWriteAdmission',
  ).getText(compactionSource)
  const startOwnerText = findFunction(
    compactionSource,
    'startStorageCompactionIntentOwnerOnce',
  ).getText(compactionSource)
  const recoverText = findFunction(compactionSource, 'recoverStorageCompactionDebtIntents').getText(
    compactionSource,
  )
  const receiptText = findFunction(
    semanticSource,
    'semanticOperationCommandLifetimeReceipt',
  ).getText(semanticSource)
  const assertReceiptText = findFunction(
    semanticSource,
    'assertSemanticOperationCommandLifetimeReceipt',
  ).getText(semanticSource)
  const extendReceiptText = findFunction(
    semanticSource,
    'semanticOperationCommandLifetimeReceiptWithPhysicalReads',
  ).getText(semanticSource)
  const preflightText = findMethod(
    browserRepoSource,
    'BrowserCommandCommit',
    'readSemanticOperationPreflight',
  ).getText(browserRepoSource)
  const runTransactionText = findMethod(
    browserRepoSource,
    'BrowserCommandCommit',
    'runTransaction',
  ).getText(browserRepoSource)
  const commitClassText = findClass(browserRepoSource, 'BrowserCommandCommit').getText(
    browserRepoSource,
  )
  const commonKernel = Object.freeze({
    cachedFenceInsideAuthoritativeGate: tokensInOrder(executeText, [
      'withSharedAuthoritativeCommandSession(db, async (lockSession) => {',
      'const workspace = this.session.getWorkspaceFence()',
      'assertPermitFence(permit, workspace)',
      'semanticOperationCommandLifetimeReceipt(',
      'new BrowserCommandCommit(',
      'this.dispatchCommand(',
    ]),
    noCommandDurableMetaRead:
      !executeText.includes('readBrowserWorkspaceMeta') && !executeText.includes('this.openDb('),
    prestartedWriteAdmission:
      tokensInOrder(resumeText, [
        'activateStorageCompactionWriteAdmission(db)',
        'resumeBrowserWorkspaceRepositoryAdmissions()',
      ]) &&
      !resumeText.includes('await ') &&
      activateText.includes('startStorageCompactionIntentOwner(db).then('),
    zeroIoAdmissionAwait:
      !awaitAdmissionText.includes('startStorageCompactionIntentOwner(') &&
      !awaitAdmissionText.includes('(db:') &&
      awaitAdmissionText.includes('return receipt'),
    brandedZeroIoAdmissionReceipt:
      semanticSource
        .getText()
        .includes('const SEMANTIC_OPERATION_COMMAND_LIFETIME_RECEIPT = Symbol(') &&
      semanticSource.getText().includes('admission: StorageCompactionWriteAdmission') &&
      receiptText.includes(
        'const physicalReads = Object.freeze([] as readonly SemanticOperationPhysicalRead[])',
      ) &&
      receiptText.includes('commandPhysicalReads: admission.commandPhysicalReads') &&
      assertReceiptText.includes('receipt.preconditions[0].commandPhysicalReads !== 0'),
    observedPreflightExtension:
      extendReceiptText.includes('aggregateSemanticOperationPhysicalReadIo([') &&
      extendReceiptText.includes('...receipt.physicalReads') &&
      extendReceiptText.includes('...physicalReads') &&
      preflightText.includes('runBrowserCommandTransaction(') &&
      preflightText.includes('observePhysicalReads: true') &&
      preflightText.includes('assertPhysicalTransactionTablesDeclared(') &&
      preflightText.includes('SemanticOperationPreflightMutationForbidden') &&
      preflightText.includes('semanticOperationCommandLifetimeReceiptWithPhysicalReads(') &&
      runTransactionText.includes('...this.commandLifetimeReceipt.physicalReads'),
    databaseAndFenceBound:
      receiptText.includes('admission.databaseName !== databaseName') &&
      assertReceiptText.includes('receipt.workspaceId !== expected.workspaceId') &&
      assertReceiptText.includes('receipt.replacementEpoch !== expected.replacementEpoch') &&
      assertReceiptText.includes('receipt.databaseName !== expected.databaseName'),
    boundOnceToCommit:
      countOccurrences(executeText, 'semanticOperationCommandLifetimeReceipt(') === 1 &&
      countOccurrences(executeText, 'new BrowserCommandCommit(') === 1 &&
      commitClassText.includes(
        'private commandLifetimeReceipt: SemanticOperationCommandLifetimeReceipt',
      ) &&
      commitClassText.includes('this.commandLifetimeReceipt = commandLifetimeReceipt'),
    semanticKernelConsumed:
      executeSemanticText.includes('this.semanticOperationMismatch(descriptor)') &&
      completeSemanticText.includes('this.semanticOperationMismatch(descriptor)') &&
      mismatchText.includes(
        'assertSemanticOperationCommandLifetimeReceipt(this.commandLifetimeReceipt, {',
      ),
    ownershipLossInvalidatesAdmission:
      awaitAdmissionText.includes('storageCompactionWriteAdmission !== admission') &&
      awaitAdmissionText.includes('storageCompactionIntentOwnerFailure()') &&
      awaitAdmissionText.includes('!physicalMutationIntentOwnerController'),
    recoveryAbortable:
      startOwnerText.includes(
        'recoverStorageCompactionDebtIntents(db, { signal: controller.signal })',
      ) &&
      countOccurrences(recoverText, 'options.signal?.aborted') >= 4 &&
      recoverText.includes('...(options.signal ? { signal: options.signal } : {})'),
  })
  for (const [name, consumed] of Object.entries(commonKernel)) {
    if (!consumed) outputProblems.push(`command lifetime receipt missing ${name}`)
  }
  return Object.freeze({ commonKernel })
}

function scopeDerivedMutationCapabilityFacts(
  program,
  browserRepoSource,
  workspaceUnion,
  scopeDerivedMutationUnion,
  attemptMutationUnion,
  commandLifetimeReceipt,
  outputProblems,
) {
  const checker = program.getTypeChecker()
  const domainSource = exactSource(program, 'src/store/browser-domain-mutations.ts')
  const messagesSource = exactSource(program, 'src/core/messages.ts')
  const generationEngineSource = exactSource(program, GENERATION_ENGINE_PATH)
  const generationRuntimeSource = exactSource(program, BROWSER_GENERATION_COMMAND_RUNTIME_PATH)
  const terminalizationSource = exactSource(program, ATTEMPT_TERMINALIZATION_PATH)
  const catalogRuntimeSource = exactSource(program, BROWSER_CATALOG_COMMAND_RUNTIME_PATH)
  const workspaceProtocolSource = exactSource(program, 'src/store/workspace-protocol.ts')
  const mutationRuntimeSource = exactSource(program, 'src/store/browser-mutation-runtime.ts')
  const mutationPlanSource = exactSource(program, 'src/store/browser-mutation-plan.ts')
  const mutationJournalSource = exactSource(program, MUTATION_JOURNAL_PATH)
  const repositorySource = exactSource(program, 'src/store/repository.ts')
  const semanticSource = exactSource(program, SEMANTIC_OPERATION_CAPABILITY_PATH)
  const attachmentReferenceSource = exactSource(program, 'src/store/attachment-reference-edges.ts')
  const attachmentCatalogSource = exactSource(program, 'src/store/attachment-catalog-projection.ts')
  const byteOwnerSource = exactSource(program, BYTE_OWNER_MUTATION_PATH)
  const attachmentsSource = exactSource(program, ATTACHMENTS_PATH)
  const attachmentBulkDeleteSource = exactSource(program, ATTACHMENT_BULK_DELETE_PATH)
  const storageMaintenanceSource = exactSource(program, 'src/store/storage-maintenance-runtime.ts')
  const chatRowSource = exactSource(program, 'src/store/chat-row-transition.ts')
  const sidebarProjectionSource = exactSource(program, 'src/store/chat-sidebar-projection.ts')
  const profileUsageProjectionSource = exactSource(
    program,
    'src/store/configuration-profile-usage-projection.ts',
  )
  const repositoryRunMutation = findMethod(
    browserRepoSource,
    'BrowserWorkspaceRepository',
    'runMutation',
  )
  const runnerPortRunMutation = findInterfaceMethod(
    domainSource,
    'BrowserMutationRunnerPort',
    'runMutation',
  )
  const messageRepositoryRunMutation = findInterfaceMethod(
    messagesSource,
    'MessageMutationRepository',
    'runMutation',
  )
  const semanticTerminals = [
    repositoryRunMutation,
    runnerPortRunMutation,
    messageRepositoryRunMutation,
  ]
  const dispatchClauses = commandDispatchCaseStatements(browserRepoSource)
  const routes = new Map()
  for (const variant of workspaceUnion.variants) {
    const route = commandRouteFacts(checker, dispatchClauses.get(variant) ?? [], semanticTerminals)
    routes.set(variant, route)
  }

  const declared = [...scopeDerivedMutationUnion.variants].sort()
  const routed = [...routes]
    .filter(([, route]) => route.semanticTerminals.length > 0)
    .map(([variant]) => variant)
    .sort()
  compareExact('scope-derived mutation command routes', declared, routed, outputProblems)

  const commonKernel = scopeDerivedMutationCommonKernelFacts(
    checker,
    browserRepoSource,
    domainSource,
    mutationRuntimeSource,
    mutationPlanSource,
    repositoryRunMutation,
  )
  for (const [name, consumed] of Object.entries(commonKernel)) {
    if (!consumed) outputProblems.push(`scope-derived mutation common kernel missing ${name}`)
  }

  const commonConsumed = Object.values(commonKernel).every(Boolean)
  const fixedReceiptPolicy = findFunction(mutationPlanSource, 'scopeDerivedMutationReceiptPolicy')
  const fixedPolicyBodies = switchCaseBodiesForExpression(
    fixedReceiptPolicy,
    'command.kind',
    mutationPlanSource,
  )
  const messageCapability = findFunction(messagesSource, 'messageBodyMutationCapability')
  const messageCapabilityBodies = switchCaseBodiesForExpression(
    messageCapability,
    'input.kind',
    messagesSource,
  )
  const mutateMessageBodyText = findFunction(
    messagesSource,
    'mutateMessageBodyInRepository',
  ).getText(messagesSource)
  const compileMutationScopesText = findFunction(
    mutationPlanSource,
    'compileMutationScopes',
  ).getText(mutationPlanSource)
  const runBrowserMutation = findFunction(mutationRuntimeSource, 'runBrowserMutation')
  const runBrowserMutationText = runBrowserMutation.getText(mutationRuntimeSource)
  const messageVariants = [...messageCapabilityBodies.keys()].sort()
  const fixedVariants = [...fixedPolicyBodies]
    .filter(
      ([variant, body]) =>
        variant !== 'draft.put' &&
        variant !== 'attachment.bytes.delete' &&
        variant !== 'attachment.bundle.write' &&
        variant !== 'attachment.delete-if-unreferenced' &&
        variant !== 'attachment.delete-many' &&
        !body.includes('return undefined'),
    )
    .map(([variant]) => variant)
    .sort()
  const attemptVariants = [...attemptMutationUnion.variants].sort()
  const materializeVariants = fixedVariants.filter(
    (variant) => !messageVariants.includes(variant) && !attemptVariants.includes(variant),
  )
  const replayVariants = [...messageVariants, ...materializeVariants].sort()
  const constructors = constructorSitesByVariant(workspaceUnion, true)
  const constructorFacts = replayVariants.map((variant) => {
    const sites = constructors.get(variant) ?? []
    if (sites.length !== 1) return Object.freeze({ variant, singleSubmit: false })
    const site = sites[0]
    if (
      site.path !== 'src/store/chats.ts' &&
      site.path !== 'src/store/conversation-command-client.ts'
    ) {
      return Object.freeze({ variant, singleSubmit: false })
    }
    const source = exactSource(program, site.path)
    const owner = findFunctionOrVariableInitializer(source, site.owner)
    const calls = executableCalls(owner)
    if (site.path === 'src/store/chats.ts') {
      const ownerText = owner.getText(source)
      return Object.freeze({
        variant,
        path: site.path,
        owner: site.owner,
        calls: Object.freeze(calls.map((call) => call.expression.getText(source))),
        singleSubmit:
          countOccurrences(ownerText, "runWorkspaceAction('chat-metadata'") === 1 &&
          countOccurrences(ownerText, '.execute(') === 1 &&
          !ownerText.includes(`return ${site.owner}(`),
      })
    }
    const submitName = 'executeConversationCommand'
    const submits = calls.filter((call) => call.expression.getText(source).endsWith(submitName))
    return Object.freeze({
      variant,
      path: site.path,
      owner: site.owner,
      calls: Object.freeze(calls.map((call) => call.expression.getText(source))),
      singleSubmit:
        submits.length === 1 &&
        !callHasIterationAncestor(submits[0], owner) &&
        !calls.some((call) => call.expression.getText(source).endsWith(site.owner)),
    })
  })
  const constructorSingleSubmit = constructorFacts.every((fact) => fact.singleSubmit)
  const fixedReceiptCommon = Object.freeze({
    familyDerived:
      fixedVariants.length === 8 &&
      messageVariants.length === 4 &&
      attemptVariants.length === 3 &&
      materializeVariants.length === 1 &&
      fixedVariants.every((variant) => declared.includes(variant)) &&
      attemptVariants.every((variant) => fixedVariants.includes(variant)),
    exactInvalidationsBound:
      mutationPlanSource
        .getText()
        .includes('semanticOperationExactMutationAndInvalidationReceiptContracts') &&
      mutationPlanSource.getText().includes('receiptPolicy'),
    constructiveDependencies:
      mutationJournalSource
        .getText()
        .includes('boundSemanticOperationExactReceiptAccumulator(tx)?.dependency(invalidation)') &&
      mutationRuntimeSource.getText().includes("kind: 'message-header'") &&
      mutationRuntimeSource.getText().includes("kind: 'message-body'") &&
      mutationRuntimeSource.getText().includes("kind: 'message-preview'"),
    observedDependencies:
      browserRepoSource.getText().includes('...facts.messageRevisions.flatMap((revision) => [') &&
      browserRepoSource.getText().includes("kind: 'message-preview' as const"),
    messageSummaryPreserved:
      messagesSource.getText().includes('messageBodyMutationCapability(input)') &&
      messagesSource.getText().includes("capability.summary !== 'preserves'"),
    replayPolicyBound:
      mutationPlanSource.getText().includes('semanticOperationCallerSingleAttemptReplayContract') &&
      fixedPolicyBodies.get(materializeVariants[0])?.includes("replayReason: 'random-identity'") ===
        true &&
      messageCapabilityBodies.size === 4 &&
      [...messageCapabilityBodies.values()].every(
        (body) =>
          body.includes("replayReason: 'unfenced-relative-update'") ||
          body.includes("replayReason: 'non-replayable'"),
      ),
    constructorSingleSubmit,
    constructorFacts: Object.freeze(constructorFacts),
    ...workspaceRuntimeSingleAttemptFacts(program),
  })
  const fixedReceiptEffectsProved =
    fixedReceiptCommon.familyDerived &&
    fixedReceiptCommon.exactInvalidationsBound &&
    fixedReceiptCommon.constructiveDependencies &&
    fixedReceiptCommon.observedDependencies &&
    fixedReceiptCommon.messageSummaryPreserved
  const fixedReceiptReplayProved =
    fixedReceiptCommon.familyDerived &&
    fixedReceiptCommon.replayPolicyBound &&
    fixedReceiptCommon.constructorSingleSubmit &&
    fixedReceiptCommon.runningRuntimeSingleInvoke &&
    fixedReceiptCommon.waitingRuntimeSingleInvoke &&
    fixedReceiptCommon.admittedRootSingleInvoke
  const draftPutOwner = findMethod(browserRepoSource, 'BrowserWorkspaceRepository', 'putDraftRow')
  const draftPutText = draftPutOwner.getText(browserRepoSource)
  const draftPutPlanOwner = findFunction(browserRepoSource, 'readDraftPutPlan')
  const draftPutPlanText = draftPutPlanOwner.getText(browserRepoSource)
  const attachmentOwnerScopesOwner = findFunction(browserRepoSource, 'attachmentOwnerScopes')
  const repositoryPutDraft = findInterfaceMethod(repositorySource, 'MutationContext', 'putDraft')
  const draftPutAttachmentIdsText = findFunction(
    browserRepoSource,
    'draftPutAttachmentIds',
  ).getText(browserRepoSource)
  const preflightReceiptText = findFunction(
    semanticSource,
    'semanticOperationCommandLifetimeReceiptWithPreflight',
  ).getText(semanticSource)
  const attachLifetimeReadsText = findFunction(
    semanticSource,
    'attachSemanticOperationExactPhysicalReads',
  ).getText(semanticSource)
  const readPreflightOwner = findMethod(
    browserRepoSource,
    'BrowserCommandCommit',
    'readSemanticOperationPreflight',
  )
  const runTransactionText = findMethod(
    browserRepoSource,
    'BrowserCommandCommit',
    'runTransaction',
  ).getText(browserRepoSource)
  const runTransactionOwner = findMethod(
    browserRepoSource,
    'BrowserCommandCommit',
    'runTransaction',
  )
  const attachmentTransitionText = findFunction(
    attachmentReferenceSource,
    'applyAttachmentReferenceOwnerTransitions',
  ).getText(attachmentReferenceSource)
  const requireAttachmentTargetsText = findFunction(
    attachmentReferenceSource,
    'requireAttachmentTargets',
  ).getText(attachmentReferenceSource)
  const putDraftByteOwnerText = findFunction(byteOwnerSource, 'putDraftByteOwner').getText(
    byteOwnerSource,
  )
  const putWorkspaceDraft = findFunction(attachmentsSource, 'putWorkspaceDraft')
  const putWorkspaceDraftText = putWorkspaceDraft.getText(attachmentsSource)
  const draftConstructors = constructors.get('draft.put') ?? []
  const draftRuntimeSingleAttempt = workspaceRuntimeSingleAttemptFacts(program)
  const draftPutCalls = executableCalls(draftPutOwner)
  const draftPlanCalls = executableCalls(draftPutPlanOwner)
  const draftRunMutationCalls = draftPutCalls.filter((call) =>
    callResolvesTo(checker, call, repositoryRunMutation),
  )
  const draftRunMutationCall = draftRunMutationCalls[0]
  const draftScopeCall = draftRunMutationCall?.arguments[0]
    ? unwrap(draftRunMutationCall.arguments[0])
    : undefined
  const draftMutationCallback = draftRunMutationCall?.arguments[1]
    ? unwrap(draftRunMutationCall.arguments[1])
    : undefined
  const draftMutationCallbackCalls =
    draftMutationCallback && ts.isFunctionLike(draftMutationCallback)
      ? executableCalls(draftMutationCallback)
      : []
  const callbackPutDraftCalls = draftMutationCallbackCalls.filter((call) =>
    callResolvesTo(checker, call, repositoryPutDraft),
  )
  const runtimePutDraft = findNestedObjectPropertyFunction(runBrowserMutation, 'putDraft')
  const syncAttachmentReferenceOwner = findNestedVariableFunction(
    runBrowserMutation,
    'syncAttachmentReferenceOwner',
  )
  const applyAttachmentTransitionsOwner = findFunction(
    attachmentReferenceSource,
    'applyAttachmentReferenceOwnerTransitions',
  )
  const attachmentTransitionReceiptOwner = findFunction(
    attachmentReferenceSource,
    'attachmentReferenceTransitionReceipt',
  )
  const applyAttachmentReferenceDeltasOwner = findFunction(
    attachmentReferenceSource,
    'applyAttachmentReferenceDeltas',
  )
  const absorbReceiptFragmentOwner = findFunction(
    semanticSource,
    'absorbSemanticOperationReceiptFragment',
  )
  const recordOwnerInvalidationOwner = findFunction(
    mutationJournalSource,
    'recordBrowserCommandOwnerInvalidation',
  )
  const transitionCalls = executableCalls(applyAttachmentTransitionsOwner)
  const transitionReceiptCalls = transitionCalls.filter((call) =>
    callResolvesTo(checker, call, attachmentTransitionReceiptOwner),
  )
  const transitionAbsorbCalls = transitionCalls.filter((call) =>
    callResolvesTo(checker, call, absorbReceiptFragmentOwner),
  )
  const transitionInvalidationCalls = transitionCalls.filter((call) =>
    callResolvesTo(checker, call, recordOwnerInvalidationOwner),
  )
  const receiptFactoryCalls = executableCalls(attachmentTransitionReceiptOwner).filter(
    (call) =>
      call.expression.getText(attachmentReferenceSource) === 'semanticOperationReceiptFragment',
  )
  const receiptFactoryDefinition = receiptFactoryCalls[0]?.arguments[0]
    ? unwrap(receiptFactoryCalls[0].arguments[0])
    : undefined
  const workspaceDraftCalls = executableCalls(putWorkspaceDraft)
  const workspaceDraftActionCalls = workspaceDraftCalls.filter(
    (call) => call.expression.getText(attachmentsSource) === 'runWorkspaceAction',
  )
  const workspaceDraftCallback = workspaceDraftActionCalls[0]?.arguments[1]
    ? unwrap(workspaceDraftActionCalls[0].arguments[1])
    : undefined
  const workspaceDraftExecuteCalls =
    workspaceDraftCallback && ts.isFunctionLike(workspaceDraftCallback)
      ? executableCalls(workspaceDraftCallback).filter((call) =>
          call.expression.getText(attachmentsSource).endsWith('.execute'),
        )
      : []
  const draftPreflightCalls = draftPlanCalls.filter(
    (call) =>
      call.expression.getText(browserRepoSource) === 'commit.readSemanticOperationPreflight',
  )
  const draftPreflightCall = draftPreflightCalls[0]
  const observedPreflightCallback = draftPreflightCall?.arguments[1]
    ? unwrap(draftPreflightCall.arguments[1])
    : undefined
  const exactPreflightCallback = draftPreflightCall?.arguments[2]
    ? unwrap(draftPreflightCall.arguments[2])
    : undefined
  const commitPreflightReceiptCalls = executableCalls(readPreflightOwner).filter(
    (call) =>
      call.expression.getText(browserRepoSource) ===
      'semanticOperationCommandLifetimeReceiptWithPreflight',
  )
  const transactionGrantCalls = executableCalls(runTransactionOwner).filter(
    (call) => call.expression.getText(browserRepoSource) === 'grant.runTransaction',
  )
  const transactionGrantCallback = transactionGrantCalls[0]?.arguments[2]
    ? unwrap(transactionGrantCalls[0].arguments[2])
    : undefined
  const transactionAttachReadCalls =
    transactionGrantCallback && ts.isFunctionLike(transactionGrantCallback)
      ? executableCalls(transactionGrantCallback).filter(
          (call) =>
            call.expression.getText(browserRepoSource) ===
            'attachSemanticOperationExactPhysicalReads',
        )
      : []
  const scopeProfileText = findFunction(
    mutationPlanSource,
    'planMutationSemanticOperation',
  ).getText(mutationPlanSource)
  const compileScopesText = findFunction(mutationPlanSource, 'compileMutationScopes').getText(
    mutationPlanSource,
  )
  const receiptDefinition =
    receiptFactoryDefinition && ts.isObjectLiteralExpression(receiptFactoryDefinition)
      ? receiptFactoryDefinition
      : undefined
  const receiptDependenciesText =
    objectPropertyInitializer(receiptDefinition, 'dependencies')?.getText(
      attachmentReferenceSource,
    ) ?? ''
  const receiptMutationsText =
    objectPropertyInitializer(receiptDefinition, 'physicalMutations')?.getText(
      attachmentReferenceSource,
    ) ?? ''
  const receiptReadsText =
    objectPropertyInitializer(receiptDefinition, 'physicalReads')?.getText(
      attachmentReferenceSource,
    ) ?? ''
  const draftPreflightProofFacts = Object.freeze({
    onePreflight:
      draftPreflightCalls.length === 1 &&
      !callHasIterationAncestor(draftPreflightCall, draftPutPlanOwner),
    typedPlan:
      draftPreflightCall?.arguments[0]?.getText(browserRepoSource) ===
      'DRAFT_PUT_PREFLIGHT_TRANSACTION_PLAN',
    observedRead:
      observedPreflightCallback
        ?.getText(browserRepoSource)
        .includes("table<DraftRow, ChatId>('drafts').get(input.draft.chatId)") === true,
    exactRead:
      exactPreflightCallback?.getText(browserRepoSource).includes("tableName: 'drafts'") === true &&
      exactPreflightCallback?.getText(browserRepoSource).includes("operation: 'get'") === true,
    lifetimeReceipt:
      commitPreflightReceiptCalls.length === 1 &&
      !callHasIterationAncestor(commitPreflightReceiptCalls[0], readPreflightOwner),
    transactionAttachment:
      transactionGrantCalls.length === 1 &&
      transactionAttachReadCalls.length === 1 &&
      !callHasIterationAncestor(transactionAttachReadCalls[0], transactionGrantCallback),
    exactReceiptComposition:
      preflightReceiptText.includes('...receipt.exactPhysicalReads') &&
      preflightReceiptText.includes('...exactPhysicalReads') &&
      attachLifetimeReadsText.includes(
        'physicalReads: [...exact.physicalReads, ...physicalReads]',
      ) &&
      runTransactionText.includes('this.commandLifetimeReceipt.exactPhysicalReads'),
  })
  const draftPutCommon = Object.freeze({
    exactOccurrencePolicy:
      fixedPolicyBodies.get('draft.put')?.includes('exactOccurrence: true') === true &&
      mutationPlanSource
        .getText()
        .includes('receiptPolicy?.exactOccurrence || receiptPolicy?.exactPlan'),
    typedReplayPolicy:
      fixedPolicyBodies.get('draft.put')?.includes("replayReason: 'unfenced-relative-update'") ===
      true,
    typedCommandLifetimePreflight: Object.values(draftPreflightProofFacts).every(Boolean),
    exactResourcePlan:
      draftRunMutationCalls.length === 1 &&
      draftScopeCall !== undefined &&
      ts.isCallExpression(draftScopeCall) &&
      callResolvesTo(checker, draftScopeCall, attachmentOwnerScopesOwner) &&
      draftScopeCall.arguments[1]?.getText(browserRepoSource) === 'attachmentIds' &&
      !callHasIterationAncestor(draftRunMutationCall, draftPutOwner) &&
      draftPutAttachmentIdsText.includes('new Set(liveAttachmentRefs(refs)') &&
      draftPutAttachmentIdsText.includes('.sort()') &&
      draftPutPlanText.includes('previousAttachmentIds: draftPutAttachmentIds(') &&
      draftPutPlanText.includes('nextAttachmentIds: draftPutAttachmentIds(') &&
      draftPutText.includes('...plan.previousAttachmentIds') &&
      draftPutText.includes('...plan.nextAttachmentIds') &&
      attachmentOwnerScopesOwner
        .getText(browserRepoSource)
        .includes('...attachmentIds.map((attachmentId) => ({') &&
      attachmentOwnerScopesOwner
        .getText(browserRepoSource)
        .includes("kind: 'attachment' as const") &&
      draftPutText.includes('new DraftPutPlanChangedError('),
    transactionLocalValidation:
      draftRunMutationCalls.length === 1 &&
      draftMutationCallback !== undefined &&
      ts.isFunctionLike(draftMutationCallback) &&
      callbackPutDraftCalls.length === 1 &&
      !callHasIterationAncestor(callbackPutDraftCalls[0], draftMutationCallback) &&
      callbackPutDraftCalls[0]?.arguments[1]?.getText(browserRepoSource) ===
        '{ validateAttachmentTargets: true }' &&
      draftPutText.includes('const current = await ctx.getDraft(') &&
      draftPutText.includes('(current?.updatedAt ?? null) !== input.expectedUpdatedAt') &&
      !draftPutText.includes('this.getDraft(') &&
      !draftPutText.includes('ctx.getAttachment('),
    narrowTransactionProfile:
      scopeProfileText.includes("command.kind === 'draft.put'") &&
      scopeProfileText.includes("? 'draft-reference-update'") &&
      compileScopesText.includes("storageProfile !== 'draft-reference-update'") &&
      compileScopesText.includes("storageProfile !== 'attachment-payload'") &&
      compileScopesText.includes("['attachmentCatalogAggregate', 'attachmentCatalogRows']") &&
      compileScopesText.includes("builder.addMutationTable('attachmentRefEdges', 'attachment')") &&
      compileScopesText.includes("builder.addMutationTable('attachments', 'attachment')") &&
      compileScopesText.includes("builder.addMutationTable('drafts', 'draft')") &&
      !runtimePutDraft.getText(mutationRuntimeSource).includes('ensureChatState(') &&
      !runBrowserMutationText
        .slice(
          runBrowserMutationText.indexOf('for (const scope of scopes)'),
          runBrowserMutationText.indexOf('const requireChatState'),
        )
        .includes("scope.kind === 'draft'"),
    constructivePhysicalAccess:
      countOccurrences(
        runtimePutDraft.getText(mutationRuntimeSource),
        'await syncAttachmentReferenceOwner({',
      ) === 1 &&
      countOccurrences(
        runtimePutDraft.getText(mutationRuntimeSource),
        'await putDraftByteOwner(tx, normalized, existing)',
      ) === 1 &&
      runtimePutDraft.getText(mutationRuntimeSource).includes("ownerKind: 'draft'") &&
      runtimePutDraft.getText(mutationRuntimeSource).includes('ownerId: normalized.chatId') &&
      runtimePutDraft.getText(mutationRuntimeSource).includes('chatId: normalized.chatId') &&
      runtimePutDraft
        .getText(mutationRuntimeSource)
        .includes('previousRefs: existing?.attachmentRefs') &&
      runtimePutDraft
        .getText(mutationRuntimeSource)
        .includes('nextRefs: normalized.attachmentRefs') &&
      runtimePutDraft
        .getText(mutationRuntimeSource)
        .includes('draftOptions?.validateAttachmentTargets') &&
      runtimePutDraft
        .getText(mutationRuntimeSource)
        .includes('{ validateUnchangedTargets: true }') &&
      !runtimePutDraft.getText(mutationRuntimeSource).includes('for (') &&
      !runtimePutDraft.getText(mutationRuntimeSource).includes('while (') &&
      syncAttachmentReferenceOwner
        .getText(mutationRuntimeSource)
        .includes('await applyAttachmentReferenceOwnerTransitions(tx, [input], now,') &&
      attachmentTransitionText.includes('await requireAttachmentTargets(tx, [...nextTargetIds])') &&
      runBrowserMutationText.includes(
        'const draftReads = new Map<ChatId, DraftRow | undefined>()',
      ) &&
      runBrowserMutationText.includes("tableName: 'drafts'") &&
      runBrowserMutationText.includes('if (operationPlan.descriptor.exactPhysicalReads &&') &&
      requireAttachmentTargetsText.includes(
        "table<AttachmentHeaderRow, AttachmentId>('attachments')",
      ) &&
      requireAttachmentTargetsText.includes('bulkGet([...attachmentIds])') &&
      putDraftByteOwnerText.includes("putPhysicalStorageRow<DraftRow, string>(tx, 'drafts'") &&
      putDraftByteOwnerText.includes("kind: 'draft'"),
    constructiveExactReceipt:
      transitionCalls.filter((call) =>
        callResolvesTo(checker, call, applyAttachmentReferenceDeltasOwner),
      ).length === 1 &&
      transitionReceiptCalls.length === 3 &&
      transitionAbsorbCalls.length === 2 &&
      transitionInvalidationCalls.length === 1 &&
      callForOfAncestorExpressionText(
        transitionInvalidationCalls[0],
        applyAttachmentTransitionsOwner,
        attachmentReferenceSource,
      ) === 'receipt.fragment.dependencies' &&
      receiptFactoryCalls.length === 1 &&
      receiptDependenciesText.includes('mutationAttachmentIds') &&
      receiptMutationsText.includes('removedEdgeKeys') &&
      receiptMutationsText.includes('writtenEdgeKeys') &&
      receiptMutationsText.includes('delta.headerWriteIds') &&
      receiptMutationsText.includes('delta.catalog.fragment.physicalMutations') &&
      receiptReadsText.includes('targetReadIds') &&
      receiptReadsText.includes('delta.headerReadIds') &&
      receiptReadsText.includes('delta.catalog.fragment.physicalReads') &&
      attachmentTransitionText.includes('recordBrowserCommandOwnerInvalidation(tx, dependency)') &&
      attachmentTransitionText.includes(
        'absorbSemanticOperationReceiptFragment(tx, receipt.fragment)',
      ),
    oneApplicationSubmission:
      draftConstructors.length === 1 &&
      draftConstructors[0]?.path === ATTACHMENTS_PATH &&
      draftConstructors[0]?.owner === 'putWorkspaceDraft' &&
      workspaceDraftActionCalls.length === 1 &&
      workspaceDraftExecuteCalls.length === 1 &&
      !callHasIterationAncestor(workspaceDraftActionCalls[0], putWorkspaceDraft) &&
      !callHasIterationAncestor(workspaceDraftExecuteCalls[0], workspaceDraftCallback) &&
      putWorkspaceDraftText.includes("runWorkspaceAction('attachment'") &&
      !putWorkspaceDraftText.includes('return putWorkspaceDraft('),
    noRetryOrBroadPlanning:
      !draftPutText.includes('for (;;)') &&
      !draftPutText.includes('setTimeout(') &&
      !draftPutText.includes('.withLocks(') &&
      !draftPutText.includes('catch ('),
    ...draftRuntimeSingleAttempt,
  })
  for (const [name, proved] of Object.entries(draftPutCommon)) {
    if (!proved) outputProblems.push(`draft put mutation family missing ${name}`)
  }
  for (const [name, proved] of Object.entries(draftPreflightProofFacts)) {
    if (!proved) outputProblems.push(`draft put command-lifetime preflight missing ${name}`)
  }
  const draftPutTablesProved =
    commonConsumed &&
    draftPutCommon.typedCommandLifetimePreflight &&
    draftPutCommon.exactResourcePlan &&
    draftPutCommon.transactionLocalValidation &&
    draftPutCommon.narrowTransactionProfile &&
    draftPutCommon.constructivePhysicalAccess &&
    draftPutCommon.noRetryOrBroadPlanning
  const draftPutReceiptProved =
    draftPutTablesProved &&
    draftPutCommon.exactOccurrencePolicy &&
    draftPutCommon.constructiveExactReceipt
  const draftPutReplayProved =
    commonConsumed &&
    draftPutCommon.typedReplayPolicy &&
    draftPutCommon.oneApplicationSubmission &&
    draftPutCommon.runningRuntimeSingleInvoke &&
    draftPutCommon.waitingRuntimeSingleInvoke &&
    draftPutCommon.admittedRootSingleInvoke
  const attachmentBytesOwner = findMethod(
    browserRepoSource,
    'BrowserWorkspaceRepository',
    'deleteAttachmentBytes',
  )
  const repositoryDeleteAttachmentBytes = findInterfaceMethod(
    repositorySource,
    'MutationContext',
    'deleteAttachmentBytes',
  )
  const runtimeDeleteAttachmentBytes = findNestedObjectPropertyFunction(
    runBrowserMutation,
    'deleteAttachmentBytes',
  )
  const runtimeDeleteAttachmentBytesForHeader = findNestedVariableFunction(
    runBrowserMutation,
    'deleteAttachmentBytesForHeader',
  )
  const deleteReferencedAttachmentBytes = findFunction(
    attachmentsSource,
    'deleteReferencedAttachmentBytes',
  )
  const attachmentBytesConstructors = constructors.get('attachment.bytes.delete') ?? []
  const attachmentBytesCalls = executableCalls(attachmentBytesOwner)
  const attachmentBytesRunMutationCalls = attachmentBytesCalls.filter((call) =>
    callResolvesTo(checker, call, repositoryRunMutation),
  )
  const attachmentBytesRunMutationCall = attachmentBytesRunMutationCalls[0]
  const attachmentBytesMutationCallback = attachmentBytesRunMutationCall?.arguments[1]
    ? unwrap(attachmentBytesRunMutationCall.arguments[1])
    : undefined
  const attachmentBytesCallbackCalls =
    attachmentBytesMutationCallback && ts.isFunctionLike(attachmentBytesMutationCallback)
      ? executableCalls(attachmentBytesMutationCallback)
      : []
  const attachmentBytesContextCalls = attachmentBytesCallbackCalls.filter((call) =>
    callResolvesTo(checker, call, repositoryDeleteAttachmentBytes),
  )
  const runtimeAttachmentBytesCalls = [
    ...executableCalls(runtimeDeleteAttachmentBytes),
    ...executableCalls(runtimeDeleteAttachmentBytesForHeader),
  ]
  const runtimeAttachmentBytesPhysicalReads = runtimeAttachmentBytesCalls
    .filter(
      (call) =>
        call.expression.getText(mutationRuntimeSource) === 'receiptAccumulator.physicalRead',
    )
    .map((call) => (call.arguments[0] ? unwrap(call.arguments[0]) : undefined))
    .filter((node) => node && ts.isObjectLiteralExpression(node))
  const hasAttachmentBytesPhysicalRead = (
    tableName,
    indexKind,
    operation,
    rowCount,
    indexName = undefined,
  ) =>
    runtimeAttachmentBytesPhysicalReads.some(
      (read) =>
        objectPropertyInitializer(read, 'tableName')?.getText(mutationRuntimeSource) ===
          `'${tableName}'` &&
        objectPropertyInitializer(read, 'indexKind')?.getText(mutationRuntimeSource) ===
          `'${indexKind}'` &&
        objectPropertyInitializer(read, 'operation')?.getText(mutationRuntimeSource) ===
          `'${operation}'` &&
        (indexName === undefined ||
          objectPropertyInitializer(read, 'indexName')?.getText(mutationRuntimeSource) ===
            `'${indexName}'`) &&
        objectPropertyInitializer(read, 'requestCount')?.getText(mutationRuntimeSource) === '1' &&
        objectPropertyInitializer(read, 'rowCount')?.getText(mutationRuntimeSource) === rowCount,
    )
  const deleteAttachmentBlobRowsOwner = findFunction(byteOwnerSource, 'deleteAttachmentBlobRows')
  const deletePhysicalStorageRowsOwner = findFunction(byteOwnerSource, 'deletePhysicalStorageRows')
  const putPhysicalStorageRowsOwner = findFunction(byteOwnerSource, 'putPhysicalStorageRows')
  const putAttachmentHeaderByteOwnerOwner = findFunction(
    byteOwnerSource,
    'putAttachmentHeaderByteOwner',
  )
  const putAttachmentCatalogProjectionOwner = findFunction(
    attachmentCatalogSource,
    'putAttachmentCatalogProjectionFromHeader',
  )
  const recordAttachmentReferenceStateOwner = findFunction(
    mutationJournalSource,
    'recordBrowserCommandAttachmentReferenceState',
  )
  const attachmentBytesBlobDeleteCalls = runtimeAttachmentBytesCalls.filter((call) =>
    callResolvesTo(checker, call, deleteAttachmentBlobRowsOwner),
  )
  const attachmentBytesSidecarDeleteCalls = runtimeAttachmentBytesCalls.filter((call) =>
    callResolvesTo(checker, call, deletePhysicalStorageRowsOwner),
  )
  const attachmentBytesSidecarWriteCalls = runtimeAttachmentBytesCalls.filter((call) =>
    callResolvesTo(checker, call, putPhysicalStorageRowsOwner),
  )
  const attachmentBytesHeaderWriteCalls = runtimeAttachmentBytesCalls.filter((call) =>
    callResolvesTo(checker, call, putAttachmentHeaderByteOwnerOwner),
  )
  const attachmentBytesCatalogWriteCalls = runtimeAttachmentBytesCalls.filter((call) =>
    callResolvesTo(checker, call, putAttachmentCatalogProjectionOwner),
  )
  const attachmentBytesReceiptAbsorbCalls = runtimeAttachmentBytesCalls.filter((call) =>
    callResolvesTo(checker, call, absorbReceiptFragmentOwner),
  )
  const recordInvalidationOwner = findFunction(
    mutationJournalSource,
    'recordBrowserCommandInvalidation',
  )
  const attachmentBytesJobInvalidationCalls = runtimeAttachmentBytesCalls.filter((call) =>
    callResolvesTo(checker, call, recordInvalidationOwner),
  )
  const attachmentBytesReferenceStateCalls = runtimeAttachmentBytesCalls.filter((call) =>
    callResolvesTo(checker, call, recordAttachmentReferenceStateOwner),
  )
  const attachmentBytesWriterCalls = [
    ...attachmentBytesBlobDeleteCalls,
    ...attachmentBytesSidecarDeleteCalls,
    ...attachmentBytesSidecarWriteCalls,
    ...attachmentBytesHeaderWriteCalls,
    ...attachmentBytesCatalogWriteCalls,
    ...attachmentBytesReceiptAbsorbCalls,
    ...attachmentBytesReferenceStateCalls,
  ]
  const attachmentCatalogCalls = executableCalls(putAttachmentCatalogProjectionOwner)
  const attachmentCatalogReceiptOwner = findFunction(
    attachmentCatalogSource,
    'attachmentCatalogReferenceMutationReceipt',
  )
  const attachmentCatalogReceiptCalls = attachmentCatalogCalls.filter((call) =>
    callResolvesTo(checker, call, attachmentCatalogReceiptOwner),
  )
  const attachmentCatalogReceiptFactoryCalls = executableCalls(
    attachmentCatalogReceiptOwner,
  ).filter(
    (call) =>
      call.expression.getText(attachmentCatalogSource) === 'semanticOperationReceiptFragment',
  )
  const attachmentCatalogReceiptDefinition = attachmentCatalogReceiptFactoryCalls[0]?.arguments[0]
    ? unwrap(attachmentCatalogReceiptFactoryCalls[0].arguments[0])
    : undefined
  const attachmentCatalogReceiptObject =
    attachmentCatalogReceiptDefinition &&
    ts.isObjectLiteralExpression(attachmentCatalogReceiptDefinition)
      ? attachmentCatalogReceiptDefinition
      : undefined
  const attachmentCatalogDependenciesText =
    objectPropertyInitializer(attachmentCatalogReceiptObject, 'dependencies')?.getText(
      attachmentCatalogSource,
    ) ?? ''
  const attachmentCatalogMutationsText =
    objectPropertyInitializer(attachmentCatalogReceiptObject, 'physicalMutations')?.getText(
      attachmentCatalogSource,
    ) ?? ''
  const attachmentCatalogReadsText =
    objectPropertyInitializer(attachmentCatalogReceiptObject, 'physicalReads')?.getText(
      attachmentCatalogSource,
    ) ?? ''
  const deleteReferencedAttachmentBytesCalls = executableCalls(deleteReferencedAttachmentBytes)
  const attachmentBytesActionCalls = deleteReferencedAttachmentBytesCalls.filter(
    (call) => call.expression.getText(attachmentsSource) === 'runWorkspaceAction',
  )
  const attachmentBytesActionCallback = attachmentBytesActionCalls[0]?.arguments[1]
    ? unwrap(attachmentBytesActionCalls[0].arguments[1])
    : undefined
  const attachmentBytesExecuteCalls =
    attachmentBytesActionCallback && ts.isFunctionLike(attachmentBytesActionCallback)
      ? executableCalls(attachmentBytesActionCallback).filter((call) =>
          call.expression.getText(attachmentsSource).endsWith('.execute'),
        )
      : []
  const attachmentBytesRuntimeSingleAttempt = workspaceRuntimeSingleAttemptFacts(program)
  const attachmentBytesCommon = Object.freeze({
    exactOccurrencePolicy:
      fixedPolicyBodies.get('attachment.bytes.delete')?.includes('exactOccurrence: true') ===
        true &&
      mutationPlanSource
        .getText()
        .includes('receiptPolicy?.exactOccurrence || receiptPolicy?.exactPlan'),
    typedReplayPolicy:
      fixedPolicyBodies
        .get('attachment.bytes.delete')
        ?.includes("replayReason: 'unfenced-relative-update'") === true,
    oneSemanticRoute:
      attachmentBytesRunMutationCalls.length === 1 &&
      attachmentBytesContextCalls.length === 1 &&
      !callHasIterationAncestor(attachmentBytesRunMutationCall, attachmentBytesOwner) &&
      !callHasIterationAncestor(attachmentBytesContextCalls[0], attachmentBytesMutationCallback) &&
      attachmentBytesRunMutationCall?.arguments[0]?.getText(browserRepoSource) ===
        "[{ kind: 'attachment', attachmentId: input.attachmentId }]" &&
      attachmentBytesContextCalls[0]?.arguments[0]?.getText(browserRepoSource) ===
        'input.attachmentId' &&
      attachmentBytesContextCalls[0]?.arguments[1]?.getText(browserRepoSource) === 'input.reason' &&
      attachmentBytesContextCalls[0]?.arguments[2]?.getText(browserRepoSource) === 'input.now' &&
      !attachmentBytesOwner.getText(browserRepoSource).includes('this.getAttachment(') &&
      !attachmentBytesOwner.getText(browserRepoSource).includes('this.list') &&
      !browserRepoSource.getText().includes('deleteAttachmentBytesInMutation'),
    narrowTransactionProfile:
      scopeProfileText.includes("command.kind === 'attachment.bytes.delete'") &&
      scopeProfileText.includes("? 'attachment-payload'") &&
      compileScopesText.includes(`if (storageProfile !== 'attachment-payload') {
          builder.addMutationTable('attachmentRefEdges', 'attachment')
        }`) &&
      compileScopesText.includes("['attachmentCatalogAggregate', 'attachmentCatalogRows']") &&
      compileScopesText.includes(
        "builder.addMutationTables(['attachmentArtifacts', 'attachmentBlobs'], 'attachment')",
      ) &&
      compileScopesText.includes("builder.addMutationTable('attachmentJobs', 'attachment-job')") &&
      compileScopesText.includes("builder.addMutationTable('attachments', 'attachment')"),
    exactPhysicalReads:
      runtimeAttachmentBytesPhysicalReads.length === 4 &&
      hasAttachmentBytesPhysicalRead('attachments', 'primary', 'get', '1') &&
      hasAttachmentBytesPhysicalRead(
        'attachmentArtifacts',
        'secondary',
        'query',
        'artifacts.length',
        'attachmentId',
      ) &&
      hasAttachmentBytesPhysicalRead(
        'attachmentJobs',
        'secondary',
        'query',
        'jobs.length',
        'attachmentId',
      ) &&
      hasAttachmentBytesPhysicalRead(
        'attachmentBlobs',
        'secondary',
        'query',
        'deletedBlobCount',
        'attachmentId',
      ),
    oneBatchedPhysicalTransition:
      attachmentBytesBlobDeleteCalls.length === 1 &&
      attachmentBytesSidecarDeleteCalls.length === 2 &&
      attachmentBytesSidecarWriteCalls.length === 1 &&
      attachmentBytesHeaderWriteCalls.length === 1 &&
      attachmentBytesCatalogWriteCalls.length === 1 &&
      attachmentBytesWriterCalls.every(
        (call) => !callHasIterationAncestor(call, runtimeDeleteAttachmentBytesForHeader),
      ),
    exactEffectReceipt:
      attachmentBytesReceiptAbsorbCalls.length === 1 &&
      attachmentBytesReferenceStateCalls.length === 1 &&
      attachmentBytesJobInvalidationCalls.length === 1 &&
      attachmentBytesJobInvalidationCalls[0]?.arguments[1]
        ?.getText(mutationRuntimeSource)
        .includes("kind: 'attachment-job'") === true &&
      attachmentBytesJobInvalidationCalls[0]?.arguments[1]
        ?.getText(mutationRuntimeSource)
        .includes('attachmentIds: [attachmentId]') === true &&
      attachmentBytesJobInvalidationCalls[0]?.arguments[1]
        ?.getText(mutationRuntimeSource)
        .includes('jobIds:') === true &&
      deleteAttachmentBlobRowsOwner.getText(byteOwnerSource).includes("kind: 'attachment-job'") &&
      attachmentCatalogReceiptCalls.length === 1 &&
      attachmentCatalogReceiptCalls[0]?.arguments[4]?.getText(attachmentCatalogSource) ===
        "'get'" &&
      attachmentCatalogReceiptFactoryCalls.length === 1 &&
      attachmentCatalogDependenciesText.includes(
        "{ kind: 'attachment', attachmentIds: [...rowWriteIds] }",
      ) &&
      attachmentCatalogMutationsText.includes("tableName: 'attachmentCatalogRows'") &&
      attachmentCatalogMutationsText.includes("tableName: 'attachmentCatalogAggregate'") &&
      attachmentCatalogReadsText.includes("tableName: 'attachmentCatalogRows'") &&
      attachmentCatalogReadsText.includes('operation: rowReadOperation') &&
      attachmentCatalogReadsText.includes("tableName: 'attachmentCatalogAggregate'") &&
      attachmentCatalogReadsText.includes("operation: 'get'"),
    oneApplicationSubmission:
      attachmentBytesConstructors.length === 1 &&
      attachmentBytesConstructors[0]?.path === ATTACHMENTS_PATH &&
      attachmentBytesConstructors[0]?.owner === 'deleteReferencedAttachmentBytes' &&
      attachmentBytesActionCalls.length === 1 &&
      attachmentBytesExecuteCalls.length === 1 &&
      !callHasIterationAncestor(attachmentBytesActionCalls[0], deleteReferencedAttachmentBytes) &&
      !callHasIterationAncestor(attachmentBytesExecuteCalls[0], attachmentBytesActionCallback) &&
      !deleteReferencedAttachmentBytes
        .getText(attachmentsSource)
        .includes('return deleteReferencedAttachmentBytes('),
    noRetryOrBroadPlanning:
      !attachmentBytesOwner.getText(browserRepoSource).includes('for (;;)') &&
      !attachmentBytesOwner.getText(browserRepoSource).includes('setTimeout(') &&
      !attachmentBytesOwner.getText(browserRepoSource).includes('.withLocks(') &&
      !attachmentBytesOwner.getText(browserRepoSource).includes('catch (') &&
      !runtimeDeleteAttachmentBytes.getText(mutationRuntimeSource).includes('for (;;)') &&
      !runtimeDeleteAttachmentBytes.getText(mutationRuntimeSource).includes('setTimeout(') &&
      !runtimeDeleteAttachmentBytes.getText(mutationRuntimeSource).includes('.withLocks(') &&
      !runtimeDeleteAttachmentBytes.getText(mutationRuntimeSource).includes('catch (') &&
      !runtimeDeleteAttachmentBytesForHeader.getText(mutationRuntimeSource).includes('for (;;)') &&
      !runtimeDeleteAttachmentBytesForHeader
        .getText(mutationRuntimeSource)
        .includes('setTimeout(') &&
      !runtimeDeleteAttachmentBytesForHeader
        .getText(mutationRuntimeSource)
        .includes('.withLocks(') &&
      !runtimeDeleteAttachmentBytesForHeader.getText(mutationRuntimeSource).includes('catch (') &&
      !runtimeDeleteAttachmentBytes
        .getText(mutationRuntimeSource)
        .includes('recordObsoleteByteOwnerValues('),
    immediateDuplicateNoop:
      runtimeDeleteAttachmentBytes
        .getText(mutationRuntimeSource)
        .includes('if (!header) return undefined') &&
      runtimeDeleteAttachmentBytesForHeader
        .getText(mutationRuntimeSource)
        .includes(
          'if (!payloadChanged && stableStringify(unchangedHeader) === stableStringify(header))',
        ) &&
      runtimeDeleteAttachmentBytesForHeader
        .getText(mutationRuntimeSource)
        .includes('return current'),
    ...attachmentBytesRuntimeSingleAttempt,
  })
  for (const [name, proved] of Object.entries(attachmentBytesCommon)) {
    if (!proved) outputProblems.push(`attachment byte deletion mutation family missing ${name}`)
  }
  const attachmentBytesTablesProved =
    commonConsumed &&
    attachmentBytesCommon.oneSemanticRoute &&
    attachmentBytesCommon.narrowTransactionProfile &&
    attachmentBytesCommon.exactPhysicalReads &&
    attachmentBytesCommon.oneBatchedPhysicalTransition &&
    attachmentBytesCommon.noRetryOrBroadPlanning
  const attachmentBytesReceiptProved =
    attachmentBytesTablesProved &&
    attachmentBytesCommon.exactOccurrencePolicy &&
    attachmentBytesCommon.exactEffectReceipt
  const attachmentBytesReplayProved =
    commonConsumed &&
    attachmentBytesCommon.typedReplayPolicy &&
    attachmentBytesCommon.oneApplicationSubmission &&
    attachmentBytesCommon.immediateDuplicateNoop &&
    attachmentBytesCommon.runningRuntimeSingleInvoke &&
    attachmentBytesCommon.waitingRuntimeSingleInvoke &&
    attachmentBytesCommon.admittedRootSingleInvoke
  const attachmentBundleOwner = findMethod(
    browserRepoSource,
    'BrowserWorkspaceRepository',
    'writeAttachmentBundle',
  )
  const repositoryWriteAttachmentBundle = findInterfaceMethod(
    repositorySource,
    'MutationContext',
    'writeAttachmentBundle',
  )
  const runtimeWriteAttachmentBundle = findNestedObjectPropertyFunction(
    runBrowserMutation,
    'writeAttachmentBundle',
  )
  const applicationWriteAttachmentBundle = findFunction(attachmentsSource, 'writeAttachmentBundle')
  const attachmentBundleConstructors = constructors.get('attachment.bundle.write') ?? []
  const attachmentBundleOwnerCalls = executableCalls(attachmentBundleOwner)
  const attachmentBundleRunMutationCalls = attachmentBundleOwnerCalls.filter((call) =>
    callResolvesTo(checker, call, repositoryRunMutation),
  )
  const attachmentBundleRunMutationCall = attachmentBundleRunMutationCalls[0]
  const attachmentBundleMutationCallback = attachmentBundleRunMutationCall?.arguments[1]
    ? unwrap(attachmentBundleRunMutationCall.arguments[1])
    : undefined
  const attachmentBundleCallbackCalls =
    attachmentBundleMutationCallback && ts.isFunctionLike(attachmentBundleMutationCallback)
      ? executableCalls(attachmentBundleMutationCallback)
      : []
  const attachmentBundleContextCalls = attachmentBundleCallbackCalls.filter((call) =>
    callResolvesTo(checker, call, repositoryWriteAttachmentBundle),
  )
  const runtimeAttachmentBundleCalls = executableCalls(runtimeWriteAttachmentBundle)
  const runtimeAttachmentBundlePhysicalReads = runtimeAttachmentBundleCalls
    .filter(
      (call) =>
        call.expression.getText(mutationRuntimeSource) === 'receiptAccumulator.physicalRead',
    )
    .map((call) => (call.arguments[0] ? unwrap(call.arguments[0]) : undefined))
    .filter((node) => node && ts.isObjectLiteralExpression(node))
  const hasAttachmentBundlePhysicalRead = (
    tableName,
    indexKind,
    operation,
    rowCount,
    indexName = undefined,
  ) =>
    runtimeAttachmentBundlePhysicalReads.some(
      (read) =>
        objectPropertyInitializer(read, 'tableName')?.getText(mutationRuntimeSource) ===
          `'${tableName}'` &&
        objectPropertyInitializer(read, 'indexKind')?.getText(mutationRuntimeSource) ===
          `'${indexKind}'` &&
        objectPropertyInitializer(read, 'operation')?.getText(mutationRuntimeSource) ===
          `'${operation}'` &&
        (indexName === undefined ||
          objectPropertyInitializer(read, 'indexName')?.getText(mutationRuntimeSource) ===
            `'${indexName}'`) &&
        objectPropertyInitializer(read, 'requestCount')?.getText(mutationRuntimeSource) === '1' &&
        objectPropertyInitializer(read, 'rowCount')?.getText(mutationRuntimeSource) === rowCount,
    )
  const replaceAttachmentByteOwnerBundleOwner = findFunction(
    byteOwnerSource,
    'replaceAttachmentByteOwnerBundle',
  )
  const deletePhysicalStorageKeysOwner = findFunction(byteOwnerSource, 'deletePhysicalStorageKeys')
  const addAttachmentBlobByteOwnersOwner = findFunction(
    byteOwnerSource,
    'addAttachmentBlobByteOwners',
  )
  const addAttachmentArtifactByteOwnersOwner = findFunction(
    byteOwnerSource,
    'addAttachmentArtifactByteOwners',
  )
  const addAttachmentByteOwnersOwner = findFunction(byteOwnerSource, 'addAttachmentByteOwners')
  const attachmentBundleBatchCalls = executableCalls(replaceAttachmentByteOwnerBundleOwner)
  const attachmentBundleDeleteCalls = attachmentBundleBatchCalls.filter((call) =>
    callResolvesTo(checker, call, deletePhysicalStorageKeysOwner),
  )
  const attachmentBundleBlobAddCalls = attachmentBundleBatchCalls.filter((call) =>
    callResolvesTo(checker, call, addAttachmentBlobByteOwnersOwner),
  )
  const attachmentBundleArtifactAddCalls = attachmentBundleBatchCalls.filter((call) =>
    callResolvesTo(checker, call, addAttachmentArtifactByteOwnersOwner),
  )
  const attachmentBundleJobAddCalls = attachmentBundleBatchCalls.filter((call) =>
    callResolvesTo(checker, call, addAttachmentByteOwnersOwner),
  )
  const attachmentBundleBatchInvalidationCalls = attachmentBundleBatchCalls.filter((call) =>
    callResolvesTo(checker, call, recordOwnerInvalidationOwner),
  )
  const attachmentBundleReplaceCalls = runtimeAttachmentBundleCalls.filter((call) =>
    callResolvesTo(checker, call, replaceAttachmentByteOwnerBundleOwner),
  )
  const attachmentBundleHeaderWriteCalls = runtimeAttachmentBundleCalls.filter((call) =>
    callResolvesTo(checker, call, putAttachmentHeaderByteOwnerOwner),
  )
  const attachmentBundleCatalogWriteCalls = runtimeAttachmentBundleCalls.filter((call) =>
    callResolvesTo(checker, call, putAttachmentCatalogProjectionOwner),
  )
  const attachmentBundleReceiptAbsorbCalls = runtimeAttachmentBundleCalls.filter((call) =>
    callResolvesTo(checker, call, absorbReceiptFragmentOwner),
  )
  const attachmentBundleReferenceStateCalls = runtimeAttachmentBundleCalls.filter((call) =>
    callResolvesTo(checker, call, recordAttachmentReferenceStateOwner),
  )
  const attachmentBundleRuntimeWriterCalls = [
    ...attachmentBundleReplaceCalls,
    ...attachmentBundleHeaderWriteCalls,
    ...attachmentBundleCatalogWriteCalls,
    ...attachmentBundleReceiptAbsorbCalls,
    ...attachmentBundleReferenceStateCalls,
  ]
  const attachmentBundleBatchWriterCalls = [
    ...attachmentBundleDeleteCalls,
    ...attachmentBundleBlobAddCalls,
    ...attachmentBundleArtifactAddCalls,
    ...attachmentBundleJobAddCalls,
    ...attachmentBundleBatchInvalidationCalls,
  ]
  const applicationAttachmentBundleCalls = executableCalls(applicationWriteAttachmentBundle)
  const attachmentBundleActionCalls = applicationAttachmentBundleCalls.filter(
    (call) => call.expression.getText(attachmentsSource) === 'runWorkspaceAction',
  )
  const attachmentBundleActionCallback = attachmentBundleActionCalls[0]?.arguments[1]
    ? unwrap(attachmentBundleActionCalls[0].arguments[1])
    : undefined
  const attachmentBundleExecuteCalls =
    attachmentBundleActionCallback && ts.isFunctionLike(attachmentBundleActionCallback)
      ? executableCalls(attachmentBundleActionCallback).filter((call) =>
          call.expression.getText(attachmentsSource).endsWith('.execute'),
        )
      : []
  const attachmentBundleRuntimeSingleAttempt = workspaceRuntimeSingleAttemptFacts(program)
  const attachmentBundleCommon = Object.freeze({
    exactOccurrencePolicy:
      fixedPolicyBodies.get('attachment.bundle.write')?.includes('exactOccurrence: true') ===
        true &&
      mutationPlanSource
        .getText()
        .includes('receiptPolicy?.exactOccurrence || receiptPolicy?.exactPlan'),
    typedReplayPolicy:
      fixedPolicyBodies
        .get('attachment.bundle.write')
        ?.includes("replayReason: 'unfenced-relative-update'") === true,
    oneSemanticRoute:
      attachmentBundleRunMutationCalls.length === 1 &&
      attachmentBundleContextCalls.length === 1 &&
      !callHasIterationAncestor(attachmentBundleRunMutationCall, attachmentBundleOwner) &&
      !callHasIterationAncestor(
        attachmentBundleContextCalls[0],
        attachmentBundleMutationCallback,
      ) &&
      attachmentBundleRunMutationCall?.arguments[0]?.getText(browserRepoSource) ===
        "[{ kind: 'attachment', attachmentId: bundle.attachment.id }]" &&
      attachmentBundleContextCalls[0]?.arguments[0]?.getText(browserRepoSource) === 'bundle' &&
      attachmentBundleContextCalls[0]?.arguments[1]?.getText(browserRepoSource) === 'mode' &&
      !attachmentBundleOwner.getText(browserRepoSource).includes('ctx.getAttachment(') &&
      !attachmentBundleOwner
        .getText(browserRepoSource)
        .includes('persistPreparedAttachmentBundleInMutation('),
    narrowTransactionProfile:
      scopeProfileText.includes("command.kind === 'attachment.bundle.write'") &&
      scopeProfileText.includes("? 'attachment-payload'") &&
      compileScopesText.includes(`if (storageProfile !== 'attachment-payload') {
          builder.addMutationTable('attachmentRefEdges', 'attachment')
        }`) &&
      compileScopesText.includes("['attachmentCatalogAggregate', 'attachmentCatalogRows']") &&
      compileScopesText.includes(
        "builder.addMutationTables(['attachmentArtifacts', 'attachmentBlobs'], 'attachment')",
      ) &&
      compileScopesText.includes("builder.addMutationTable('attachmentJobs', 'attachment-job')") &&
      compileScopesText.includes("builder.addMutationTable('attachments', 'attachment')"),
    exactPhysicalReads:
      runtimeAttachmentBundlePhysicalReads.length === 5 &&
      hasAttachmentBundlePhysicalRead(
        'attachments',
        'secondary',
        'query',
        'candidates.length',
        'contentHash',
      ) &&
      hasAttachmentBundlePhysicalRead('attachments', 'primary', 'get', '1') &&
      hasAttachmentBundlePhysicalRead(
        'attachmentBlobs',
        'secondary',
        'query',
        'deleted.blobs',
        'attachmentId',
      ) &&
      hasAttachmentBundlePhysicalRead(
        'attachmentArtifacts',
        'secondary',
        'query',
        'deleted.artifacts',
        'attachmentId',
      ) &&
      hasAttachmentBundlePhysicalRead(
        'attachmentJobs',
        'secondary',
        'query',
        'deleted.jobs',
        'attachmentId',
      ),
    oneBatchedPhysicalTransition:
      attachmentBundleReplaceCalls.length === 1 &&
      attachmentBundleHeaderWriteCalls.length === 1 &&
      attachmentBundleCatalogWriteCalls.length === 1 &&
      attachmentBundleDeleteCalls.length === 3 &&
      attachmentBundleBlobAddCalls.length === 1 &&
      attachmentBundleArtifactAddCalls.length === 1 &&
      attachmentBundleJobAddCalls.length === 1 &&
      attachmentBundleBatchInvalidationCalls.length === 1 &&
      attachmentBundleRuntimeWriterCalls.every(
        (call) => !callHasIterationAncestor(call, runtimeWriteAttachmentBundle),
      ) &&
      attachmentBundleBatchWriterCalls.every(
        (call) => !callHasIterationAncestor(call, replaceAttachmentByteOwnerBundleOwner),
      ) &&
      replaceAttachmentByteOwnerBundleOwner
        .getText(byteOwnerSource)
        .includes('next.blobs.some((row) => row.attachmentId !== attachmentId)') &&
      replaceAttachmentByteOwnerBundleOwner
        .getText(byteOwnerSource)
        .includes('next.artifacts.some((row) => row.attachmentId !== attachmentId)') &&
      replaceAttachmentByteOwnerBundleOwner
        .getText(byteOwnerSource)
        .includes('next.jobs.some((row) => row.attachmentId !== attachmentId)'),
    exactEffectReceipt:
      attachmentBundleReceiptAbsorbCalls.length === 1 &&
      attachmentBundleReferenceStateCalls.length === 1 &&
      attachmentBundleBatchInvalidationCalls[0]?.arguments[1]
        ?.getText(byteOwnerSource)
        .includes("kind: 'attachment-job'") === true &&
      attachmentBundleBatchInvalidationCalls[0]?.arguments[1]
        ?.getText(byteOwnerSource)
        .includes('attachmentIds: [attachmentId]') === true &&
      attachmentBundleBatchInvalidationCalls[0]?.arguments[1]
        ?.getText(byteOwnerSource)
        .includes('jobIds:') === true &&
      attachmentCatalogReceiptCalls.length === 1 &&
      attachmentCatalogReceiptCalls[0]?.arguments[4]?.getText(attachmentCatalogSource) ===
        "'get'" &&
      attachmentCatalogReceiptFactoryCalls.length === 1 &&
      attachmentCatalogDependenciesText.includes(
        "{ kind: 'attachment', attachmentIds: [...rowWriteIds] }",
      ) &&
      attachmentCatalogMutationsText.includes("tableName: 'attachmentCatalogRows'") &&
      attachmentCatalogMutationsText.includes("tableName: 'attachmentCatalogAggregate'") &&
      attachmentCatalogReadsText.includes("tableName: 'attachmentCatalogRows'") &&
      attachmentCatalogReadsText.includes('operation: rowReadOperation') &&
      attachmentCatalogReadsText.includes("tableName: 'attachmentCatalogAggregate'") &&
      attachmentCatalogReadsText.includes("operation: 'get'"),
    oneApplicationSubmission:
      attachmentBundleConstructors.length === 1 &&
      attachmentBundleConstructors[0]?.path === ATTACHMENTS_PATH &&
      attachmentBundleConstructors[0]?.owner === 'writeAttachmentBundle' &&
      attachmentBundleActionCalls.length === 1 &&
      attachmentBundleExecuteCalls.length === 1 &&
      !callHasIterationAncestor(attachmentBundleActionCalls[0], applicationWriteAttachmentBundle) &&
      !callHasIterationAncestor(attachmentBundleExecuteCalls[0], attachmentBundleActionCallback) &&
      attachmentBundleExecuteCalls[0]?.arguments[1]
        ?.getText(attachmentsSource)
        .includes("kind: 'attachment.bundle.write'") === true &&
      attachmentBundleExecuteCalls[0]?.arguments[1]
        ?.getText(attachmentsSource)
        .includes('input: { bundle, mode }') === true &&
      !applicationWriteAttachmentBundle
        .getText(attachmentsSource)
        .includes('return writeAttachmentBundle('),
    noRetryOrBroadPlanning:
      !attachmentBundleOwner.getText(browserRepoSource).includes('for (;;)') &&
      !attachmentBundleOwner.getText(browserRepoSource).includes('setTimeout(') &&
      !attachmentBundleOwner.getText(browserRepoSource).includes('.withLocks(') &&
      !attachmentBundleOwner.getText(browserRepoSource).includes('catch (') &&
      !runtimeWriteAttachmentBundle.getText(mutationRuntimeSource).includes('for (;;)') &&
      !runtimeWriteAttachmentBundle.getText(mutationRuntimeSource).includes('setTimeout(') &&
      !runtimeWriteAttachmentBundle.getText(mutationRuntimeSource).includes('.withLocks(') &&
      !runtimeWriteAttachmentBundle.getText(mutationRuntimeSource).includes('catch ('),
    ...attachmentBundleRuntimeSingleAttempt,
  })
  for (const [name, proved] of Object.entries(attachmentBundleCommon)) {
    if (!proved) outputProblems.push(`attachment bundle write mutation family missing ${name}`)
  }
  const attachmentBundleTablesProved =
    commonConsumed &&
    attachmentBundleCommon.oneSemanticRoute &&
    attachmentBundleCommon.narrowTransactionProfile &&
    attachmentBundleCommon.exactPhysicalReads &&
    attachmentBundleCommon.oneBatchedPhysicalTransition &&
    attachmentBundleCommon.noRetryOrBroadPlanning
  const attachmentBundleReceiptProved =
    attachmentBundleTablesProved &&
    attachmentBundleCommon.exactOccurrencePolicy &&
    attachmentBundleCommon.exactEffectReceipt
  const attachmentBundleReplayProved =
    commonConsumed &&
    attachmentBundleCommon.typedReplayPolicy &&
    attachmentBundleCommon.oneApplicationSubmission &&
    attachmentBundleCommon.runningRuntimeSingleInvoke &&
    attachmentBundleCommon.waitingRuntimeSingleInvoke &&
    attachmentBundleCommon.admittedRootSingleInvoke
  const attachmentDeleteOwner = findMethod(
    browserRepoSource,
    'BrowserWorkspaceRepository',
    'deleteAttachmentIfUnreferenced',
  )
  const repositoryDeleteAttachmentIfUnreferenced = findInterfaceMethod(
    repositorySource,
    'MutationContext',
    'deleteAttachmentIfUnreferenced',
  )
  const runtimeDeleteAttachmentIfUnreferenced = findNestedObjectPropertyFunction(
    runBrowserMutation,
    'deleteAttachmentIfUnreferenced',
  )
  const runtimeDeleteAttachmentOwnerBundle = findNestedVariableFunction(
    runBrowserMutation,
    'deleteAttachmentOwnerBundle',
  )
  const runtimeReadAttachmentDispositionState = findNestedVariableFunction(
    runBrowserMutation,
    'readAttachmentDispositionState',
  )
  const applicationDeleteAttachmentIfUnreferenced = findFunction(
    attachmentsSource,
    'deleteUnreferencedAttachment',
  )
  const attachmentDeleteConstructors = constructors.get('attachment.delete-if-unreferenced') ?? []
  const attachmentDeleteOwnerCalls = executableCalls(attachmentDeleteOwner)
  const attachmentDeleteRunMutationCalls = attachmentDeleteOwnerCalls.filter((call) =>
    callResolvesTo(checker, call, repositoryRunMutation),
  )
  const attachmentDeleteRunMutationCall = attachmentDeleteRunMutationCalls[0]
  const attachmentDeleteMutationCallback = attachmentDeleteRunMutationCall?.arguments[1]
    ? unwrap(attachmentDeleteRunMutationCall.arguments[1])
    : undefined
  const attachmentDeleteCallbackCalls =
    attachmentDeleteMutationCallback && ts.isFunctionLike(attachmentDeleteMutationCallback)
      ? executableCalls(attachmentDeleteMutationCallback)
      : []
  const attachmentDeleteContextCalls = attachmentDeleteCallbackCalls.filter((call) =>
    callResolvesTo(checker, call, repositoryDeleteAttachmentIfUnreferenced),
  )
  const runtimeAttachmentDeleteCalls = executableCalls(runtimeDeleteAttachmentIfUnreferenced)
  const runtimeAttachmentDeleteBundleCalls = executableCalls(runtimeDeleteAttachmentOwnerBundle)
  const runtimeAttachmentDeletePhysicalReads = [
    ...runtimeAttachmentDeleteCalls,
    ...executableCalls(runtimeReadAttachmentDispositionState),
    ...runtimeAttachmentDeleteBundleCalls,
  ]
    .filter(
      (call) =>
        call.expression.getText(mutationRuntimeSource) === 'receiptAccumulator.physicalRead',
    )
    .map((call) => (call.arguments[0] ? unwrap(call.arguments[0]) : undefined))
    .filter((node) => node && ts.isObjectLiteralExpression(node))
  const hasAttachmentDeletePhysicalRead = (
    tableName,
    indexKind,
    operation,
    rowCount,
    indexName = undefined,
  ) =>
    runtimeAttachmentDeletePhysicalReads.some(
      (read) =>
        objectPropertyInitializer(read, 'tableName')?.getText(mutationRuntimeSource) ===
          `'${tableName}'` &&
        objectPropertyInitializer(read, 'indexKind')?.getText(mutationRuntimeSource) ===
          `'${indexKind}'` &&
        objectPropertyInitializer(read, 'operation')?.getText(mutationRuntimeSource) ===
          `'${operation}'` &&
        (indexName === undefined ||
          objectPropertyInitializer(read, 'indexName')?.getText(mutationRuntimeSource) ===
            `'${indexName}'`) &&
        objectPropertyInitializer(read, 'requestCount')?.getText(mutationRuntimeSource) === '1' &&
        objectPropertyInitializer(read, 'rowCount')?.getText(mutationRuntimeSource) === rowCount,
    )
  const deleteAttachmentByteOwnerBundleOwner = findFunction(
    byteOwnerSource,
    'deleteAttachmentByteOwnerBundle',
  )
  const deleteAttachmentHeaderByteOwnerOwner = findFunction(
    byteOwnerSource,
    'deleteAttachmentHeaderByteOwner',
  )
  const deleteAttachmentCatalogProjectionOwner = findFunction(
    attachmentCatalogSource,
    'deleteAttachmentCatalogProjection',
  )
  const attachmentDeleteBundleDeleteCalls = runtimeAttachmentDeleteBundleCalls.filter((call) =>
    callResolvesTo(checker, call, deleteAttachmentByteOwnerBundleOwner),
  )
  const attachmentDeleteHeaderCalls = runtimeAttachmentDeleteBundleCalls.filter((call) =>
    callResolvesTo(checker, call, deleteAttachmentHeaderByteOwnerOwner),
  )
  const attachmentDeleteCatalogCalls = runtimeAttachmentDeleteBundleCalls.filter((call) =>
    callResolvesTo(checker, call, deleteAttachmentCatalogProjectionOwner),
  )
  const attachmentDeleteReceiptAbsorbCalls = runtimeAttachmentDeleteBundleCalls.filter((call) =>
    callResolvesTo(checker, call, absorbReceiptFragmentOwner),
  )
  const attachmentDeleteReferenceStateCalls = runtimeAttachmentDeleteBundleCalls.filter((call) =>
    callResolvesTo(checker, call, recordAttachmentReferenceStateOwner),
  )
  const attachmentDeleteCatalogReceiptCalls = executableCalls(
    deleteAttachmentCatalogProjectionOwner,
  ).filter((call) => callResolvesTo(checker, call, attachmentCatalogReceiptOwner))
  const applicationAttachmentDeleteCalls = executableCalls(
    applicationDeleteAttachmentIfUnreferenced,
  )
  const attachmentDeleteActionCalls = applicationAttachmentDeleteCalls.filter(
    (call) => call.expression.getText(attachmentsSource) === 'runWorkspaceAction',
  )
  const attachmentDeleteActionCallback = attachmentDeleteActionCalls[0]?.arguments[1]
    ? unwrap(attachmentDeleteActionCalls[0].arguments[1])
    : undefined
  const attachmentDeleteExecuteCalls =
    attachmentDeleteActionCallback && ts.isFunctionLike(attachmentDeleteActionCallback)
      ? executableCalls(attachmentDeleteActionCallback).filter((call) =>
          call.expression.getText(attachmentsSource).endsWith('.execute'),
        )
      : []
  const attachmentDeleteRuntimeSingleAttempt = workspaceRuntimeSingleAttemptFacts(program)
  const attachmentDeleteCommon = Object.freeze({
    exactOccurrencePolicy:
      fixedPolicyBodies
        .get('attachment.delete-if-unreferenced')
        ?.includes('exactOccurrence: true') === true &&
      mutationPlanSource
        .getText()
        .includes('receiptPolicy?.exactOccurrence || receiptPolicy?.exactPlan'),
    typedReplayPolicy:
      fixedPolicyBodies
        .get('attachment.delete-if-unreferenced')
        ?.includes("replayReason: 'unfenced-relative-update'") === true,
    oneSemanticRoute:
      attachmentDeleteRunMutationCalls.length === 1 &&
      attachmentDeleteContextCalls.length === 1 &&
      !callHasIterationAncestor(attachmentDeleteRunMutationCall, attachmentDeleteOwner) &&
      !callHasIterationAncestor(
        attachmentDeleteContextCalls[0],
        attachmentDeleteMutationCallback,
      ) &&
      attachmentDeleteRunMutationCall?.arguments[0]?.getText(browserRepoSource) ===
        "[{ kind: 'attachment', attachmentId }]" &&
      attachmentDeleteContextCalls[0]?.arguments[0]?.getText(browserRepoSource) ===
        'attachmentId' &&
      !attachmentDeleteOwner.getText(browserRepoSource).includes('ctx.getAttachment(') &&
      !attachmentDeleteOwner
        .getText(browserRepoSource)
        .includes('ctx.countAttachmentReferences(') &&
      !attachmentDeleteOwner.getText(browserRepoSource).includes('ctx.deleteAttachment('),
    exactAttachmentTransactionProfile:
      !scopeProfileText.includes("command.kind === 'attachment.delete-if-unreferenced'") &&
      compileScopesText.includes("['attachmentCatalogAggregate', 'attachmentCatalogRows']") &&
      compileScopesText.includes(
        "builder.addMutationTables(['attachmentArtifacts', 'attachmentBlobs'], 'attachment')",
      ) &&
      compileScopesText.includes("builder.addMutationTable('attachmentJobs', 'attachment-job')") &&
      compileScopesText.includes("builder.addMutationTable('attachmentRefEdges', 'attachment')") &&
      compileScopesText.includes("builder.addMutationTable('attachments', 'attachment')"),
    exactPhysicalReads:
      runtimeAttachmentDeletePhysicalReads.length === 6 &&
      hasAttachmentDeletePhysicalRead('attachments', 'primary', 'get', 'header ? 1 : 0') &&
      hasAttachmentDeletePhysicalRead(
        'attachmentCatalogRows',
        'primary',
        'get',
        'catalogRow ? 1 : 0',
      ) &&
      hasAttachmentDeletePhysicalRead(
        'attachmentRefEdges',
        'secondary',
        'query',
        'firstReference ? 1 : 0',
        'attachmentId',
      ) &&
      hasAttachmentDeletePhysicalRead(
        'attachmentBlobs',
        'secondary',
        'query',
        'deleted.blobs',
        'attachmentId',
      ) &&
      hasAttachmentDeletePhysicalRead(
        'attachmentArtifacts',
        'secondary',
        'query',
        'deleted.artifacts',
        'attachmentId',
      ) &&
      hasAttachmentDeletePhysicalRead(
        'attachmentJobs',
        'secondary',
        'query',
        'deleted.jobs',
        'attachmentId',
      ),
    oneBatchedPhysicalTransition:
      attachmentDeleteBundleDeleteCalls.length === 1 &&
      attachmentDeleteHeaderCalls.length === 1 &&
      attachmentDeleteCatalogCalls.length === 1 &&
      attachmentDeleteReceiptAbsorbCalls.length === 1 &&
      attachmentDeleteReferenceStateCalls.length === 1 &&
      [
        ...attachmentDeleteBundleDeleteCalls,
        ...attachmentDeleteHeaderCalls,
        ...attachmentDeleteCatalogCalls,
        ...attachmentDeleteReceiptAbsorbCalls,
        ...attachmentDeleteReferenceStateCalls,
      ].every((call) => !callHasIterationAncestor(call, runtimeDeleteAttachmentOwnerBundle)) &&
      executableCalls(deleteAttachmentByteOwnerBundleOwner).filter((call) =>
        callResolvesTo(checker, call, replaceAttachmentByteOwnerBundleOwner),
      ).length === 1 &&
      attachmentBundleDeleteCalls.length === 3,
    exactEffectReceipt:
      attachmentDeleteCatalogReceiptCalls.length === 1 &&
      attachmentDeleteCatalogReceiptCalls[0]?.arguments[4]?.getText(attachmentCatalogSource) ===
        "'get'" &&
      attachmentDeleteCatalogReceiptCalls[0]?.arguments[5]?.getText(attachmentCatalogSource) ===
        "'delete'" &&
      attachmentCatalogMutationsText.includes('operation: rowMutationOperation') &&
      attachmentCatalogDependenciesText.includes(
        "{ kind: 'attachment', attachmentIds: [...rowWriteIds] }",
      ) &&
      runtimeDeleteAttachmentOwnerBundle
        .getText(mutationRuntimeSource)
        .includes('absorbSemanticOperationReceiptFragment(tx, catalogReceipt.fragment)') &&
      runtimeDeleteAttachmentOwnerBundle
        .getText(mutationRuntimeSource)
        .includes("kind: 'attachment-job'") === false &&
      replaceAttachmentByteOwnerBundleOwner
        .getText(byteOwnerSource)
        .includes("kind: 'attachment-job'") &&
      runtimeDeleteAttachmentOwnerBundle
        .getText(mutationRuntimeSource)
        .includes('recordBrowserCommandAttachmentReferenceState(tx, {'),
    oneApplicationSubmission:
      attachmentDeleteConstructors.length === 1 &&
      attachmentDeleteConstructors[0]?.path === ATTACHMENTS_PATH &&
      attachmentDeleteConstructors[0]?.owner === 'deleteUnreferencedAttachment' &&
      attachmentDeleteActionCalls.length === 1 &&
      attachmentDeleteExecuteCalls.length === 1 &&
      !callHasIterationAncestor(
        attachmentDeleteActionCalls[0],
        applicationDeleteAttachmentIfUnreferenced,
      ) &&
      !callHasIterationAncestor(attachmentDeleteExecuteCalls[0], attachmentDeleteActionCallback) &&
      !applicationDeleteAttachmentIfUnreferenced
        .getText(attachmentsSource)
        .includes('return deleteUnreferencedAttachment('),
    noRetryOrBroadPlanning:
      !attachmentDeleteOwner.getText(browserRepoSource).includes('for (;;)') &&
      !attachmentDeleteOwner.getText(browserRepoSource).includes('setTimeout(') &&
      !attachmentDeleteOwner.getText(browserRepoSource).includes('.withLocks(') &&
      !attachmentDeleteOwner.getText(browserRepoSource).includes('catch (') &&
      runtimeReadAttachmentDispositionState
        .getText(mutationRuntimeSource)
        .includes(".where('attachmentId')") &&
      runtimeReadAttachmentDispositionState.getText(mutationRuntimeSource).includes('.first()') &&
      !runtimeReadAttachmentDispositionState
        .getText(mutationRuntimeSource)
        .includes('.toArray()') &&
      !runtimeReadAttachmentDispositionState
        .getText(mutationRuntimeSource)
        .includes('attachmentReferenceCounts(') &&
      !runtimeReadAttachmentDispositionState
        .getText(mutationRuntimeSource)
        .includes('requireNoAttachmentReferences(') &&
      !runtimeReadAttachmentDispositionState
        .getText(mutationRuntimeSource)
        .includes('hydrateStoredAttachment(') &&
      !runtimeDeleteAttachmentIfUnreferenced.getText(mutationRuntimeSource).includes('for (;;)') &&
      !runtimeDeleteAttachmentIfUnreferenced.getText(mutationRuntimeSource).includes('setTimeout('),
    ...attachmentDeleteRuntimeSingleAttempt,
  })
  for (const [name, proved] of Object.entries(attachmentDeleteCommon)) {
    if (!proved) {
      outputProblems.push(`attachment delete-if-unreferenced mutation family missing ${name}`)
    }
  }
  const attachmentDeleteTablesProved =
    commonConsumed &&
    attachmentDeleteCommon.oneSemanticRoute &&
    attachmentDeleteCommon.exactAttachmentTransactionProfile &&
    attachmentDeleteCommon.exactPhysicalReads &&
    attachmentDeleteCommon.oneBatchedPhysicalTransition &&
    attachmentDeleteCommon.noRetryOrBroadPlanning
  const attachmentDeleteReceiptProved =
    attachmentDeleteTablesProved &&
    attachmentDeleteCommon.exactOccurrencePolicy &&
    attachmentDeleteCommon.exactEffectReceipt
  const attachmentDeleteReplayProved =
    commonConsumed &&
    attachmentDeleteCommon.typedReplayPolicy &&
    attachmentDeleteCommon.oneApplicationSubmission &&
    attachmentDeleteCommon.runningRuntimeSingleInvoke &&
    attachmentDeleteCommon.waitingRuntimeSingleInvoke &&
    attachmentDeleteCommon.admittedRootSingleInvoke
  const attachmentDeleteManyOwner = findMethod(
    browserRepoSource,
    'BrowserWorkspaceRepository',
    'deleteManyAttachments',
  )
  const repositoryDeleteAttachmentForStorage = findInterfaceMethod(
    repositorySource,
    'MutationContext',
    'deleteAttachmentForStorage',
  )
  const runtimeDeleteAttachmentForStorage = findNestedObjectPropertyFunction(
    runBrowserMutation,
    'deleteAttachmentForStorage',
  )
  const runtimeGetAttachmentCatalogRevision = findNestedObjectPropertyFunction(
    runBrowserMutation,
    'getAttachmentCatalogRevision',
  )
  const executeAttachmentBulkDelete = findFunction(
    attachmentBulkDeleteSource,
    'executeAttachmentBulkDelete',
  )
  const attachmentDeleteManyConstructors = constructors.get('attachment.delete-many') ?? []
  const attachmentDeleteManyOwnerCalls = executableCalls(attachmentDeleteManyOwner)
  const attachmentDeleteManyRunMutationCalls = attachmentDeleteManyOwnerCalls.filter((call) =>
    callResolvesTo(checker, call, repositoryRunMutation),
  )
  const attachmentDeleteManyRunMutationCall = attachmentDeleteManyRunMutationCalls[0]
  const attachmentDeleteManyMutationCallback = attachmentDeleteManyRunMutationCall?.arguments[1]
    ? unwrap(attachmentDeleteManyRunMutationCall.arguments[1])
    : undefined
  const attachmentDeleteManyCallbackCalls =
    attachmentDeleteManyMutationCallback && ts.isFunctionLike(attachmentDeleteManyMutationCallback)
      ? executableCalls(attachmentDeleteManyMutationCallback)
      : []
  const attachmentDeleteManyContextCalls = attachmentDeleteManyCallbackCalls.filter((call) =>
    callResolvesTo(checker, call, repositoryDeleteAttachmentForStorage),
  )
  const runtimeAttachmentDeleteManyCalls = executableCalls(runtimeDeleteAttachmentForStorage)
  const runtimeAttachmentDeleteManyPhysicalReads = executableCalls(
    runtimeReadAttachmentDispositionState,
  )
    .filter(
      (call) =>
        call.expression.getText(mutationRuntimeSource) === 'receiptAccumulator.physicalRead',
    )
    .map((call) => (call.arguments[0] ? unwrap(call.arguments[0]) : undefined))
    .filter((node) => node && ts.isObjectLiteralExpression(node))
  const hasAttachmentDeleteManyPhysicalRead = (
    tableName,
    indexKind,
    operation,
    rowCount,
    indexName = undefined,
  ) =>
    runtimeAttachmentDeleteManyPhysicalReads.some(
      (read) =>
        objectPropertyInitializer(read, 'tableName')?.getText(mutationRuntimeSource) ===
          `'${tableName}'` &&
        objectPropertyInitializer(read, 'indexKind')?.getText(mutationRuntimeSource) ===
          `'${indexKind}'` &&
        objectPropertyInitializer(read, 'operation')?.getText(mutationRuntimeSource) ===
          `'${operation}'` &&
        (indexName === undefined ||
          objectPropertyInitializer(read, 'indexName')?.getText(mutationRuntimeSource) ===
            `'${indexName}'`) &&
        objectPropertyInitializer(read, 'requestCount')?.getText(mutationRuntimeSource) === '1' &&
        objectPropertyInitializer(read, 'rowCount')?.getText(mutationRuntimeSource) === rowCount,
    )
  const attachmentDeleteManyBundleCalls = runtimeAttachmentDeleteManyCalls.filter((call) =>
    callResolvesTo(checker, call, runtimeDeleteAttachmentOwnerBundle),
  )
  const attachmentDeleteManyBytesCalls = runtimeAttachmentDeleteManyCalls.filter((call) =>
    callResolvesTo(checker, call, runtimeDeleteAttachmentBytesForHeader),
  )
  const attachmentDeleteManyApplicationCalls = executableCalls(executeAttachmentBulkDelete)
  const attachmentDeleteManyActionCalls = attachmentDeleteManyApplicationCalls.filter(
    (call) => call.expression.getText(attachmentBulkDeleteSource) === 'runWorkspaceAction',
  )
  const attachmentDeleteManyActionCallback = attachmentDeleteManyActionCalls[0]?.arguments[1]
    ? unwrap(attachmentDeleteManyActionCalls[0].arguments[1])
    : undefined
  const attachmentDeleteManyExecuteCalls =
    attachmentDeleteManyActionCallback && ts.isFunctionLike(attachmentDeleteManyActionCallback)
      ? executableCalls(attachmentDeleteManyActionCallback).filter((call) =>
          call.expression.getText(attachmentBulkDeleteSource).endsWith('.execute'),
        )
      : []
  const attachmentDeleteManyRuntimeSingleAttempt = workspaceRuntimeSingleAttemptFacts(program)
  const attachmentDeleteManyRuntimeText =
    runtimeDeleteAttachmentForStorage.getText(mutationRuntimeSource)
  const attachmentDeleteManyApplicationText = executeAttachmentBulkDelete.getText(
    attachmentBulkDeleteSource,
  )
  const attachmentDeleteManyCommon = Object.freeze({
    exactOccurrencePolicy:
      fixedPolicyBodies.get('attachment.delete-many')?.includes('exactOccurrence: true') === true &&
      mutationPlanSource
        .getText()
        .includes('receiptPolicy?.exactOccurrence || receiptPolicy?.exactPlan'),
    typedReplayPolicy:
      fixedPolicyBodies
        .get('attachment.delete-many')
        ?.includes("replayReason: 'non-replayable'") === true,
    oneSemanticRoute:
      attachmentDeleteManyRunMutationCalls.length === 1 &&
      attachmentDeleteManyContextCalls.length === 1 &&
      attachmentDeleteManyRunMutationCall?.arguments[0]
        ?.getText(browserRepoSource)
        .includes("({ kind: 'attachment', attachmentId })") === true &&
      attachmentDeleteManyContextCalls[0]?.arguments[0]?.getText(browserRepoSource) ===
        'attachmentId' &&
      attachmentDeleteManyContextCalls[0]?.arguments[1]?.getText(browserRepoSource) ===
        'input.reason' &&
      attachmentDeleteManyContextCalls[0]?.arguments[2]?.getText(browserRepoSource) ===
        'input.now' &&
      countOccurrences(
        attachmentDeleteManyOwner.getText(browserRepoSource),
        'ctx.deleteAttachmentForStorage(',
      ) === 1 &&
      !attachmentDeleteManyOwner.getText(browserRepoSource).includes('ctx.getAttachment(') &&
      !attachmentDeleteManyOwner
        .getText(browserRepoSource)
        .includes('ctx.countAttachmentReferences(') &&
      !attachmentDeleteManyOwner.getText(browserRepoSource).includes('ctx.deleteAttachment(') &&
      !attachmentDeleteManyOwner.getText(browserRepoSource).includes('ctx.deleteAttachmentBytes('),
    completeAttachmentTransactionProfile:
      !scopeProfileText.includes("command.kind === 'attachment.delete-many'") &&
      compileScopesText.includes("['attachmentCatalogAggregate', 'attachmentCatalogRows']") &&
      compileScopesText.includes(
        "builder.addMutationTables(['attachmentArtifacts', 'attachmentBlobs'], 'attachment')",
      ) &&
      compileScopesText.includes("builder.addMutationTable('attachmentJobs', 'attachment-job')") &&
      compileScopesText.includes("builder.addMutationTable('attachmentRefEdges', 'attachment')") &&
      compileScopesText.includes("builder.addMutationTable('attachments', 'attachment')"),
    exactPhysicalReads:
      runtimeAttachmentDeleteManyPhysicalReads.length === 3 &&
      hasAttachmentDeleteManyPhysicalRead('attachments', 'primary', 'get', 'header ? 1 : 0') &&
      hasAttachmentDeleteManyPhysicalRead(
        'attachmentCatalogRows',
        'primary',
        'get',
        'catalogRow ? 1 : 0',
      ) &&
      hasAttachmentDeleteManyPhysicalRead(
        'attachmentRefEdges',
        'secondary',
        'query',
        'firstReference ? 1 : 0',
        'attachmentId',
      ) &&
      runtimeGetAttachmentCatalogRevision
        .getText(mutationRuntimeSource)
        .includes("tableName: 'attachmentCatalogAggregate'") &&
      runBrowserMutationText.includes('if (options?.expectedAttachmentCatalogRevision') &&
      runBrowserMutationText.includes("tableName: 'attachmentCatalogAggregate'"),
    currentStateTransition:
      attachmentDeleteManyBundleCalls.length === 1 &&
      attachmentDeleteManyBytesCalls.length === 1 &&
      attachmentDeleteManyBundleCalls[0]?.arguments[1]?.getText(mutationRuntimeSource) ===
        'current.header' &&
      attachmentDeleteManyBytesCalls[0]?.arguments[1]?.getText(mutationRuntimeSource) ===
        'current.header' &&
      runtimeReadAttachmentDispositionState.getText(mutationRuntimeSource).includes('.first()') &&
      !attachmentDeleteManyRuntimeText.includes('.toArray()') &&
      !attachmentDeleteManyRuntimeText.includes('hydrateStoredAttachment(') &&
      !attachmentDeleteManyRuntimeText.includes('attachmentReferenceCounts(') &&
      !attachmentDeleteManyRuntimeText.includes('requireNoAttachmentReferences('),
    exactEffectReceipt:
      attachmentDeleteCommon.exactEffectReceipt &&
      attachmentBytesCommon.exactEffectReceipt &&
      attachmentDeleteManyBundleCalls[0]?.arguments[2]?.getText(mutationRuntimeSource) ===
        'current.catalogRow' &&
      attachmentDeleteManyBytesCalls[0]?.arguments[4]?.getText(mutationRuntimeSource) ===
        'current.catalogRow' &&
      attachmentDeleteManyRuntimeText.includes(
        'await deleteAttachmentOwnerBundle(attachmentId, current.header, current.catalogRow)',
      ) &&
      attachmentDeleteManyRuntimeText.includes('await deleteAttachmentBytesForHeader('),
    oneApplicationSubmission:
      attachmentDeleteManyConstructors.length === 1 &&
      attachmentDeleteManyConstructors[0]?.path === ATTACHMENT_BULK_DELETE_PATH &&
      attachmentDeleteManyConstructors[0]?.owner === 'executeAttachmentBulkDelete' &&
      attachmentDeleteManyActionCalls.length === 1 &&
      attachmentDeleteManyExecuteCalls.length === 1 &&
      countOccurrences(attachmentDeleteManyApplicationText, '.execute(') === 1 &&
      attachmentDeleteManyApplicationText.includes('index += BULK_DELETE_COMMAND_SIZE') &&
      attachmentDeleteManyApplicationText.includes(
        '.slice(index, index + BULK_DELETE_COMMAND_SIZE)',
      ) &&
      attachmentDeleteManyApplicationText.includes(
        'expectedCatalogRevision = result.catalogRevision',
      ) &&
      attachmentDeleteManyApplicationText.includes('AttachmentBulkDeleteCursorDidNotAdvance') &&
      !attachmentDeleteManyApplicationText.includes('catch (') &&
      !attachmentDeleteManyApplicationText.includes('setTimeout(') &&
      !attachmentDeleteManyApplicationText.includes('return executeAttachmentBulkDelete('),
    noRetryOrBroadPlanning:
      !attachmentDeleteManyOwner.getText(browserRepoSource).includes('for (;;)') &&
      !attachmentDeleteManyOwner.getText(browserRepoSource).includes('setTimeout(') &&
      !attachmentDeleteManyOwner.getText(browserRepoSource).includes('.withLocks(') &&
      !attachmentDeleteManyOwner.getText(browserRepoSource).includes('catch (') &&
      !attachmentDeleteManyRuntimeText.includes('for (;;)') &&
      !attachmentDeleteManyRuntimeText.includes('setTimeout(') &&
      !attachmentDeleteManyRuntimeText.includes('.withLocks(') &&
      !attachmentDeleteManyRuntimeText.includes('catch ('),
    ...attachmentDeleteManyRuntimeSingleAttempt,
  })
  for (const [name, proved] of Object.entries(attachmentDeleteManyCommon)) {
    if (!proved) outputProblems.push(`attachment delete-many mutation family missing ${name}`)
  }
  const attachmentDeleteManyTablesProved =
    commonConsumed &&
    attachmentDeleteManyCommon.oneSemanticRoute &&
    attachmentDeleteManyCommon.completeAttachmentTransactionProfile &&
    attachmentDeleteManyCommon.exactPhysicalReads &&
    attachmentDeleteManyCommon.currentStateTransition &&
    attachmentDeleteManyCommon.noRetryOrBroadPlanning
  const attachmentDeleteManyReceiptProved =
    attachmentDeleteManyTablesProved &&
    attachmentDeleteManyCommon.exactOccurrencePolicy &&
    attachmentDeleteManyCommon.exactEffectReceipt
  const attachmentDeleteManyReplayProved =
    commonConsumed &&
    attachmentDeleteManyCommon.typedReplayPolicy &&
    attachmentDeleteManyCommon.oneApplicationSubmission &&
    attachmentDeleteManyCommon.runningRuntimeSingleInvoke &&
    attachmentDeleteManyCommon.waitingRuntimeSingleInvoke &&
    attachmentDeleteManyCommon.admittedRootSingleInvoke
  const attachmentReapOwner = findMethod(
    browserRepoSource,
    'BrowserWorkspaceRepository',
    'reapAttachments',
  )
  const attachmentReapPlanOwner = findFunction(browserRepoSource, 'readAttachmentReapPlan')
  const attachmentReapReplayOwner = findFunction(browserRepoSource, 'attachmentReapReplayPlan')
  const storageRetentionCommitOwner = findFunction(browserRepoSource, 'commitStorageRetentionPage')
  const repositoryReapAttachment = findInterfaceMethod(
    repositorySource,
    'MutationContext',
    'reapAttachmentIfEligible',
  )
  const runtimeReapAttachment = findNestedObjectPropertyFunction(
    runBrowserMutation,
    'reapAttachmentIfEligible',
  )
  const attachmentReapRunMutationCalls = executableCalls(attachmentReapOwner).filter((call) =>
    callResolvesTo(checker, call, repositoryRunMutation),
  )
  const attachmentReapRunMutationCall = attachmentReapRunMutationCalls[0]
  const attachmentReapCallback = attachmentReapRunMutationCall?.arguments[1]
    ? unwrap(attachmentReapRunMutationCall.arguments[1])
    : undefined
  const attachmentReapContextCalls =
    attachmentReapCallback && ts.isFunctionLike(attachmentReapCallback)
      ? executableCalls(attachmentReapCallback).filter((call) =>
          callResolvesTo(checker, call, repositoryReapAttachment),
        )
      : []
  const attachmentReapExtension = attachmentReapRunMutationCall?.arguments[5]
    ? unwrap(attachmentReapRunMutationCall.arguments[5])
    : undefined
  const attachmentReapExtensionText = attachmentReapExtension?.getText(browserRepoSource) ?? ''
  const attachmentReapOwnerText = attachmentReapOwner.getText(browserRepoSource)
  const attachmentReapPlanText = attachmentReapPlanOwner.getText(browserRepoSource)
  const attachmentReapReplayText = attachmentReapReplayOwner.getText(browserRepoSource)
  const runtimeReapAttachmentText = runtimeReapAttachment.getText(mutationRuntimeSource)
  const runtimeAttachmentDispositionText =
    runtimeReadAttachmentDispositionState.getText(mutationRuntimeSource)
  const storageRetentionCommitText = storageRetentionCommitOwner.getText(browserRepoSource)
  const attachmentReapConstructors = constructors.get('attachment.reap') ?? []
  const storageMaintenanceText = storageMaintenanceSource.getText()
  const attachmentReapCommon = Object.freeze({
    oneTypedPreflight:
      countOccurrences(attachmentReapOwnerText, 'readAttachmentReapPlan(') === 1 &&
      countOccurrences(attachmentReapPlanText, 'commit.readSemanticOperationPreflight(') === 1 &&
      countOccurrences(
        attachmentReapPlanText,
        "readStorageRetentionState(tx, 'attachment-reap')",
      ) === 1 &&
      countOccurrences(attachmentReapPlanText, ".where('[refCount+unreferencedAt+id]')") === 1 &&
      attachmentReapPlanText.includes('.limit(limit)') &&
      attachmentReapPlanText.includes('.toArray()') &&
      !attachmentReapOwnerText.includes('this.openDb()') &&
      !browserRepoSource.getText().includes('listAttachmentReapCandidates'),
    exactPreflightReceipt:
      browserRepoSource
        .getText()
        .includes("physicalStorageTables('attachments', 'storageRetentionState')") &&
      attachmentReapPlanText.includes("tableName: 'storageRetentionState'") &&
      attachmentReapPlanText.includes("indexKind: 'primary'") &&
      attachmentReapPlanText.includes("tableName: 'attachments'") &&
      attachmentReapPlanText.includes("indexName: '[refCount+unreferencedAt+id]'") &&
      attachmentReapPlanText.includes('rowCount: plan.candidates.length'),
    oneSemanticRoute:
      attachmentReapRunMutationCalls.length === 1 &&
      attachmentReapContextCalls.length === 1 &&
      attachmentReapContextCalls[0]?.arguments[0]?.getText(browserRepoSource) === 'attachmentId' &&
      attachmentReapContextCalls[0]?.arguments[1]?.getText(browserRepoSource) === 'cycle.cutoff' &&
      countOccurrences(attachmentReapOwnerText, 'ctx.reapAttachmentIfEligible(') === 1 &&
      !attachmentReapOwnerText.includes('ctx.getAttachmentReclamationState(') &&
      !attachmentReapOwnerText.includes('ctx.countAttachmentReferences(') &&
      !attachmentReapOwnerText.includes('ctx.deleteAttachment('),
    sharedCurrentStateTransition:
      countOccurrences(runtimeReapAttachmentText, 'readAttachmentDispositionState(') === 1 &&
      countOccurrences(runtimeReapAttachmentText, 'deleteAttachmentOwnerBundle(') === 1 &&
      runtimeAttachmentDispositionText.includes(".where('attachmentId')") &&
      runtimeAttachmentDispositionText.includes('.first()') &&
      !runtimeAttachmentDispositionText.includes('.toArray()') &&
      !runtimeAttachmentDispositionText.includes('attachmentReferenceCounts(') &&
      runtimeReapAttachmentText.includes('state.firstReference') &&
      runtimeReapAttachmentText.includes('!state.catalogRow') &&
      runtimeReapAttachmentText.includes('state.header.unreferencedAt >= cutoff') &&
      runtimeReapAttachmentText.includes(
        'deleteAttachmentOwnerBundle(attachmentId, state.header, state.catalogRow)',
      ),
    exactTransactionReceipt:
      countOccurrences(attachmentReapExtensionText, "indexName: '[refCount+unreferencedAt+id]'") ===
        2 &&
      countOccurrences(attachmentReapExtensionText, 'receipt.physicalRead({') === 2 &&
      attachmentReapExtensionText.includes(
        'receipt.absorb(await commitStorageRetentionPage(tx, cycle, outcome))',
      ) &&
      storageRetentionCommitText.includes("tableName: 'storageRetentionState'") &&
      storageRetentionCommitText.includes("operation: 'get'") &&
      storageRetentionCommitText.includes("operation: 'write'"),
    completeTransactionProfile:
      compileScopesText.includes("['attachmentCatalogAggregate', 'attachmentCatalogRows']") &&
      compileScopesText.includes(
        "builder.addMutationTables(['attachmentArtifacts', 'attachmentBlobs'], 'attachment')",
      ) &&
      compileScopesText.includes("builder.addMutationTable('attachmentJobs', 'attachment-job')") &&
      compileScopesText.includes("builder.addMutationTable('attachmentRefEdges', 'attachment')") &&
      compileScopesText.includes("builder.addMutationTable('attachments', 'attachment')") &&
      attachmentReapExtensionText.includes("readTableNames: ['attachments']") &&
      attachmentReapExtensionText.includes("writeTableNames: ['storageRetentionState']"),
    exactEffectReceipt:
      attachmentDeleteCommon.exactEffectReceipt &&
      runtimeReapAttachmentText.includes(
        'deleteAttachmentOwnerBundle(attachmentId, state.header, state.catalogRow)',
      ),
    typedDurableReplay:
      attachmentReapExtensionText.includes('exactOccurrence: true') &&
      attachmentReapExtensionText.includes('attachmentReapReplayPlan(cycle, limit)') &&
      attachmentReapReplayText.includes("kind: 'durable-page-resume'") &&
      attachmentReapReplayText.includes("owner: 'storage-retention:attachment-reap'") &&
      attachmentReapReplayText.includes('cycle: cycle.cycleNow') &&
      attachmentReapReplayText.includes('revision: cycle.expectedRevision') &&
      attachmentReapReplayText.includes('cursor: stableStringify(cycle.cursor ?? null)') &&
      attachmentReapReplayText.includes('doneMarker: `cutoff:${cycle.cutoff}`') &&
      attachmentReapReplayText.includes('limit') &&
      mutationPlanSource.getText().includes('extensionReceipt?: {') &&
      mutationPlanSource.getText().includes('replayPlan: extensionReceipt.replay') &&
      runBrowserMutationText.includes('transactionExtension?.receipt'),
    oneMaintenanceIngress:
      attachmentReapConstructors.length === 1 &&
      attachmentReapConstructors[0]?.path === 'src/store/storage-maintenance-runtime.ts' &&
      attachmentReapConstructors[0]?.owner === 'StorageMaintenanceController.<computed-method>' &&
      countOccurrences(storageMaintenanceText, "kind: 'attachment.reap'") === 1,
    noRetryOrBroadPlanning:
      !attachmentReapOwnerText.includes('for (;;)') &&
      !attachmentReapOwnerText.includes('setTimeout(') &&
      !attachmentReapOwnerText.includes('catch (') &&
      !attachmentReapPlanText.includes('for (;;)') &&
      !runtimeReapAttachmentText.includes('for (;;)') &&
      !runtimeReapAttachmentText.includes('setTimeout('),
  })
  for (const [name, proved] of Object.entries(attachmentReapCommon)) {
    if (!proved) outputProblems.push(`attachment reap mutation family missing ${name}`)
  }
  const attachmentReapTablesProved =
    commonConsumed &&
    attachmentReapCommon.oneTypedPreflight &&
    attachmentReapCommon.exactPreflightReceipt &&
    attachmentReapCommon.oneSemanticRoute &&
    attachmentReapCommon.sharedCurrentStateTransition &&
    attachmentReapCommon.completeTransactionProfile &&
    attachmentReapCommon.noRetryOrBroadPlanning
  const attachmentReapReceiptProved =
    attachmentReapTablesProved &&
    attachmentReapCommon.exactTransactionReceipt &&
    attachmentReapCommon.exactEffectReceipt
  const attachmentReapReplayProved =
    commonConsumed &&
    attachmentReapCommon.typedDurableReplay &&
    attachmentReapCommon.oneMaintenanceIngress
  const presentationMessageCommon = Object.freeze({
    exhaustiveTypedAccess:
      messageVariants.length === 4 &&
      [...messageCapabilityBodies.values()].every((body) =>
        body.includes("access: 'presentation'"),
      ) &&
      mutateMessageBodyText.includes('const capability = messageBodyMutationCapability(input)') &&
      mutateMessageBodyText.includes('[messageScope(input.messageId, capability.access)]'),
    noExternalPreflight:
      countOccurrences(mutateMessageBodyText, 'repo.runMutation(') === 1 &&
      !mutateMessageBodyText.includes('repo.get') &&
      !mutateMessageBodyText.includes('repo.list'),
    narrowTypedTransaction:
      compileMutationScopesText.includes("scope.access === 'presentation'") &&
      compileMutationScopesText.includes("builder.addReadTable('chats')") &&
      compileMutationScopesText.includes("builder.addMutationTable('messages'") &&
      compileMutationScopesText.includes("builder.addMutationTable('messageBodies'") &&
      compileMutationScopesText.includes("builder.addMutationTable('messagePreviews'") &&
      compileMutationScopesText.includes("builder.addReadTable('streamLeases')"),
    exactPlan:
      fixedReceiptPolicy
        .getText(mutationPlanSource)
        .includes('exactPlan: semanticOperationExactPlan({') &&
      fixedReceiptPolicy.getText(mutationPlanSource).includes('maxRequests: 5') &&
      fixedReceiptPolicy.getText(mutationPlanSource).includes('maxRows: 5') &&
      fixedReceiptPolicy.getText(mutationPlanSource).includes('maxRequests: 3') &&
      fixedReceiptPolicy.getText(mutationPlanSource).includes('maxRows: 3') &&
      fixedReceiptPolicy.getText(mutationPlanSource).match(/maxBytes: Number\.MAX_SAFE_INTEGER/gu)
        ?.length === 2 &&
      mutationPlanSource.getText().includes('receiptPolicy?.exactPlan') &&
      mutationPlanSource.getText().includes('semanticOperationExactReceiptPhysicalReadContract<'),
    exactPhysicalReads:
      [
        "tableName: 'messages'",
        "tableName: 'messageBodies'",
        "tableName: 'messagePreviews'",
        "tableName: 'streamLeases'",
        "tableName: 'chats'",
      ].every((token) => runBrowserMutationText.includes(token)) &&
      runBrowserMutationText.includes("indexName: 'targetOwnerKey'") &&
      runBrowserMutationText.includes("operation: 'get-many'") &&
      runBrowserMutationText.includes('rowCount: revisionChatIds.length') &&
      runBrowserMutationText.includes('semanticOperationExactReceipt(operationPlan.exactPlan') &&
      !runBrowserMutationText.includes(
        "tx.table<MessageHeaderRow, MessageId>('messages').bulkGet(affectedIds)",
      ),
    byteBoundsExplicitlyOpen:
      fixedReceiptPolicy.getText(mutationPlanSource).match(/maxBytes: Number\.MAX_SAFE_INTEGER/gu)
        ?.length === 2,
  })
  for (const [name, consumed] of Object.entries(presentationMessageCommon)) {
    if (!consumed) outputProblems.push(`presentation message mutation family missing ${name}`)
  }
  const presentationMessageProved = Object.values(presentationMessageCommon).every(Boolean)
  const materializeRuntimeText = findFunction(
    catalogRuntimeSource,
    'materializeTemporaryChat',
  ).getText(catalogRuntimeSource)
  const materializeExactPlanText = findFunction(
    mutationPlanSource,
    'materializeTemporaryChatExactPlan',
  ).getText(mutationPlanSource)
  const mutationInfrastructureText = findFunction(
    mutationPlanSource,
    'mutationInfrastructurePlan',
  ).getText(mutationPlanSource)
  const linkedChatCapabilityText = findVariableInitializer(
    chatRowSource,
    'CHAT_ROW_LINKED_TRANSACTION_CAPABILITY',
  ).getText(chatRowSource)
  const preservingChatCapabilityText = findVariableInitializer(
    chatRowSource,
    'CHAT_ROW_PRESERVING_LINKS_TRANSACTION_CAPABILITY',
  ).getText(chatRowSource)
  const sidebarCapabilityText = findVariableInitializer(
    sidebarProjectionSource,
    'CHAT_SIDEBAR_PROJECTION_TRANSACTION_CAPABILITY',
  ).getText(sidebarProjectionSource)
  const configurationLinkCapabilityText = findVariableInitializer(
    profileUsageProjectionSource,
    'CONFIGURATION_LINK_MUTATION_TRANSACTION_CAPABILITY',
  ).getText(profileUsageProjectionSource)
  const materializeCommon = Object.freeze({
    oneTransactionLocalRoute:
      countOccurrences(materializeRuntimeText, 'mutationPort.runMutation(') === 1 &&
      materializeRuntimeText.includes('initialChat: chat') &&
      !materializeRuntimeText.includes('mutationPort.get') &&
      !materializeRuntimeText.includes('mutationPort.list'),
    exactLinkedTables:
      mutationInfrastructureText.includes(
        "addChatCapabilityTables(builder, CHAT_ROW_LINKED_TRANSACTION_CAPABILITY, 'write')",
      ) &&
      [
        'CHAT_ROW_PRESERVING_LINKS_TRANSACTION_CAPABILITY.tableNames',
        'CONFIGURATION_LINK_MUTATION_TRANSACTION_CAPABILITY.tableNames',
      ].every((token) => linkedChatCapabilityText.includes(token)) &&
      preservingChatCapabilityText.includes("'chats'") &&
      preservingChatCapabilityText.includes('CHAT_SIDEBAR_PROJECTION_TRANSACTION_CAPABILITY') &&
      sidebarCapabilityText.includes("'chatSidebarRows'") &&
      sidebarCapabilityText.includes("'chatSidebarAggregates'") &&
      configurationLinkCapabilityText.includes("'configurationLinks'") &&
      configurationLinkCapabilityText.includes("'configurationProfileUsageRows'") &&
      configurationLinkCapabilityText.includes("'configurationCatalogAggregates'"),
    exactReadReceipt:
      countOccurrences(
        runBrowserMutationText,
        "commandCommit.command.kind === 'chat.materialize-temporary'",
      ) === 1 &&
      runBrowserMutationText.includes(
        'const initialRead = await chatMutation.readWithEvidence(initialChat.id)',
      ) &&
      runBrowserMutationText.includes("tableName: 'chats'") &&
      runBrowserMutationText.includes("operation: 'get'") &&
      runBrowserMutationText.includes('requestCount: initialRead.requestCount') &&
      runBrowserMutationText.includes('receiptAccumulator.physicalRead({'),
    admittedInputBounds:
      materializeExactPlanText.includes('const links = configurationLinksForChat(initialChat)') &&
      materializeExactPlanText.includes(
        "links.filter((link) => link.targetKind === 'profile').length",
      ) &&
      materializeExactPlanText.includes('maxRequests: 5 + 2 * profileLinks') &&
      materializeExactPlanText.includes('maxRows: 5 + 2 * profileLinks') &&
      materializeExactPlanText.includes(
        'maxRequests: 3 + (links.length > 0 ? 1 : 0) + 2 * profileLinks',
      ) &&
      materializeExactPlanText.includes('maxRows: 3 + links.length + 2 * profileLinks') &&
      materializeExactPlanText.includes('maxBatchRows: Math.max(1, links.length)'),
    byteBoundsExplicitlyOpen:
      materializeExactPlanText.match(/maxBytes: Number\.MAX_SAFE_INTEGER/gu)?.length === 2,
  })
  for (const [name, consumed] of Object.entries(materializeCommon)) {
    if (!consumed) outputProblems.push(`temporary chat materialization missing ${name}`)
  }
  const materializeProved = Object.values(materializeCommon).every(Boolean)
  const prepareBrowserAttemptText = findFunction(
    generationRuntimeSource,
    'prepareBrowserAttempt',
  ).getText(generationRuntimeSource)
  const prepareCommandInputText = findFunction(
    generationEngineSource,
    'prepareCommandInput',
  ).getText(generationEngineSource)
  const generationAdmissionSource = exactSource(
    program,
    'src/store/generation-admission-controller.ts',
  )
  const captureGenerationConfigurationText = findFunction(
    generationAdmissionSource,
    'captureGenerationConfiguration',
  ).getText(generationAdmissionSource)
  const configurationControllerSource = exactSource(
    program,
    'src/store/configuration-controller.ts',
  )
  const createActiveGenerationConfigurationFrameText = findFunction(
    configurationControllerSource,
    'createActiveGenerationConfigurationFrame',
  ).getText(configurationControllerSource)
  const attemptMutationInfrastructureText = findFunction(
    mutationPlanSource,
    'mutationInfrastructurePlan',
  ).getText(mutationPlanSource)
  const attemptPrepareCommon = Object.freeze({
    typedConfigurationLinkProof:
      workspaceProtocolSource.getText().includes('type ExistingChatPrepareConfiguration') &&
      workspaceProtocolSource.getText().includes('readonly configurationLinkTransition:') &&
      workspaceProtocolSource
        .getText()
        .includes('readonly expectedResourceNames: readonly string[]') &&
      workspaceProtocolSource.getText().includes('readonly nextResourceNames: readonly string[]'),
    proofCapturedAtAdmission:
      createActiveGenerationConfigurationFrameText.includes(
        'expectedResourceNames: target.configurationLinkProof.expectedResourceNames',
      ) &&
      createActiveGenerationConfigurationFrameText.includes('nextResourceNames: Object.freeze(') &&
      captureGenerationConfigurationText.includes(
        'configurationLinkTransition: resolution.configurationLinkTransition',
      ) &&
      prepareCommandInputText.includes(
        'configurationLinkTransition: configuration.configurationLinkTransition',
      ),
    noExternalChatPreflight:
      countOccurrences(prepareBrowserAttemptText, 'repository.runMutation(') === 1 &&
      !prepareBrowserAttemptText.includes('repository.getChat('),
    transactionValidatesProof:
      prepareBrowserAttemptText.includes(
        'expectedResourceNames: input.configurationLinkTransition.expectedResourceNames',
      ) &&
      prepareBrowserAttemptText.includes(
        'nextResourceNames: input.configurationLinkTransition.nextResourceNames',
      ) &&
      runBrowserMutationText.includes('if (options?.configurationLinkTransition)') &&
      runBrowserMutationText.includes(
        'stableStringify(chatConfigurationTargetResourceNames(current))',
      ) &&
      runBrowserMutationText.includes(
        'stableStringify(configurationLinkTransition.nextResourceNames)',
      ),
    exactTableCompilation:
      prepareBrowserAttemptText.includes('captureGenerationPlanningSnapshot: true') &&
      prepareBrowserAttemptText.includes('promoteChatId: chatId') &&
      prepareBrowserAttemptText.includes('streamAdmission: input.lease') &&
      attemptMutationInfrastructureText.includes(
        'if (options?.configurationLinkTransition) addConfigurationLinkMutationTables(builder)',
      ) &&
      attemptMutationInfrastructureText.includes(
        'if (options?.captureGenerationPlanningSnapshot) {',
      ) &&
      attemptMutationInfrastructureText.includes(
        "addChatCapabilityTables(builder, CHAT_ROW_PRESERVING_LINKS_TRANSACTION_CAPABILITY, 'write')",
      ),
  })
  for (const [name, consumed] of Object.entries(attemptPrepareCommon)) {
    if (!consumed) outputProblems.push(`attempt prepare mutation family missing ${name}`)
  }
  const attemptPrepareProved = Object.values(attemptPrepareCommon).every(Boolean)
  const prepareAttemptOwner = findFunction(generationEngineSource, 'prepareAttempt')
  const runGenerationOwner = findFunction(generationEngineSource, 'runGeneration')
  const startClaimedGenerationOwner = findFunction(generationEngineSource, 'startClaimedGeneration')
  const claimCapturedOwner = findMethod(
    generationAdmissionSource,
    'TabGenerationAdmissionController',
    'claimCaptured',
  )
  const claimCapturedText = claimCapturedOwner.getText(generationAdmissionSource)
  const startClaimedGenerationText = startClaimedGenerationOwner.getText(generationEngineSource)
  const runGenerationText = runGenerationOwner.getText(generationEngineSource)
  const prepareSubmitCalls = executableCalls(prepareAttemptOwner).filter(
    (call) =>
      call.expression.getText(generationEngineSource) === 'getWorkspaceRepository().execute',
  )
  const startGenerationExecuteCalls = executableCalls(startClaimedGenerationOwner).filter(
    (call) =>
      call.expression.getText(generationEngineSource) === 'generationAdmissionController.execute',
  )
  const runGenerationPrepareCalls = executableCalls(runGenerationOwner).filter(
    (call) => call.expression.getText(generationEngineSource) === 'prepareAttempt',
  )
  const runGenerationDispatchCalls = executableCalls(runGenerationOwner).filter(
    (call) => call.expression.getText(generationEngineSource) === 'planAndDispatch',
  )
  const attemptPrepareConstructorSites = constructors.get('attempt.prepare') ?? []
  const attemptPrepareReplayCommon = Object.freeze({
    typedSingleAttemptPolicy:
      fixedPolicyBodies.get('attempt.prepare')?.includes("replayReason: 'random-identity'") ===
      true,
    freshStreamIdentity:
      countOccurrences(claimCapturedText, 'const streamId = newId()') === 1 &&
      claimCapturedText.includes('streamId,') &&
      startClaimedGenerationText.includes(
        'const { streamId, chatId, assistantMessageId, userMessageId } = claim',
      ) &&
      runGenerationText.includes('const leaseAdmission = preparedStreamLeaseAdmission(') &&
      runGenerationText.includes('admission.placement.createdAt,') &&
      runGenerationText.includes(
        'preparedState = await prepareAttempt({ ...input, admission, lease: leaseAdmission })',
      ),
    soleProductionConstructor:
      attemptPrepareConstructorSites.length === 1 &&
      attemptPrepareConstructorSites[0]?.path === 'src/store/generation-engine.ts' &&
      attemptPrepareConstructorSites[0]?.owner === 'prepareAttempt',
    oneCommandSubmission:
      prepareSubmitCalls.length === 1 &&
      !callHasIterationAncestor(prepareSubmitCalls[0], prepareAttemptOwner) &&
      !executableCalls(prepareAttemptOwner).some(
        (call) => call.expression.getText(generationEngineSource) === 'prepareAttempt',
      ),
    oneClaimedGenerationExecution:
      startGenerationExecuteCalls.length === 1 &&
      !callHasIterationAncestor(startGenerationExecuteCalls[0], startClaimedGenerationOwner) &&
      countOccurrences(startClaimedGenerationText, 'runGeneration({') === 1,
    oneGenerationOccurrence:
      runGenerationPrepareCalls.length === 1 &&
      runGenerationDispatchCalls.length === 1 &&
      !callHasIterationAncestor(runGenerationPrepareCalls[0], runGenerationOwner) &&
      runGenerationPrepareCalls[0].getStart(generationEngineSource) <
        runGenerationDispatchCalls[0].getStart(generationEngineSource),
    ...workspaceRuntimeSingleAttemptFacts(program),
  })
  for (const [name, consumed] of Object.entries(attemptPrepareReplayCommon)) {
    if (!consumed) outputProblems.push(`attempt prepare replay ownership missing ${name}`)
  }
  const attemptPrepareReplayProved = Object.values(attemptPrepareReplayCommon).every(Boolean)
  const dispatchBrowserAttemptText = findFunction(
    generationRuntimeSource,
    'dispatchBrowserAttempt',
  ).getText(generationRuntimeSource)
  const planAndDispatchText = findFunction(generationEngineSource, 'planAndDispatch').getText(
    generationEngineSource,
  )
  const attemptDispatchExactPlanText = findFunction(
    mutationPlanSource,
    'attemptDispatchExactPlan',
  ).getText(mutationPlanSource)
  const attemptDispatchReplayPlanText = findFunction(
    mutationPlanSource,
    'attemptDispatchReplayPlan',
  ).getText(mutationPlanSource)
  const validateGenerationReadSetText = findFunction(
    mutationPlanSource,
    'validateGenerationReadSetTransaction',
  ).getText(mutationPlanSource)
  const transitionGenerationText = findFunction(
    browserRepoSource,
    'transitionMessageGenerationForDispatch',
  ).getText(browserRepoSource)
  const attemptDispatchCommon = Object.freeze({
    typedTargetFromOwnedLease:
      workspaceProtocolSource.getText().includes('export interface AttemptDispatchInput') &&
      workspaceProtocolSource.getText().includes('readonly attemptKind:') &&
      planAndDispatchText.includes('messageId: streamLease.lease.messageId') &&
      planAndDispatchText.includes('attemptKind: streamLease.lease.attemptKind'),
    noExternalLeasePreflight:
      countOccurrences(dispatchBrowserAttemptText, 'repository.runMutation(') === 1 &&
      !dispatchBrowserAttemptText.includes('repository.getStreamLease('),
    transactionValidatesTarget:
      dispatchBrowserAttemptText.includes('messageId: input.target.messageId') &&
      dispatchBrowserAttemptText.includes("input.target.attemptKind === 'continuation'") &&
      dispatchBrowserAttemptText.includes("input.target.attemptKind === 'generation'") &&
      runBrowserMutationText.includes('ownedStreamLease.messageId !== target.messageId') &&
      runBrowserMutationText.includes('ownedStreamLease.attemptKind !== target.attemptKind'),
    exactReadReceipt:
      validateGenerationReadSetText.includes("tableName: 'messages'") &&
      validateGenerationReadSetText.includes("tableName: 'attachments' as const") &&
      runBrowserMutationText.includes(
        'for (const read of reads) receiptAccumulator.physicalRead(read)',
      ) &&
      countOccurrences(runBrowserMutationText, "tableName: 'streamLeases'") > 0 &&
      countOccurrences(runBrowserMutationText, "tableName: 'messages'") > 0 &&
      runBrowserMutationText.includes('rowCount: revisionChatIds.length'),
    admittedInputBounds:
      attemptDispatchExactPlanText.includes('input.readSet.messages.length') &&
      attemptDispatchExactPlanText.includes('input.readSet.attachments.length') &&
      attemptDispatchExactPlanText.includes('maxRequests: continuation ? 5 : 6') &&
      attemptDispatchExactPlanText.includes(
        'maxRows: messageRows + attachmentRows + (continuation ? 3 : 4)',
      ) &&
      attemptDispatchExactPlanText.includes('maxRequests: continuation ? 1 : 2') &&
      attemptDispatchExactPlanText.includes('maxRows: continuation ? 1 : 2') &&
      attemptDispatchExactPlanText.match(/maxBytes: Number\.MAX_SAFE_INTEGER/gu)?.length === 2,
    fencedReplay:
      attemptDispatchReplayPlanText.includes("kind: 'fenced-convergent'") &&
      attemptDispatchReplayPlanText.includes('input.fence.ownerClientId') &&
      attemptDispatchReplayPlanText.includes('input.fence.fenceToken') &&
      attemptDispatchReplayPlanText.includes('stableStringify({') &&
      mutationPlanSource
        .getText()
        .includes(
          'semanticOperationExactReceiptReplayContract<undefined, BrowserMutationTableName>',
        ),
    convergentTransitions:
      transitionGenerationText.includes(
        'stableStringify(header.generation) === stableStringify(generation)',
      ) &&
      runBrowserMutationText.includes("if (ownedStreamLease.phase !== 'reserved')") &&
      runBrowserMutationText.includes(
        'stableStringify(ownedStreamLease.dispatch) !== stableStringify(targetDispatch)',
      ) &&
      runBrowserMutationText.includes('committed = ownedStreamLease'),
    byteBoundsExplicitlyOpen:
      attemptDispatchExactPlanText.match(/maxBytes: Number\.MAX_SAFE_INTEGER/gu)?.length === 2,
  })
  for (const [name, consumed] of Object.entries(attemptDispatchCommon)) {
    if (!consumed) outputProblems.push(`attempt dispatch mutation family missing ${name}`)
  }
  const attemptDispatchProved = Object.values(attemptDispatchCommon).every(Boolean)
  const finalizeBrowserAttemptText = findFunction(
    generationRuntimeSource,
    'finalizeBrowserAttempt',
  ).getText(generationRuntimeSource)
  const attemptFinalizeReplayPlanText = findFunction(
    mutationPlanSource,
    'attemptFinalizeReplayPlan',
  ).getText(mutationPlanSource)
  const projectAttemptTerminalText = findFunction(
    terminalizationSource,
    'projectAttemptTerminal',
  ).getText(terminalizationSource)
  const attemptFinalizeCommon = Object.freeze({
    typedIdentity:
      workspaceProtocolSource.getText().includes('interface AttemptTerminalProjectionBase') &&
      workspaceProtocolSource.getText().includes('chatId: ChatId') &&
      projectAttemptTerminalText.includes('chatId: input.chatId'),
    noExternalLeasePreflight:
      countOccurrences(finalizeBrowserAttemptText, 'repository.runMutation(') === 1 &&
      !finalizeBrowserAttemptText.includes('repository.getStreamLease('),
    transactionOwnsLeaseIdentity:
      finalizeBrowserAttemptText.includes('operations.getOwnedStreamLease(input.streamId)') &&
      finalizeBrowserAttemptText.includes('lease.chatId !== input.chatId') &&
      finalizeBrowserAttemptText.includes('lease.messageId !== input.messageId') &&
      finalizeBrowserAttemptText.includes('lease.attemptKind !== input.kind') &&
      runBrowserMutationText.includes('getOwnedStreamLease: (streamId) =>') &&
      runBrowserMutationText.includes('return structuredClone(ownedStreamLease)'),
    exactResourceScope:
      finalizeBrowserAttemptText.includes("{ kind: 'chat-meta', chatId: input.chatId }") &&
      finalizeBrowserAttemptText.includes("{ kind: 'message', messageId: input.messageId }") &&
      finalizeBrowserAttemptText.includes("kind: 'attachment' as const") &&
      compileMutationScopesText.includes("case 'chat-meta':") &&
      compileMutationScopesText.includes("case 'message':") &&
      compileMutationScopesText.includes("case 'attachment':"),
    fencedReplay:
      attemptFinalizeReplayPlanText.includes("kind: 'fenced-convergent'") &&
      attemptFinalizeReplayPlanText.includes('input.fence.ownerClientId') &&
      attemptFinalizeReplayPlanText.includes('input.fence.fenceToken') &&
      attemptFinalizeReplayPlanText.includes('input.chatId') &&
      attemptFinalizeReplayPlanText.includes('input.messageId') &&
      attemptFinalizeReplayPlanText.includes('stableStringify(input.terminal.decision)') &&
      mutationPlanSource.getText().includes('receiptPolicy?.replayPlan') &&
      mutationRuntimeSource
        .getText()
        .includes('operationPlan.replayPlan ? { replay: operationPlan.replayPlan }'),
    convergentTransition:
      finalizeBrowserAttemptText.includes('lease.canonicalAt !== undefined') &&
      finalizeBrowserAttemptText.includes("outcome: 'already-canonical' as const") &&
      runBrowserMutationText.includes(
        "currentLease.phase === 'canonical' || currentLease.phase === 'metadata-committed'",
      ) &&
      runBrowserMutationText.includes(
        'stableStringify(currentLease.postCommit.final) !== stableStringify(finalEvidence)',
      ),
  })
  for (const [name, consumed] of Object.entries(attemptFinalizeCommon)) {
    if (!consumed) outputProblems.push(`attempt finalize mutation family missing ${name}`)
  }
  const attemptFinalizeProved = Object.values(attemptFinalizeCommon).every(Boolean)
  const capabilities = {}
  const routeFacts = {}
  for (const variant of declared) {
    const route = routes.get(variant) ?? {
      entries: [],
      semanticTerminals: [],
      legacyTerminals: [],
    }
    const consumed =
      commonConsumed && route.semanticTerminals.length > 0 && route.legacyTerminals.length === 0
    if (route.legacyTerminals.length > 0) {
      outputProblems.push(
        `scope-derived mutation ${variant}: legacy terminals ${route.legacyTerminals.join(', ')}`,
      )
    }
    capabilities[variant] = Object.freeze({
      path: 'src/store/browser-mutation-plan.ts',
      owner: 'planMutationSemanticOperation',
      transaction: 'plan.transaction',
      consumed,
      physicalWritesProved: commonKernel.exactPhysicalWriteReceipt,
      exactPhysicalWritesProved: commonKernel.exactPhysicalWriteReceipt,
      exactEffectsProved:
        (fixedVariants.includes(variant) && fixedReceiptEffectsProved) ||
        (variant === 'draft.put' && draftPutReceiptProved) ||
        (variant === 'attachment.bytes.delete' && attachmentBytesReceiptProved) ||
        (variant === 'attachment.bundle.write' && attachmentBundleReceiptProved) ||
        (variant === 'attachment.delete-if-unreferenced' && attachmentDeleteReceiptProved) ||
        (variant === 'attachment.delete-many' && attachmentDeleteManyReceiptProved) ||
        (variant === 'attachment.reap' && attachmentReapReceiptProved),
      tablesProved:
        (messageVariants.includes(variant) && presentationMessageProved) ||
        (variant === 'chat.materialize-temporary' && materializeProved) ||
        (variant === 'attempt.prepare' && attemptPrepareProved) ||
        (variant === 'attempt.dispatch' && attemptDispatchProved) ||
        (variant === 'attempt.finalize' && attemptFinalizeProved) ||
        (variant === 'draft.put' && draftPutTablesProved) ||
        (variant === 'attachment.bytes.delete' && attachmentBytesTablesProved) ||
        (variant === 'attachment.bundle.write' && attachmentBundleTablesProved) ||
        (variant === 'attachment.delete-if-unreferenced' && attachmentDeleteTablesProved) ||
        (variant === 'attachment.delete-many' && attachmentDeleteManyTablesProved) ||
        (variant === 'attachment.reap' && attachmentReapTablesProved),
      boundsProved:
        (messageVariants.includes(variant) && presentationMessageProved) ||
        (variant === 'chat.materialize-temporary' && materializeProved) ||
        (variant === 'attempt.dispatch' && attemptDispatchProved),
      byteBoundsProved: false,
      idempotenceProved:
        (replayVariants.includes(variant) && fixedReceiptReplayProved) ||
        (variant === 'attempt.prepare' && attemptPrepareReplayProved) ||
        (variant === 'attempt.dispatch' && attemptDispatchProved) ||
        (variant === 'attempt.finalize' && attemptFinalizeProved) ||
        (variant === 'draft.put' && draftPutReplayProved) ||
        (variant === 'attachment.bytes.delete' && attachmentBytesReplayProved) ||
        (variant === 'attachment.bundle.write' && attachmentBundleReplayProved) ||
        (variant === 'attachment.delete-if-unreferenced' && attachmentDeleteReplayProved) ||
        (variant === 'attachment.delete-many' && attachmentDeleteManyReplayProved) ||
        (variant === 'attachment.reap' && attachmentReapReplayProved),
    })
    routeFacts[variant] = Object.freeze({
      entries: Object.freeze(route.entries),
      semanticTerminals: Object.freeze(route.semanticTerminals),
      legacyTerminals: Object.freeze(route.legacyTerminals),
      consumed,
    })
  }
  return Object.freeze({
    declaredVariants: Object.freeze(declared),
    routedVariants: Object.freeze(routed),
    routesByVariant: Object.freeze(routeFacts),
    commonKernel: Object.freeze(commonKernel),
    fixedReceiptFamily: Object.freeze({
      variants: Object.freeze(fixedVariants),
      messageVariants: Object.freeze(messageVariants),
      attemptVariants: Object.freeze(attemptVariants),
      materializeVariants: Object.freeze(materializeVariants),
      replayVariants: Object.freeze(replayVariants),
      commonKernel: fixedReceiptCommon,
      commandLifetimeReceipt,
      presentationOnly: Object.freeze({
        variants: Object.freeze(messageVariants),
        commonKernel: presentationMessageCommon,
      }),
      materializeTemporary: Object.freeze({
        variant: 'chat.materialize-temporary',
        commonKernel: materializeCommon,
      }),
      attemptDispatch: Object.freeze({
        variant: 'attempt.dispatch',
        commonKernel: attemptDispatchCommon,
      }),
      attemptPrepare: Object.freeze({
        variant: 'attempt.prepare',
        commonKernel: attemptPrepareCommon,
        replayCommonKernel: attemptPrepareReplayCommon,
      }),
      attemptFinalize: Object.freeze({
        variant: 'attempt.finalize',
        commonKernel: attemptFinalizeCommon,
      }),
      draftPut: Object.freeze({
        variant: 'draft.put',
        commonKernel: draftPutCommon,
      }),
      attachmentBytesDelete: Object.freeze({
        variant: 'attachment.bytes.delete',
        commonKernel: attachmentBytesCommon,
      }),
      attachmentBundleWrite: Object.freeze({
        variant: 'attachment.bundle.write',
        commonKernel: attachmentBundleCommon,
      }),
      attachmentDeleteIfUnreferenced: Object.freeze({
        variant: 'attachment.delete-if-unreferenced',
        commonKernel: attachmentDeleteCommon,
      }),
      attachmentDeleteMany: Object.freeze({
        variant: 'attachment.delete-many',
        commonKernel: attachmentDeleteManyCommon,
      }),
      attachmentReap: Object.freeze({
        variant: 'attachment.reap',
        commonKernel: attachmentReapCommon,
      }),
    }),
    capabilities: Object.freeze(capabilities),
  })
}

function configurationSettingCapabilityFacts(
  program,
  browserRepoSource,
  configurationSource,
  outputProblems,
) {
  const checker = program.getTypeChecker()
  const domainSource = exactSource(program, 'src/store/browser-domain-mutations.ts')
  const executeSemanticOperation = findMethod(
    browserRepoSource,
    'BrowserCommandCommit',
    'executeSemanticOperation',
  )
  const completeSemanticOperation = findMethod(
    browserRepoSource,
    'BrowserCommandCommit',
    'completeSemanticOperation',
  )
  const semanticPortExecute = findInterfaceMethod(
    domainSource,
    'BrowserSemanticCommandPort',
    'executeSemanticOperation',
  )
  const semanticPortComplete = findInterfaceMethod(
    domainSource,
    'BrowserSemanticCommandPort',
    'completeSemanticOperation',
  )
  const settingExecutor = findFunction(configurationSource, 'executeSettingRowsOperation')
  const settingCompleter = findFunction(configurationSource, 'completeSettingRowsOperation')
  const semanticTerminals = [settingExecutor, settingCompleter]
  const roots = configurationHandlerRoots(checker, configurationSource)
  const routes = new Map()
  for (const [variant, root] of roots) {
    routes.set(variant, commandRouteFacts(checker, [root], semanticTerminals))
  }
  const variants = [...routes]
    .filter(([, route]) => route.semanticTerminals.length > 0)
    .map(([variant]) => variant)
    .sort()
  const commonKernel = configurationSettingCommonKernelFacts(
    program,
    checker,
    browserRepoSource,
    domainSource,
    configurationSource,
    executeSemanticOperation,
    completeSemanticOperation,
    semanticPortExecute,
    semanticPortComplete,
  )
  for (const [name, consumed] of Object.entries(commonKernel)) {
    if (name === 'replayReceiptProof' || name === 'callerSingleAttemptOwned') continue
    if (!consumed) outputProblems.push(`configuration setting common kernel missing ${name}`)
  }
  const commonConsumed = Object.entries(commonKernel).every(
    ([name, consumed]) =>
      name === 'replayReceiptProof' || name === 'callerSingleAttemptOwned' || consumed,
  )
  const replayProved = commonKernel.replayReceiptProof && commonKernel.callerSingleAttemptOwned
  const capabilities = {}
  const routeFacts = {}
  for (const variant of variants) {
    const route = routes.get(variant)
    const consumed =
      commonConsumed && route.semanticTerminals.length > 0 && route.legacyTerminals.length === 0
    if (route.legacyTerminals.length > 0) {
      outputProblems.push(
        `configuration setting ${variant}: legacy terminals ${route.legacyTerminals.join(', ')}`,
      )
    }
    capabilities[variant] = Object.freeze({
      path: CONFIGURATION_HANDLER_PATH,
      owner: 'executeSettingRowsOperation',
      transaction: 'CONFIGURATION_SETTING_TRANSACTION',
      consumed,
      physicalWritesProved: true,
      exactPhysicalWritesProved: true,
      exactEffectsProved: true,
      tablesProved: true,
      boundsProved: true,
      idempotenceProved: replayProved,
    })
    routeFacts[variant] = Object.freeze({
      entries: Object.freeze(route.entries),
      semanticTerminals: Object.freeze(route.semanticTerminals),
      legacyTerminals: Object.freeze(route.legacyTerminals),
      consumed,
    })
  }
  return Object.freeze({
    variants: Object.freeze(variants),
    routesByVariant: Object.freeze(routeFacts),
    commonKernel: Object.freeze(commonKernel),
    capabilities: Object.freeze(capabilities),
  })
}

function configurationCallerSingleAttemptFacts(program) {
  const configurationApplicationSource = exactSource(program, CONFIGURATION_APPLICATION_PATH)
  const configurationCommandClientSource = exactSource(program, CONFIGURATION_COMMAND_CLIENT_PATH)
  const configurationDomainSource = exactSource(program, CONFIGURATION_DOMAIN_PATH)
  const createConfigurationApplication = findFunction(
    configurationDomainSource,
    'createConfigurationApplication',
  )
  const configurationApplicationExecute = findNestedVariableFunction(
    createConfigurationApplication,
    'execute',
  )
  const executeConfigurationCommand = findFunction(
    configurationCommandClientSource,
    'executeConfigurationCommand',
  )
  const applicationSubmitCalls = executableCalls(configurationApplicationExecute).filter(
    (call) =>
      call.expression.getText(configurationDomainSource) === 'dependencies.port.execute' &&
      call.arguments[0]?.getText(configurationDomainSource) === 'command',
  )
  return Object.freeze({
    productionPortBound: configurationApplicationSource
      .getText()
      .includes('port: { execute: executeConfigurationCommand }'),
    genericApplicationSingleSubmit:
      applicationSubmitCalls.length === 1 &&
      !callHasIterationAncestor(applicationSubmitCalls[0], configurationApplicationExecute) &&
      executableCalls(configurationApplicationExecute).every(
        (call) => call.expression.getText(configurationDomainSource) !== 'execute',
      ),
    commandClientSingleSubmit:
      countOccurrences(
        executeConfigurationCommand.getText(configurationCommandClientSource),
        '.execute(permit,',
      ) === 1 &&
      countOccurrences(
        executeConfigurationCommand.getText(configurationCommandClientSource),
        "runWorkspaceAction('configuration', execute)",
      ) === 1,
    ...workspaceRuntimeSingleAttemptFacts(program),
  })
}

function workspaceRuntimeSingleAttemptFacts(program) {
  const workspaceRuntimeSource = exactSource(program, WORKSPACE_RUNTIME_PATH)
  const workspaceRuntimeKernel = findFunction(
    workspaceRuntimeSource,
    'createWorkspaceRuntimeKernel',
  )
  const runRootWhenAvailable = findNestedFunction(workspaceRuntimeKernel, 'runRootWhenAvailable')
  const waitForRootAdmission = findNestedFunction(workspaceRuntimeKernel, 'waitForRootAdmission')
  const runRoot = findNestedFunction(workspaceRuntimeKernel, 'runRoot')
  return Object.freeze({
    runningRuntimeSingleInvoke:
      countOccurrences(
        runRootWhenAvailable.getText(workspaceRuntimeSource),
        'runRoot(admitRoot(kind, type, options), operation)',
      ) === 1,
    waitingRuntimeSingleInvoke:
      countOccurrences(
        runRootWhenAvailable.getText(workspaceRuntimeSource),
        'waitForRootAdmission(kind, type, operation, options)',
      ) === 1 &&
      countOccurrences(
        waitForRootAdmission.getText(workspaceRuntimeSource),
        'runRoot(record, operation)',
      ) === 1,
    admittedRootSingleInvoke:
      countOccurrences(runRoot.getText(workspaceRuntimeSource), 'operation(record.permit as P)') ===
      1,
  })
}

function configurationReplayOwnershipFacts(
  program,
  configurationUnion,
  familyDescriptors,
  outputProblems,
) {
  const configurationSource = exactSource(program, CONFIGURATION_HANDLER_PATH)
  const typedReplayVariants = new Set()
  const callerPolicyVariants = new Set()
  const callerPolicyDescriptors = new Set()
  const descriptorContracts = {}
  for (const [family, descriptorNames] of familyDescriptors) {
    const descriptorFacts = descriptorNames.map((name) => {
      const owner = findFunctionOrVariableInitializer(configurationSource, name)
      const descriptorCall = ts.isCallExpression(owner)
        ? owner
        : executableCalls(owner).find(
            (call) =>
              call.expression.getText(configurationSource) === 'semanticOperationDescriptor',
          )
      const definition = semanticDescriptorDefinition(descriptorCall, configurationSource)
      const replayText =
        objectPropertyInitializer(definition, 'replay')?.getText(configurationSource) ?? ''
      const callerPolicy =
        replayText.includes('semanticOperationCallerSingleAttemptReplayContract') &&
        replayText.includes("'unfenced-relative-update'")
      const bound =
        name === 'keyMaterialOperationDescriptor'
          ? replayText.includes('semanticOperationExactReceiptReplayContract') &&
            replayText.includes('keyMaterialOperationReplayPlan')
          : (replayText.includes('semanticOperationExactReceiptReplayProofContract') &&
              replayText.includes('assertConfigurationSingleAttemptReplayProof')) ||
            callerPolicy
      return Object.freeze({ name, bound, callerPolicy })
    })
    const bound = descriptorFacts.every((fact) => fact.bound)
    descriptorContracts[descriptorNames.join('+')] = bound
    if (!bound) continue
    for (const variant of family.variants) typedReplayVariants.add(variant)
    if (descriptorFacts.some((fact) => fact.callerPolicy)) {
      for (const fact of descriptorFacts) {
        if (fact.callerPolicy) callerPolicyDescriptors.add(fact.name)
      }
      for (const variant of family.variants) callerPolicyVariants.add(variant)
    }
  }

  const constructors = constructorSitesByVariant(configurationUnion, true)
  const constructedVariants = [...typedReplayVariants]
    .filter((variant) => (constructors.get(variant)?.length ?? 0) > 0)
    .sort()
  const constructorlessVariants = [...typedReplayVariants]
    .filter((variant) => (constructors.get(variant)?.length ?? 0) === 0)
    .sort()
  const keyVariants = constructedVariants.filter((variant) => variant.startsWith('key.'))
  const switchVariants = constructedVariants.filter((variant) => variant === 'chat.switch-profile')
  const resolutionVariants = constructedVariants.filter(
    (variant) => variant === 'chat.resolve-model',
  )
  const ordinaryVariants = constructedVariants.filter(
    (variant) =>
      !variant.startsWith('key.') &&
      variant !== 'chat.switch-profile' &&
      variant !== 'chat.resolve-model',
  )

  const caller = configurationCallerSingleAttemptFacts(program)
  const clientRuntimeOwned =
    caller.productionPortBound &&
    caller.commandClientSingleSubmit &&
    caller.runningRuntimeSingleInvoke &&
    caller.waitingRuntimeSingleInvoke &&
    caller.admittedRootSingleInvoke
  const ordinaryConstructorSitesOwned = ordinaryVariants.every((variant) =>
    (constructors.get(variant) ?? []).every(
      (site) =>
        (site.path === CONFIGURATION_DOMAIN_PATH &&
          site.owner.startsWith('createConfigurationApplication.')) ||
        (variant === 'connection.touch' &&
          site.path === 'src/ui/header/ConnectionHeader.tsx' &&
          site.owner === 'ConnectionHeader'),
    ),
  )
  const configurationDomainSource = exactSource(program, CONFIGURATION_DOMAIN_PATH)
  const createConfigurationApplication = findFunction(
    configurationDomainSource,
    'createConfigurationApplication',
  )
  const ordinaryConstructorSubmitFacts = ordinaryVariants
    .flatMap((variant) =>
      (constructors.get(variant) ?? [])
        .filter((site) => site.path === CONFIGURATION_DOMAIN_PATH)
        .map((site) => {
          const ownerPrefix = 'createConfigurationApplication.'
          const methodName = site.owner.startsWith(ownerPrefix)
            ? site.owner.slice(ownerPrefix.length)
            : ''
          const method = methodName
            ? findNestedMethod(createConfigurationApplication, methodName)
            : undefined
          const calls = method ? executableCalls(method) : []
          const constructorNode =
            site.offset === undefined
              ? undefined
              : findObjectLiteralAtOffset(configurationDomainSource, site.offset)
          const executeCalls = calls.filter(
            (call) => call.expression.getText(configurationDomainSource) === 'execute',
          )
          const matchingCalls = executeCalls.filter((call) => {
            const command = call.arguments[0] ? unwrap(call.arguments[0]) : undefined
            return (
              command === constructorNode &&
              command !== undefined &&
              ts.isObjectLiteralExpression(command) &&
              objectPropertyInitializer(command, 'kind')?.getText(configurationDomainSource) ===
                `'${variant}'`
            )
          })
          const recursiveCalls = calls.filter((call) => {
            const expression = call.expression.getText(configurationDomainSource)
            return expression === methodName || expression.endsWith(`.${methodName}`)
          })
          return Object.freeze({
            variant,
            owner: site.owner,
            offset: site.offset,
            singleSubmit:
              constructorNode !== undefined &&
              executeCalls.length === 1 &&
              matchingCalls.length === 1 &&
              !callHasIterationAncestor(matchingCalls[0], method) &&
              recursiveCalls.length === 0,
          })
        }),
    )
    .sort((left, right) =>
      `${left.variant}:${left.owner}`.localeCompare(`${right.variant}:${right.owner}`),
    )
  const ordinaryConstructorSingleSubmit =
    ordinaryConstructorSubmitFacts.length > 0 &&
    ordinaryConstructorSubmitFacts.every((fact) => fact.singleSubmit)
  const connectionHeaderText = exactSource(program, 'src/ui/header/ConnectionHeader.tsx').getText()
  const ordinaryOwned =
    clientRuntimeOwned &&
    caller.genericApplicationSingleSubmit &&
    ordinaryConstructorSitesOwned &&
    ordinaryConstructorSingleSubmit &&
    countOccurrences(connectionHeaderText, "kind: 'connection.touch'") === 1 &&
    countOccurrences(connectionHeaderText, 'configurationApplication.execute({') === 1

  const keysSource = exactSource(program, 'src/store/keys.ts')
  const directKeyCalls = []
  visit(keysSource, (node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(keysSource) === 'executeConfigurationCommand' &&
      keyVariants.some((variant) =>
        node.arguments[0]?.getText(keysSource).includes(`kind: '${variant}'`),
      )
    ) {
      directKeyCalls.push(node)
    }
  })
  const keyOwned =
    clientRuntimeOwned &&
    keyVariants.every((variant) =>
      (constructors.get(variant) ?? []).every((site) => site.path === 'src/store/keys.ts'),
    ) &&
    directKeyCalls.length === keyVariants.length &&
    directKeyCalls.every((call) => call.arguments.length === 2)

  const switchChatProfile = findNestedMethod(createConfigurationApplication, 'switchChatProfile')
  const switchText = switchChatProfile.getText(configurationDomainSource)
  const switchOwned =
    clientRuntimeOwned &&
    switchVariants.length === 1 &&
    configurationDomainSource
      .getText()
      .includes('const PROFILE_SWITCH_PLAN_ATTEMPTS = [true, false] as const') &&
    countOccurrences(switchText, 'for (const canRebase of PROFILE_SWITCH_PLAN_ATTEMPTS)') === 1 &&
    countOccurrences(switchText, 'dependencies.loadProfileSwitchPlan(') === 1 &&
    countOccurrences(switchText, 'dependencies.port.execute(command)') === 1

  const modelResolutionSource = exactSource(
    program,
    'src/store/configuration-model-resolution-capability.ts',
  )
  const drainTarget = findFunction(modelResolutionSource, 'drainTarget')
  const resolutionSubmitCalls = executableCalls(drainTarget).filter(
    (call) => call.expression.getText(modelResolutionSource) === 'executeConfigurationCommand',
  )
  const browserRepoText = exactSource(program, BROWSER_REPO_PATH).getText()
  const resolutionOwned =
    clientRuntimeOwned &&
    resolutionVariants.length === 1 &&
    (constructors.get('chat.resolve-model') ?? []).every(
      (site) =>
        site.path === 'src/store/configuration-model-resolution-capability.ts' &&
        site.owner === 'drainTarget',
    ) &&
    resolutionSubmitCalls.length === 1 &&
    resolutionSubmitCalls[0]?.arguments[0]
      ?.getText(modelResolutionSource)
      .includes("kind: 'chat.resolve-model'") === true &&
    modelResolutionSource.getText().includes('for (const pending of page.pending)') &&
    modelResolutionSource.getText().includes('withCoordinationLock(') &&
    modelResolutionSource
      .getText()
      .includes('`configuration-model-resolution:' + '$' + '{cycle.fence.workspaceId}`') &&
    modelResolutionSource.getText().includes('if (!pageProgress) return targetProgress') &&
    !modelResolutionSource.getText().includes('setTimeout(') &&
    browserRepoText.includes('.limit(CONFIGURATION_MODEL_RESOLUTION_PAGE_SIZE)')

  const provedVariants = [
    ...(ordinaryOwned ? ordinaryVariants : []),
    ...(keyOwned ? keyVariants : []),
    ...(switchOwned ? switchVariants : []),
    ...(resolutionOwned ? resolutionVariants : []),
  ].sort()
  const commonKernel = Object.freeze({
    descriptorContractsBound: Object.values(descriptorContracts).every(Boolean),
    clientRuntimeOwned,
    ordinaryConstructorSingleSubmit,
    ordinaryOwned,
    keyOwned,
    switchOwned,
    resolutionOwned,
    constructorlessWithheld: constructorlessVariants.every(
      (variant) => !provedVariants.includes(variant),
    ),
  })
  for (const [name, consumed] of Object.entries(commonKernel)) {
    if (!consumed) outputProblems.push(`configuration replay ownership missing ${name}`)
  }
  return Object.freeze({
    typedReplayVariants: Object.freeze([...typedReplayVariants].sort()),
    callerPolicyVariants: Object.freeze([...callerPolicyVariants].sort()),
    callerPolicyDescriptors: Object.freeze([...callerPolicyDescriptors].sort()),
    constructedVariants: Object.freeze(constructedVariants),
    constructorlessVariants: Object.freeze(constructorlessVariants),
    ordinaryVariants: Object.freeze(ordinaryVariants),
    keyVariants: Object.freeze(keyVariants),
    switchVariants: Object.freeze(switchVariants),
    resolutionVariants: Object.freeze(resolutionVariants),
    provedVariants: Object.freeze(provedVariants),
    ordinaryConstructorSubmitFacts: Object.freeze(ordinaryConstructorSubmitFacts),
    descriptorContracts: Object.freeze(descriptorContracts),
    caller,
    commonKernel,
  })
}

function configurationSettingCommonKernelFacts(
  program,
  checker,
  browserRepoSource,
  domainSource,
  configurationSource,
  executeSemanticOperation,
  completeSemanticOperation,
  semanticPortExecute,
  semanticPortComplete,
) {
  const descriptor = findFunction(configurationSource, 'settingRowsOperationDescriptor')
  const execute = findFunction(configurationSource, 'executeSettingRowsOperation')
  const complete = findFunction(configurationSource, 'completeSettingRowsOperation')
  const descriptorCalls = executableCalls(descriptor)
  const descriptorCall = descriptorCalls.find(
    (call) => call.expression.getText(configurationSource) === 'semanticOperationDescriptor',
  )
  const definition = descriptorCall?.arguments[0] ? unwrap(descriptorCall.arguments[0]) : undefined
  const effectDefinition =
    definition && ts.isObjectLiteralExpression(definition)
      ? objectPropertyInitializer(definition, 'effects')
      : undefined
  const effectObject = effectDefinition ? unwrap(effectDefinition) : undefined
  const exactPhysicalDefinition =
    definition && ts.isObjectLiteralExpression(definition)
      ? objectPropertyInitializer(definition, 'exactPhysicalMutations')
      : undefined
  const exactReadDefinition =
    definition && ts.isObjectLiteralExpression(definition)
      ? objectPropertyInitializer(definition, 'exactPhysicalReads')
      : undefined
  const exactReadText = exactReadDefinition?.getText(configurationSource) ?? ''
  const exactReceiptContract =
    definition !== undefined &&
    ts.isObjectLiteralExpression(definition) &&
    objectSpreadsCall(definition, 'semanticOperationExactReceiptContracts')
  const descriptorIsExact =
    definition !== undefined &&
    ts.isObjectLiteralExpression(definition) &&
    objectPropertyInitializer(definition, 'operationKind')?.getText(configurationSource) ===
      'configurationSemanticOperationKind(operationKind)' &&
    objectPropertyInitializer(definition, 'transaction')?.getText(configurationSource) ===
      'CONFIGURATION_SETTING_TRANSACTION' &&
    ((effectObject !== undefined &&
      ts.isObjectLiteralExpression(effectObject) &&
      stringProperty(effectObject, 'kind') === 'exact-invalidations' &&
      objectPropertyInitializer(effectObject, 'expected') !== undefined &&
      exactPhysicalDefinition !== undefined &&
      exactReadDefinition !== undefined &&
      exactReadText.includes("tableName: 'settings'") &&
      exactReadText.includes("indexKind: 'primary'") &&
      exactReadText.includes("operation: 'get-many'") &&
      exactReadText.includes('requestCount: 1') &&
      exactReadText.includes('rowCount: settingKeys.length')) ||
      (exactReceiptContract &&
        configurationSource.getText().includes('function settingRowsOperationExactPlan(') &&
        configurationSource.getText().includes('function settingRowsOperationExactReceipt(')))
  const executeCalls = executableCalls(execute)
  const completeCalls = executableCalls(complete)
  const executeTerminal = executeCalls.find(
    (call) =>
      callResolvesTo(checker, call, executeSemanticOperation) ||
      callResolvesTo(checker, call, semanticPortExecute),
  )
  const completeTerminal = completeCalls.find(
    (call) =>
      callResolvesTo(checker, call, completeSemanticOperation) ||
      callResolvesTo(checker, call, semanticPortComplete),
  )
  const repoTransaction = findMethod(
    browserRepoSource,
    'BrowserCommandCommit',
    'runTransaction',
  ).getText(browserRepoSource)
  const semanticPort = findInterfaceMethod(
    domainSource,
    'BrowserSemanticCommandPort',
    'executeSemanticOperation',
  )
  const callerSingleAttempt = configurationCallerSingleAttemptFacts(program)
  const descriptorText = descriptor.getText(configurationSource)
  const exactPlanText = findFunction(configurationSource, 'settingRowsOperationExactPlan').getText(
    configurationSource,
  )
  return {
    nestedKindBound: browserRepoSource
      .getText()
      .includes('configurationSemanticOperationKind(command.input.kind)'),
    descriptorCompiled: descriptorIsExact,
    descriptorConsumed:
      executeCalls.some((call) => callResolvesTo(checker, call, descriptor)) &&
      completeCalls.some((call) => callResolvesTo(checker, call, descriptor)),
    executorConsumed: executeTerminal !== undefined,
    noOpConsumed: completeTerminal !== undefined,
    primaryKeyReadsOwned: execute.getText(configurationSource).includes('.bulkGet('),
    writesOwned:
      execute.getText(configurationSource).includes('putUserSettingByteOwner') &&
      execute.getText(configurationSource).includes('putUserSettingByteOwners') &&
      execute.getText(configurationSource).includes('deleteUserSettingByteOwner'),
    transactionLocalExactWrites: repoTransaction.includes(
      'assertSemanticOperationExactPhysicalMutations',
    ),
    transactionLocalExactEffects: repoTransaction.includes(
      'assertSemanticOperationExactInvalidations',
    ),
    transactionLocalExactReads: repoTransaction.includes(
      'assertSemanticOperationExactPhysicalReads',
    ),
    readObservationOptIn: repoTransaction.includes(
      'observePhysicalReads: semanticOperation?.descriptor.exactPhysicalReads !== undefined',
    ),
    noOpExactValidated:
      completeSemanticOperation
        .getText(browserRepoSource)
        .includes('assertSemanticOperationExactInvalidations') &&
      completeSemanticOperation
        .getText(browserRepoSource)
        .includes('assertSemanticOperationExactPhysicalMutations') &&
      completeSemanticOperation
        .getText(browserRepoSource)
        .includes('assertSemanticOperationExactPhysicalReads'),
    boundedPrimaryIo:
      execute.getText(configurationSource).includes('.bulkGet(') &&
      configurationSource.getText().includes('if (values.length === 0 || values.length > 2)'),
    replayReceiptProof:
      descriptorText.includes('semanticOperationExactReceiptReplayProofContract') &&
      descriptorText.includes('assertSettingRowsSingleAttemptReplayProof') &&
      exactPlanText.includes("kind: 'single-attempt'") &&
      exactPlanText.includes("reason: 'unfenced-relative-update'"),
    callerSingleAttemptOwned: Object.values(callerSingleAttempt).every(Boolean),
    semanticPortBound: semanticPort !== undefined,
    legacyCallsAbsent:
      !executeCalls.some((call) =>
        call.expression.getText(configurationSource).endsWith('.withLocks'),
      ) &&
      !completeCalls.some((call) =>
        call.expression.getText(configurationSource).endsWith('.withLocks'),
      ),
  }
}

function scopeDerivedMutationCommonKernelFacts(
  checker,
  browserRepoSource,
  domainSource,
  mutationRuntimeSource,
  mutationPlanSource,
  repositoryRunMutation,
) {
  const runBrowserMutation = findFunction(mutationRuntimeSource, 'runBrowserMutation')
  const planMutationSemanticOperation = findFunction(
    mutationPlanSource,
    'planMutationSemanticOperation',
  )
  const executeSemanticOperation = findMethod(
    browserRepoSource,
    'BrowserCommandCommit',
    'executeSemanticOperation',
  )
  const semanticPortExecute = findInterfaceMethod(
    domainSource,
    'BrowserSemanticCommandPort',
    'executeSemanticOperation',
  )
  const repositoryCalls = executableCalls(repositoryRunMutation)
  const runtimeCalls = executableCalls(runBrowserMutation)
  const planCalls = executableCalls(planMutationSemanticOperation)
  const descriptorCall = planCalls.find(
    (call) => call.expression.getText(mutationPlanSource) === 'semanticOperationDescriptor',
  )
  const definition = descriptorCall?.arguments[0] ? unwrap(descriptorCall.arguments[0]) : undefined
  const runTransaction = findMethod(browserRepoSource, 'BrowserCommandCommit', 'runTransaction')
  const exactMutationReceiptContracts =
    definition
      ?.getText(mutationPlanSource)
      .includes('semanticOperationExactMutationReceiptContracts') &&
    definition
      .getText(mutationPlanSource)
      .includes('semanticOperationExactMutationAndInvalidationReceiptContracts')
  const runtimeText = runBrowserMutation.getText(mutationRuntimeSource)
  const transactionText = runTransaction.getText(browserRepoSource)
  const descriptorIsExecutable =
    definition !== undefined &&
    ts.isObjectLiteralExpression(definition) &&
    objectPropertyInitializer(definition, 'transaction')?.getText(mutationPlanSource) ===
      'plan.transaction' &&
    objectPropertyInitializer(definition, 'permittedWrites')?.getText(mutationPlanSource) ===
      'plan.permittedWrites' &&
    objectPropertyInitializer(definition, 'resources') !== undefined &&
    objectPropertyInitializer(definition, 'effects') !== undefined
  const plannerCall = runtimeCalls.find((call) =>
    callResolvesTo(checker, call, planMutationSemanticOperation),
  )
  const executorCall = runtimeCalls.find(
    (call) =>
      callResolvesTo(checker, call, executeSemanticOperation) ||
      callResolvesTo(checker, call, semanticPortExecute),
  )
  return {
    repositoryBridgeConsumed: repositoryCalls.some((call) =>
      callResolvesTo(checker, call, runBrowserMutation),
    ),
    plannerConsumed: plannerCall !== undefined && descriptorIsExecutable,
    executorConsumed: executorCall !== undefined,
    operationKindBound:
      plannerCall?.arguments[0]?.getText(mutationRuntimeSource) === 'commandCommit.command',
    descriptorBound:
      executorCall?.arguments[0]?.getText(mutationRuntimeSource) === 'operationPlan.descriptor',
    oneExactOccurrenceReceipt:
      exactMutationReceiptContracts &&
      runtimeText.includes('receiptAccumulator.snapshotFragment()') &&
      countOccurrences(runtimeText, 'semanticOperationExactReceipt(operationPlan.exactPlan, {') ===
        1,
    exactPhysicalWriteReceipt:
      exactMutationReceiptContracts &&
      runtimeText.includes(
        'boundSemanticOperationExactReceiptAccumulator<BrowserMutationTableName>(transaction)',
      ) &&
      transactionText.includes('assertSemanticOperationExactPhysicalMutations(') &&
      transactionText.includes('assertSemanticOperationExactPhysicalWrites(') &&
      transactionText.includes('result.facts.physicalWrites'),
    runtimeTableFence:
      descriptorIsExecutable &&
      transactionText.includes('assertPhysicalTransactionTablesDeclared(') &&
      transactionText.includes('assertSemanticOperationWrites('),
    legacyCallsAbsent: !runtimeCalls.some((call) =>
      call.expression.getText(mutationRuntimeSource).endsWith('.withLocks'),
    ),
  }
}

function commandRouteFacts(checker, roots, semanticTerminals) {
  const queue = [...roots]
  const visited = new Set()
  const entries = new Set()
  const matchedSemanticTerminals = new Set()
  const legacyTerminals = new Set()
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) continue
    const currentId = nodeIdentity(current)
    if (visited.has(currentId)) continue
    visited.add(currentId)
    const currentPath = relative(ROOT, current.getSourceFile().fileName).split(sep).join('/')
    if (isProductionSource(current.getSourceFile())) entries.add(currentPath)
    for (const call of executableCalls(current)) {
      const declaration = checker.getResolvedSignature(call)?.declaration
      for (const terminal of semanticTerminals) {
        if (callResolvesTo(checker, call, terminal)) {
          matchedSemanticTerminals.add(declarationIdentity(terminal))
        }
      }
      const expressionText = call.expression.getText(call.getSourceFile())
      if (expressionText.endsWith('.withLocks')) legacyTerminals.add(expressionText)
      if (
        declaration?.body &&
        isProductionSource(declaration.getSourceFile()) &&
        !semanticTerminals.some((terminal) => sameDeclaration(declaration, terminal))
      ) {
        queue.push(declaration)
      }
    }
  }
  return {
    entries: [...entries].sort(),
    semanticTerminals: [...matchedSemanticTerminals].sort(),
    legacyTerminals: [...legacyTerminals].sort(),
  }
}

function reachableCallsResolvingTo(checker, roots, target) {
  const queue = roots.filter(Boolean)
  const visited = new Set()
  const matches = []
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) continue
    const currentId = nodeIdentity(current)
    if (visited.has(currentId)) continue
    visited.add(currentId)
    for (const call of executableCalls(current)) {
      if (callResolvesTo(checker, call, target)) {
        matches.push(call)
        continue
      }
      const declaration = checker.getResolvedSignature(call)?.declaration
      if (declaration?.body && isProductionSource(declaration.getSourceFile())) {
        queue.push(declaration)
      }
    }
  }
  return matches
}

function executableCalls(root) {
  const calls = []
  const scan = (node) => {
    if (node !== root && ts.isFunctionLike(node)) return
    if (ts.isCallExpression(node)) calls.push(node)
    node.forEachChild(scan)
  }
  scan(root)
  return calls
}

function callHasIterationAncestor(call, root) {
  if (!call || !root) return true
  for (let current = call.parent; current && current !== root; current = current.parent) {
    if (
      ts.isForStatement(current) ||
      ts.isForInStatement(current) ||
      ts.isForOfStatement(current) ||
      ts.isWhileStatement(current) ||
      ts.isDoStatement(current)
    ) {
      return true
    }
  }
  return false
}

function callForOfAncestorExpressionText(call, root, source) {
  if (!call || !root) return undefined
  for (let current = call.parent; current && current !== root; current = current.parent) {
    if (ts.isForOfStatement(current)) return current.expression.getText(source)
  }
  return undefined
}

function identifierCount(root, identifier) {
  let count = 0
  visit(root, (node) => {
    if (ts.isIdentifier(node) && node.text === identifier) count += 1
  })
  return count
}

function sameSortedValues(left, right) {
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  )
}

function nodeIdentity(node) {
  return `${node.getSourceFile().fileName}:${node.getStart(node.getSourceFile())}`
}

function declarationIdentity(node) {
  const path = relative(ROOT, node.getSourceFile().fileName).split(sep).join('/')
  const name = 'name' in node && node.name ? propertyName(node.name) : undefined
  return `${path}#${name ?? '<anonymous>'}`
}

function callResolvesTo(checker, call, declaration) {
  const resolved = checker.getResolvedSignature(call)?.declaration
  if (sameDeclaration(resolved, declaration)) return true
  const resolvedName = resolved && 'name' in resolved ? resolved.name : undefined
  const declarationName = 'name' in declaration ? declaration.name : undefined
  if (!resolvedName || !declarationName) return false
  return (
    canonicalSymbol(checker, checker.getSymbolAtLocation(resolvedName)) ===
    canonicalSymbol(checker, checker.getSymbolAtLocation(declarationName))
  )
}

function sameDeclaration(left, right) {
  return (
    left !== undefined &&
    right !== undefined &&
    left.getSourceFile().fileName === right.getSourceFile().fileName &&
    left.getStart(left.getSourceFile()) === right.getStart(right.getSourceFile())
  )
}

function canonicalSymbol(checker, symbol) {
  let current = symbol
  const seen = new Set()
  while (current && (current.flags & ts.SymbolFlags.Alias) !== 0 && !seen.has(current)) {
    seen.add(current)
    current = checker.getAliasedSymbol(current)
  }
  return current
}

function semanticDescriptorOwnerIsConsumed(source, owner) {
  const sourceCalls = callsInNode(source)
  return sourceCalls.some((executeCall) => {
    if (!executeCall.expression.getText(source).endsWith('.executeSemanticOperation')) return false
    const descriptorArgument = executeCall.arguments[0]
    const descriptor = descriptorArgument ? unwrap(descriptorArgument) : undefined
    if (!descriptor || !ts.isIdentifier(descriptor)) return false
    if (descriptor.text === owner) return true
    const route = containingFunctionDeclaration(executeCall)
    if (!route?.name) return false
    const parameterIndex = route.parameters.findIndex(
      (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === descriptor.text,
    )
    if (parameterIndex < 0) return false
    return sourceCalls.some((routeCall) => {
      const argument = routeCall.arguments[parameterIndex]
      return (
        routeCall.expression.getText(source) === route.name.text &&
        argument?.getText(source) === owner
      )
    })
  })
}

function containingFunctionDeclaration(node) {
  let current = node.parent
  while (current) {
    if (ts.isFunctionDeclaration(current)) return current
    current = current.parent
  }
  return undefined
}

function callsInNode(node) {
  const calls = []
  visit(node, (current) => {
    if (ts.isCallExpression(current)) calls.push(current)
  })
  return calls
}

function containingVariableName(node) {
  let current = node.parent
  while (current) {
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
      return current.name.text
    }
    current = current.parent
  }
  return undefined
}

function objectPropertyInitializer(object, name) {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property) || propertyName(property.name) !== name) continue
    return property.initializer
  }
  return undefined
}

function objectSpreadsCall(object, name) {
  return object.properties.some((property) => {
    if (!ts.isSpreadAssignment(property)) return false
    const expression = unwrap(property.expression)
    return (
      ts.isCallExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === name
    )
  })
}

function typedExactReceiptFactoryFacts(definition, source, planFunctionName, receiptFunctionName) {
  const plan = findFunction(source, planFunctionName)
  const receipt = findFunction(source, receiptFunctionName)
  const planText = plan.getText(source)
  const receiptText = receipt.getText(source)
  return {
    contractBound: objectSpreadsCall(definition, 'semanticOperationExactReceiptContracts'),
    planBound: planText.includes('semanticOperationExactPlan({'),
    planText,
    receiptBound: receiptText.includes('semanticOperationExactReceipt(plan, {'),
    receiptText,
  }
}

function stringProperty(object, name) {
  const initializer = objectPropertyInitializer(object, name)
  return initializer ? literalText(unwrap(initializer)) : undefined
}

function validSemanticEffects(value) {
  if (!ts.isObjectLiteralExpression(value)) return false
  if (stringProperty(value, 'kind') === 'exact-invalidations') {
    return objectPropertyInitializer(value, 'expected') !== undefined
  }
  return (
    stringProperty(value, 'kind') === 'effect-kinds' &&
    stringArrayProperty(value, 'permitted').length > 0 &&
    objectPropertyInitializer(value, 'requiredWhenMutated') !== undefined
  )
}

function nonEmptyArrayProperty(object, name) {
  const initializer = objectPropertyInitializer(object, name)
  const value = initializer ? unwrap(initializer) : undefined
  return Boolean(value && ts.isArrayLiteralExpression(value) && value.elements.length > 0)
}

function arrayProperty(object, name) {
  const initializer = objectPropertyInitializer(object, name)
  const value = initializer ? unwrap(initializer) : undefined
  return Boolean(value && ts.isArrayLiteralExpression(value))
}

function nonEmptyArrayLikeProperty(object, name) {
  const initializer = objectPropertyInitializer(object, name)
  const value = initializer ? unwrap(initializer) : undefined
  return Boolean(
    value &&
      ((ts.isArrayLiteralExpression(value) && value.elements.length > 0) ||
        ts.isPropertyAccessExpression(value)),
  )
}

function stringArrayProperty(object, name) {
  const initializer = objectPropertyInitializer(object, name)
  const value = initializer ? unwrap(initializer) : undefined
  if (!value || !ts.isArrayLiteralExpression(value)) return []
  return value.elements.flatMap((element) => {
    const text = literalText(unwrap(element))
    return text === undefined ? [] : [text]
  })
}

function parseArgs(argv) {
  const parsed = { mode: 'inventory', json: false, detail: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') {
      parsed.json = true
      continue
    }
    if (arg === '--detail') {
      parsed.detail = true
      continue
    }
    if (arg !== '--mode') {
      throw new Error(`Unknown durable-command-pipeline argument: ${arg}`)
    }
    const value = argv[index + 1]
    if (!value) throw new Error(`Missing value for ${arg}`)
    if (value === 'inventory' || value === 'enforce') parsed.mode = value
    else throw new Error(`Invalid durable-command-pipeline mode: ${value}`)
    index += 1
  }
  return parsed
}

function exactUnion(unions, id) {
  const matches = unions.filter((entry) => entry.id === id)
  if (matches.length !== 1) throw new Error(`DurableCommandPipelineUnionExpectedOnce:${id}`)
  return matches[0]
}

function exactSource(currentProgram, path) {
  const source = currentProgram
    .getSourceFiles()
    .find((candidate) => relative(ROOT, candidate.fileName).split(sep).join('/') === path)
  if (!source) throw new Error(`DurableCommandPipelineSourceMissing:${path}`)
  return source
}

function findObjectLiteralAtOffset(source, offset) {
  let match
  visit(source, (node) => {
    if (!match && ts.isObjectLiteralExpression(node) && node.getStart(source) === offset) {
      match = node
    }
  })
  return match
}

function constructorSitesByVariant(union, includeOffset = false) {
  const sites = new Map(union.variants.map((variant) => [variant, []]))
  for (const site of union.constructorSites) {
    sites.get(site.variant)?.push({
      path: site.path,
      owner: site.owner,
      ...(includeOffset ? { offset: site.offset } : {}),
      confidence: site.confidence,
    })
  }
  return sites
}

function frozenArrayRecord(entries) {
  return Object.freeze(
    Object.fromEntries([...entries].map(([key, values]) => [key, Object.freeze([...values])])),
  )
}

function frozenScalarRecord(entries) {
  return Object.freeze(Object.fromEntries(entries))
}

function validatePipelineRecords(scope, records, required, outputProblems) {
  if (!records || typeof records !== 'object' || Array.isArray(records)) {
    outputProblems.push(`${scope}: pipeline records must be an object`)
    return
  }
  for (const [variant, record] of Object.entries(records)) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      outputProblems.push(`${scope} ${variant}: pipeline record must be an object`)
      continue
    }
    compareExact(
      `${scope} ${variant}: pipeline stages`,
      required,
      Object.keys(record),
      outputProblems,
    )
    for (const stage of required) {
      const disposition = record[stage]
      if (!disposition || typeof disposition !== 'object' || Array.isArray(disposition)) {
        outputProblems.push(`${scope} ${variant}: missing stage ${stage}`)
        continue
      }
      if (!VALID_STAGE_STATUSES.has(disposition.status)) {
        outputProblems.push(
          `${scope} ${variant}: stage ${stage} has invalid status ${disposition.status}`,
        )
      } else if (disposition.status === 'observed') {
        if (!validProof(disposition.proof)) {
          outputProblems.push(`${scope} ${variant}: observed stage ${stage} needs proof`)
        }
      } else if (typeof disposition.reason !== 'string' || disposition.reason.length === 0) {
        outputProblems.push(`${scope} ${variant}: gap stage ${stage} needs a reason`)
      }
    }
  }
}

function validProof(value) {
  return (
    (typeof value === 'string' && value.length > 0) ||
    (Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === 'string'))
  )
}

function proofTokens(value) {
  return Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
}

function commandDispatchCaseBodies(source) {
  const method = findMethod(source, 'BrowserWorkspaceRepository', 'dispatchCommand')
  const switchStatement = findSwitch(method, 'command.kind', source)
  const clauses = switchStatement.caseBlock.clauses
  const bodies = new Map()
  let nextBody = ''
  for (let index = clauses.length - 1; index >= 0; index -= 1) {
    const clause = clauses[index]
    if (!ts.isCaseClause(clause)) continue
    if (clause.statements.length > 0) {
      nextBody = clause.statements.map((statement) => statement.getText(source)).join('\n')
    }
    const variant = literalText(clause.expression)
    if (variant) bodies.set(variant, nextBody)
  }
  return bodies
}

function commandDispatchCaseStatements(source) {
  const method = findMethod(source, 'BrowserWorkspaceRepository', 'dispatchCommand')
  const switchStatement = findSwitch(method, 'command.kind', source)
  const clauses = switchStatement.caseBlock.clauses
  const statements = new Map()
  let nextStatements = []
  for (let index = clauses.length - 1; index >= 0; index -= 1) {
    const clause = clauses[index]
    if (!ts.isCaseClause(clause)) continue
    if (clause.statements.length > 0) nextStatements = [...clause.statements]
    const variant = literalText(clause.expression)
    if (variant) statements.set(variant, nextStatements)
  }
  return statements
}

function switchCaseBodiesForExpression(owner, expression, source) {
  const switchStatement = findSwitch(owner, expression, source)
  const bodies = new Map()
  let nextBody = ''
  for (let index = switchStatement.caseBlock.clauses.length - 1; index >= 0; index -= 1) {
    const clause = switchStatement.caseBlock.clauses[index]
    if (!ts.isCaseClause(clause)) continue
    if (clause.statements.length > 0) {
      nextBody = clause.statements.map((statement) => statement.getText(source)).join('\n')
    }
    const variant = literalText(clause.expression)
    if (variant) bodies.set(variant, nextBody)
  }
  return bodies
}

function configurationHandlerTargets(source) {
  const object = variableObjectLiteral(source, 'configurationDomainHandlers')
  const handlers = new Map()
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue
    const variant = propertyName(property.name)
    if (!variant) continue
    if (ts.isShorthandPropertyAssignment(property)) {
      handlers.set(variant, property.name.text)
      continue
    }
    const initializer = unwrap(property.initializer)
    handlers.set(
      variant,
      ts.isIdentifier(initializer)
        ? initializer.text
        : ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)
          ? '<inline>'
          : initializer.getText(source),
    )
  }
  return handlers
}

function configurationHandlerRoots(checker, source) {
  const object = variableObjectLiteral(source, 'configurationDomainHandlers')
  const handlers = new Map()
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue
    const variant = propertyName(property.name)
    if (!variant) continue
    const initializer = ts.isShorthandPropertyAssignment(property)
      ? property.name
      : unwrap(property.initializer)
    if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
      handlers.set(variant, initializer)
      continue
    }
    const symbol = canonicalSymbol(checker, checker.getSymbolAtLocation(initializer))
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0]
    if (declaration && ts.isFunctionLike(declaration)) handlers.set(variant, declaration)
  }
  return handlers
}

function manualWriteMarkerOwnerCounts(currentProgram) {
  const counts = new Map()
  for (const source of currentProgram.getSourceFiles()) {
    if (!isProductionSource(source)) continue
    const path = relative(ROOT, source.fileName).split(sep).join('/')
    const scan = (node, ownerNames) => {
      const name = declaredOwnerName(node, source)
      const nextOwners = name ? [...ownerNames, name] : ownerNames
      if (ts.isCallExpression(node)) {
        const marker = node.expression.getText(source)
        if (
          marker === 'commandMeta.markWrite' ||
          marker === 'commit.markWrite' ||
          marker === 'markWorkspaceWrite'
        ) {
          const id = `${path}#${nextOwners.join('.') || '<module>'}#${marker}`
          counts.set(id, (counts.get(id) ?? 0) + 1)
        }
      }
      node.forEachChild((child) => scan(child, nextOwners))
    }
    scan(source, [])
  }
  return counts
}

function directGrantTransactionOwnerCounts(currentProgram) {
  const counts = new Map()
  for (const path of COMMAND_TRANSACTION_BOUNDARY_PATHS) {
    const source = exactSource(currentProgram, path)
    const scan = (node, ownerNames) => {
      const name = declaredOwnerName(node, source)
      const nextOwners = name ? [...ownerNames, name] : ownerNames
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'grant.runTransaction') {
        const id = `${path}#${nextOwners.join('.') || '<module>'}#grant.runTransaction`
        counts.set(id, (counts.get(id) ?? 0) + 1)
      }
      node.forEachChild((child) => scan(child, nextOwners))
    }
    scan(source, [])
  }
  return counts
}

function validateWriteArchitectureDeclaration(architecture, output) {
  if (architecture?.mechanism !== 'transaction-local-mutation-journal') {
    output.push('write-detection architecture must use the transaction-local mutation journal')
  }
  if (architecture?.status !== 'observed') {
    output.push('transaction-local write detection must remain observed')
  }
  if (!validProof(architecture?.proof)) {
    output.push('transaction-local write detection needs proof')
  }
}

function validateTransactionDerivedWriteSource(
  browserRepo,
  mutationJournal,
  database,
  workspaceRepository,
  workspaceEffectHub,
  output,
) {
  const repoText = browserRepo.getText()
  const journalText = mutationJournal.getText()
  const databaseText = database.getText()
  const deliveryText = workspaceRepository.getText()
  const effectHubText = workspaceEffectHub.getText()

  for (const fragment of [
    'const journals = new WeakMap<DBCoreTransaction',
    'journals.get(request.trans)',
    'const value = await operation(tx)',
  ]) {
    if (!journalText.includes(fragment)) {
      output.push(`transaction mutation journal proof missing ${fragment}`)
    }
  }
  if (journalText.includes('storagemutated')) {
    output.push('transaction mutation journal must not use the global storagemutated event')
  }
  if (!databaseText.includes('installBrowserCommandMutationJournal(this)')) {
    output.push('database does not install the transaction mutation journal before commands run')
  }
  if (!hasAwaitedTransactionJournalCallback(browserRepo)) {
    output.push(
      'transaction-derived write proof missing awaited async runBrowserCommandTransaction callback',
    )
  }
  for (const fragment of [
    'this.recordCommittedMutationFacts(committed.facts)',
    'didMutateStorage: this.committedMutationTables.size > 0',
  ]) {
    if (!repoText.includes(fragment)) {
      output.push(`transaction-derived write proof missing ${fragment}`)
    }
  }
  const awaitCommit = repoText.indexOf('const committed = await grant.runTransaction')
  const mergeFacts = repoText.indexOf('this.recordCommittedMutationFacts(committed.facts)')
  if (awaitCommit < 0 || mergeFacts < 0 || awaitCommit > mergeFacts) {
    output.push('mutation facts must merge only after the fenced transaction commits')
  }
  const prepare = deliveryText.indexOf('prepared = prepareWorkspaceEffectForLocalCommit(commit)')
  const gate = deliveryText.indexOf('if (!prepared) return')
  const publishEffect = deliveryText.indexOf(
    'publishPreparedWorkspaceEffect(effect, suppressedGroups)',
  )
  const publishChange = deliveryText.indexOf('postWorkspaceChange(change)')
  if (!effectHubText.includes("if (commit.effectScope !== 'workspace') return null")) {
    output.push('local commit effect preparation is not gated by the typed effect scope')
  }
  if (prepare < 0) output.push('local commit effect preparation call is missing')
  if (gate < 0) output.push('local commit no-effect gate is missing')
  if (publishEffect < 0 || publishChange < 0) output.push('commit publication call is missing')
  if (
    prepare >= 0 &&
    gate >= 0 &&
    publishEffect >= 0 &&
    publishChange >= 0 &&
    !(prepare < gate && gate < publishEffect && publishEffect < publishChange)
  ) {
    output.push('commit publication is no longer gated by prepared committed effects')
  }
}

function hasAwaitedTransactionJournalCallback(source) {
  const method = findMethod(source, 'BrowserCommandCommit', 'runTransaction')
  let matched = false
  visit(method, (node) => {
    if (
      matched ||
      !ts.isAwaitExpression(node) ||
      !ts.isCallExpression(unwrap(node.expression)) ||
      unwrap(node.expression).expression.getText(source) !== 'grant.runTransaction'
    ) {
      return
    }
    const transactionCall = unwrap(node.expression)
    const callback = transactionCall.arguments[2] ? unwrap(transactionCall.arguments[2]) : undefined
    if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) return
    if (!callback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword))
      return
    visit(callback.body, (candidate) => {
      if (
        matched ||
        !ts.isAwaitExpression(candidate) ||
        !ts.isCallExpression(unwrap(candidate.expression))
      ) {
        return
      }
      const journalCall = unwrap(candidate.expression)
      if (
        journalCall.expression.getText(source) !== 'runBrowserCommandTransaction' ||
        journalCall.arguments[0]?.getText(source) !== 'tx'
      ) {
        return
      }
      const operationCallback = journalCall.arguments[1]
        ? unwrap(journalCall.arguments[1])
        : undefined
      if (
        !operationCallback ||
        (!ts.isArrowFunction(operationCallback) && !ts.isFunctionExpression(operationCallback))
      ) {
        return
      }
      let fencedTransactionBound = false
      let physicalWritesCollected = false
      let operationInvoked = false
      visit(operationCallback.body, (operationCandidate) => {
        if (
          ts.isVariableDeclaration(operationCandidate) &&
          ts.isIdentifier(operationCandidate.name) &&
          operationCandidate.name.text === 'fencedTransaction' &&
          operationCandidate.initializer &&
          ts.isCallExpression(unwrap(operationCandidate.initializer)) &&
          unwrap(operationCandidate.initializer).expression.getText(source) ===
            'bindFencedTransaction'
        ) {
          fencedTransactionBound = true
        }
        if (!ts.isCallExpression(operationCandidate)) return
        if (
          operationCandidate.expression.getText(source) ===
            'collectSemanticOperationPhysicalWrites' &&
          operationCandidate.arguments[0]?.getText(source) === 'fencedTransaction'
        ) {
          physicalWritesCollected = true
        }
        if (
          operationCandidate.expression.getText(source) === 'operation' &&
          operationCandidate.arguments[0]?.getText(source) === 'fencedTransaction'
        ) {
          operationInvoked = true
        }
      })
      matched = fencedTransactionBound && physicalWritesCollected && operationInvoked
    })
  })
  return matched
}

function literalArrayValues(source, variableName) {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== variableName) continue
      const initializer = declaration.initializer ? unwrap(declaration.initializer) : undefined
      if (!initializer || !ts.isArrayLiteralExpression(initializer)) {
        throw new Error(`DurableCommandPipelineArrayInvalid:${variableName}`)
      }
      return initializer.elements.flatMap((element) => {
        const value = literalText(element)
        return value ? [value] : []
      })
    }
  }
  throw new Error(`DurableCommandPipelineArrayMissing:${variableName}`)
}

function countOccurrences(text, token) {
  return text.split(token).length - 1
}

function tokensInOrder(text, tokens) {
  let cursor = 0
  for (const token of tokens) {
    const next = text.indexOf(token, cursor)
    if (next < 0) return false
    cursor = next + token.length
  }
  return true
}

function findClass(source, className) {
  for (const statement of source.statements) {
    if (ts.isClassDeclaration(statement) && statement.name?.text === className) return statement
  }
  throw new Error(`DurableCommandPipelineClassMissing:${className}`)
}

function findMethod(source, className, methodName) {
  for (const statement of source.statements) {
    if (!ts.isClassDeclaration(statement) || statement.name?.text !== className) continue
    const method = statement.members.find(
      (member) => ts.isMethodDeclaration(member) && propertyName(member.name) === methodName,
    )
    if (method) return method
  }
  throw new Error(`DurableCommandPipelineMethodMissing:${className}.${methodName}`)
}

function findInterfaceMethod(source, interfaceName, methodName) {
  for (const statement of source.statements) {
    if (!ts.isInterfaceDeclaration(statement) || statement.name.text !== interfaceName) continue
    const method = statement.members.find(
      (member) => ts.isMethodSignature(member) && propertyName(member.name) === methodName,
    )
    if (method) return method
  }
  throw new Error(`DurableCommandPipelineInterfaceMethodMissing:${interfaceName}.${methodName}`)
}

function findFunction(source, functionName) {
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === functionName)
      return statement
  }
  throw new Error(`DurableCommandPipelineFunctionMissing:${functionName}`)
}

function findNestedFunction(root, functionName) {
  let match
  visit(root, (node) => {
    if (!match && ts.isFunctionDeclaration(node) && node.name?.text === functionName) match = node
  })
  if (match) return match
  throw new Error(`DurableCommandPipelineNestedFunctionMissing:${functionName}`)
}

function findNestedMethod(root, methodName) {
  let match
  visit(root, (node) => {
    if (!match && ts.isMethodDeclaration(node) && propertyName(node.name) === methodName)
      match = node
  })
  if (match) return match
  throw new Error(`DurableCommandPipelineNestedMethodMissing:${methodName}`)
}

function findNestedVariableFunction(root, variableName) {
  let match
  visit(root, (node) => {
    if (
      !match &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === variableName &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      match = node.initializer
    }
  })
  if (match) return match
  throw new Error(`DurableCommandPipelineNestedVariableFunctionMissing:${variableName}`)
}

function findNestedObjectPropertyFunction(root, propertyNameText) {
  let match
  visit(root, (node) => {
    if (!match && ts.isPropertyAssignment(node) && propertyName(node.name) === propertyNameText) {
      const initializer = unwrap(node.initializer)
      if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
        match = initializer
      }
    }
  })
  if (match) return match
  throw new Error(`DurableCommandPipelineNestedPropertyFunctionMissing:${propertyNameText}`)
}

function findFunctionImplementation(source, functionName) {
  for (const statement of source.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === functionName &&
      statement.body
    ) {
      return statement
    }
  }
  throw new Error(`DurableCommandPipelineFunctionImplementationMissing:${functionName}`)
}

function findVariableInitializer(source, variableName) {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== variableName) continue
      if (declaration.initializer) return unwrap(declaration.initializer)
    }
  }
  throw new Error(`DurableCommandPipelineVariableMissing:${variableName}`)
}

function findFunctionOrVariableInitializer(source, ownerName) {
  for (const statement of source.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === ownerName &&
      statement.body
    ) {
      return statement
    }
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== ownerName) continue
      if (declaration.initializer) return unwrap(declaration.initializer)
    }
  }
  throw new Error(`DurableCommandPipelineDescriptorOwnerMissing:${ownerName}`)
}

function semanticDescriptorDefinition(value, source) {
  let definition = value
  if (definition && ts.isCallExpression(definition)) {
    if (definition.expression.getText(source) !== 'semanticOperationDescriptor') {
      throw new Error('DurableCommandPipelineSemanticDescriptorFactoryMismatch')
    }
    definition = definition.arguments[0] ? unwrap(definition.arguments[0]) : undefined
  }
  if (!definition || !ts.isObjectLiteralExpression(definition)) {
    throw new Error('DurableCommandPipelineSemanticDescriptorDefinitionMissing')
  }
  return definition
}

function findSwitch(node, expressionText, source) {
  let match
  visit(node, (current) => {
    if (
      !match &&
      ts.isSwitchStatement(current) &&
      unwrap(current.expression).getText(source) === expressionText
    ) {
      match = current
    }
  })
  if (!match) throw new Error(`DurableCommandPipelineSwitchMissing:${expressionText}`)
  return match
}

function variableObjectLiteral(source, name) {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue
      const initializer = declaration.initializer ? unwrap(declaration.initializer) : undefined
      if (initializer && ts.isObjectLiteralExpression(initializer)) return initializer
    }
  }
  throw new Error(`DurableCommandPipelineObjectMissing:${name}`)
}

function declaredOwnerName(node, source) {
  if (ts.isMethodDeclaration(node) && node.name) {
    return propertyName(node.name) ?? '<computed-method>'
  }
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text
  if (
    ts.isPropertyAssignment(node) &&
    (ts.isArrowFunction(unwrap(node.initializer)) ||
      ts.isFunctionExpression(unwrap(node.initializer)))
  ) {
    return propertyName(node.name) ?? '<computed-property>'
  }
  if (ts.isClassDeclaration(node) && node.name) return node.name.text
  void source
  return undefined
}

function compareCountMap(label, expectedObject, actualMap, output) {
  const expected = new Map(Object.entries(expectedObject))
  compareExact(label, [...expected.keys()], [...actualMap.keys()], output)
  for (const [id, count] of expected) {
    const actual = actualMap.get(id)
    if (actual !== undefined && actual !== count) {
      output.push(`${label}: ${id} expected ${count}, found ${actual}`)
    }
  }
}

function compareExact(label, expected, actual, output) {
  const expectedValues = [...expected].sort()
  const actualValues = [...actual].sort()
  for (const value of difference(expectedValues, actualValues))
    output.push(`${label}: missing ${value}`)
  for (const value of difference(actualValues, expectedValues)) {
    output.push(`${label}: unclassified ${value}`)
  }
  for (const value of duplicates(actualValues)) output.push(`${label}: duplicate ${value}`)
}

function difference(left, right) {
  const rightSet = new Set(right)
  return left.filter((value) => !rightSet.has(value))
}

function duplicates(values) {
  const seen = new Set()
  const repeated = new Set()
  for (const value of values) {
    if (seen.has(value)) repeated.add(value)
    else seen.add(value)
  }
  return [...repeated].sort()
}

function hasTypedSingleAttemptReplayPlan(text) {
  return (
    text.includes("kind: 'single-attempt'") && text.includes("reason: 'unfenced-relative-update'")
  )
}

function literalText(expression) {
  const current = unwrap(expression)
  return ts.isStringLiteralLike(current) ? current.text : undefined
}

function propertyName(name) {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)
    ? name.text
    : undefined
}

function unwrap(node) {
  let current = node
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression
  }
  return current
}

function visit(node, callback) {
  callback(node)
  node.forEachChild((child) => visit(child, callback))
}

function isProductionSource(source) {
  const path = resolve(source.fileName)
  return path.startsWith(`${SRC_ROOT}${sep}`) && /\.tsx?$/u.test(path) && !path.endsWith('.d.ts')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = parseArgs(process.argv.slice(2))
  const output = evaluateDurableCommandPipeline(defaultInventory, args.mode, {
    detail: args.detail,
  })
  if (args.json) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  } else {
    process.stdout.write(
      `Durable command pipeline: workspace=${output.workspaceCommands}, configuration=${output.configurationCommands}, records=${output.pipelineRecords}, cells=${output.stageCells}, gaps=${output.gapCells}, manual-markers=${output.manualMarkerCalls}, direct-transactions=${output.directTransactionCalls}.\n`,
    )
    for (const problem of output.problems) process.stderr.write(`  ${problem}\n`)
  }
  if (!output.ok) process.exitCode = 1
}
