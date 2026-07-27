import type { ChatFolder, ChatSidebarRow, FolderId } from './types'

export type SidebarSortDirection = 'asc' | 'desc'

export type SidebarSortField =
  | 'updatedAt'
  | 'createdAt'
  | 'lastViewedAt'
  | 'totalCostUsd'
  | 'wordCount'
  | 'title'

export type SidebarSortMode = `${SidebarSortField}-${SidebarSortDirection}`

export interface SidebarSortExtremum<T extends number | string = number | string> {
  min: T
  max: T
}

export type SidebarSortExtrema = {
  [Field in SidebarSortField]: SidebarSortExtremum<Field extends 'title' ? string : number>
}

interface SidebarSortOption {
  mode: SidebarSortMode
  label: string
  shortLabel: string
}

export const DEFAULT_SIDEBAR_SORT_MODE: SidebarSortMode = 'updatedAt-desc'
export const SIDEBAR_SORT_SETTING_KEY = 'sidebar:sort-key'
export const SIDEBAR_COLLAPSED_FOLDERS_SETTING_KEY = 'sidebar:collapsed-folders'

export const SIDEBAR_SORT_OPTIONS: readonly SidebarSortOption[] = [
  { mode: 'updatedAt-desc', label: 'Updated newest', shortLabel: 'Updated' },
  { mode: 'updatedAt-asc', label: 'Updated oldest', shortLabel: 'Updated' },
  { mode: 'createdAt-desc', label: 'Created newest', shortLabel: 'Created' },
  { mode: 'createdAt-asc', label: 'Created oldest', shortLabel: 'Created' },
  { mode: 'lastViewedAt-desc', label: 'Viewed recent', shortLabel: 'Viewed' },
  { mode: 'lastViewedAt-asc', label: 'Viewed oldest', shortLabel: 'Viewed' },
  { mode: 'totalCostUsd-desc', label: 'Cost highest', shortLabel: 'Cost' },
  { mode: 'totalCostUsd-asc', label: 'Cost lowest', shortLabel: 'Cost' },
  { mode: 'wordCount-desc', label: 'Words most', shortLabel: 'Words' },
  { mode: 'wordCount-asc', label: 'Words fewest', shortLabel: 'Words' },
  { mode: 'title-asc', label: 'Title A-Z', shortLabel: 'Title' },
  { mode: 'title-desc', label: 'Title Z-A', shortLabel: 'Title' },
] as const

export function compareChatFolders(left: ChatFolder, right: ChatFolder): number {
  if (left.sortIndex !== right.sortIndex) return left.sortIndex - right.sortIndex
  const byName = left.name.localeCompare(right.name)
  return byName !== 0 ? byName : left.id.localeCompare(right.id)
}

export function sortChatFolders(rows: ChatFolder[]): ChatFolder[] {
  return rows.sort(compareChatFolders)
}

const VALID_SIDEBAR_SORT_MODES = new Set<string>(SIDEBAR_SORT_OPTIONS.map((option) => option.mode))

export function parseSidebarSortMode(value: unknown): SidebarSortMode {
  if (typeof value !== 'string') return DEFAULT_SIDEBAR_SORT_MODE
  if (VALID_SIDEBAR_SORT_MODES.has(value)) return value as SidebarSortMode
  return DEFAULT_SIDEBAR_SORT_MODE
}

export function normalizeCollapsedSidebarFolderIds(value: unknown): FolderId[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is FolderId => typeof item === 'string'))].sort()
}

export function sidebarSortField(mode: SidebarSortMode): SidebarSortField {
  return mode.slice(0, mode.lastIndexOf('-')) as SidebarSortField
}

export function sidebarSortDirection(mode: SidebarSortMode): SidebarSortDirection {
  return mode.endsWith('-asc') ? 'asc' : 'desc'
}

export function sidebarSortOption(mode: SidebarSortMode): SidebarSortOption {
  const fallback = SIDEBAR_SORT_OPTIONS[0]
  if (!fallback) throw new Error('No sidebar sort options configured')
  return SIDEBAR_SORT_OPTIONS.find((option) => option.mode === mode) ?? fallback
}

export function sidebarTitleSortKey(title: string): string {
  const normalized = title.normalize('NFKC').trim() || 'Untitled chat'
  let key = ''
  let length = 0
  for (const codePoint of normalized.toLowerCase()) {
    if (length === 256) break
    key += codePoint
    length += 1
  }
  return key
}

export function compareSidebarChatRows(
  left: ChatSidebarRow,
  right: ChatSidebarRow,
  mode: SidebarSortMode,
  pinnedFirst = true,
): number {
  if (pinnedFirst) {
    const pinned = Number(right.pinned === true) - Number(left.pinned === true)
    if (pinned !== 0) return pinned
  }
  const direction = sidebarSortDirection(mode) === 'asc' ? 1 : -1
  const field = sidebarSortField(mode)
  const primary =
    direction *
    compareSidebarSortValues(sidebarRowSortValue(left, field), sidebarRowSortValue(right, field))
  if (primary !== 0) return primary
  const title =
    direction * compareCodeUnits(sidebarTitleSortKey(left.title), sidebarTitleSortKey(right.title))
  if (title !== 0) return title
  return direction * compareCodeUnits(left.id, right.id)
}

function sidebarRowSortValue(row: ChatSidebarRow, field: SidebarSortField): number | string {
  const updatedAt = finiteOrZero(row.updatedAt)
  switch (field) {
    case 'updatedAt':
      return updatedAt
    case 'createdAt':
      return finiteOrFallback(row.createdAt, updatedAt)
    case 'lastViewedAt':
      return finiteOrFallback(row.lastViewedAt, updatedAt)
    case 'totalCostUsd':
      return finiteOrZero(row.totalCostUsd)
    case 'wordCount':
      return finiteOrZero(row.wordCount)
    case 'title':
      return sidebarTitleSortKey(row.title)
  }
}

function compareSidebarSortValues(left: number | string, right: number | string): number {
  return typeof left === 'string' || typeof right === 'string'
    ? compareCodeUnits(String(left), String(right))
    : left - right
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function finiteOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function finiteOrFallback(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
