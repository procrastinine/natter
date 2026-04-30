import { providerOutputItemsFromServerTools } from '../core/provider-tool-context'
import type { GenerationMeta, ProviderOutputItem } from '../core/types'
import type { NatterDb, SettingsRow } from '../store/db'
import type { MessageBodyRow } from '../store/message-storage'

export const PROVIDER_OUTPUT_ITEMS_BACKFILL_KEY = 'backfill:provider-output-items-v1'

export function providerOutputItemsBackfillMarker(): SettingsRow {
  return { key: PROVIDER_OUTPUT_ITEMS_BACKFILL_KEY, value: 1 }
}

export async function migrateProviderOutputItemRows(db: NatterDb): Promise<void> {
  const marker = await db.settings.get(PROVIDER_OUTPUT_ITEMS_BACKFILL_KEY)
  if (marker?.value === 1) return

  await db.transaction('rw', db.messages, db.messageBodies, db.settings, async () => {
    const headers = await db.messages.toArray()
    const headersById = new Map(headers.map((header) => [header.id, header]))
    await db.messageBodies.toCollection().modify((body: MessageBodyRow) => {
      const migrated = migrateProviderOutputItemsFromGeneration(
        headersById.get(body.id)?.generation,
        body.providerOutputItems,
      )
      if (migrated) body.providerOutputItems = migrated
    })
    await db.settings.put(providerOutputItemsBackfillMarker())
  })
}

export function migrateProviderOutputItemsFromGeneration(
  generation: GenerationMeta | undefined,
  existing: unknown,
): ProviderOutputItem[] | undefined {
  if (Array.isArray(existing)) return undefined
  const migrated = providerOutputItemsFromServerTools(generation?.serverTools ?? [])
  return migrated.length > 0 ? migrated : undefined
}
