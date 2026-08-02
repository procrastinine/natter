function observed(proof) {
  return Object.freeze({ status: 'observed', proof })
}

function gap(reason, evidence = undefined) {
  return Object.freeze({
    status: 'gap',
    reason,
    ...(evidence ? { evidence } : {}),
  })
}

const TRANSACTION_WRITE_DETECTION = observed([
  'src/store/browser-command-mutation-journal.ts#runBrowserCommandTransaction',
  'src/store/browser-repo.ts#BrowserCommandCommit.runTransaction',
])
const LOCK_GAP = gap(
  'The command-to-lock-set relationship is not represented by one exact, exhaustively checked protocol.',
)
const TRANSACTION_GAP = gap(
  'The command-to-transaction-kernel relationship is distributed across repository methods and domain helpers and is not yet exhaustively proven.',
)
const KERNEL_GAP = gap(
  'A dispatch handler is identified, but its complete helper graph and selected mutation kernel are not exhaustively proven.',
)
const TABLE_GAP = gap(
  'Declared transaction tables are guarded locally, but there is no exact command-to-table manifest spanning every helper and nested command.',
)
const PHYSICAL_WRITE_GAP = gap(
  'Physical write ports are bounded, but no deterministic proof links every command variant through its helpers to every physical write call.',
)
const RECEIPT_DELTA_GAP = gap(
  'The generic commit envelope is derived from transaction-local evidence and checked against physical mutations, but exact command-to-semantic-effect completeness is not yet proven per variant.',
  'src/store/browser-repo.ts#BrowserCommandCommit.assertPhysicalEvidenceCoverage',
)
const COMMITTED_EFFECT_PUBLICATION = observed([
  'src/store/workspace-effect-hub.ts#prepareWorkspaceEffectForLocalCommit',
  'src/store/workspace-repository.ts#deliverLocalCommit',
])
const ROLLBACK_GAP = gap(
  'Dexie transactions roll back their own writes, but no end-to-end proof covers commands that prepare, retry, or compose more than one helper boundary.',
)
const IDEMPOTENCE_GAP = gap(
  'Idempotence and retry semantics are not declared and checked per command variant.',
)
const BOUNDS_GAP = gap(
  'Time, work, and memory bounds are not declared and checked per command variant.',
)

function pipeline(handler) {
  return Object.freeze({
    constructor: observed('typed production constructor inventory'),
    admission: observed('src/store/workspace-repository.ts#bindCommitDelivery.execute'),
    dispatch: observed('src/store/browser-repo.ts#BrowserWorkspaceRepository.dispatchCommand'),
    handler: observed(handler),
    kernel: KERNEL_GAP,
    lock: LOCK_GAP,
    transaction: TRANSACTION_GAP,
    tables: TABLE_GAP,
    physicalWrites: PHYSICAL_WRITE_GAP,
    writeDetection: TRANSACTION_WRITE_DETECTION,
    receiptDelta: RECEIPT_DELTA_GAP,
    broadcast: COMMITTED_EFFECT_PUBLICATION,
    rollback: ROLLBACK_GAP,
    idempotence: IDEMPOTENCE_GAP,
    bounds: BOUNDS_GAP,
  })
}

export const WORKSPACE_COMMAND_PIPELINES = Object.freeze({
  'attachment.bundle.write': pipeline('writeAttachmentBundle'),
  'attachment.bytes.delete': pipeline('deleteAttachmentBytes'),
  'attachment.delete-if-unreferenced': pipeline('deleteAttachmentIfUnreferenced'),
  'attachment.delete-many': pipeline('deleteManyAttachments'),
  'attachment.reap': pipeline('reapAttachments'),
  'attachment.ref.add': pipeline('addAttachmentReference'),
  'attachment.ref.detach': pipeline('detachAttachmentReference'),
  'attachment.ref.relink': pipeline('relinkAttachmentReferences'),
  'attachment.ref.set-visibility': pipeline('setAttachmentReferenceVisibility'),
  'attempt.dispatch': pipeline('dispatchAttempt'),
  'attempt.finalize': pipeline('finalizeAttempt'),
  'attempt.prepare': pipeline('prepareAttempt'),
  'attempt.request-stop': pipeline('requestAttemptStop'),
  'attempt.seal-terminal': pipeline('sealAttemptTerminal'),
  'chat.calibration.clear': pipeline('clearChatCalibration'),
  'chat.calibration.clear-all': pipeline('clearCalibrationEverywhere'),
  'chat.calibration.clear-family': pipeline('clearCalibrationEverywhere'),
  'chat.delete-archived': pipeline('deleteArchivedChatRows'),
  'chat.discard-empty-drafts': pipeline('discardEmptyDraftChats'),
  'chat.empty-archive': pipeline('emptyArchivedChatRows'),
  'chat.fork': pipeline('forkChatFromMessage'),
  'chat.materialize-temporary': pipeline('materializeTemporaryChat'),
  'chat.move-to-folder': pipeline('moveChatRowsToFolder'),
  'chat.set-archived': pipeline('setChatsArchived'),
  'chat.set-manual-title': pipeline('setChatManualTitle'),
  'chat.set-tags-from-names': pipeline('setChatRowsTagsFromNames'),
  'chat.touch-viewed': pipeline('touchChatViewed'),
  'configuration.execute': pipeline('executeConfigurationCommandInBrowser'),
  'discovery.endpoints.put': pipeline('mutateDiscoveryCache'),
  'discovery.models.delete': pipeline('mutateDiscoveryCache'),
  'discovery.models.put': pipeline('mutateDiscoveryCache'),
  'discovery.privacy.put': pipeline('mutateDiscoveryCache'),
  'draft.put': pipeline('putDraftRow'),
  'folder.create': pipeline('createFolder'),
  'folder.delete': pipeline('deleteFolder'),
  'folder.ensure-and-move-chats': pipeline('ensureFolderAndMoveChats'),
  'folder.update': pipeline('updateFolder'),
  'generated-output.localization-claim': pipeline('claimGeneratedOutputLocalization'),
  'generated-output.localization-complete': pipeline('completeGeneratedOutputLocalization'),
  'generated-output.localization-fail': pipeline('failGeneratedOutputLocalization'),
  'generated-output.localization-retry': pipeline('retryGeneratedOutputLocalization'),
  'generated-output.video-expand': pipeline('expandGeneratedOutputVideo'),
  'generation.post-commit-metadata': pipeline('commitGenerationMetadata'),
  'interchange.import-chat': pipeline('importChats'),
  'interchange.import-chat-preset': pipeline('importChatPreset'),
  'interchange.import-connection-profile': pipeline('importConnectionProfile'),
  'maintenance.prune-discovery-cache': pipeline('pruneDiscoveryCache'),
  'maintenance.prune-empty-draft-chats': pipeline('pruneEmptyDraftChats'),
  'maintenance.prune-terminal-stream-journals': pipeline('pruneTerminalStreamJournals'),
  'maintenance.reconcile-attachment-integrity': pipeline('reconcileAttachmentIntegrity'),
  'maintenance.reconcile-stream-journal-integrity': pipeline('reconcileStreamJournalIntegrity'),
  'message.delete': pipeline([
    'deletePairInRepository',
    'deleteSingleMessageInRepository',
    'deleteTurnInRepository',
    'deleteVariantInRepository',
  ]),
  'message.dismiss-generation-notice': pipeline('mutateMessageBodyInRepository'),
  'message.edit-body': pipeline('editMessageBodyInRepository'),
  'message.import': pipeline('pasteImportInRepository'),
  'message.restore-structure': pipeline('applyStructuralSnapshotInRepository'),
  'message.toggle-context': pipeline('mutateMessageBodyInRepository'),
  'message.toggle-provider-output-item': pipeline('mutateMessageBodyInRepository'),
  'message.toggle-reasoning-detail': pipeline('mutateMessageBodyInRepository'),
  'stream.append-journal-frames': pipeline('appendStreamJournalFrames'),
  'stream.claim-recovery': pipeline('claimStreamLeaseForRecovery'),
  'stream.finish-cleanup': pipeline('deleteStreamJournal'),
  'stream.handoff-recovery': pipeline('handoffStreamLeaseForRecovery'),
  'stream.note-selected-key': pipeline('noteStreamSelectedKey'),
  'stream.renew': pipeline('renewStreamLease'),
})

function configurationPipeline(handler, reachable = true) {
  const record = pipeline(handler)
  return Object.freeze({
    ...record,
    constructor: reachable
      ? record.constructor
      : gap(
          'The nested configuration protocol inventory found no typed production constructor for this declared command.',
          'scripts/configuration-protocol-inventory.mjs',
        ),
    admission: observed('src/store/configuration-command-client.ts#executeConfigurationCommand'),
    dispatch: observed('src/store/browser-configuration-domain.ts#configurationDomainHandlers'),
  })
}

export const CONFIGURATION_COMMAND_PIPELINES = Object.freeze({
  'chat-preset.apply': configurationPipeline('applyChatPreset'),
  'chat-preset.create': configurationPipeline('createChatPreset'),
  'chat-preset.create-and-link': configurationPipeline('createAndLinkChatPreset'),
  'chat-preset.delete': configurationPipeline('deleteChatPreset'),
  'chat-preset.duplicate': configurationPipeline('duplicateChatPreset'),
  'chat-preset.move': configurationPipeline('moveChatPreset'),
  'chat-preset.save': configurationPipeline('saveChatPreset'),
  'chat-preset.set-archived': configurationPipeline('setChatPresetArchived'),
  'chat-preset.update': configurationPipeline('updateChatPreset'),
  'chat.resolve-model': configurationPipeline('resolveChatModel', true),
  'chat.settings-fields-patch': configurationPipeline('<inline>'),
  'chat.settings-patch': configurationPipeline('<inline>'),
  'chat.settings-replace': configurationPipeline('<inline>'),
  'chat.switch-profile': configurationPipeline('switchChatProfile'),
  'connection.create': configurationPipeline('createConnection'),
  'connection.delete': configurationPipeline('deleteConnection'),
  'connection.duplicate': configurationPipeline('duplicateConnection'),
  'connection.edit': configurationPipeline('editConnection'),
  'connection.touch': configurationPipeline('touchConnection'),
  'global-preference.set': configurationPipeline('<inline>'),
  'image-allowlist.add': configurationPipeline('mutateImageAllowlist'),
  'image-allowlist.remove': configurationPipeline('mutateImageAllowlist'),
  'install-secret.ensure': configurationPipeline('<inline>'),
  'key.delete': configurationPipeline('deleteKey'),
  'key.material-replace': configurationPipeline('replaceKeyMaterial'),
  'key.put': configurationPipeline('putKey'),
  'key.touch': configurationPipeline('touchKey'),
  'pinned-model.move': configurationPipeline('<inline>'),
  'pinned-model.set-membership': configurationPipeline('<inline>'),
  'prompt-preset.create-and-pin': configurationPipeline('createAndPinPrompt'),
  'prompt-preset.delete': configurationPipeline('deletePromptPreset'),
  'prompt-preset.load-and-pin': configurationPipeline('loadAndPinPrompt'),
  'prompt-preset.local-commit': configurationPipeline('commitLocalPrompt'),
  'prompt-preset.overwrite-and-pin': configurationPipeline('overwriteAndPinPrompt'),
  'prompt-preset.rename': configurationPipeline('renamePromptPreset'),
  'recent-model.clear': configurationPipeline('<inline>'),
  'rendering-preferences.patch': configurationPipeline('patchRenderingPreferences'),
  'sample-prompts.set-dismissed': configurationPipeline('<inline>'),
  'sidebar-preference.set-folder-collapsed': configurationPipeline('<inline>'),
  'sidebar-preference.set-sort': configurationPipeline('<inline>'),
  'text-template.create': configurationPipeline('createTextTemplate'),
  'text-template.create-and-select': configurationPipeline('createAndSelectTextTemplate'),
  'text-template.delete': configurationPipeline('deleteTextTemplate'),
  'text-template.update': configurationPipeline('updateTextTemplate'),
})

export const MANUAL_WRITE_MARKER_OWNER_COUNTS = Object.freeze({})

export const DIRECT_COMMAND_TRANSACTION_OWNER_COUNTS = Object.freeze({
  'src/store/browser-import-export.ts#commitPreparedBrowserWorkspaceBackup#grant.runTransaction': 2,
  'src/store/browser-repo.ts#BrowserCommandCommit.runTransaction#grant.runTransaction': 1,
})

export const WRITE_DETECTION_ARCHITECTURE = Object.freeze({
  mechanism: 'transaction-local-mutation-journal',
  status: 'observed',
  proof: [
    'src/store/browser-command-mutation-journal.ts#runBrowserCommandTransaction',
    'src/store/browser-repo.ts#BrowserCommandCommit.runTransaction',
  ],
})

export const REQUIRED_PIPELINE_STAGES = Object.freeze([
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
