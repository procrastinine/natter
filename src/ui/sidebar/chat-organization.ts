import {
  compareSidebarChatRows,
  type SidebarSortMode,
  sidebarSortDirection,
  sidebarSortField,
} from '../../core/sidebar-sort'
import type { ChatSidebarRow } from '../../core/types'

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

export function sortChats(
  chats: readonly ChatSidebarRow[],
  mode: SidebarSortMode,
): ChatSidebarRow[] {
  return [...chats].sort((left, right) => compareSidebarChatRows(left, right, mode))
}

export function createdAtGroupBoundaries(now: number): readonly [number, number, number, number] {
  const todayStart = startOfLocalDay(now)
  const day = 86_400_000
  return [todayStart, todayStart - day, todayStart - day * 6, todayStart - day * 29]
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

function startOfLocalDay(value: number): number {
  const date = new Date(value)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
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
