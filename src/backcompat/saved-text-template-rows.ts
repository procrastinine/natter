import type { Transaction } from 'dexie'
import {
  LEGACY_SAVED_TEXT_TEMPLATES_KEY,
  normalizeSavedTextTemplate,
  type SavedTextTemplate,
} from '../core/text-templates'
import type { TextTemplateId } from '../core/types'
import { sameValue } from '../lib/same-value'
import { createBoundedBatchWriter } from '../store/bounded-idb-cursor'
import type { SettingsRow } from '../store/db-rows'
import { estimateStoredValueBytes } from '../store/storage-size-estimate'

const PAGE_MAX_ROWS = 128
const PAGE_MAX_BYTES = 4 * 1024 * 1024

export async function migrateLegacySavedTextTemplateRows(
  tx: Transaction,
  options: { readonly recordObsoleteBytes?: (byteLength: number) => void } = {},
): Promise<void> {
  const settings = tx.table<SettingsRow, string>('settings')
  const legacy = await settings.get(LEGACY_SAVED_TEXT_TEMPLATES_KEY)
  if (!legacy) return
  const table = tx.table<SavedTextTemplate, TextTemplateId>('textTemplates')
  const writer = createBoundedBatchWriter<SavedTextTemplate>({
    maxRows: PAGE_MAX_ROWS,
    maxBytes: PAGE_MAX_BYTES,
    operation: 'WaveALegacyTextTemplates',
    write: async (rows) => {
      const candidates = new Map<TextTemplateId, SavedTextTemplate>()
      for (const row of rows) {
        const current = candidates.get(row.id)
        if (!current || newerTemplate(row, current)) candidates.set(row.id, row)
      }
      const ids = [...candidates.keys()]
      const existing = await table.bulkGet(ids)
      const changed: SavedTextTemplate[] = []
      for (let index = 0; index < ids.length; index += 1) {
        const candidate = candidates.get(ids[index] as TextTemplateId) as SavedTextTemplate
        const current = existing[index]
        if (current && !newerTemplate(candidate, current)) continue
        if (current && sameValue(current, candidate)) continue
        if (current) options.recordObsoleteBytes?.(estimateStoredValueBytes(current))
        changed.push(candidate)
      }
      if (changed.length > 0) await table.bulkPut(changed)
    },
  })
  if (Array.isArray(legacy.value)) {
    for (const raw of legacy.value) {
      const template = normalizeSavedTextTemplate(raw)
      if (template) await writer.add(template)
    }
  }
  await writer.flush()
  options.recordObsoleteBytes?.(estimateStoredValueBytes(legacy))
  await settings.delete(LEGACY_SAVED_TEXT_TEMPLATES_KEY)
}

function newerTemplate(candidate: SavedTextTemplate, current: SavedTextTemplate): boolean {
  return (
    candidate.updatedAt > current.updatedAt ||
    (candidate.updatedAt === current.updatedAt && candidate.createdAt > current.createdAt)
  )
}
