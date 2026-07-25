import { migrateNatterExportEnvelope } from '../backcompat/import-export'

export { WorkspaceReplacementInProgressError } from '../core/import-export/errors'

import {
  GENERATED_OUTPUT_LOCALIZATION_PROCESSOR_ID,
  generatedOutputLocalizationJob,
  isGeneratedOutputLocalizationJob,
  withGeneratedOutputLocalizationState,
} from '../core/generated-output-localization'
import type {
  ChatExportEnvelope,
  ChatPresetExportEnvelope,
  ConnectionProfileExportEnvelope,
  PortableAttachmentBlob,
  PortableAttachmentBundle,
  WorkspaceBackupEnvelope,
} from '../core/import-export/schema'
import { assertEnvelopeKind, workspaceBackupManifest } from '../core/import-export/schema'
import { normalizeWorkspaceCredentialReferences } from '../core/import-export/workspace-credentials'
import {
  validatePortableChatGraph,
  validateWorkspaceBackupGraph,
} from '../core/import-export/workspace-validation'
import type {
  AttachmentJob,
  ChatId,
  ContentItem,
  Message,
  MessageId,
  PresetId,
  ProfileId,
} from '../core/types'
import { createAttachmentRef } from './attachment-refs'
import {
  type ConversationCommittedResult,
  conversationCommittedResult,
} from './conversation-repository-adapter'
import {
  contentNeedsGeneratedOutputMaterialization,
  generatedOutputAttachmentId,
  generatedOutputAttachmentIds,
  mergeGeneratedImageAttachmentRefs,
  prepareGeneratedOutputAttachments,
} from './generated-images'
import type {
  ImportChatOptions,
  ImportChatPresetOptions,
  ImportChatPresetResult,
  ImportChatResult,
  ImportConnectionProfileOptions,
  ImportConnectionProfileResult,
  RestoreWorkspaceBackupOptions,
  RestoreWorkspaceBackupResult,
} from './import-export-contract'
import type { PreparedAttachmentBundle } from './workspace-protocol'
import { getWorkspaceRepository } from './workspace-repository'
import { runWorkspaceAction, runWorkspaceRead } from './workspace-runtime'

export type {
  ImportChatOptions,
  ImportChatPresetOptions,
  ImportChatPresetResult,
  ImportChatResult,
  ImportConnectionProfileOptions,
  ImportConnectionProfileResult,
  RestoreWorkspaceBackupOptions,
  RestoreWorkspaceBackupResult,
} from './import-export-contract'

async function parseChatExportEnvelope(value: unknown): Promise<ChatExportEnvelope> {
  const envelope = migrateNatterExportEnvelope(value)
  assertEnvelopeKind(envelope, 'chat')
  const canonical = await canonicalizeImportedGeneratedOutputs(
    envelope.payload.messages,
    envelope.payload.attachments,
  )
  const result = canonical.changed
    ? {
        ...envelope,
        payload: {
          ...envelope.payload,
          messages: canonical.messages,
          attachments: canonical.attachments,
        },
      }
    : envelope
  assertEnvelopeKind(result, 'chat')
  validatePortableChatGraph(result.payload)
  return result
}

function parseChatPresetExportEnvelope(value: unknown): ChatPresetExportEnvelope {
  const envelope = migrateNatterExportEnvelope(value)
  assertEnvelopeKind(envelope, 'chat-preset')
  return envelope
}

function parseConnectionProfileExportEnvelope(value: unknown): ConnectionProfileExportEnvelope {
  const envelope = migrateNatterExportEnvelope(value)
  assertEnvelopeKind(envelope, 'connection-profile')
  return envelope
}

async function parseWorkspaceBackupEnvelope(value: unknown): Promise<WorkspaceBackupEnvelope> {
  const envelope = migrateNatterExportEnvelope(value)
  assertEnvelopeKind(envelope, 'workspace-backup')
  const canonical = await canonicalizeImportedGeneratedOutputs(
    envelope.payload.messages,
    envelope.payload.attachments,
  )
  const canonicalized = canonical.changed
    ? {
        ...envelope,
        payload: {
          ...envelope.payload,
          messages: canonical.messages,
          attachments: canonical.attachments,
        },
      }
    : envelope
  const normalizedPayload = normalizeWorkspaceCredentialReferences(canonicalized.payload)
  const migratedPayload =
    normalizedPayload.manifest && (canonical.changed || normalizedPayload !== canonicalized.payload)
      ? { ...normalizedPayload, manifest: workspaceBackupManifest(normalizedPayload) }
      : normalizedPayload
  const result =
    migratedPayload === canonicalized.payload
      ? canonicalized
      : { ...canonicalized, payload: migratedPayload }
  assertEnvelopeKind(result, 'workspace-backup')
  return result
}

export function exportChat(chatId: ChatId): Promise<ChatExportEnvelope> {
  return runWorkspaceRead(
    'import-export',
    async (permit) =>
      (
        await getWorkspaceRepository().query(permit, {
          kind: 'interchange.export-chat',
          chatId,
        })
      ).value,
  )
}

export async function importChat(
  value: unknown,
  options: ImportChatOptions = {},
  apply?: (result: ConversationCommittedResult<ImportChatResult>) => void,
): Promise<ConversationCommittedResult<ImportChatResult>> {
  const envelope = await parseChatExportEnvelope(value)
  return runWorkspaceAction('import-export', async (permit) => {
    const commit = await getWorkspaceRepository().execute(
      permit,
      {
        kind: 'interchange.import-chat',
        envelope,
        options,
      },
      apply
        ? {
            localApplications: {
              conversation: (committed) => {
                apply(conversationCommittedResult(committed, committed.value.chatId))
                return 'applied'
              },
            },
          }
        : undefined,
    )
    return conversationCommittedResult(commit, commit.value.chatId)
  })
}

export function exportChatPreset(presetId: PresetId): Promise<ChatPresetExportEnvelope> {
  return runWorkspaceRead(
    'import-export',
    async (permit) =>
      (
        await getWorkspaceRepository().query(permit, {
          kind: 'interchange.export-chat-preset',
          presetId,
        })
      ).value,
  )
}

export function importChatPreset(
  value: unknown,
  options: ImportChatPresetOptions = {},
): Promise<ImportChatPresetResult> {
  return runWorkspaceAction('import-export', async (permit) => {
    const envelope = parseChatPresetExportEnvelope(value)
    return (
      await getWorkspaceRepository().execute(permit, {
        kind: 'interchange.import-chat-preset',
        envelope,
        options,
      })
    ).value
  })
}

export function exportConnectionProfile(
  profileId: ProfileId,
): Promise<ConnectionProfileExportEnvelope> {
  return runWorkspaceRead(
    'import-export',
    async (permit) =>
      (
        await getWorkspaceRepository().query(permit, {
          kind: 'interchange.export-connection-profile',
          profileId,
        })
      ).value,
  )
}

export function importConnectionProfile(
  value: unknown,
  options: ImportConnectionProfileOptions = {},
): Promise<ImportConnectionProfileResult> {
  return runWorkspaceAction('import-export', async (permit) => {
    const envelope = parseConnectionProfileExportEnvelope(value)
    return (
      await getWorkspaceRepository().execute(permit, {
        kind: 'interchange.import-connection-profile',
        envelope,
        options,
      })
    ).value
  })
}

export function exportWorkspaceBackup(): Promise<WorkspaceBackupEnvelope> {
  return runWorkspaceRead(
    'import-export',
    async (permit) =>
      (
        await getWorkspaceRepository().query(permit, {
          kind: 'interchange.export-workspace-backup',
        })
      ).value,
  )
}

export async function exportWorkspaceBackupDocument<T>(
  encode: (envelope: WorkspaceBackupEnvelope) => T,
): Promise<T> {
  const envelope = await exportWorkspaceBackup()
  return encodeWorkspaceBackupDocument(envelope, encode)
}

export function encodeWorkspaceBackupDocument<T>(
  envelope: WorkspaceBackupEnvelope,
  encode: (envelope: WorkspaceBackupEnvelope) => T,
): T {
  assertEnvelopeKind(envelope, 'workspace-backup')
  if (!envelope.payload.manifest) throw new Error('ExportWorkspaceManifestMissing')
  validateWorkspaceBackupGraph(envelope.payload)
  return encode(envelope)
}

export async function restoreWorkspaceBackup(
  value: unknown,
  options: RestoreWorkspaceBackupOptions = {},
): Promise<RestoreWorkspaceBackupResult> {
  const envelope = await parseWorkspaceBackupEnvelope(value)
  return (
    await getWorkspaceRepository().replace({
      kind: 'interchange.restore-workspace-backup',
      envelope,
      options,
    })
  ).value
}

async function canonicalizeImportedGeneratedOutputs(
  sourceMessages: readonly Message[],
  sourceAttachments: readonly PortableAttachmentBundle[],
): Promise<{
  messages: Message[]
  attachments: PortableAttachmentBundle[]
  changed: boolean
}> {
  const attachmentIds = new Set(sourceAttachments.map((bundle) => bundle.attachment.id))
  const importedAt = Date.now()
  let messages: Message[] | undefined
  let attachmentsChanged = false
  const attachments = sourceAttachments.map((bundle) => {
    const canonical = canonicalImportedLocalizationJob(bundle, importedAt)
    if (canonical !== bundle) attachmentsChanged = true
    return canonical
  })
  for (let index = 0; index < sourceMessages.length; index += 1) {
    const message = sourceMessages[index] as Message
    let nextMessage = message
    if (contentNeedsGeneratedOutputMaterialization(nextMessage.content)) {
      const namespace = unusedGeneratedOutputNamespace(nextMessage, attachmentIds)
      const prepared = await prepareGeneratedOutputAttachments({
        messageId: namespace,
        content: nextMessage.content,
        now: nextMessage.createdAt,
      })
      if (contentNeedsGeneratedOutputMaterialization(prepared.content)) {
        throw new Error(`ImportGeneratedOutputUrlUnsupported:${nextMessage.id}`)
      }
      const merged = mergeGeneratedImageAttachmentRefs(
        nextMessage.attachmentRefs,
        prepared.newRefs,
        nextMessage.id,
        nextMessage.createdAt,
      )
      nextMessage = {
        ...nextMessage,
        content: prepared.content,
        attachmentRefs: merged.refs,
      }
      for (const bundle of prepared.attachmentBundles) {
        if (attachmentIds.has(bundle.attachment.id)) {
          throw new Error(`ImportGeneratedOutputAttachmentCollision:${bundle.attachment.id}`)
        }
        attachmentIds.add(bundle.attachment.id)
        attachments.push(await portablePreparedAttachmentBundle(bundle))
      }
    }
    const requiredIds = generatedOutputAttachmentIds(nextMessage.content)
    const liveIds = new Set(
      (nextMessage.attachmentRefs ?? [])
        .filter((ref) => ref.deletedAt === undefined)
        .map((ref) => ref.attachmentId),
    )
    const missingRefs = [...requiredIds]
      .filter((attachmentId) => !liveIds.has(attachmentId))
      .map((attachmentId) => {
        if (!attachmentIds.has(attachmentId)) {
          throw new Error(
            `ImportGeneratedOutputAttachmentMissing:${nextMessage.id}:${attachmentId}`,
          )
        }
        return createAttachmentRef(attachmentId, {
          messageId: nextMessage.id,
          createdAt: nextMessage.createdAt,
        })
      })
    if (missingRefs.length > 0) {
      nextMessage = {
        ...nextMessage,
        attachmentRefs: mergeGeneratedImageAttachmentRefs(
          nextMessage.attachmentRefs,
          missingRefs,
          nextMessage.id,
          nextMessage.createdAt,
        ).refs,
      }
    }
    if (nextMessage !== message) {
      if (!messages) messages = [...sourceMessages.slice(0, index)]
      messages.push(nextMessage)
    } else if (messages) {
      messages.push(message)
    }
  }
  return {
    messages: messages ?? [...sourceMessages],
    attachments,
    changed: messages !== undefined || attachmentsChanged,
  }
}

function canonicalImportedLocalizationJob(
  bundle: PortableAttachmentBundle,
  now: number,
): PortableAttachmentBundle {
  if (bundle.attachment.origin !== 'generated-output') return bundle
  const sourceJob = bundle.jobs.find(
    (job) => job.processorId === GENERATED_OUTPUT_LOCALIZATION_PROCESSOR_ID,
  )
  const requestCredential = isGeneratedOutputLocalizationJob(sourceJob)
    ? sourceJob.task.requestCredential
    : undefined
  const fresh = generatedOutputLocalizationJob(bundle.attachment, now, requestCredential)
  if (!sourceJob && !fresh) return bundle
  const job = importedLocalizationJob(sourceJob, fresh, now)
  if (!job) return bundle
  return {
    ...bundle,
    attachment: {
      ...bundle.attachment,
      processing: withGeneratedOutputLocalizationState(bundle.attachment.processing, job),
    },
    jobs: [
      ...bundle.jobs.filter(
        (candidate) => candidate.processorId !== GENERATED_OUTPUT_LOCALIZATION_PROCESSOR_ID,
      ),
      job,
    ],
  }
}

function importedLocalizationJob(
  source: AttachmentJob | undefined,
  fresh: AttachmentJob | undefined,
  now: number,
): AttachmentJob | undefined {
  if (fresh) {
    const base = isGeneratedOutputLocalizationJob(source) ? source : fresh
    const pending: AttachmentJob = {
      ...base,
      id: fresh.id,
      attachmentId: fresh.attachmentId,
      ...(fresh.task ? { task: fresh.task } : {}),
      inputHash: fresh.inputHash,
      status: 'pending',
      attemptCount: 0,
      nextAttemptAt: now,
      updatedAt: now,
    }
    delete pending.startedAt
    delete pending.finishedAt
    delete pending.error
    delete pending.leaseId
    delete pending.leaseExpiresAt
    return pending
  }
  if (!source) return undefined
  const succeeded: AttachmentJob = {
    ...source,
    status: 'succeeded',
    finishedAt: now,
    updatedAt: now,
  }
  delete succeeded.startedAt
  delete succeeded.error
  delete succeeded.nextAttemptAt
  delete succeeded.leaseId
  delete succeeded.leaseExpiresAt
  return succeeded
}

function unusedGeneratedOutputNamespace(
  message: Message,
  attachmentIds: ReadonlySet<string>,
): MessageId {
  let suffix = 0
  for (;;) {
    const namespace = suffix === 0 ? message.id : `${message.id}:legacy-import:${suffix}`
    if (
      generatedOutputIdsForUrlItems(namespace, message.content).every(
        (attachmentId) => !attachmentIds.has(attachmentId),
      )
    ) {
      return namespace
    }
    suffix += 1
  }
}

function generatedOutputIdsForUrlItems(
  namespace: MessageId,
  content: readonly ContentItem[],
): string[] {
  const ids: string[] = []
  for (let index = 0; index < content.length; index += 1) {
    const item = content[index]
    if (
      item &&
      (item.type === 'output_image' ||
        item.type === 'audio_output' ||
        item.type === 'output_video' ||
        item.type === 'file') &&
      !item.attachmentId &&
      typeof item.url === 'string' &&
      item.url.length > 0
    ) {
      ids.push(generatedOutputAttachmentId(namespace, item, index))
    }
  }
  return ids
}

async function portablePreparedAttachmentBundle(
  bundle: PreparedAttachmentBundle,
): Promise<PortableAttachmentBundle> {
  const blobs: PortableAttachmentBlob[] = []
  for (const blob of bundle.blobs) {
    const bytes = new Uint8Array(await blob.blob.arrayBuffer())
    blobs.push({
      id: blob.id,
      attachmentId: blob.attachmentId,
      role: blob.role,
      mime: blob.mime,
      contentHash: blob.contentHash,
      sizeBytes: blob.sizeBytes,
      dataBase64: bytesToBase64(bytes),
      createdAt: blob.createdAt,
    })
  }
  return {
    attachment: structuredClone(bundle.attachment),
    blobs,
    artifacts: structuredClone([...bundle.artifacts]),
    jobs: structuredClone([...bundle.jobs]),
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
  }
  return btoa(binary)
}
