import type { IndexableType } from 'dexie'
import { GLOBAL_PREFERENCE_KEYS } from '../core/global-settings'
import { GLOBAL_TOKEN_CALIBRATION_KEY } from '../core/token-calibration'
import type { ChatId } from '../core/types'
import {
  CHAT_SIDEBAR_PROJECTION_BACKFILL_KEY,
  CHAT_SIDEBAR_PROJECTION_MANIFEST_KEY,
} from './chat-sidebar-projection'
import type { RepositoryQueryDependency, RepositoryQueryTable } from './reactive-query'
import { WORKSPACE_META_KEY } from './workspace-meta'

export const GLOBAL_PREFERENCES_DEPENDENCIES = Object.freeze([
  { table: 'settings', keys: GLOBAL_PREFERENCE_KEYS },
]) satisfies readonly RepositoryQueryDependency[]

export const GLOBAL_TOKEN_CALIBRATION_DEPENDENCIES = Object.freeze([
  { table: 'settings', keys: [GLOBAL_TOKEN_CALIBRATION_KEY] },
]) satisfies readonly RepositoryQueryDependency[]

export const WORKSPACE_META_DEPENDENCIES = Object.freeze([
  { table: 'settings', keys: [WORKSPACE_META_KEY] },
]) satisfies readonly RepositoryQueryDependency[]

export const SIDEBAR_MODEL_DEPENDENCIES = Object.freeze([
  { table: 'chatSidebarRows' },
  {
    table: 'settings',
    keys: [CHAT_SIDEBAR_PROJECTION_BACKFILL_KEY, CHAT_SIDEBAR_PROJECTION_MANIFEST_KEY],
  },
  { table: 'folders' },
  { table: 'tags' },
]) satisfies readonly RepositoryQueryDependency[]

export function allTable(
  ...tables: readonly RepositoryQueryTable[]
): readonly RepositoryQueryDependency[] {
  return tables.map((table) => ({ table }))
}

export function primaryKeys(
  table: RepositoryQueryTable,
  ...keys: readonly (IndexableType | null | undefined)[]
): readonly RepositoryQueryDependency[] {
  const filtered = keys.filter((key): key is IndexableType => key != null)
  return filtered.length === 0 ? [] : [{ table, keys: filtered }]
}

export function indexKeys(
  table: RepositoryQueryTable,
  index: string,
  ...keys: readonly (IndexableType | null | undefined)[]
): readonly RepositoryQueryDependency[] {
  const filtered = keys.filter((key): key is IndexableType => key != null)
  return filtered.length === 0 ? [] : [{ table, index, keys: filtered }]
}

export function chatRowDependencies(
  chatId: ChatId | null | undefined,
): readonly RepositoryQueryDependency[] {
  return primaryKeys('chats', chatId)
}

export function chatMessageDependencies(
  chatId: ChatId | null | undefined,
): readonly RepositoryQueryDependency[] {
  if (!chatId) return []
  return [
    ...primaryKeys('chats', chatId),
    ...indexKeys('messages', 'chatId', chatId),
    ...indexKeys('messageBodies', 'chatId', chatId),
  ]
}

function attachmentDependencies(
  attachmentId: string | null | undefined,
): readonly RepositoryQueryDependency[] {
  if (!attachmentId) return []
  return [...primaryKeys('attachments', attachmentId), ...allTable('attachmentArtifacts')]
}

export function attachmentMapDependencies(
  attachmentIds: readonly string[],
): readonly RepositoryQueryDependency[] {
  if (attachmentIds.length === 0) return []
  return [{ table: 'attachments', keys: attachmentIds }, { table: 'attachmentArtifacts' }]
}

export function attachmentBundleDependencies(
  attachmentId: string | null | undefined,
): readonly RepositoryQueryDependency[] {
  if (!attachmentId) return []
  return [...attachmentDependencies(attachmentId), ...allTable('attachmentBlobs', 'attachmentJobs')]
}
