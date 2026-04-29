type SidebarSortDirection = 'asc' | 'desc'

type SidebarSortField =
  | 'updatedAt'
  | 'createdAt'
  | 'lastViewedAt'
  | 'totalCostUsd'
  | 'wordCount'
  | 'title'

export type SidebarSortMode = `${SidebarSortField}-${SidebarSortDirection}`

interface SidebarSortOption {
  mode: SidebarSortMode
  label: string
  shortLabel: string
}

export const DEFAULT_SIDEBAR_SORT_MODE: SidebarSortMode = 'updatedAt-desc'

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

const VALID_SIDEBAR_SORT_MODES = new Set<string>(SIDEBAR_SORT_OPTIONS.map((option) => option.mode))

const LEGACY_SIDEBAR_SORT_MODES: Record<string, SidebarSortMode> = {
  'updated-desc': 'updatedAt-desc',
  'updated-asc': 'updatedAt-asc',
}

export function parseSidebarSortMode(value: unknown): SidebarSortMode {
  if (typeof value !== 'string') return DEFAULT_SIDEBAR_SORT_MODE
  const legacy = LEGACY_SIDEBAR_SORT_MODES[value]
  if (legacy) return legacy
  if (VALID_SIDEBAR_SORT_MODES.has(value)) return value as SidebarSortMode
  return DEFAULT_SIDEBAR_SORT_MODE
}

export function sidebarSortField(mode: SidebarSortMode): SidebarSortField {
  return mode.slice(0, mode.lastIndexOf('-')) as SidebarSortField
}

export function sidebarSortDirection(mode: SidebarSortMode): SidebarSortDirection {
  return mode.endsWith('-asc') ? 'asc' : 'desc'
}

export function isCreatedAtSidebarSort(mode: SidebarSortMode): boolean {
  return sidebarSortField(mode) === 'createdAt'
}

export function sidebarSortOption(mode: SidebarSortMode): SidebarSortOption {
  const fallback = SIDEBAR_SORT_OPTIONS[0]
  if (!fallback) throw new Error('No sidebar sort options configured')
  return SIDEBAR_SORT_OPTIONS.find((option) => option.mode === mode) ?? fallback
}
