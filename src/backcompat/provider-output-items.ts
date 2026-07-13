import type Dexie from 'dexie'
import type { Table } from 'dexie'
import { providerOutputItemsFromServerTools } from '../core/provider-tool-context'
import type { GenerationMeta, ProviderOutputItem } from '../core/types'
import type { SettingsRow } from '../store/db-rows'
import type { MessageBodyRow, MessageHeaderRow } from '../store/message-storage'
import { forEachTableBatch } from './batched-table'

const PROVIDER_OUTPUT_ITEMS_BACKFILL_KEY = 'backfill:provider-output-items-v1'

export function providerOutputItemsBackfillMarker(): SettingsRow {
  return { key: PROVIDER_OUTPUT_ITEMS_BACKFILL_KEY, value: 1 }
}

export async function migrateProviderOutputItemRows(db: Dexie): Promise<void> {
  const messages = db.table<MessageHeaderRow, string>('messages')
  const messageBodies = db.table<MessageBodyRow, string>('messageBodies')
  const settings = db.table<SettingsRow, string>('settings')
  const marker = await settings.get(PROVIDER_OUTPUT_ITEMS_BACKFILL_KEY)
  if (marker?.value === 1) return

  await db.transaction('rw', messages, messageBodies, settings, async () => {
    await migrateProviderOutputItemRowsInTables(messages, messageBodies)
    await settings.put(providerOutputItemsBackfillMarker())
  })
}

export async function migrateProviderOutputItemRowsInTables(
  messages: Table<MessageHeaderRow, string>,
  messageBodies: Table<MessageBodyRow, string>,
): Promise<void> {
  await forEachTableBatch(messageBodies, async (bodies) => {
    const headers = await messages.bulkGet(bodies.map((body) => body.id))
    const changed: MessageBodyRow[] = []
    for (const [index, body] of bodies.entries()) {
      const migrated = migrateProviderOutputItemsFromGeneration(
        generationWithStoredOutputs(headers[index]?.generation, body),
        body.providerOutputItems,
      )
      if (migrated) changed.push({ ...body, providerOutputItems: migrated })
    }
    if (changed.length > 0) await messageBodies.bulkPut(changed)
  })
}

function generationWithStoredOutputs(
  generation: GenerationMeta | undefined,
  body: MessageBodyRow,
): GenerationMeta | undefined {
  if (!generation || !body.generationServerToolOutputs) return generation
  const next = structuredClone(generation)
  for (const entry of body.generationServerToolOutputs) {
    const tool = next.serverTools?.[entry.index]
    if (tool) tool.output = structuredClone(entry.output)
  }
  return next
}

function migrateProviderOutputItemsFromGeneration(
  generation: GenerationMeta | undefined,
  existing: unknown,
): ProviderOutputItem[] | undefined {
  if (Array.isArray(existing)) return undefined
  const migrated = providerOutputItemsFromServerTools(generation?.serverTools ?? [])
  return migrated.length > 0 ? migrated : undefined
}
