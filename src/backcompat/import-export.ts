import { assertNatterExportEnvelope, type NatterExportEnvelope } from '../core/import-export/schema'
import { validatePortableChatGraph } from '../core/import-export/workspace-validation'
import type { Message } from '../core/types'
import { chatPreviewProjectionBackfillMarker } from './chat-preview-projection'
import {
  normalizeContinuationAttemptOutcome,
  normalizeGenerationMetaOutcome,
} from './generation-attempt-outcomes'

export function migrateNatterExportEnvelope(value: unknown): NatterExportEnvelope {
  assertNatterExportEnvelope(value)
  let envelope: NatterExportEnvelope = value
  if (value.objectKind === 'chat') {
    const messages = mapChanged(value.payload.messages, normalizeImportedMessageOutcomes)
    const chatEnvelope =
      messages === value.payload.messages
        ? value
        : { ...value, payload: { ...value.payload, messages } }
    validatePortableChatGraph(chatEnvelope.payload)
    envelope = chatEnvelope
  }
  if (value.objectKind === 'workspace-backup') {
    const messages = mapChanged(value.payload.messages, normalizeImportedMessageOutcomes)
    const marker = chatPreviewProjectionBackfillMarker()
    const markerIndex = value.payload.settings.findIndex((row) => row.key === marker.key)
    let settings = value.payload.settings
    if (markerIndex === -1) settings = [...settings, marker]
    else if (value.payload.settings[markerIndex]?.value !== marker.value) {
      settings = [...settings]
      settings[markerIndex] = marker
    }
    if (messages !== value.payload.messages || settings !== value.payload.settings) {
      envelope = { ...value, payload: { ...value.payload, messages, settings } }
    }
  }
  return envelope
}

function normalizeImportedMessageOutcomes(input: Message): Message {
  const generation = input.generation ? normalizeGenerationMetaOutcome(input.generation) : undefined
  const continuationAttempts = input.continuationAttempts
    ? mapChanged(input.continuationAttempts, normalizeContinuationAttemptOutcome)
    : undefined
  if (generation === input.generation && continuationAttempts === input.continuationAttempts) {
    return input
  }
  const message = { ...input }
  if (generation !== undefined) message.generation = generation
  if (continuationAttempts !== undefined) message.continuationAttempts = continuationAttempts
  return message
}

function mapChanged<T>(values: readonly T[], map: (value: T) => T): T[] {
  let result: T[] | undefined
  for (let index = 0; index < values.length; index += 1) {
    const current = values[index] as T
    const next = map(current)
    if (result) result.push(next)
    else if (next !== current) result = [...values.slice(0, index), next]
  }
  return result ?? (values as T[])
}
