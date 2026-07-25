import { create } from 'zustand'

export type AnnouncementPriority = 'polite' | 'assertive'

interface AnnouncementInput {
  text: string
  priority?: AnnouncementPriority
  eventKey?: string
}

export interface Announcement {
  id: string
  text: string
  priority: AnnouncementPriority
}

interface AnnouncementStoreState {
  polite: Announcement[]
  assertive: Announcement[]
  announce: (input: AnnouncementInput) => string | null
  consume: (priority: AnnouncementPriority, id: string) => void
  reset: () => void
}

const MAX_QUEUED_PER_LANE = 24
const MAX_REMEMBERED_EVENT_KEYS = 256
let counter = 0
const seenEventKeys = new Set<string>()

function rememberEventKey(eventKey: string): boolean {
  if (seenEventKeys.has(eventKey)) return false
  seenEventKeys.add(eventKey)
  if (seenEventKeys.size > MAX_REMEMBERED_EVENT_KEYS) {
    const oldest = seenEventKeys.values().next().value
    if (oldest !== undefined) seenEventKeys.delete(oldest)
  }
  return true
}

function nextAnnouncementId(): string {
  counter += 1
  return `announcement-${counter}`
}

export const useAnnouncementStore = create<AnnouncementStoreState>((set) => ({
  polite: [],
  assertive: [],
  announce: ({ text, priority = 'polite', eventKey }) => {
    const normalized = text.trim()
    if (normalized.length === 0) return null
    if (eventKey && !rememberEventKey(eventKey)) return null

    const id = nextAnnouncementId()
    const announcement: Announcement = { id, text: normalized, priority }
    set((state) => ({
      [priority]: [...state[priority], announcement].slice(-MAX_QUEUED_PER_LANE),
    }))
    return id
  },
  consume: (priority, id) =>
    set((state) => ({
      [priority]: state[priority].filter((announcement) => announcement.id !== id),
    })),
  reset: () => {
    seenEventKeys.clear()
    set({ polite: [], assertive: [] })
  },
}))

export function announceGenerationOutcome(
  streamId: string,
  outcome: 'done' | 'error' | 'abort',
): void {
  if (outcome === 'done') return
  useAnnouncementStore.getState().announce({
    text:
      outcome === 'abort'
        ? 'Generation stopped. Partial response kept.'
        : 'Response failed. Partial response kept if available.',
    priority: outcome === 'error' ? 'assertive' : 'polite',
    eventKey: `stream-end:${streamId}:${outcome}`,
  })
}

export function announceVariantPosition(index: number, total: number): void {
  useAnnouncementStore.getState().announce({ text: `Variant ${index + 1} of ${total}.` })
}

export function announceTreeBranchOpened(role: string): void {
  useAnnouncementStore.getState().announce({ text: `Opened branch at ${role} message.` })
}

export function announceEditTreeMode(enabled: boolean): void {
  useAnnouncementStore.getState().announce({ text: `Edit tree mode ${enabled ? 'on' : 'off'}.` })
}
