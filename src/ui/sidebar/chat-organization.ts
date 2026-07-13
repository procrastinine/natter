import {
  DEFAULT_SIDEBAR_SORT_MODE,
  isCreatedAtSidebarSort,
  type SidebarSortMode,
  sidebarSortDirection,
  sidebarSortField,
} from '../../core/sidebar-sort'
import type { ChatFolder, ChatSidebarRow } from '../../core/types'

type SidebarSortValue = number | string

interface SidebarChatEntry {
  kind: 'chat'
  chat: ChatSidebarRow
  sortValue: SidebarSortValue
  pinned: boolean
}

interface SidebarFolderEntry {
  kind: 'folder'
  folder: ChatFolder
  chats: ChatSidebarRow[]
  sortValue: SidebarSortValue
  pinned: boolean
}

type SidebarEntry = SidebarChatEntry | SidebarFolderEntry

interface SidebarCreatedAtGroup {
  key: 'today' | 'yesterday' | 'previous-7-days' | 'previous-30-days' | 'older'
  label: string
  chats: ChatSidebarRow[]
}

interface SidebarSortOptions {
  locale?: string | string[]
}

const SIDEBAR_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
})
const SIDEBAR_DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
})
const SIDEBAR_DATE_WITH_YEAR_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: '2-digit',
})

export function isEmptySidebarDraft(chat: ChatSidebarRow): boolean {
  const p = chat.previewText
  return p === undefined || p === ''
}

export function shouldRenderCreatedAtGroups(mode: SidebarSortMode): boolean {
  return isCreatedAtSidebarSort(mode)
}

function chatSortValue(chat: ChatSidebarRow, mode: SidebarSortMode): SidebarSortValue {
  const updatedAt = numberOrZero(chat.updatedAt)
  const field = sidebarSortField(mode)
  switch (field) {
    case 'updatedAt':
      return updatedAt
    case 'createdAt':
      return numberOrFallback(chat.createdAt, updatedAt)
    case 'lastViewedAt':
      return numberOrFallback(chat.lastViewedAt, updatedAt)
    case 'totalCostUsd':
      return numberOrZero(chat.totalCostUsd)
    case 'wordCount':
      return numberOrZero(chat.wordCount)
    case 'title':
      return chatTitle(chat)
  }
}

function folderSortValue(
  folder: ChatFolder,
  chats: readonly ChatSidebarRow[],
  mode: SidebarSortMode,
  options: SidebarSortOptions = {},
): SidebarSortValue {
  if (chats.length === 0) return emptyFolderSortValue(folder, mode)
  const firstChat = chats[0]
  if (!firstChat) return emptyFolderSortValue(folder, mode)
  const collator = collatorFor(options.locale)
  const direction = sidebarSortDirection(mode)
  return chats.slice(1).reduce<SidebarSortValue>(
    (best, chat) => {
      const next = chatSortValue(chat, mode)
      const byValue = compareSortValuesAscending(next, best, collator)
      if (direction === 'asc') return byValue < 0 ? next : best
      return byValue > 0 ? next : best
    },
    chatSortValue(firstChat, mode),
  )
}

export function sortChats(
  chats: readonly ChatSidebarRow[],
  mode: SidebarSortMode,
  options: SidebarSortOptions = {},
): ChatSidebarRow[] {
  const collator = collatorFor(options.locale)
  return [...chats].sort((left, right) => {
    const byPinned = Number(right.pinned === true) - Number(left.pinned === true)
    if (byPinned !== 0) return byPinned
    return compareChatsWithinBucket(left, right, mode, collator)
  })
}

export function buildSidebarEntries(
  chats: readonly ChatSidebarRow[],
  folders: readonly ChatFolder[],
  mode: SidebarSortMode = DEFAULT_SIDEBAR_SORT_MODE,
  options: SidebarSortOptions = {},
): SidebarEntry[] {
  const visibleChats = chats.filter((chat) => !chat.archived && !isEmptySidebarDraft(chat))
  const foldersById = new Map(folders.map((folder) => [folder.id, folder]))
  const chatsByFolder = new Map<string, ChatSidebarRow[]>()
  const entries: SidebarEntry[] = []
  const collator = collatorFor(options.locale)

  for (const chat of visibleChats) {
    const folderId = chat.folderId
    if (folderId && foldersById.has(folderId)) {
      const list = chatsByFolder.get(folderId) ?? []
      list.push(chat)
      chatsByFolder.set(folderId, list)
      continue
    }
    entries.push({
      kind: 'chat',
      chat,
      sortValue: chatSortValue(chat, mode),
      pinned: chat.pinned === true,
    })
  }

  for (const folder of folders) {
    const folderChats = sortChats(chatsByFolder.get(folder.id) ?? [], mode, options)
    entries.push({
      kind: 'folder',
      folder,
      chats: folderChats,
      sortValue: folderSortValue(folder, folderChats, mode, options),
      pinned: folderChats.some((chat) => chat.pinned === true),
    })
  }

  return entries.sort((left, right) => {
    const byPinned = Number(right.pinned) - Number(left.pinned)
    if (byPinned !== 0) return byPinned
    const byValue = compareSortValues(left.sortValue, right.sortValue, mode, collator)
    if (byValue !== 0) return byValue
    if (left.kind !== right.kind) return left.kind === 'folder' ? -1 : 1
    const leftName = left.kind === 'folder' ? left.folder.name : left.chat.title
    const rightName = right.kind === 'folder' ? right.folder.name : right.chat.title
    const byName = collator.compare(leftName, rightName)
    if (byName !== 0) return byName
    const leftId = left.kind === 'folder' ? left.folder.id : left.chat.id
    const rightId = right.kind === 'folder' ? right.folder.id : right.chat.id
    return leftId.localeCompare(rightId)
  })
}

export function buildCreatedAtGroups(
  chats: readonly ChatSidebarRow[],
  mode: SidebarSortMode,
  now: number = Date.now(),
): SidebarCreatedAtGroup[] {
  if (!shouldRenderCreatedAtGroups(mode)) return []
  const groups: SidebarCreatedAtGroup[] = []
  for (const chat of chats) {
    const bucket = createdAtBucket(chat, now)
    const current = groups[groups.length - 1]
    if (current?.key === bucket.key) {
      current.chats.push(chat)
      continue
    }
    groups.push({ ...bucket, chats: [chat] })
  }
  return groups
}

export function formatSidebarRowMeta(
  chat: ChatSidebarRow,
  mode: SidebarSortMode,
  now: number = Date.now(),
): string {
  const field = sidebarSortField(mode)
  switch (field) {
    case 'updatedAt':
      return formatRelativeDate(numberOrZero(chat.updatedAt), now)
    case 'createdAt':
      return formatRelativeDate(numberOrFallback(chat.createdAt, chat.updatedAt), now)
    case 'lastViewedAt':
      return formatRelativeDate(numberOrFallback(chat.lastViewedAt, chat.updatedAt), now)
    case 'totalCostUsd':
      return formatCost(numberOrZero(chat.totalCostUsd))
    case 'wordCount':
      return `${numberOrZero(chat.wordCount).toLocaleString()}w`
    case 'title':
      return sidebarSortDirection(mode) === 'asc' ? 'A-Z' : 'Z-A'
  }
}

function compareChatsWithinBucket(
  left: ChatSidebarRow,
  right: ChatSidebarRow,
  mode: SidebarSortMode,
  collator: Intl.Collator,
): number {
  const byValue = compareSortValues(
    chatSortValue(left, mode),
    chatSortValue(right, mode),
    mode,
    collator,
  )
  if (byValue !== 0) return byValue
  const byTitle = collator.compare(chatTitle(left), chatTitle(right))
  if (byTitle !== 0) return byTitle
  return right.id.localeCompare(left.id)
}

function compareSortValues(
  left: SidebarSortValue,
  right: SidebarSortValue,
  mode: SidebarSortMode,
  collator: Intl.Collator,
): number {
  const direction = sidebarSortDirection(mode) === 'asc' ? 1 : -1
  return compareSortValuesAscending(left, right, collator) * direction
}

function compareSortValuesAscending(
  left: SidebarSortValue,
  right: SidebarSortValue,
  collator: Intl.Collator,
): number {
  if (typeof left === 'string' || typeof right === 'string') {
    return collator.compare(String(left), String(right))
  }
  return left - right
}

function emptyFolderSortValue(folder: ChatFolder, mode: SidebarSortMode): SidebarSortValue {
  const updatedAt = numberOrFallback(folder.updatedAt, folder.createdAt)
  switch (sidebarSortField(mode)) {
    case 'updatedAt':
      return updatedAt
    case 'createdAt':
      return numberOrFallback(folder.createdAt, updatedAt)
    case 'lastViewedAt':
      return numberOrFallback(folder.lastUsedAt, updatedAt)
    case 'totalCostUsd':
    case 'wordCount':
      return 0
    case 'title':
      return folder.name
  }
}

function createdAtBucket(
  chat: ChatSidebarRow,
  now: number,
): Pick<SidebarCreatedAtGroup, 'key' | 'label'> {
  const createdAt = numberOrFallback(chat.createdAt, chat.updatedAt)
  const daysAgo = Math.floor((startOfLocalDay(now) - startOfLocalDay(createdAt)) / 86_400_000)
  if (daysAgo <= 0) return { key: 'today', label: 'Today' }
  if (daysAgo === 1) return { key: 'yesterday', label: 'Yesterday' }
  if (daysAgo < 7) return { key: 'previous-7-days', label: 'Previous 7 days' }
  if (daysAgo < 30) return { key: 'previous-30-days', label: 'Previous 30 days' }
  return { key: 'older', label: 'Older' }
}

function startOfLocalDay(value: number): number {
  const date = new Date(value)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function chatTitle(chat: ChatSidebarRow): string {
  const title = chat.title.trim()
  return title ? title : 'Untitled chat'
}

function collatorFor(locale: string | string[] | undefined): Intl.Collator {
  return new Intl.Collator(locale, { numeric: true, sensitivity: 'base' })
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function numberOrFallback(value: unknown, fallback: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : numberOrZero(fallback)
}

function formatRelativeDate(value: number, now: number): string {
  if (value <= 0) return ''
  const daysAgo = Math.floor((startOfLocalDay(now) - startOfLocalDay(value)) / 86_400_000)
  if (daysAgo === 0) {
    return SIDEBAR_TIME_FORMATTER.format(value)
  }
  if (daysAgo === 1) return 'Yesterday'
  const date = new Date(value)
  const nowYear = new Date(now).getFullYear()
  const formatter =
    date.getFullYear() === nowYear ? SIDEBAR_DATE_FORMATTER : SIDEBAR_DATE_WITH_YEAR_FORMATTER
  return formatter.format(date)
}

function formatCost(value: number): string {
  if (value <= 0) return '$0.00'
  if (value < 0.01) return '<$0.01'
  if (value < 100) return `$${value.toFixed(2)}`
  return `$${Math.round(value).toLocaleString()}`
}
