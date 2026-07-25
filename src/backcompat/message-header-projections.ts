import type { Transaction } from 'dexie'
import { forEachTableBatch } from './batched-table'

type StoredRecord = Record<string, unknown>

interface LegacyGenerationServerToolOutput {
  readonly index: number
  readonly output: unknown
}

const MESSAGE_TEXT_PREVIEW_MAX_CHARS_V23 = 1_024
const WHITESPACE_V23 = /\s/

export async function migrateMessageHeaderProjections(tx: Transaction): Promise<void> {
  const messages = tx.table<StoredRecord, string>('messages')
  const bodies = tx.table<StoredRecord, string>('messageBodies')

  await forEachTableBatch(messages, async (headers) => {
    const bodyRows = await bodies.bulkGet(headers.map((header) => String(header.id)))
    for (const [index, legacyHeader] of headers.entries()) {
      const body = bodyRows[index]
      const header = structuredClone(legacyHeader)
      if (!body) {
        await messages.put({ ...header, textPreview: '' })
        continue
      }
      const outputs = takeLegacyGenerationServerToolOutputs(header)
      const nextBody =
        outputs.length === 0 ? body : { ...body, generationServerToolOutputs: outputs }
      await messages.put({
        ...header,
        textPreview: previewTextFromLegacyContent(body.content),
      })
      if (nextBody !== body) await bodies.put(nextBody)
    }
  })
}

function takeLegacyGenerationServerToolOutputs(
  header: StoredRecord,
): LegacyGenerationServerToolOutput[] {
  const generation = record(header.generation)
  const tools = Array.isArray(generation?.serverTools) ? generation.serverTools : []
  const outputs: LegacyGenerationServerToolOutput[] = []
  for (const [index, candidate] of tools.entries()) {
    const tool = record(candidate)
    if (!tool || !Object.hasOwn(tool, 'output')) continue
    outputs.push({ index, output: structuredClone(tool.output) })
    delete tool.output
  }
  return outputs
}

function previewTextFromLegacyContent(value: unknown): string {
  const prefix: string[] = []
  let normalizedLength = 0
  let pendingSpace = false
  for (const candidate of Array.isArray(value) ? value : []) {
    const item = record(candidate)
    if (
      !item ||
      (item.type !== 'text' && item.type !== 'output_text') ||
      typeof item.text !== 'string'
    ) {
      continue
    }
    for (const character of item.text) {
      if (WHITESPACE_V23.test(character)) {
        pendingSpace = normalizedLength > 0
        continue
      }
      if (pendingSpace) {
        normalizedLength += 1
        if (prefix.length < MESSAGE_TEXT_PREVIEW_MAX_CHARS_V23) prefix.push(' ')
        pendingSpace = false
      }
      normalizedLength += 1
      if (prefix.length < MESSAGE_TEXT_PREVIEW_MAX_CHARS_V23) prefix.push(character)
      if (normalizedLength > MESSAGE_TEXT_PREVIEW_MAX_CHARS_V23) {
        return `${prefix.slice(0, MESSAGE_TEXT_PREVIEW_MAX_CHARS_V23 - 1).join('')}…`
      }
    }
  }
  return prefix.join('')
}

function record(value: unknown): StoredRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as StoredRecord)
    : undefined
}
