import type {
  AttachmentArtifact,
  AttachmentId,
  ChatSettings,
  ConnectionProfile,
  KeyId,
  Message,
  MessageAttachmentRef,
  MessageId,
  PromptPresetKind,
} from '../types'
import type {
  PortableAttachmentBundle,
  PortableChatPayload,
  WorkspaceBackupPayload,
} from './schema'

export interface WorkspaceValidationResult {
  readonly attachmentRefCounts: ReadonlyMap<AttachmentId, number>
}

export function validateWorkspaceBackupGraph(
  payload: WorkspaceBackupPayload,
): WorkspaceValidationResult {
  const chats = uniqueMap(payload.chats, (row) => row.id, 'Chat')
  const messages = uniqueMap(payload.messages, (row) => row.id, 'Message')
  const attachments = uniqueMap(payload.attachments, (row) => row.attachment.id, 'Attachment')
  const profiles = uniqueMap(payload.profiles, (row) => row.id, 'Profile')
  const presets = uniqueMap(payload.presets, (row) => row.id, 'Preset')
  const promptPresets = uniqueMap(payload.promptPresets, (row) => row.id, 'PromptPreset')
  const folders = uniqueMap(payload.folders, (row) => row.id, 'Folder')
  const tags = uniqueMap(payload.tags, (row) => row.id, 'Tag')
  const keys = uniqueMap(payload.keys, (row) => row.id, 'Key')
  uniqueMap(payload.settings, (row) => row.key, 'Setting')
  uniqueMap(payload.drafts, (row) => row.chatId, 'Draft')
  uniqueMap(payload.childLists, (row) => row.id, 'ChildList')
  uniqueMap(payload.chatBranchCache, (row) => row.chatId, 'ChatBranchCache')

  validateMessages(payload.messages, chats, messages)
  validateProfiles(payload.profiles, keys)
  validateChats(payload, messages, profiles, presets, promptPresets, folders, tags)
  validatePresets(payload, profiles, promptPresets)
  validateDrafts(payload, chats)
  validateChildLists(payload, chats, messages)
  validateBranchCaches(payload, chats, messages)
  validateAttachmentBundles(payload.attachments, attachments)
  const attachmentRefCounts = validateAttachmentReferences(payload, attachments)
  for (const bundle of payload.attachments) {
    const expected = attachmentRefCounts.get(bundle.attachment.id) ?? 0
    if (bundle.attachment.refCount !== expected) {
      throw new Error(
        `ImportAttachmentRefCountMismatch:${bundle.attachment.id}:${bundle.attachment.refCount}:${expected}`,
      )
    }
  }
  return { attachmentRefCounts }
}

export function validatePortableChatGraph(payload: PortableChatPayload): void {
  const messages = uniqueMap(payload.messages, (row) => row.id, 'Message')
  const chats = new Map([[payload.chat.sourceChatId, { id: payload.chat.sourceChatId }]])
  const attachments = uniqueMap(payload.attachments, (row) => row.attachment.id, 'Attachment')
  validateMessages(payload.messages, chats, messages)
  validateAttachmentBundles(payload.attachments, attachments)
  validateMessageAttachmentReferences(payload.messages, attachments)
}

function validateMessages(
  rows: readonly Message[],
  chats: ReadonlyMap<string, { id: string }>,
  messages: ReadonlyMap<MessageId, Message>,
): void {
  const turnOwners = new Map<string, string>()
  const siblingIndexes = new Map<string, Map<MessageId | null, Set<number>>>()
  for (const message of rows) {
    if (!chats.has(message.chatId)) throw new Error(`ImportMessageChatMissing:${message.id}`)
    const owner = turnOwners.get(message.turnId)
    if (owner !== undefined && owner !== message.chatId) {
      throw new Error(`ImportTurnChatMismatch:${message.turnId}`)
    }
    turnOwners.set(message.turnId, message.chatId)
    if (message.parentId !== null) {
      const parent = messages.get(message.parentId)
      if (!parent) throw new Error(`ImportParentMissing:${message.id}`)
      if (parent.chatId !== message.chatId)
        throw new Error(`ImportParentChatMismatch:${message.id}`)
    }
    const byParent = siblingIndexes.get(message.chatId) ?? new Map<MessageId | null, Set<number>>()
    siblingIndexes.set(message.chatId, byParent)
    const indexes = byParent.get(message.parentId) ?? new Set<number>()
    byParent.set(message.parentId, indexes)
    if (indexes.has(message.siblingIndex)) {
      throw new Error(`ImportSiblingIndexDuplicate:${message.chatId}:${message.parentId ?? ''}`)
    }
    indexes.add(message.siblingIndex)
  }
  validateParentCycles(rows, messages)
}

function validateParentCycles(
  rows: readonly Message[],
  messages: ReadonlyMap<MessageId, Message>,
): void {
  const complete = new Set<MessageId>()
  for (const start of rows) {
    if (complete.has(start.id)) continue
    const path: MessageId[] = []
    const pathIndexes = new Map<MessageId, number>()
    let current: Message | undefined = start
    while (current && !complete.has(current.id)) {
      const priorIndex = pathIndexes.get(current.id)
      if (priorIndex !== undefined) {
        throw new Error(`ImportParentCycle:${path[priorIndex] ?? current.id}`)
      }
      pathIndexes.set(current.id, path.length)
      path.push(current.id)
      current = current.parentId === null ? undefined : messages.get(current.parentId)
    }
    for (const id of path) complete.add(id)
  }
}

function validateChats(
  payload: WorkspaceBackupPayload,
  messages: ReadonlyMap<MessageId, Message>,
  profiles: ReadonlyMap<string, { id: string }>,
  presets: ReadonlyMap<string, { id: string }>,
  promptPresets: ReadonlyMap<string, { id: string; kind: PromptPresetKind }>,
  folders: ReadonlyMap<string, { id: string }>,
  tags: ReadonlyMap<string, { id: string }>,
): void {
  for (const chat of payload.chats) {
    if (chat.settings.profileId !== '' && !profiles.has(chat.settings.profileId)) {
      throw new Error(`ImportChatProfileMissing:${chat.id}:${chat.settings.profileId}`)
    }
    if (chat.presetId !== undefined && !presets.has(chat.presetId)) {
      throw new Error(`ImportChatPresetMissing:${chat.id}:${chat.presetId}`)
    }
    if (chat.folderId !== null && !folders.has(chat.folderId)) {
      throw new Error(`ImportChatFolderMissing:${chat.id}:${chat.folderId}`)
    }
    assertUniqueStrings(chat.tags, `ImportChatTagDuplicate:${chat.id}`)
    for (const tagId of chat.tags) {
      if (!tags.has(tagId)) throw new Error(`ImportChatTagMissing:${chat.id}:${tagId}`)
    }
    validatePromptPins(chat.settings, promptPresets, `chat:${chat.id}`)
    if (chat.lastUpdatedLeafId !== null) {
      const leaf = messages.get(chat.lastUpdatedLeafId)
      if (!leaf) throw new Error(`ImportChatLeafMissing:${chat.id}:${chat.lastUpdatedLeafId}`)
      if (leaf.chatId !== chat.id) throw new Error(`ImportChatLeafOwnership:${chat.id}`)
      if (leaf.deleted) throw new Error(`ImportChatLeafDeleted:${chat.id}:${leaf.id}`)
    }
  }
}

function validatePresets(
  payload: WorkspaceBackupPayload,
  profiles: ReadonlyMap<string, { id: string }>,
  promptPresets: ReadonlyMap<string, { id: string; kind: PromptPresetKind }>,
): void {
  for (const preset of payload.presets) {
    if (preset.settings.profileId !== preset.connectionProfileId) {
      throw new Error(`ImportPresetProfileMismatch:${preset.id}`)
    }
    if (!profiles.has(preset.connectionProfileId)) {
      throw new Error(
        `ImportPresetConnectionProfileMissing:${preset.id}:${preset.connectionProfileId}`,
      )
    }
    if (!profiles.has(preset.settings.profileId)) {
      throw new Error(
        `ImportPresetSettingsProfileMissing:${preset.id}:${preset.settings.profileId}`,
      )
    }
    validatePromptPins(preset.settings, promptPresets, `preset:${preset.id}`)
  }
}

function validateProfiles(
  profiles: readonly ConnectionProfile[],
  keys: ReadonlyMap<KeyId, { id: KeyId }>,
): void {
  for (const profile of profiles) {
    validateProfileKeyRef(profile, 'primary', profile.apiKeyRef, keys)
    for (const keyId of profile.apiKeyFallbackRefs ?? []) {
      validateProfileKeyRef(profile, 'fallback', keyId, keys)
    }
    if (profile.managementApiKeyRef !== undefined) {
      validateProfileKeyRef(profile, 'management', profile.managementApiKeyRef, keys)
    }
  }
}

function validateProfileKeyRef(
  profile: ConnectionProfile,
  kind: 'primary' | 'fallback' | 'management',
  keyId: KeyId,
  keys: ReadonlyMap<KeyId, { id: KeyId }>,
): void {
  if (!keys.has(keyId)) throw new Error(`ImportProfileKeyMissing:${profile.id}:${kind}:${keyId}`)
}

function validatePromptPins(
  settings: ChatSettings,
  presets: ReadonlyMap<string, { id: string; kind: PromptPresetKind }>,
  owner: string,
): void {
  const pins: Array<[string | undefined, PromptPresetKind]> = [
    [settings.systemPromptPresetId, 'system'],
    [settings.appendPromptPresetId, 'append'],
    [settings.continueSystemPromptPresetId, 'continue-system'],
    [settings.continueUserPromptPresetId, 'continue-user'],
    [settings.defaultPrefillPresetId, 'prefill'],
  ]
  for (const [id, kind] of pins) {
    if (id === undefined) continue
    const preset = presets.get(id)
    if (!preset) throw new Error(`ImportPromptPresetMissing:${owner}:${id}`)
    if (preset.kind !== kind) throw new Error(`ImportPromptPresetKindMismatch:${owner}:${id}`)
  }
}

function validateDrafts(
  payload: WorkspaceBackupPayload,
  chats: ReadonlyMap<string, { id: string }>,
): void {
  for (const draft of payload.drafts) {
    if (!chats.has(draft.chatId)) throw new Error(`ImportDraftChatMissing:${draft.chatId}`)
  }
}

function validateChildLists(
  payload: WorkspaceBackupPayload,
  chats: ReadonlyMap<string, { id: string }>,
  messages: ReadonlyMap<MessageId, Message>,
): void {
  for (const childList of payload.childLists) {
    if (!chats.has(childList.chatId)) throw new Error(`ImportChildListChatMissing:${childList.id}`)
    const expectedId = `${childList.chatId}:${childList.parentId ?? '__root__'}`
    if (childList.id !== expectedId) throw new Error(`ImportChildListIdMismatch:${childList.id}`)
    if (childList.parentId !== null) {
      const parent = messages.get(childList.parentId)
      if (!parent) throw new Error(`ImportChildListParentMissing:${childList.id}`)
      if (parent.chatId !== childList.chatId) {
        throw new Error(`ImportChildListParentOwnership:${childList.id}`)
      }
    }
  }
}

function validateBranchCaches(
  payload: WorkspaceBackupPayload,
  chats: ReadonlyMap<string, { id: string }>,
  messages: ReadonlyMap<MessageId, Message>,
): void {
  for (const cache of payload.chatBranchCache) {
    if (!chats.has(cache.chatId)) throw new Error(`ImportBranchCacheChatMissing:${cache.chatId}`)
    if (cache.branchLeafId !== null) {
      const leaf = messages.get(cache.branchLeafId)
      if (!leaf) throw new Error(`ImportBranchCacheLeafMissing:${cache.chatId}`)
      if (leaf.chatId !== cache.chatId)
        throw new Error(`ImportBranchCacheLeafOwnership:${cache.chatId}`)
    }
    if (cache.messageCount !== cache.messageTimestamps.length) {
      throw new Error(`ImportBranchCacheCountMismatch:${cache.chatId}`)
    }
    const seen = new Set<MessageId>()
    for (const timestamp of cache.messageTimestamps) {
      if (seen.has(timestamp.id))
        throw new Error(`ImportBranchCacheMessageDuplicate:${cache.chatId}`)
      seen.add(timestamp.id)
      const message = messages.get(timestamp.id)
      if (!message)
        throw new Error(`ImportBranchCacheMessageMissing:${cache.chatId}:${timestamp.id}`)
      if (message.chatId !== cache.chatId) {
        throw new Error(`ImportBranchCacheMessageOwnership:${cache.chatId}:${timestamp.id}`)
      }
    }
  }
}

function validateAttachmentBundles(
  bundles: readonly PortableAttachmentBundle[],
  attachments: ReadonlyMap<AttachmentId, PortableAttachmentBundle>,
): void {
  const blobIds = new Set<string>()
  const artifactIds = new Set<string>()
  const jobIds = new Set<string>()
  for (const bundle of bundles) {
    const attachment = bundle.attachment
    if (attachment.refCount < 0) throw new Error(`ImportAttachmentRefCountInvalid:${attachment.id}`)
    const blobsById = new Map<string, (typeof bundle.blobs)[number]>()
    for (const blob of bundle.blobs) {
      if (blobIds.has(blob.id)) throw new Error(`ImportAttachmentBlobDuplicateId:${blob.id}`)
      blobIds.add(blob.id)
      if (blob.attachmentId !== attachment.id) {
        throw new Error(`ImportAttachmentBlobOwnership:${blob.id}`)
      }
      blobsById.set(blob.id, blob)
    }
    const artifactsById = new Map<string, AttachmentArtifact>()
    for (const artifact of bundle.artifacts) {
      if (artifactIds.has(artifact.artifactId)) {
        throw new Error(`ImportAttachmentArtifactDuplicateId:${artifact.artifactId}`)
      }
      artifactIds.add(artifact.artifactId)
      if (artifact.attachmentId !== attachment.id) {
        throw new Error(`ImportAttachmentArtifactOwnership:${artifact.artifactId}`)
      }
      if (artifact.kind === 'text' && artifact.charCount !== artifact.text.length) {
        throw new Error(`ImportAttachmentArtifactCharCountMismatch:${artifact.artifactId}`)
      }
      if (artifact.kind === 'blob' && !blobsById.has(artifact.blobId)) {
        throw new Error(`ImportAttachmentArtifactBlobMissing:${artifact.artifactId}`)
      }
      artifactsById.set(artifact.artifactId, artifact)
    }
    for (const artifact of attachment.artifacts) {
      if (!artifactsById.has(artifact.artifactId)) {
        throw new Error(`ImportAttachmentEmbeddedArtifactMissing:${artifact.artifactId}`)
      }
    }
    for (const state of attachment.processing) {
      validateArtifactOutputs(state.outputArtifactIds, artifactsById, attachment.id)
    }
    for (const job of bundle.jobs) {
      if (jobIds.has(job.id)) throw new Error(`ImportAttachmentJobDuplicateId:${job.id}`)
      jobIds.add(job.id)
      if (job.attachmentId !== attachment.id)
        throw new Error(`ImportAttachmentJobOwnership:${job.id}`)
      validateArtifactOutputs(job.outputArtifactIds, artifactsById, job.id)
    }
    if (attachment.storage.kind === 'local-blob') {
      const original = blobsById.get(attachment.storage.blobId)
      if (!original) throw new Error(`ImportAttachmentStorageBlobMissing:${attachment.id}`)
      if (attachment.contentHash && original.contentHash !== attachment.contentHash) {
        throw new Error(`ImportAttachmentHashMismatch:${attachment.id}`)
      }
      if (attachment.sizeBytes !== undefined && original.sizeBytes !== attachment.sizeBytes) {
        throw new Error(`ImportAttachmentSizeMismatch:${attachment.id}`)
      }
    } else if (attachment.storage.kind === 'missing' && blobsById.size > 0) {
      throw new Error(`ImportMissingAttachmentContainsBytes:${attachment.id}`)
    }
    if (attachment.thumbnailBlobId && !blobsById.has(attachment.thumbnailBlobId)) {
      throw new Error(`ImportAttachmentThumbnailMissing:${attachment.id}`)
    }
    if (
      attachment.supersededByAttachmentId !== undefined &&
      !attachments.has(attachment.supersededByAttachmentId)
    ) {
      throw new Error(`ImportAttachmentSupersederMissing:${attachment.id}`)
    }
  }
}

function validateArtifactOutputs(
  ids: readonly string[],
  artifacts: ReadonlyMap<string, AttachmentArtifact>,
  owner: string,
): void {
  assertUniqueStrings(ids, `ImportAttachmentArtifactOutputDuplicate:${owner}`)
  for (const id of ids) {
    if (!artifacts.has(id)) throw new Error(`ImportAttachmentArtifactOutputMissing:${owner}:${id}`)
  }
}

function validateAttachmentReferences(
  payload: WorkspaceBackupPayload,
  attachments: ReadonlyMap<AttachmentId, PortableAttachmentBundle>,
): Map<AttachmentId, number> {
  const counts = new Map<AttachmentId, number>()
  validateMessageAttachmentReferences(payload.messages, attachments, counts)
  for (const draft of payload.drafts) {
    validateOwnerRefs('draft', draft.chatId, draft.attachmentRefs, attachments, counts)
  }
  return counts
}

function validateMessageAttachmentReferences(
  messages: readonly Message[],
  attachments: ReadonlyMap<AttachmentId, PortableAttachmentBundle>,
  counts = new Map<AttachmentId, number>(),
): Map<AttachmentId, number> {
  for (const message of messages) {
    validateOwnerRefs('message', message.id, message.attachmentRefs ?? [], attachments, counts)
    const liveAttachmentIds = new Set(
      (message.attachmentRefs ?? [])
        .filter((ref) => ref.deletedAt === undefined)
        .map((ref) => ref.attachmentId),
    )
    for (const item of message.content) {
      if (!('attachmentId' in item)) continue
      if (!attachments.has(item.attachmentId)) {
        throw new Error(`ImportContentAttachmentMissing:${message.id}:${item.attachmentId}`)
      }
      if (!liveAttachmentIds.has(item.attachmentId)) {
        throw new Error(`ImportContentAttachmentRefMissing:${message.id}:${item.attachmentId}`)
      }
    }
  }
  return counts
}

function validateOwnerRefs(
  ownerKind: 'message' | 'draft',
  ownerId: string,
  refs: readonly MessageAttachmentRef[],
  attachments: ReadonlyMap<AttachmentId, PortableAttachmentBundle>,
  counts: Map<AttachmentId, number>,
): void {
  const refIds = new Set<string>()
  for (const ref of refs) {
    if (refIds.has(ref.refId)) {
      throw new Error(`DuplicateAttachmentRefId:${ownerKind}:${ownerId}:${ref.refId}`)
    }
    refIds.add(ref.refId)
    if (!attachments.has(ref.attachmentId)) throw new Error(`AttachmentMissing:${ref.attachmentId}`)
    if (ref.deletedAt !== undefined) continue
    counts.set(ref.attachmentId, (counts.get(ref.attachmentId) ?? 0) + 1)
  }
}

function uniqueMap<T>(
  rows: readonly T[],
  keyOf: (row: T) => string,
  label: string,
): Map<string, T> {
  const result = new Map<string, T>()
  for (const row of rows) {
    const key = keyOf(row)
    if (result.has(key)) throw new Error(`Import${label}DuplicateId:${key}`)
    result.set(key, row)
  }
  return result
}

function assertUniqueStrings(values: readonly string[], error: string): void {
  if (new Set(values).size !== values.length) throw new Error(error)
}
