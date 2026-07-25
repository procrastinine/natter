import type { Table } from 'dexie'
import type { SavedTextTemplate, SavedTextTemplateCatalogRow } from '../core/text-templates'
import type { TextTemplateId } from '../core/types'

const TEXT_TEMPLATE_CATALOG_INDEX = '[createdAt+id+name+updatedAt]'

export async function readTextTemplateCatalog(
  table: Table<SavedTextTemplate, TextTemplateId>,
  signal?: AbortSignal,
): Promise<SavedTextTemplateCatalogRow[]> {
  signal?.throwIfAborted()
  const keys = (await table.orderBy(TEXT_TEMPLATE_CATALOG_INDEX).keys()) as unknown[]
  signal?.throwIfAborted()
  return keys.map(textTemplateCatalogRowFromIndexKey)
}

function textTemplateCatalogRowFromIndexKey(raw: unknown): SavedTextTemplateCatalogRow {
  if (
    !Array.isArray(raw) ||
    raw.length !== 4 ||
    typeof raw[0] !== 'number' ||
    !Number.isFinite(raw[0]) ||
    typeof raw[1] !== 'string' ||
    !raw[1].startsWith('user:') ||
    typeof raw[2] !== 'string' ||
    typeof raw[3] !== 'number' ||
    !Number.isFinite(raw[3])
  ) {
    throw new Error('TextTemplateCatalogIndexInvalid')
  }
  return {
    id: raw[1],
    name: raw[2],
    createdAt: raw[0],
    updatedAt: raw[3],
  }
}
