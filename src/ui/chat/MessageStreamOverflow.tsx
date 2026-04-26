import type { ReactNode } from 'react'

export type MessageCollapseMode = 'full' | 'compact' | 'peek'

export interface MessageCollapseProfile {
  defaultMode: MessageCollapseMode
  modes: readonly MessageCollapseMode[]
  oversized: boolean
}

export interface MessageCollapseProfileOptions {
  streaming?: boolean
}

export interface MessageStreamOverflowProps {
  collapseMode: MessageCollapseMode
  fullChildren: ReactNode
  compactChildren: ReactNode
  peekChildren: ReactNode
}

export const DEFAULT_OVERFLOW_THRESHOLD = 20_000
export const LONG_MESSAGE_THRESHOLD = 4_000

// The user wants avatar-driven collapse states instead of a separate
// "show full" banner:
// - short messages:        full <-> peek
// - long messages:         full -> compact -> peek -> full
// - truly oversized rows:  start in compact to protect render cost
// - active streams:        stay full unless the user manually collapses
export function collapseProfileFor(
  totalChars: number,
  options: MessageCollapseProfileOptions = {},
): MessageCollapseProfile {
  if (totalChars <= 0) {
    return { defaultMode: 'full', modes: ['full'], oversized: false }
  }
  if (totalChars > DEFAULT_OVERFLOW_THRESHOLD) {
    return {
      defaultMode: options.streaming ? 'full' : 'compact',
      modes: ['full', 'compact', 'peek'],
      oversized: true,
    }
  }
  if (totalChars > LONG_MESSAGE_THRESHOLD) {
    return {
      defaultMode: 'full',
      modes: ['full', 'compact', 'peek'],
      oversized: false,
    }
  }
  return {
    defaultMode: 'full',
    modes: ['full', 'peek'],
    oversized: false,
  }
}

export function nextCollapseMode(
  current: MessageCollapseMode,
  modes: readonly MessageCollapseMode[],
): MessageCollapseMode {
  if (modes.length === 0) return 'full'
  const idx = modes.indexOf(current)
  if (idx < 0) return modes[0] ?? 'full'
  return modes[(idx + 1) % modes.length] ?? modes[0] ?? 'full'
}

export function MessageStreamOverflow({
  collapseMode,
  fullChildren,
  compactChildren,
  peekChildren,
}: MessageStreamOverflowProps) {
  if (collapseMode === 'peek') {
    return <>{peekChildren}</>
  }
  if (collapseMode === 'compact') {
    return <>{compactChildren}</>
  }
  return <>{fullChildren}</>
}
