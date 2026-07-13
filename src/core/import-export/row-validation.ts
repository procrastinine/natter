const MESSAGE_ROLES = new Set(['system', 'user', 'assistant', 'tool', 'developer'])
const MESSAGE_ORIGINS = new Set(['user', 'generated', 'imported', 'continued', 'prefill'])
const CONTENT_TYPES = new Set([
  'text',
  'image_url',
  'input_audio',
  'file',
  'video_url',
  'output_text',
  'output_image',
  'audio_output',
  'output_video',
])
const ATTACHMENT_KINDS = new Set([
  'image',
  'pdf',
  'audio',
  'video',
  'plaintext',
  'code',
  'document',
  'spreadsheet',
  'presentation',
  'archive',
  'other',
  'file',
])
const ATTACHMENT_ORIGINS = new Set([
  'user-upload',
  'user-remote-url',
  'generated-output',
  'server-tool-peel',
  'import',
  'system-fixture',
])
const CONNECTION_KINDS = new Set([
  'openrouter',
  'openai-compatible',
  'anthropic',
  'google',
  'llama-server',
  'custom',
])
const PROMPT_PRESET_KINDS = new Set([
  'system',
  'append',
  'continue-system',
  'continue-user',
  'prefill',
])
const GENERATION_APIS = new Set([
  'chat',
  'responses',
  'gemini-native',
  'anthropic-messages',
  'completion',
  'video-generation',
])
const GENERATION_STATUSES = new Set(['streaming', 'done', 'error', 'abort', 'interrupted'])

export function assertWorkspaceBackupRows(value: Record<string, unknown>): void {
  for (const row of array(value.chats, 'chats')) assertChat(row)
  for (const row of array(value.messages, 'messages')) assertMessage(row)
  for (const row of array(value.childLists, 'childLists')) assertChildList(row)
  for (const row of array(value.chatBranchCache, 'chatBranchCache')) assertBranchCache(row)
  for (const row of array(value.attachments, 'attachments')) assertAttachmentBundle(row)
  for (const row of array(value.profiles, 'profiles')) assertProfile(row)
  for (const row of array(value.presets, 'presets')) assertPreset(row)
  for (const row of array(value.promptPresets, 'promptPresets')) assertPromptPreset(row)
  for (const row of array(value.folders, 'folders')) assertFolder(row)
  for (const row of array(value.tags, 'tags')) assertTag(row)
  for (const row of array(value.drafts, 'drafts')) assertDraft(row)
  for (const row of array(value.keys, 'keys')) assertKey(row)
  for (const row of array(value.settings, 'settings')) {
    const record = object(row, 'settings row')
    string(record.key, 'settings.key')
  }
}

export function assertPortableChatRows(value: Record<string, unknown>): void {
  const chat = object(value.chat, 'portable chat')
  string(chat.sourceChatId, 'portable chat.sourceChatId')
  string(chat.title, 'portable chat.title')
  finite(chat.createdAt, 'portable chat.createdAt')
  finite(chat.updatedAt, 'portable chat.updatedAt')
  assertChatSettings(chat.settings, 'portable chat.settings')
  if (chat.favoriteModels !== undefined)
    strings(chat.favoriteModels, 'portable chat.favoriteModels')
  if (chat.recentModels !== undefined) strings(chat.recentModels, 'portable chat.recentModels')
  for (const row of array(value.messages, 'portable chat.messages')) assertMessage(row)
  if (value.folder !== undefined) assertPortableNamedSketch(value.folder, 'portable chat.folder')
  for (const row of array(value.tags, 'portable chat.tags')) {
    assertPortableNamedSketch(row, 'portable chat.tag')
  }
  for (const row of array(value.attachments, 'portable chat.attachments')) {
    assertAttachmentBundle(row)
  }
  if (value.connectionSketch !== undefined) assertConnectionSketch(value.connectionSketch)
}

export function assertPortableChatPresetRows(value: Record<string, unknown>): void {
  string(value.sourcePresetId, 'portable preset.sourcePresetId')
  string(value.name, 'portable preset.name')
  assertChatSettings(value.settings, 'portable preset.settings')
  finite(value.createdAt, 'portable preset.createdAt')
  finite(value.updatedAt, 'portable preset.updatedAt')
  if (value.connectionSketch !== undefined) assertConnectionSketch(value.connectionSketch)
}

function assertPortableNamedSketch(value: unknown, label: string): void {
  const row = object(value, label)
  string(row.name, `${label}.name`)
  optionalString(row.color, `${label}.color`)
}

function assertConnectionSketch(value: unknown): void {
  const row = object(value, 'connection sketch')
  optionalString(row.sourceProfileId, 'connection sketch.sourceProfileId')
  string(row.name, 'connection sketch.name')
  enumValue(row.kind, CONNECTION_KINDS, 'connection sketch.kind')
  string(row.baseUrl, 'connection sketch.baseUrl')
}

function assertChat(value: unknown): void {
  const row = object(value, 'chat')
  string(row.id, 'chat.id')
  string(row.title, 'chat.title')
  string(row.titleStatus, 'chat.titleStatus')
  finite(row.createdAt, 'chat.createdAt')
  finite(row.updatedAt, 'chat.updatedAt')
  finite(row.lastViewedAt, 'chat.lastViewedAt')
  finite(row.wordCount, 'chat.wordCount')
  finite(row.totalCostUsd, 'chat.totalCostUsd')
  integer(row.metaVersion, 'chat.metaVersion')
  integer(row.summaryVersion, 'chat.summaryVersion')
  assertChatSettings(row.settings, 'chat.settings')
  optionalString(row.presetId, 'chat.presetId')
  nullableString(row.lastUpdatedLeafId, 'chat.lastUpdatedLeafId')
  finite(row.lastBranchUpdatedAt, 'chat.lastBranchUpdatedAt')
  boolean(row.archived, 'chat.archived')
  boolean(row.pinned, 'chat.pinned')
  nullableString(row.folderId, 'chat.folderId')
  strings(row.tags, 'chat.tags')
}

function assertChatSettings(value: unknown, label: string): void {
  const row = object(value, label)
  string(row.profileId, `${label}.profileId`)
  string(row.model, `${label}.model`)
  string(row.systemPrompt, `${label}.systemPrompt`)
  enumValue(row.systemRole, new Set(['system', 'developer']), `${label}.systemRole`)
  string(row.appendPrompt, `${label}.appendPrompt`)
  string(row.continueSystemPrompt, `${label}.continueSystemPrompt`)
  string(row.continueUserPrompt, `${label}.continueUserPrompt`)
  const sampling = object(row.sampling, `${label}.sampling`)
  for (const value of Object.values(sampling)) finite(value, `${label}.sampling`)
  if (row.fallbackModels !== undefined) strings(row.fallbackModels, `${label}.fallbackModels`)
  if (row.stop !== undefined) strings(row.stop, `${label}.stop`)
  if (row.modalities !== undefined) strings(row.modalities, `${label}.modalities`)
  const reasoning = object(row.reasoning, `${label}.reasoning`)
  string(reasoning.mode, `${label}.reasoning.mode`)
  boolean(reasoning.exclude, `${label}.reasoning.exclude`)
  const include = object(reasoning.include, `${label}.reasoning.include`)
  boolean(include.encrypted, `${label}.reasoning.include.encrypted`)
  boolean(include.summary, `${label}.reasoning.include.summary`)
  boolean(include.text, `${label}.reasoning.include.text`)
  const contextStrategy = object(row.contextStrategy, `${label}.contextStrategy`)
  string(contextStrategy.kind, `${label}.contextStrategy.kind`)
  finite(contextStrategy.reservedForCompletion, `${label}.contextStrategy.reservedForCompletion`)
  string(contextStrategy.onOverflow, `${label}.contextStrategy.onOverflow`)
  boolean(row.allowFallbacks, `${label}.allowFallbacks`)
  string(row.mediaContextStrategy, `${label}.mediaContextStrategy`)
  boolean(row.cacheRemoteImages, `${label}.cacheRemoteImages`)
  boolean(row.stripExifOnUpload, `${label}.stripExifOnUpload`)
  string(row.toolContextStrategy, `${label}.toolContextStrategy`)
  const toolCallContext = object(row.toolCallContext, `${label}.toolCallContext`)
  boolean(toolCallContext.include, `${label}.toolCallContext.include`)
  strings(row.enabledToolIds, `${label}.enabledToolIds`)
  const tools = object(row.tools, `${label}.tools`)
  for (const provider of ['openrouter', 'openai', 'anthropic', 'google']) {
    const bucket = object(tools[provider], `${label}.tools.${provider}`)
    strings(bucket.enabledServerToolIds, `${label}.tools.${provider}.enabledServerToolIds`)
  }
  strings(row.enabledPluginIds, `${label}.enabledPluginIds`)
  strings(row.trustedToolIds, `${label}.trustedToolIds`)
  boolean(row.autoContinueToolLoop, `${label}.autoContinueToolLoop`)
  const cache = object(row.anthropicCache, `${label}.anthropicCache`)
  string(cache.mode, `${label}.anthropicCache.mode`)
  string(cache.ttl, `${label}.anthropicCache.ttl`)
  const privacy = object(row.privacy, `${label}.privacy`)
  boolean(privacy.denyDataCollection, `${label}.privacy.denyDataCollection`)
  boolean(privacy.zdrOnly, `${label}.privacy.zdrOnly`)
  boolean(privacy.paretoFilter, `${label}.privacy.paretoFilter`)
  boolean(privacy.byokEnabled, `${label}.privacy.byokEnabled`)
  string(row.api, `${label}.api`)
  string(row.userIdMode, `${label}.userIdMode`)
  optionalBoolean(row.continuePrefill, `${label}.continuePrefill`)
  optionalBoolean(row.strictProviderRouting, `${label}.strictProviderRouting`)
  optionalFinite(row.maxCompletionTokens, `${label}.maxCompletionTokens`)
  optionalFinite(row.customMaxContext, `${label}.customMaxContext`)
  optionalFinite(row.mediaEchoN, `${label}.mediaEchoN`)
  optionalFinite(row.toolContextSummarizeAfterN, `${label}.toolContextSummarizeAfterN`)
  optionalBoolean(row.cachePrompt, `${label}.cachePrompt`)
  if (row.metadata !== undefined) stringRecord(row.metadata, `${label}.metadata`)
  if (row.responses !== undefined) {
    const responses = object(row.responses, `${label}.responses`)
    boolean(responses.store, `${label}.responses.store`)
  }
}

function assertMessage(value: unknown): void {
  const row = object(value, 'message')
  string(row.id, 'message.id')
  string(row.chatId, 'message.chatId')
  nullableString(row.parentId, 'message.parentId')
  integer(row.siblingIndex, 'message.siblingIndex')
  string(row.turnId, 'message.turnId')
  integer(row.turnIndex, 'message.turnIndex')
  finite(row.createdAt, 'message.createdAt')
  enumValue(row.role, MESSAGE_ROLES, 'message.role')
  enumValue(row.origin, MESSAGE_ORIGINS, 'message.origin')
  if (row.generation !== undefined) assertGeneration(row.generation)
  for (const item of array(row.content, 'message.content')) assertContentItem(item)
  if (row.reasoningDetails !== undefined) {
    for (const detail of array(row.reasoningDetails, 'message.reasoningDetails')) {
      const record = object(detail, 'reasoning detail')
      const type = string(record.type, 'reasoning detail.type')
      if (type === 'reasoning.text') optionalString(record.text, 'reasoning detail.text')
      else if (type === 'reasoning.summary') string(record.summary, 'reasoning detail.summary')
      else if (type === 'reasoning.encrypted') string(record.data, 'reasoning detail.data')
      else throw invalid('reasoning detail.type')
    }
  }
  if (row.attachmentRefs !== undefined) {
    for (const ref of array(row.attachmentRefs, 'message.attachmentRefs')) assertAttachmentRef(ref)
  }
  if (row.toolCalls !== undefined) {
    assertToolCalls(row.toolCalls, 'message.toolCalls')
  }
  if (row.continuationAttempts !== undefined) {
    for (const attempt of array(row.continuationAttempts, 'message.continuationAttempts')) {
      const record = object(attempt, 'continuation attempt')
      string(record.streamId, 'continuation attempt.streamId')
      string(record.strategy, 'continuation attempt.strategy')
      string(record.status, 'continuation attempt.status')
      finite(record.startedAt, 'continuation attempt.startedAt')
      finite(record.finishedAt, 'continuation attempt.finishedAt')
      if (record.toolCalls !== undefined) {
        assertToolCalls(record.toolCalls, 'continuation attempt.toolCalls')
      }
    }
  }
  if (row.providerOutputItems !== undefined) {
    for (const item of array(row.providerOutputItems, 'message.providerOutputItems')) {
      const record = object(item, 'provider output item')
      string(record.dialect, 'provider output item.dialect')
      string(record.type, 'provider output item.type')
      if (!('item' in record)) throw invalid('provider output item.item')
    }
  }
  integer(row.nodeVersion, 'message.nodeVersion')
  boolean(row.deleted, 'message.deleted')
}

function assertToolCalls(value: unknown, label: string): void {
  for (const call of array(value, label)) {
    const record = object(call, 'tool call')
    string(record.id, 'tool call.id')
    if (record.type !== 'function') throw invalid('tool call.type')
    const fn = object(record.function, 'tool call.function')
    string(fn.name, 'tool call.function.name')
    string(fn.arguments, 'tool call.function.arguments')
  }
}

function assertGeneration(value: unknown): void {
  const row = object(value, 'generation')
  string(row.id, 'generation.id')
  string(row.model, 'generation.model')
  string(row.requestedModel, 'generation.requestedModel')
  enumValue(row.apiUsed, GENERATION_APIS, 'generation.apiUsed')
  enumValue(row.delivery, new Set(['streaming', 'buffered']), 'generation.delivery')
  if (row.status !== undefined) enumValue(row.status, GENERATION_STATUSES, 'generation.status')
  if (row.integrity !== undefined) {
    enumValue(row.integrity, new Set(['clean', 'degraded', 'failed']), 'generation.integrity')
  }
  string(row.costSource, 'generation.costSource')
  finite(row.startedAt, 'generation.startedAt')
  optionalFinite(row.finishedAt, 'generation.finishedAt')
  optionalFinite(row.cost, 'generation.cost')
}

function assertContentItem(value: unknown): void {
  const row = object(value, 'content item')
  const type = enumValue(row.type, CONTENT_TYPES, 'content item.type')
  if (type === 'text' || type === 'output_text') string(row.text, `content item.${type}.text`)
  if (type === 'input_audio') string(row.format, 'content item.input_audio.format')
  if (type === 'file') {
    string(row.filename, 'content item.file.filename')
    string(row.mime, 'content item.file.mime')
  }
  optionalString(row.attachmentId, `content item.${type}.attachmentId`)
}

function assertAttachmentRef(value: unknown): void {
  const row = object(value, 'attachment ref')
  string(row.refId, 'attachment ref.refId')
  string(row.attachmentId, 'attachment ref.attachmentId')
  boolean(row.includeInContext, 'attachment ref.includeInContext')
  object(row.presentation, 'attachment ref.presentation')
  finite(row.createdAt, 'attachment ref.createdAt')
  finite(row.updatedAt, 'attachment ref.updatedAt')
  optionalFinite(row.deletedAt, 'attachment ref.deletedAt')
}

function assertChildList(value: unknown): void {
  const row = object(value, 'child list')
  string(row.id, 'child list.id')
  string(row.chatId, 'child list.chatId')
  nullableString(row.parentId, 'child list.parentId')
  integer(row.version, 'child list.version')
  finite(row.updatedAt, 'child list.updatedAt')
}

function assertBranchCache(value: unknown): void {
  const row = object(value, 'chat branch cache')
  string(row.chatId, 'chat branch cache.chatId')
  nullableString(row.branchLeafId, 'chat branch cache.branchLeafId')
  finite(row.generatedAt, 'chat branch cache.generatedAt')
  string(row.textContent, 'chat branch cache.textContent')
  string(row.previewText, 'chat branch cache.previewText')
  integer(row.messageCount, 'chat branch cache.messageCount')
  finite(row.wordCount, 'chat branch cache.wordCount')
  for (const timestamp of array(row.messageTimestamps, 'chat branch cache.messageTimestamps')) {
    const record = object(timestamp, 'chat branch cache timestamp')
    string(record.id, 'chat branch cache timestamp.id')
    finite(record.createdAt, 'chat branch cache timestamp.createdAt')
    finite(record.editedAt, 'chat branch cache timestamp.editedAt')
  }
}

function assertAttachmentBundle(value: unknown): void {
  const row = object(value, 'attachment bundle')
  assertAttachment(row.attachment)
  for (const blob of array(row.blobs, 'attachment bundle.blobs')) assertPortableBlob(blob)
  for (const artifact of array(row.artifacts, 'attachment bundle.artifacts')) {
    assertAttachmentArtifact(artifact)
  }
  for (const job of array(row.jobs, 'attachment bundle.jobs')) assertAttachmentJob(job)
}

function assertAttachment(value: unknown): void {
  const row = object(value, 'attachment')
  string(row.id, 'attachment.id')
  enumValue(row.kind, ATTACHMENT_KINDS, 'attachment.kind')
  string(row.mime, 'attachment.mime')
  string(row.filename, 'attachment.filename')
  enumValue(row.origin, ATTACHMENT_ORIGINS, 'attachment.origin')
  finite(row.createdAt, 'attachment.createdAt')
  finite(row.updatedAt, 'attachment.updatedAt')
  const storage = object(row.storage, 'attachment.storage')
  const storageKind = string(storage.kind, 'attachment.storage.kind')
  if (storageKind === 'local-blob') string(storage.blobId, 'attachment.storage.blobId')
  else if (storageKind === 'remote-url') string(storage.url, 'attachment.storage.url')
  else if (storageKind === 'missing') {
    string(storage.reason, 'attachment.storage.reason')
    finite(storage.missingSince, 'attachment.storage.missingSince')
  } else throw invalid('attachment.storage.kind')
  for (const artifact of array(row.artifacts, 'attachment.artifacts')) {
    assertAttachmentArtifact(artifact)
  }
  for (const state of array(row.processing, 'attachment.processing')) {
    assertProcessingState(state, 'attachment.processing')
  }
  integer(row.refCount, 'attachment.refCount')
}

function assertPortableBlob(value: unknown): void {
  const row = object(value, 'attachment blob')
  string(row.id, 'attachment blob.id')
  string(row.attachmentId, 'attachment blob.attachmentId')
  string(row.role, 'attachment blob.role')
  string(row.mime, 'attachment blob.mime')
  string(row.contentHash, 'attachment blob.contentHash')
  integer(row.sizeBytes, 'attachment blob.sizeBytes')
  string(row.dataBase64, 'attachment blob.dataBase64')
  finite(row.createdAt, 'attachment blob.createdAt')
}

function assertAttachmentArtifact(value: unknown): void {
  const row = object(value, 'attachment artifact')
  const kind = string(row.kind, 'attachment artifact.kind')
  if (kind !== 'text' && kind !== 'json' && kind !== 'blob') {
    throw invalid('attachment artifact.kind')
  }
  string(row.artifactId, 'attachment artifact.artifactId')
  string(row.attachmentId, 'attachment artifact.attachmentId')
  string(row.processorId, 'attachment artifact.processorId')
  finite(row.createdAt, 'attachment artifact.createdAt')
  if (kind === 'text') {
    string(row.text, 'attachment artifact.text')
    integer(row.charCount, 'attachment artifact.charCount')
  }
  if (kind === 'blob') string(row.blobId, 'attachment artifact.blobId')
}

function assertAttachmentJob(value: unknown): void {
  const row = object(value, 'attachment job')
  string(row.id, 'attachment job.id')
  string(row.attachmentId, 'attachment job.attachmentId')
  assertProcessingState(row, 'attachment job')
  finite(row.updatedAt, 'attachment job.updatedAt')
}

function assertProcessingState(value: unknown, label: string): void {
  const row = object(value, label)
  string(row.processorId, `${label}.processorId`)
  string(row.inputHash, `${label}.inputHash`)
  string(row.status, `${label}.status`)
  strings(row.outputArtifactIds, `${label}.outputArtifactIds`)
}

function assertProfile(value: unknown): void {
  const row = object(value, 'profile')
  string(row.id, 'profile.id')
  string(row.name, 'profile.name')
  enumValue(row.kind, CONNECTION_KINDS, 'profile.kind')
  string(row.baseUrl, 'profile.baseUrl')
  string(row.apiKeyRef, 'profile.apiKeyRef')
  if (row.apiKeyFallbackRefs !== undefined)
    strings(row.apiKeyFallbackRefs, 'profile.apiKeyFallbackRefs')
  optionalString(row.managementApiKeyRef, 'profile.managementApiKeyRef')
  object(row.defaultHeaders, 'profile.defaultHeaders')
  stringRecord(row.defaultHeaders, 'profile.defaultHeaders')
  string(row.appTitle, 'profile.appTitle')
  string(row.appUrl, 'profile.appUrl')
  boolean(row.supportsEndpointsApi, 'profile.supportsEndpointsApi')
  boolean(row.supportsGenerationApi, 'profile.supportsGenerationApi')
  boolean(row.supportsPrivacyScrape, 'profile.supportsPrivacyScrape')
  finite(row.createdAt, 'profile.createdAt')
  finite(row.updatedAt, 'profile.updatedAt')
}

function assertPreset(value: unknown): void {
  const row = object(value, 'preset')
  string(row.id, 'preset.id')
  string(row.name, 'preset.name')
  string(row.connectionProfileId, 'preset.connectionProfileId')
  assertChatSettings(row.settings, 'preset.settings')
  finite(row.sortIndex, 'preset.sortIndex')
  finite(row.createdAt, 'preset.createdAt')
  finite(row.updatedAt, 'preset.updatedAt')
}

function assertPromptPreset(value: unknown): void {
  const row = object(value, 'prompt preset')
  string(row.id, 'prompt preset.id')
  enumValue(row.kind, PROMPT_PRESET_KINDS, 'prompt preset.kind')
  string(row.name, 'prompt preset.name')
  string(row.text, 'prompt preset.text')
  finite(row.createdAt, 'prompt preset.createdAt')
  finite(row.updatedAt, 'prompt preset.updatedAt')
}

function assertFolder(value: unknown): void {
  const row = object(value, 'folder')
  string(row.id, 'folder.id')
  string(row.name, 'folder.name')
  finite(row.sortIndex, 'folder.sortIndex')
  finite(row.createdAt, 'folder.createdAt')
  finite(row.updatedAt, 'folder.updatedAt')
}

function assertTag(value: unknown): void {
  const row = object(value, 'tag')
  string(row.id, 'tag.id')
  string(row.name, 'tag.name')
  string(row.nameLower, 'tag.nameLower')
  finite(row.createdAt, 'tag.createdAt')
  finite(row.updatedAt, 'tag.updatedAt')
}

function assertDraft(value: unknown): void {
  const row = object(value, 'draft')
  string(row.chatId, 'draft.chatId')
  string(row.text, 'draft.text')
  for (const ref of array(row.attachmentRefs, 'draft.attachmentRefs')) assertAttachmentRef(ref)
  finite(row.updatedAt, 'draft.updatedAt')
}

function assertKey(value: unknown): void {
  const row = object(value, 'key')
  string(row.id, 'key.id')
  string(row.name, 'key.name')
  string(row.ciphertext, 'key.ciphertext')
  string(row.iv, 'key.iv')
  string(row.salt, 'key.salt')
  if (row.algorithm !== 'AES-GCM-256') throw invalid('key.algorithm')
  const kdf = object(row.kdf, 'key.kdf')
  if (kdf.name !== 'PBKDF2' || kdf.iterations !== 200_000 || kdf.hash !== 'SHA-256') {
    throw invalid('key.kdf')
  }
  string(row.obscuredPreview, 'key.obscuredPreview')
  finite(row.createdAt, 'key.createdAt')
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(label)
  return value as Record<string, unknown>
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw invalid(label)
  return value
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string') throw invalid(label)
  return value
}

function optionalString(value: unknown, label: string): void {
  if (value !== undefined) string(value, label)
}

function nullableString(value: unknown, label: string): void {
  if (value !== null) string(value, label)
}

function boolean(value: unknown, label: string): void {
  if (typeof value !== 'boolean') throw invalid(label)
}

function finite(value: unknown, label: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid(label)
}

function optionalFinite(value: unknown, label: string): void {
  if (value !== undefined) finite(value, label)
}

function optionalBoolean(value: unknown, label: string): void {
  if (value !== undefined) boolean(value, label)
}

function integer(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value)) throw invalid(label)
}

function strings(value: unknown, label: string): void {
  for (const entry of array(value, label)) string(entry, label)
}

function stringRecord(value: unknown, label: string): void {
  for (const entry of Object.values(object(value, label))) string(entry, label)
}

function enumValue(value: unknown, allowed: ReadonlySet<string>, label: string): string {
  const result = string(value, label)
  if (!allowed.has(result)) throw invalid(label)
  return result
}

function invalid(label: string): Error {
  return new Error(`ImportRowInvalid:${label}`)
}
